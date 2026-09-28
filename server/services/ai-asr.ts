// 语音转录（ASR）：把库里的本地音频转成可检索文字（plan §18.2 的下半）。
//
// 形态来自 `scripts/probe-ai.mjs` 的实测（2026-09-28，不是照文档抄的）：
//   · 走 POST {base}/chat/completions，messages[0].content 只有 **一个 input_audio part**——
//     带 text part 会被网关直接拒绝；
//   · `input_audio.format` **只收 wav / mp3**（喂 m4a 得 400「must be one of: wav, mp3」），
//     而源库里的语音全是 m4a → 先用 ffmpeg 转码成 mp3（Dockerfile 已 apk add，本机开发需自装）；
//   · model = mimo-v2.5-asr；MiMo 系推理模型同样必须 thinking:{type:'disabled'}；
//   · 计费按**音频秒数**（usage.seconds），所以按需触发 + 单篇上限，绝不进刷新管道。
//
// 与 ai-vision.ts 的差别：那是用户点的"图片识别"，这是用户点的"语音转录"——
// 同样失败必须说清原因（凭据/超时/没装 ffmpeg/转码失败），返回带 reason 的结果而不是 null。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeOcrText } from './ai-vision.js';

export interface AsrConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 单段超时。最长的实测语音近 10 分钟，转录通常几十秒——给 300s 默认 */
  timeoutMs: number;
  /** 一篇最多转录几段（与 OCR 的 maxPerNote 同一纪律；按秒计费，上限必须存在） */
  maxPerNote: number;
}

export function aiAsrConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AsrConfig | null {
  // || 而不是 ??：空串视为"没配"（compose 白名单会把未设置的变量透传成空串）
  const apiKey = (env.AI_CLASSIFY_API_KEY || env.MIMO_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.AI_CLASSIFY_BASE_URL || env.MIMO_API_BASE || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    model: (env.AI_ASR_MODEL || 'mimo-v2.5-asr').trim(),
    timeoutMs: positiveInt(env.AI_ASR_TIMEOUT_MS, 300000, 1000),
    maxPerNote: positiveInt(env.AI_ASR_MAX_PER_NOTE, 4, 1),
  };
}

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  // 上限钳 2^31-1：setTimeout 超过它会溢出成 1ms，所有请求"秒超时"且日志看不出是配置错了
  return Math.min(Math.floor(n), 2_147_483_647);
}

/** 网关只收这两种格式；其余（m4a/ogg/aac…）都要先转码 */
export type AudioFormat = 'wav' | 'mp3';

/** 单段音频的读盘上限：先 stat 再读，超限直接给理由（实测最长 9 分钟 m4a 仅 ~1.4MB） */
export const MAX_ASR_AUDIO_BYTES = 50 * 1024 * 1024;

/** 按文件头判定 wav / mp3。识别不出返回 null（调用方走转码） */
export function sniffAudioFormat(bytes: Buffer): AudioFormat | null {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  // MPEG 帧同步：11 个 1
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** ffmpeg 探测结果缓存（一个进程只探一次） */
let ffmpegProbe: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  ffmpegProbe ??= new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.once('error', () => resolve(false));
    p.once('exit', (code) => resolve(code === 0));
  });
  return ffmpegProbe;
}

const TRANSCODE_TIMEOUT_MS = 60_000;

/**
 * 非 wav/mp3 → mp3（64kbps 单声道 16kHz：语音足够，体积小、上传快）。
 * 任何失败返回 null（调用方给 reason）；临时文件无论如何都会删掉。
 */
export async function transcodeToMp3(absPath: string): Promise<Buffer | null> {
  if (!(await ffmpegAvailable())) return null;
  const tmp = path.join(os.tmpdir(), `asr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(
        'ffmpeg',
        ['-nostdin', '-y', '-i', absPath, '-vn', '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '16000', tmp],
        { stdio: 'ignore' }
      );
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        done(false);
      }, TRANSCODE_TIMEOUT_MS);
      p.once('error', () => {
        clearTimeout(timer);
        done(false);
      });
      p.once('exit', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    });
    if (!ok) return null;
    const out = await fs.promises.readFile(tmp);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export type AsrResult =
  | { ok: true; text: string; model: string; usage: AsrUsage }
  | { ok: false; reason: string; status: number | null };

export interface AsrUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** 计费口径：这段音频的秒数（网关在 usage.seconds 里回报） */
  audioSeconds?: number;
}

/** 转录一段音频。bytes 必须已是 wav/mp3（调用方先 sniff / 转码）。 */
export async function transcribeAudio(
  cfg: AsrConfig,
  input: { bytes: Buffer; format: AudioFormat },
  fetchImpl: typeof fetch = fetch
): Promise<AsrResult> {
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        // audio-only：实测带 text part 会被网关拒（probe-ai.mjs 4b 同款）
        content: [{ type: 'input_audio', input_audio: { data: input.bytes.toString('base64'), format: input.format } }],
      },
    ],
    max_tokens: 4000,
    temperature: 0,
    thinking: { type: 'disabled' },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, reason: describeAsrHttpFailure(res.status, raw), status: res.status };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: '模型返回的不是 JSON（网关行为可能变了，先跑 npm run probe:ai）', status: res.status };
    }
    const j = parsed as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; seconds?: number };
    };
    const content = j.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? normalizeOcrText(content) : '';
    // 空转录当失败而不是资产：media-text 不存空白正文，界面要能看见"没识别到字"（静音/纯噪音）
    if (!text) return { ok: false, reason: '模型没有返回文字（静音或无法识别？）', status: res.status };
    const usage: AsrUsage = {};
    if (typeof j.usage?.prompt_tokens === 'number') usage.promptTokens = j.usage.prompt_tokens;
    if (typeof j.usage?.completion_tokens === 'number') usage.completionTokens = j.usage.completion_tokens;
    if (typeof j.usage?.seconds === 'number') usage.audioSeconds = j.usage.seconds;
    return { ok: true, text, model: cfg.model, usage };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      return { ok: false, reason: `转录超时（超过 ${Math.round(cfg.timeoutMs / 1000)} 秒）`, status: null };
    }
    return { ok: false, reason: `请求失败：${err.message}`, status: null };
  } finally {
    clearTimeout(timer);
  }
}

function describeAsrHttpFailure(status: number, raw: string): string {
  let detail = raw.slice(0, 200);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } };
    if (j.error?.message) detail = j.error.message;
  } catch {
    /* 保留原文片段 */
  }
  if (status === 401 || status === 403) return `AI 凭据被拒（HTTP ${status}）：${detail}`;
  if (status === 429) return `调用被限流（HTTP ${status}）：${detail}`;
  if (status === 413) return `音频太大被网关拒绝（HTTP 413）：${detail}`;
  if (status === 400 && /must be one of/i.test(detail)) {
    return `网关拒绝了音频格式（HTTP 400）：${detail}——本应转码后才发送，请跑 npm run probe:ai 核对`;
  }
  return `AI 接口返回 HTTP ${status}：${detail}`;
}
