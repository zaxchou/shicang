// 识别文本（OCR）测试：存储层去重语义 + 视觉客户端 + 服务接线 + 搜索/语料贯通 + HTTP 路由。
//
// **全程 mock 掉 fetch**（`vi.stubGlobal`）：OCR 会真的把用户的图片发给供应商、真的花钱，
// 所以自动化测试一个字节都不该发出去。真实链路只在本轮手工浏览器验收里点一次（并记录在 docs/verification.md）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apiRouter } from '../server/routes/api';
import type { AppConfig } from '../server/config';
import { LibraryService } from '../server/services/library';
import {
  MediaTextService,
  mediaHashOf,
  normalizeEntry,
} from '../server/services/media-text';
import {
  OCR_IMAGE_MIMES,
  aiVisionConfigFromEnv,
  isNoTextResult,
  normalizeOcrText,
  ocrImage,
} from '../server/services/ai-vision';
import { createFixture, tinyWebp, type Fixture } from './helpers/fixture';

// ---------- 工具 ----------

function tmpDirs(): { dataDir: string; backupDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'myinfobase-ocr-'));
  const dataDir = path.join(base, 'data');
  const backupDir = path.join(base, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  return { dataDir, backupDir };
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

/** 造一个假的视觉网关：只截获**带 image_url 的**调用，其余请求分派回去。
 *
 * 两个坑必须一起避开，否则计数会骗人：
 *   ① 刷新成功后会跑自动分类，它也走 /chat/completions（但没有 image_url）——不能算进 OCR 次数；
 *   ② 测试客户端自己要用 fetch 请求本地 HTTP 服务——全局 stub 会把它也吃掉，必须放行。
 */
function stubVision(opts: { text?: string; status?: number; raw?: string; usage?: unknown } = {}) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const rawBody = String(init?.body ?? '');
    if (!target.includes('/chat/completions')) return realFetch(url as never, init);
    if (!rawBody.includes('image_url')) {
      // 分类兜底之类的非视觉调用：给一个无害回复，绝不去碰真网络
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"categoryId":"","reason":""}' } }] }), {
        status: 200,
      });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: target, body: JSON.parse(rawBody) as Record<string, unknown>, auth: headers.Authorization });
    const status = opts.status ?? 200;
    const body =
      opts.raw ??
      JSON.stringify({
        choices: [{ message: { content: opts.text ?? '图里的字' } }],
        usage: opts.usage ?? { prompt_tokens: 900, completion_tokens: 12, prompt_tokens_details: { image_tokens: 850 } },
      });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fake);
  return { calls, fake };
}

// ---------- 存储层 ----------

describe('MediaTextService：按媒体内容 hash 存识别结果', () => {
  it('内容 hash 只跟字节走：同字节同 hash，差一个字节就不同', () => {
    const a = Buffer.from('abc');
    const b = Buffer.from('abc');
    const c = Buffer.from('abd');
    expect(mediaHashOf(a)).toBe(mediaHashOf(b));
    expect(mediaHashOf(a)).not.toBe(mediaHashOf(c));
    expect(mediaHashOf(a)).toHaveLength(64);
  });

  it('读时净化：没有正文 / 没有 refs / 未知 kind 的条目一律丢掉', () => {
    const ok = { mediaHash: 'h', kind: 'ocr', text: '字', model: 'm', at: 't', refs: [{ noteId: 'n', mediaId: 'i' }] };
    expect(normalizeEntry(ok)).toMatchObject({ text: '字' });
    expect(normalizeEntry({ ...ok, text: '   ' })).toBeNull();
    expect(normalizeEntry({ ...ok, refs: [] })).toBeNull();
    expect(normalizeEntry({ ...ok, kind: 'speech' })).toBeNull();
    expect(normalizeEntry({ ...ok, mediaHash: '' })).toBeNull();
    expect(normalizeEntry(null)).toBeNull();
    // usage 只保留数字字段
    expect(normalizeEntry({ ...ok, usage: { imageTokens: 850, junk: 'x' } })?.usage).toEqual({ imageTokens: 850 });
  });

  it('put 幂等：同一 hash + 同一 ref 不写盘、不抬 revision', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    const entry = {
      mediaHash: 'h1',
      kind: 'ocr' as const,
      text: '图里的字',
      model: 'm',
      at: '2026-01-01T00:00:00.000Z',
      refs: [{ noteId: 'n1', mediaId: 'image-1.webp' }],
    };
    const first = await svc.put(entry);
    expect(first).toMatchObject({ changed: true, revision: 1 });
    const again = await svc.put({ ...entry });
    expect(again).toMatchObject({ changed: false, revision: 1 });
  });

  it('同一份文件被第二篇引用：只补 ref、不覆盖已有文本', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: '第一次识别出来的字',
      model: 'm1',
      at: '2026-01-01T00:00:00.000Z',
      refs: [{ noteId: 'n1', mediaId: 'image-1.webp' }],
    });
    const second = await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: '不该覆盖',
      model: 'm2',
      at: '2026-02-02T00:00:00.000Z',
      refs: [{ noteId: 'n2', mediaId: 'image-1.webp' }],
    });
    expect(second.changed).toBe(true);
    const entry = svc.get('h1')!;
    expect(entry.text).toBe('第一次识别出来的字');
    expect(entry.model).toBe('m1');
    expect(entry.refs).toHaveLength(2);
    // 两篇都看得到，且各拿各自的 mediaId
    expect(svc.recognizedOf('n1')[0]).toMatchObject({ mediaId: 'image-1.webp', text: '第一次识别出来的字' });
    expect(svc.recognizedOf('n2')[0]).toMatchObject({ mediaId: 'image-1.webp', mediaHash: 'h1' });
    expect(svc.recognizedOf('n3')).toEqual([]);
  });

  it('removeRef 只摘一条；最后一条被摘掉时整条 entry 一起消失', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: '字',
      model: 'm',
      at: 't',
      refs: [
        { noteId: 'n1', mediaId: 'image-1.webp' },
        { noteId: 'n2', mediaId: 'image-1.webp' },
      ],
    });
    expect(await svc.removeRef('n1', 'image-1.webp')).toBe(true);
    expect(svc.get('h1')!.refs).toHaveLength(1);
    expect(svc.recognizedOf('n1')).toEqual([]);
    expect(svc.recognizedOf('n2')).toHaveLength(1);
    expect(await svc.removeRef('n2', 'image-1.webp')).toBe(true);
    expect(svc.get('h1')).toBeNull();
    expect(svc.entryCount).toBe(0);
    expect(await svc.removeRef('n2', 'image-1.webp')).toBe(false);
  });

  it('重启后仍在（落盘 + 回读校验），textFor 拼给搜索用', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: '第一张的字',
      model: 'm',
      at: 't',
      refs: [{ noteId: 'n1', mediaId: 'image-1.webp' }],
    });
    await svc.put({
      mediaHash: 'h2',
      kind: 'ocr',
      text: '第二张的字',
      model: 'm',
      at: 't',
      refs: [{ noteId: 'n1', mediaId: 'image-2.webp' }],
    });
    const reopened = new MediaTextService(dataDir, backupDir);
    await reopened.init();
    expect(reopened.entryCount).toBe(2);
    expect(reopened.revision).toBe(2);
    expect(reopened.textFor('n1')).toBe('第一张的字\n第二张的字');
    expect(reopened.textFor('n9')).toBe('');
    expect(reopened.hasFor('n1', 'image-1.webp')).toBe(true);
    expect(reopened.hasFor('n1', 'image-9.webp')).toBe(false);
  });

  it('文件损坏且无备份时按空处理并给诊断，不抛错', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: '字',
      model: 'm',
      at: 't',
      refs: [{ noteId: 'n1', mediaId: 'i1' }],
    });
    fs.writeFileSync(path.join(dataDir, 'media-text.json'), '{ 坏掉的 JSON', 'utf8');
    const broken = new MediaTextService(dataDir, backupDir);
    const diagnostics = await broken.init();
    expect(broken.entryCount).toBe(0);
    // 有备份时会从备份恢复；这里只要求"不抛错且说清楚了"
    expect(diagnostics.some((d) => d.includes('media-text.json'))).toBe(true);
  });
});

// ---------- 视觉客户端 ----------

describe('ai-vision：调用形态与失败翻译', () => {
  const cfg = { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'vision-test', timeoutMs: 5000, maxPerNote: 3 };

  it('请求形态：data URI 带正确的 mime、关闭 thinking、带 Bearer', async () => {
    const { calls } = stubVision({ text: '识别结果' });
    const out = await ocrImage(cfg, { bytes: Buffer.from('fake-webp'), mime: 'image/webp' });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer k');
    expect(calls[0].body.model).toBe('vision-test');
    expect(calls[0].body.thinking).toEqual({ type: 'disabled' });
    const content = (calls[0].body.messages as Array<{ content: Array<Record<string, never>> }>)[0].content;
    const imageUrl = (content[1] as unknown as { image_url: { url: string } }).image_url.url;
    expect(imageUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect(imageUrl).toContain(Buffer.from('fake-webp').toString('base64'));
  });

  it('成功时带出用量（image_tokens 可用于事后核账）', async () => {
    stubVision({ text: '字', usage: { prompt_tokens: 900, completion_tokens: 5, prompt_tokens_details: { image_tokens: 850 } } });
    const out = await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' });
    expect(out).toMatchObject({ ok: true, text: '字', model: 'vision-test' });
    if (out.ok) expect(out.usage).toEqual({ promptTokens: 900, completionTokens: 5, imageTokens: 850 });
  });

  it('失败都能说清原因：凭据 / 限流 / 太大了 / 非 JSON / 空回复 / 超时', async () => {
    stubVision({ status: 401, raw: '{"error":{"message":"invalid api key"}}' });
    expect(await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })).toMatchObject({
      ok: false,
    });
    expect(((await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })) as { reason: string }).reason).toMatch(/凭据/);

    stubVision({ status: 429, raw: '{"error":{"message":"rate limited"}}' });
    expect(((await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })) as { reason: string }).reason).toMatch(/限流/);

    stubVision({ status: 413, raw: 'too large' });
    expect(((await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })) as { reason: string }).reason).toMatch(/太大/);

    stubVision({ raw: '<html>not json</html>' });
    expect(((await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })) as { reason: string }).reason).toMatch(/不是 JSON/);

    stubVision({ text: '' });
    expect(((await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' })) as { reason: string }).reason).toMatch(/没有返回文字/);

    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));
    const timedOut = await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.reason).toMatch(/超时/);
  });

  it('HTTP 5xx 与网络抛错也说人话（这两条分支此前零覆盖）', async () => {
    stubVision({ status: 500, raw: 'boom' });
    const r1 = await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/HTTP 500/);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const r2 = await ocrImage(cfg, { bytes: Buffer.from('x'), mime: 'image/webp' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/请求失败/);
  });

  it('归一化模型输出：<br> 变真换行、剥掉 HTML 标签、还原实体（实测模型就是这么吐的）', () => {
    // 真实输出长这样：表格单元格里用 <br> 表示换行，直接展示、搜索、导出都会带上字面量标签
    const raw = '| 黄芳<br>《没骨花鸟》<br>7.15-7.29上午 | 鲁大东<br>《草法》 |\n| --- | --- |';
    const out = normalizeOcrText(raw);
    expect(out).not.toContain('<br>');
    expect(out).toContain('黄芳\n《没骨花鸟》\n7.15-7.29上午');
    expect(out).toContain('| 黄芳');

    // 各种写法都要吃
    expect(normalizeOcrText('甲<br/>乙')).toBe('甲\n乙');
    expect(normalizeOcrText('甲<br />乙')).toBe('甲\n乙');
    expect(normalizeOcrText('<p>一段</p><div>两段</div>')).toBe('一段\n两段');
    expect(normalizeOcrText('<span>行内</span>标签')).toBe('行内标签');
    expect(normalizeOcrText('a &lt; b &amp; c&nbsp;d')).toBe('a < b & c d');

    // 正文里的数学式不能被当成标签吃掉
    expect(normalizeOcrText('若 a < b 则成立')).toBe('若 a < b 则成立');
    // 多余空行压掉、首尾空白去掉
    expect(normalizeOcrText('\n\n甲乙\n\n\n\n丙\n')).toBe('甲乙\n\n丙');

    // \r 归一（行尾残留 \r 会混进导出与搜索）、控制字符剥离（终端转义注入）、长度上限（第四轮深审）
    expect(normalizeOcrText('甲\r\n乙\r丙')).toBe('甲\n乙\n丙');
    const bell = String.fromCharCode(7); // BEL
    const esc = String.fromCharCode(27); // ESC（ANSI 转义序列开头）
    const nul = String.fromCharCode(0);
    expect(normalizeOcrText(`含${bell}铃${esc}[31m红${nul}零`)).toBe('含铃[31m红零');
    expect(normalizeOcrText('x'.repeat(60_000))).toHaveLength(50_000);
  });

  it('「无文字」是有效结论（库里有大量纯图），不是失败', () => {
    expect(isNoTextResult('无文字')).toBe(true);
    expect(isNoTextResult('无文字。')).toBe(true);
    expect(isNoTextResult('这张图没有文字')).toBe(false);
  });

  it('只接受能吃进去的图片类型（HEIC/AVIF/SVG 先排除，别浪费一次调用）', () => {
    expect(OCR_IMAGE_MIMES.has('image/webp')).toBe(true);
    expect(OCR_IMAGE_MIMES.has('image/png')).toBe(true);
    expect(OCR_IMAGE_MIMES.has('image/heic')).toBe(false);
    expect(OCR_IMAGE_MIMES.has('image/avif')).toBe(false);
    expect(OCR_IMAGE_MIMES.has('image/svg+xml')).toBe(false);
  });

  it('配置：缺 key 返回 null；上限与超时可用环境变量覆盖且非法值回落', () => {
    expect(aiVisionConfigFromEnv({})).toBeNull();
    const c = aiVisionConfigFromEnv({
      AI_CLASSIFY_API_KEY: 'k',
      AI_VISION_MODEL: 'm2',
      AI_OCR_MAX_PER_NOTE: '2',
      AI_OCR_TIMEOUT_MS: 'nonsense',
    })!;
    expect(c).toMatchObject({ model: 'm2', maxPerNote: 2, timeoutMs: 120000 });
    expect(aiVisionConfigFromEnv({ AI_CLASSIFY_API_KEY: 'k' })!.maxPerNote).toBe(8);
  });
});

// ---------- 服务接线 ----------

describe('LibraryService.ocrNote：缓存、去重、防护', () => {
  beforeEach(() => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    vi.stubEnv('AI_OCR_MAX_PER_NOTE', '8');
    vi.stubEnv('AI_VISION_MODEL', 'vision-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function boot(fx: Fixture, images = 1, images2 = 0): Promise<LibraryService> {
    fx.writeNote({ id: 'id-0001', title: '笔记一', images });
    fx.writeNote({ id: 'id-0002', title: '笔记二', images: images2 });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    return svc;
  }

  it('识别一篇的图片：存下来、写进语料、能被搜到', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 2);
    const { calls } = stubVision({ text: '这是一张字帖，写着「永和九年」' });

    const out = await svc.ocrNote('id-0001');
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.ok && !r.cached)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(out.model).toBe('vision-test');
    expect(out.recognized).toHaveLength(2);

    // 落盘了
    expect(fs.existsSync(path.join(fx.dataDir, 'media-text.json'))).toBe(true);

    // 能被搜到（正文里没有这些字）
    expect(svc.query({ ...baseQuery(), q: '永和九年' }).total).toBe(1);
    expect(svc.query({ ...baseQuery(), q: '永和九年' }).items[0].id).toBe('id-0001');
    // 多词 AND：一个词命中正文、一个词命中识别文本
    expect(svc.query({ ...baseQuery(), q: '笔记一 永和九年' }).total).toBe(1);
    expect(svc.query({ ...baseQuery(), q: '永和九年 不存在的词' }).total).toBe(0);

    // 进语料（recognized 不再是空数组）
    const rec = svc.corpusRecords().find((r) => r.id === 'id-0001')!;
    expect(rec.recognized).toHaveLength(2);
    expect(rec.recognized[0]).toMatchObject({ kind: 'ocr', mediaId: 'image-1.webp' });
    expect(rec.recognized[0].mediaHash).toHaveLength(64);
    // 识别文本进了 contentHash → 外部管道会知道这篇内容变了
    const before = svc.corpusRecords().find((r) => r.id === 'id-0002')!;
    expect(before.recognized).toEqual([]);
  });

  it('第二次点击不再调模型（命中内容 hash 缓存），结果照旧拿得到', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 2);
    const { calls } = stubVision({ text: '缓存住的字' });
    await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(2);

    const again = await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(2); // 没有新的调用
    expect(again.results.every((r) => r.cached)).toBe(true);
    expect(again.recognized).toHaveLength(2);
  });

  it('同一份图片被另一篇引用时，直接复用已有结果（不重复烧额度）', async () => {
    const fx = createFixture();
    // 两篇各有一张图，但**字节完全相同**（tinyWebp 是确定性的）——就是"同一张图被两篇引用"的情形
    const svc = await boot(fx, 1, 1);
    const bytesA = fs.readFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'image-1.webp'));
    const bytesB = fs.readFileSync(path.join(fx.sourceRoot, 'Media', 'id-0002', 'image-1.webp'));
    expect(bytesA.equals(bytesB)).toBe(true);

    const { calls } = stubVision({ text: '同一张图' });
    await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(1);

    const second = await svc.ocrNote('id-0002');
    expect(calls).toHaveLength(1); // 依然只有最初那一次调用
    expect(second.results[0]).toMatchObject({ ok: true, cached: true, text: '同一张图' });
    expect(svc.mediaTextFor('id-0002')).toHaveLength(1);
    expect(svc.mediaTextFor('id-0002')[0].mediaId).toBe('image-1.webp');
    // 两篇都指向同一个内容 hash
    expect(svc.mediaTextFor('id-0001')[0].mediaHash).toBe(svc.mediaTextFor('id-0002')[0].mediaHash);
    expect(svc.mediaTextFor('id-0002')[0].text).toBe('同一张图');
  });

  it('指定 mediaId 时只识别那一张（界面逐张请求走的就是这条路）', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 3);
    const { calls } = stubVision({ text: '指定的这张' });

    const one = await svc.ocrNote('id-0001', { mediaId: 'image-2.webp' });
    expect(calls).toHaveLength(1);
    expect(one.results).toHaveLength(1);
    expect(one.results[0]).toMatchObject({ mediaId: 'image-2.webp', ok: true, cached: false });
    // remaining 是"这篇还没识别的张数"，与本次请求了几张无关
    expect(one.remaining).toBe(2);
    expect(one.recognized.map((r) => r.mediaId)).toEqual(['image-2.webp']);

    // 再点第一张：只多一次调用，且两张都在结果里
    const two = await svc.ocrNote('id-0001', { mediaId: 'image-1.webp' });
    expect(calls).toHaveLength(2);
    expect(two.recognized.map((r) => r.mediaId).sort()).toEqual(['image-1.webp', 'image-2.webp']);
    expect(two.remaining).toBe(1);
  });

  it('单次上限真的生效，剩下的明确告诉用户还剩几张', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 3);
    vi.stubEnv('AI_OCR_MAX_PER_NOTE', '1');
    const { calls } = stubVision({ text: '只识别一张' });
    const out = await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(1);
    expect(out.results).toHaveLength(1);
    expect(out.remaining).toBe(2);
  });

  it('保护：媒体路径越界拒绝读盘；不是图片的不识别；没有图就没有目标', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 1);
    stubVision({ text: '不该被调用' });

    // 把索引里的媒体路径改成越界值（模拟坏数据）
    const idxPath = path.join(fx.dataDir, 'library-index.json');
    const doc = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    doc.notes.find((n: { id: string }) => n.id === 'id-0001').media[0].localRelativePath = '../../outside.webp';
    fs.writeFileSync(idxPath, JSON.stringify(doc), 'utf8');
    const svc2 = new LibraryService(makeCfg(fx));
    await svc2.init();
    const out = await svc2.ocrNote('id-0001');
    expect(out.results[0]).toMatchObject({ ok: false });
    expect(out.results[0].reason).toMatch(/越界/);

    // 没有图片的笔记：没有可识别目标
    expect(await svc2.ocrNote('id-0002')).toMatchObject({ results: [], remaining: 0 });
    // 指定的媒体不存在 → 明确的 400 语义（这里是 ValidationError）
    await expect(svc2.ocrNote('id-0002', { mediaId: 'image-1.webp' })).rejects.toThrow(/没有可识别的本地图片/);
  });

  it('未配置 AI 凭据时说清楚，而不是假装成功', async () => {
    const fx = createFixture();
    vi.unstubAllEnvs();
    const svc = await boot(fx, 1);
    const out = await svc.ocrNote('id-0001');
    expect(out.model).toBeNull();
    expect(out.results[0]).toMatchObject({ ok: false });
    expect(out.results[0].reason).toMatch(/未配置 AI 凭据/);
    expect(out.recognized).toEqual([]);
  });

  it('模型报错时逐张报原因，不写进存储', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 1);
    stubVision({ status: 429, raw: '{"error":{"message":"quota"}}' });
    const out = await svc.ocrNote('id-0001');
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].reason).toMatch(/限流/);
    expect(svc.mediaTextFor('id-0001')).toEqual([]);
    expect(svc.mediaTextEntryCount).toBe(0);
  });

  it('识别错了可以重来（删除后重新识别会再调一次模型）', async () => {
    const fx = createFixture();
    const svc = await boot(fx, 1);
    const { calls } = stubVision({ text: '第一次的结果' });
    await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(1);

    expect(await svc.clearMediaText('id-0001', 'image-1.webp')).toBe(true);
    expect(svc.mediaTextFor('id-0001')).toEqual([]);
    expect(await svc.clearMediaText('id-0001', 'image-1.webp')).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '第二次的结果' } }] }), { status: 200 })
    ));
    const out = await svc.ocrNote('id-0001');
    expect(out.results[0]).toMatchObject({ ok: true, cached: false, text: '第二次的结果' });
  });
});

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

// ---------- HTTP ----------

describe('HTTP：识别文本路由', () => {
  let fx: Fixture;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    fx = createFixture('myinfobase-ocr-http');
    fx.writeNote({ id: 'id-0001', title: '笔记一', images: 1 });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);

    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET 还没识别时返回空数组；POST 识别后可读回；DELETE 可清掉', async () => {
    const empty = await (await fetch(`${base}/api/notes/id-0001/media-text`)).json() as any;
    expect(empty.items).toEqual([]);

    stubVision({ text: '接口识别出来的字' });
    const post = await fetch(`${base}/api/notes/id-0001/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(post.status).toBe(200);
    const out = await post.json() as any;
    expect(out.results[0]).toMatchObject({ ok: true, cached: false });
    expect(out.recognized).toHaveLength(1);

    const after = await (await fetch(`${base}/api/notes/id-0001/media-text`)).json() as any;
    expect(after.items[0]).toMatchObject({ kind: 'ocr', text: '接口识别出来的字', mediaId: 'image-1.webp' });

    const del = await fetch(`${base}/api/notes/id-0001/media-text/image-1.webp`, { method: 'DELETE' });
    expect((await del.json() as any).removed).toBe(true);
    expect((await (await fetch(`${base}/api/notes/id-0001/media-text`)).json() as any).items).toEqual([]);
  });

  it('未知笔记 404、指定不存在的媒体 400、请求体不是对象 400', async () => {
    expect((await fetch(`${base}/api/notes/nope/media-text`)).status).toBe(404);
    expect(
      (
        await fetch(`${base}/api/notes/nope/ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(404);
    const bad = await fetch(`${base}/api/notes/id-0001/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: 'image-9.webp' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error.code).toBe('INVALID_OCR_TARGET');
  });
});

// ---------- 第四轮深审：单飞 / 取消 / 体积防护 ----------

describe('ocrNote：并发只调一次、取消不再发、体积先过闸', () => {
  beforeEach(() => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    vi.stubEnv('AI_VISION_MODEL', 'vision-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function boot(fx: Fixture, images: number): Promise<LibraryService> {
    fx.writeNote({ id: 'id-0001', title: '笔记一', images });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    return svc;
  }

  it('同一张图的并发识别只调一次模型（第二个请求共享在途调用，不各花一次钱）', async () => {
    const fx = createFixture('ocr-flight-');
    const svc = await boot(fx, 1);
    const { calls } = stubVision({ text: '并发共享的字' });
    const [a, b] = await Promise.all([svc.ocrNote('id-0001'), svc.ocrNote('id-0001')]);
    expect(calls).toHaveLength(1);
    expect(a.results.every((r) => r.ok)).toBe(true);
    expect(b.results.every((r) => r.ok)).toBe(true);
    expect(svc.mediaTextFor('id-0001')).toHaveLength(1);
  });

  it('shouldStop 为真后不再发下一次请求（关窗/断开后不再烧钱），remaining 是没跑的张数', async () => {
    const fx = createFixture('ocr-stop-');
    const svc = await boot(fx, 3);
    const { calls } = stubVision({ text: '字' });
    const out = await svc.ocrNote('id-0001', { shouldStop: () => calls.length >= 1 });
    expect(calls).toHaveLength(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.remaining).toBe(2);
  });

  it('超大图与空文件给出理由且一次模型都不调（先 stat 后读盘，不再无上限整读）', async () => {
    const fx = createFixture('ocr-size-');
    // 先正常建库（写两份小图），再把文件换成坏的——ocrNote 读的是当前盘上的字节
    const svc = await boot(fx, 2);
    fs.writeFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'image-1.webp'), Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    fs.writeFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'image-2.webp'), '');
    const { calls } = stubVision({ text: '不该被调用' });
    const out = await svc.ocrNote('id-0001');
    expect(calls).toHaveLength(0);
    expect(out.results).toHaveLength(2);
    const reasons = out.results.map((r) => r.reason ?? '');
    expect(reasons.some((s) => s.includes('图片过大'))).toBe(true);
    expect(reasons.some((s) => s.includes('空'))).toBe(true);
    expect(out.remaining).toBe(2);
  });
});
