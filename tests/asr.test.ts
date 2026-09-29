// 语音转录（ASR）测试：配置、格式嗅探、请求形态、转码、服务接线、HTTP 路由。
// **全程 mock fetch**——转录按音频秒数计费，测试绝不花钱（tests/setup.ts 的守卫再兜一层底）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import http from 'node:http';
import {
  aiAsrConfigFromEnv,
  ffmpegAvailable,
  sniffAudioFormat,
  transcodeToMp3,
  transcribeAudio,
  type AsrConfig,
} from '../server/services/ai-asr';
import { LibraryService } from '../server/services/library';
import { apiRouter } from '../server/routes/api';
import type { AppConfig } from '../server/config';
import { createFixture, tinyWav, type Fixture } from './helpers/fixture';

const CFG: AsrConfig = {
  apiKey: 'k',
  baseUrl: 'https://asr.example/v1',
  model: 'mimo-v2.5-asr',
  timeoutMs: 5000,
  maxPerNote: 4,
};

/** 截获带 input_audio 的调用（其余请求分派回去：分类兜底等不能碰真网络，也不能算进转录次数） */
function stubAsr(opts: { text?: string; status?: number; raw?: string; usage?: unknown } = {}) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const rawBody = String(init?.body ?? '');
    if (!target.includes('/chat/completions') || !rawBody.includes('input_audio')) {
      return realFetch(url as never, init);
    }
    calls.push({ url: target, body: JSON.parse(rawBody) as Record<string, unknown> });
    const body =
      opts.raw ??
      JSON.stringify({
        choices: [{ message: { content: opts.text ?? '今天记得给鱼换水' } }],
        usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 20, seconds: 37.5 },
      });
    return new Response(body, { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fake);
  return { calls };
}

function makeCfg(fx: Fixture): AppConfig {
  return {
    app: 'myinfobase-test',
    vaultRoot: fx.root.replace(/\\/g, '/'),
collections: [{ id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' }],
    groups: [],
    host: '127.0.0.1',
    port: 0,
    timezone: 'Asia/Shanghai',
    publicOrigin: '',
    extraAllowedOrigins: [],
    dataDir: fx.dataDir,
    backupDir: fx.backupDir,
    exportDir: fx.exportDir,
    exportAfterRefresh: false,
    autoRefreshOnBoot: false,
    logDir: path.join(fx.root, 'logs'),
    isProduction: false,
    version: 'test',
  };
}

async function waitForJob(svc: LibraryService, jobId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const job = svc.getRefreshJob(jobId);
    if (job && job.state !== 'running') {
      if (job.state !== 'completed') throw new Error(`刷新异常(${job.state}): ${job.diagnostics.join(' | ')}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('刷新任务超时');
}

function baseQuery() {
  return {
    collection: 'rednote',
    timeField: 'published' as const,
    range: 'all' as const,
    order: 'desc' as const,
    offset: 0,
    limit: 60,
    status: 'active' as const,
  };
}

/** 用 ffmpeg 造一段真 m4a（没有 ffmpeg 就没有转码可测——调用方 ctx.skip） */
function makeM4a(dir: string): Promise<string | null> {
  const out = path.join(dir, 'clip.m4a');
  return new Promise((resolve) => {
    const p = spawn(
      'ffmpeg',
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'aac', out],
      { stdio: 'ignore' }
    );
    p.once('error', () => resolve(null));
    p.once('exit', (code) => resolve(code === 0 ? out : null));
  });
}

describe('aiAsrConfigFromEnv', () => {
  it('缺 key 返回 null；默认值与变量覆盖', () => {
    expect(aiAsrConfigFromEnv({})).toBeNull();
    const def = aiAsrConfigFromEnv({ AI_CLASSIFY_API_KEY: 'k' })!;
    expect(def).toMatchObject({ model: 'mimo-v2.5-asr', timeoutMs: 300000, maxPerNote: 4 });
    const over = aiAsrConfigFromEnv({
      AI_CLASSIFY_API_KEY: 'k',
      AI_ASR_MODEL: 'asr-2',
      AI_ASR_TIMEOUT_MS: '12000',
      AI_ASR_MAX_PER_NOTE: '2',
    })!;
    expect(over).toMatchObject({ model: 'asr-2', timeoutMs: 12000, maxPerNote: 2 });
    // 空串视为未配（compose 白名单会把没设的变量透传成空串）；非法数值回落
    expect(aiAsrConfigFromEnv({ AI_CLASSIFY_API_KEY: 'k', AI_ASR_MODEL: '' })!.model).toBe('mimo-v2.5-asr');
    expect(aiAsrConfigFromEnv({ AI_CLASSIFY_API_KEY: 'k', AI_ASR_TIMEOUT_MS: 'nonsense' })!.timeoutMs).toBe(300000);
    // 非法上限回落到默认 4（positiveInt 的语义是"写错就用默认"，不是钳到下限）
    expect(aiAsrConfigFromEnv({ AI_CLASSIFY_API_KEY: 'k', AI_ASR_MAX_PER_NOTE: '0' })!.maxPerNote).toBe(4);
  });
});

describe('sniffAudioFormat：网关只收 wav/mp3', () => {
  it('按文件头识别 wav / mp3，其余返回 null', () => {
    expect(sniffAudioFormat(tinyWav())).toBe('wav');
    expect(sniffAudioFormat(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]))).toBe('mp3');
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    // m4a（ftyp 盒）与空串都要走转码/报错
    expect(sniffAudioFormat(Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypmp42', 'ascii')]))).toBeNull();
    expect(sniffAudioFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('transcribeAudio：请求形态与失败翻译', () => {
  it('audio-only、带 format、关思考、Bearer；usage.seconds 变成 audioSeconds', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '甲<br>乙' } }],
          usage: { prompt_tokens: 9, completion_tokens: 11, seconds: 12.5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const out = await transcribeAudio(CFG, { bytes: tinyWav(), format: 'wav' }, stub);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('甲\n乙'); // 走与 OCR 同一套归一化
      expect(out.model).toBe('mimo-v2.5-asr');
      expect(out.usage.audioSeconds).toBe(12.5);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://asr.example/v1/chat/completions');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer k');
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      model: string;
      thinking: unknown;
      messages: Array<{ content: Array<{ type: string; input_audio?: { format: string } }> }>;
    };
    expect(body.model).toBe('mimo-v2.5-asr');
    expect(body.thinking).toEqual({ type: 'disabled' });
    // **只能有 input_audio part**：带 text part 会被网关拒（probe 实测）
    const content = body.messages[0]!.content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('input_audio');
    expect(content[0]!.input_audio?.format).toBe('wav');
  });

  it('失败都能说清原因：凭据 / 限流 / 5xx / 格式被拒 / 空回复 / 超时 / 网络错', async () => {
    const run = (status: number, raw: string) =>
      transcribeAudio(
        CFG,
        { bytes: tinyWav(), format: 'wav' },
        (async () => new Response(raw, { status })) as typeof fetch
      );

    const r401 = await run(401, '{"error":{"message":"bad key"}}');
    expect(r401.ok).toBe(false);
    if (!r401.ok) expect(r401.reason).toMatch(/凭据/);
    const r429 = await run(429, 'slow down');
    expect(r429.ok).toBe(false);
    if (!r429.ok) expect(r429.reason).toMatch(/限流/);
    const r500 = await run(500, 'boom');
    expect(r500.ok).toBe(false);
    if (!r500.ok) expect(r500.reason).toMatch(/HTTP 500/);
    const r400 = await run(400, '{"error":{"message":"input_audio.format must be one of: wav, mp3"}}');
    expect(r400.ok).toBe(false);
    if (!r400.ok) expect(r400.reason).toMatch(/音频格式/);

    const empty = await transcribeAudio(
      CFG,
      { bytes: tinyWav(), format: 'wav' },
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })) as typeof fetch
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/没有返回文字/);

    const timeout = await transcribeAudio(
      CFG,
      { bytes: tinyWav(), format: 'wav' },
      (async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }) as typeof fetch
    );
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.reason).toMatch(/转录超时/);

    const net = await transcribeAudio(
      CFG,
      { bytes: tinyWav(), format: 'wav' },
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch
    );
    expect(net.ok).toBe(false);
    if (!net.ok) expect(net.reason).toMatch(/请求失败/);
  });
});

describe('transcodeToMp3（依赖本机 ffmpeg）', () => {
  it('wav 转出的 mp3 能被嗅探成 mp3；坏输入返回 null', async (ctx) => {
    if (!(await ffmpegAvailable())) {
      ctx.skip('本机未安装 ffmpeg');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-tc-'));
    try {
      const wav = path.join(dir, 'a.wav');
      fs.writeFileSync(wav, tinyWav());
      const mp3 = await transcodeToMp3(wav);
      expect(mp3).not.toBeNull();
      expect(sniffAudioFormat(mp3!)).toBe('mp3');

      const bad = path.join(dir, 'b.m4a');
      fs.writeFileSync(bad, Buffer.from('not an audio file at all'));
      expect(await transcodeToMp3(bad)).toBeNull();
      expect(await transcodeToMp3(path.join(dir, 'missing.m4a'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 服务接线 ----------

describe('LibraryService.transcribeNote：缓存、上限、取消、转码', () => {
  beforeEach(() => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    vi.stubEnv('AI_ASR_MODEL', 'asr-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function boot(fx: Fixture, audios: number, id = 'id-0001'): Promise<LibraryService> {
    fx.writeNote({ id, title: '语音笔记', images: 0, audios });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    return svc;
  }

  it('转录一段 wav：落盘 kind=asr、能搜到、进语料；第二次走缓存', async () => {
    const fx = createFixture('asr-basic-');
    const svc = await boot(fx, 1);
    const { calls } = stubAsr({ text: '今天记得给鱼换水' });

    const out = await svc.transcribeNote('id-0001');
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ ok: true, cached: false });
    expect(out.model).toBe('asr-test');
    expect(calls).toHaveLength(1);
    // 正文里没有这些字 → 识别文本必须能被搜索命中
    expect(svc.query({ ...baseQuery(), q: '给鱼换水' }).total).toBe(1);
    const rec = svc.corpusRecords().find((r) => r.id === 'id-0001')!;
    expect(rec.recognized).toHaveLength(1);
    expect(rec.recognized[0]).toMatchObject({ kind: 'asr', text: '今天记得给鱼换水' });

    const again = await svc.transcribeNote('id-0001');
    expect(calls).toHaveLength(1); // 没有新的模型调用
    expect(again.results[0]).toMatchObject({ ok: true, cached: true });
    expect(again.remaining).toBe(0);
  });

  it('同一段音频被另一篇引用时直接复用（不重复计费）', async () => {
    const fx = createFixture('asr-shared-');
    fx.writeNote({ id: 'id-0001', title: '一', images: 0, audios: 1 });
    fx.writeNote({ id: 'id-0002', title: '二', images: 0, audios: 1 }); // audio-1.wav 字节完全相同
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    const { calls } = stubAsr({ text: '同一段话' });

    await svc.transcribeNote('id-0001');
    const second = await svc.transcribeNote('id-0002');
    expect(calls).toHaveLength(1);
    expect(second.results[0]).toMatchObject({ ok: true, cached: true });
    expect(svc.mediaTextFor('id-0002')).toHaveLength(1);
  });

  it('单篇上限：AI_ASR_MAX_PER_NOTE=4 时 5 段只转 4 段，remaining 是 1', async () => {
    const fx = createFixture('asr-cap-');
    fx.writeNote({ id: 'id-0001', title: '语音笔记', images: 0, audios: 5 });
    // 五段字节必须**不同**：fixture 的 tinyWav 是同一份字节，会全部命中内容 hash 缓存，测不到上限
    for (let i = 2; i <= 5; i++) {
      fx.writeMedia('id-0001', `audio-${i}.wav`, tinyWav(0.2 + i * 0.05));
    }
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    const { calls } = stubAsr({ text: '第 n 段' });
    const out = await svc.transcribeNote('id-0001');
    expect(calls).toHaveLength(4);
    expect(out.results).toHaveLength(4);
    expect(out.remaining).toBe(1);
  });

  it('shouldStop 为真后不再发（关窗即停），remaining 是没跑的段数', async () => {
    const fx = createFixture('asr-stop-');
    const svc = await boot(fx, 3);
    const { calls } = stubAsr({ text: '停在这' });
    const out = await svc.transcribeNote('id-0001', { shouldStop: () => calls.length >= 1 });
    expect(calls).toHaveLength(1);
    expect(out.results).toHaveLength(1);
    expect(out.remaining).toBe(2);
  });

  it('并发转录同一段只调一次模型（单飞）', async () => {
    const fx = createFixture('asr-flight-');
    const svc = await boot(fx, 1);
    const { calls } = stubAsr({ text: '并发共享' });
    const [a, b] = await Promise.all([svc.transcribeNote('id-0001'), svc.transcribeNote('id-0001')]);
    expect(calls).toHaveLength(1);
    expect(a.results.every((r) => r.ok)).toBe(true);
    expect(b.results.every((r) => r.ok)).toBe(true);
    expect(svc.mediaTextFor('id-0001')).toHaveLength(1);
  });

  it('m4a 走 ffmpeg 转码后以 format=mp3 送出（没有 ffmpeg 则可见地跳过本条）', async (ctx) => {
    if (!(await ffmpegAvailable())) {
      ctx.skip('本机未安装 ffmpeg，转码分支本次未验证');
      return;
    }
    const fx = createFixture('asr-m4a-');
    const m4a = await makeM4a(fx.root);
    if (!m4a) {
      ctx.skip('ffmpeg 无法生成 m4a（缺编码器）');
      return;
    }
    fx.writeNote({ id: 'id-0001', title: '语音', images: 0 });
    fx.writeMedia('id-0001', 'audio-1.m4a', fs.readFileSync(m4a));
    // 上面的 writeNote 没带 audios：手动补一条引用
    const md = path.join(fx.sourceRoot, 'Bookmarks', '语音-id-0001.md');
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8') + '\n![[RedNote/Media/id-0001/audio-1.m4a]]\n', 'utf8');
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    expect(svc.asrTargets('id-0001')).toHaveLength(1);

    const { calls } = stubAsr({ text: '转码后的转录' });
    const out = await svc.transcribeNote('id-0001');
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    const content = (calls[0]!.body.messages as Array<{ content: Array<{ type: string; input_audio?: { format: string } }> }>)[0]!.content;
    expect(content[0]!.input_audio?.format).toBe('mp3');
  });

  it('没有音频的笔记：asrTargets 为空、指定 mediaId 转录报 400 语义的校验错', async () => {
    const fx = createFixture('asr-none-');
    fx.writeNote({ id: 'id-0001', title: '纯图', images: 1, audios: 0 });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    expect(svc.asrTargets('id-0001')).toHaveLength(0);
    await expect(svc.transcribeNote('id-0001', { mediaId: 'audio-9.wav' })).rejects.toThrow(/没有可转录/);
  });
});

// ---------- HTTP ----------

describe('HTTP：POST /notes/:id/transcribe', () => {
  let fx: Fixture;
  let server: http.Server;
  let base: string;
  let svc: LibraryService;

  beforeEach(async () => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    fx = createFixture('asr-http-');
    fx.writeNote({ id: 'id-0001', title: '语音', images: 0, audios: 1 });
    svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('成功 200 带 recognized；未知笔记 404；请求体非法 400', async () => {
    const { calls } = stubAsr({ text: '语音里的内容' });
    const ok = await fetch(`${base}/api/notes/id-0001/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(200);
    const out = (await ok.json()) as { results: Array<{ ok: boolean }>; recognized: Array<{ kind: string }> };
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.recognized[0]!.kind).toBe('asr');
    expect(calls).toHaveLength(1);

    const missing = await fetch(`${base}/api/notes/nope/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(404);

    const bad = await fetch(`${base}/api/notes/id-0001/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: '' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_BODY');
  });
});
