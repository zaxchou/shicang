// 图片 OCR：调 OpenAI 兼容的 Chat Completions，把图片以 data URI 塞进 image_url。
//
// 形态来自 `scripts/probe-ai.mjs` 的实测（不是照 OpenAI 文档抄的）：
//   · 走 POST {base}/chat/completions + image_url(data URI)，**直接接受 webp**，
//     所以本地 2062 张图不需要解码器、镜像不用变重；
//   · MiMo 系推理模型必须 `thinking:{type:'disabled'}`，否则 max_tokens 被思考过程吃光；
//   · 请求体几 MB 没问题（实测 9 分钟音频 base64 5.57 MB 通过），图片最大 base64 约 1.7 MB。
//
// 与 ai-classify.ts 的差别：那个是后台兜底，失败静默返回 null；这里是**用户点的按需操作**，
// 失败必须能说清原因（配额/超时/格式不支持），所以返回带 reason 的结果而不是 null。
import type { RecognizedKind } from '../../shared/types.js';

export interface AiVisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * 一次「识别这篇的图片」最多识别几张。与 AI_CLASSIFY_MAX_PER_REFRESH 同一纪律：
   * 一篇笔记可能有 13 张图（库里真实存在），没有上限时一次点击会连打十几次接口、烧掉额度还让人干等。
   */
  maxPerNote: number;
}

export function aiVisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiVisionConfig | null {
  const apiKey = (env.AI_CLASSIFY_API_KEY ?? env.MIMO_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.AI_CLASSIFY_BASE_URL ?? env.MIMO_API_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    // 没有独立的视觉模型 id，通用 flash 模型实测就能读图（见 plan §18.2）
    model: (env.AI_VISION_MODEL ?? env.AI_CLASSIFY_MODEL ?? 'mimo-v2.6-flash').trim(),
    timeoutMs: positiveInt(env.AI_OCR_TIMEOUT_MS, 120000, 1000),
    maxPerNote: positiveInt(env.AI_OCR_MAX_PER_NOTE, 8, 1),
  };
}

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** 视觉模型能吃进去的图片类型（按文件头判定，不看扩展名）。HEIC/AVIF/SVG 先不接受 */
export const OCR_IMAGE_MIMES = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp']);

const OCR_PROMPT = `把这张图片里的文字**原样**转录出来，不要翻译、不要总结、不要解释、不要加任何前言后语。
要求：
- 保留原有的换行与分段；
- 表格用 Markdown 表格表示；**单元格内的换行用空格或分号，不要用 HTML 标签**；
- **不要输出任何 HTML 标签**（不要 <br>、<p>、<span> 之类）；
- 图片里没有文字时，只输出：无文字
- 字迹不清或无法辨认的字用 ？ 代替，不要猜。`;

/**
 * 归一化模型返回的正文。**实测模型会用 `<br>` 表示换行**（提示词里说了也不 guarantee），
 * 而我们是按纯文本展示、搜索、导出的——留着标签就是一堆字面量 `<br>` 混进检索结果。
 * 只处理"像标签"的结构（`<` 后面必须跟字母或 `/`，所以正文里的 `a < b` 不受影响），
 * 顺手把常见实体还原成字符。
 */
export function normalizeOcrText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\/?(li|td|th|tr)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type OcrResult =
  | { ok: true; text: string; model: string; usage: OcrUsage }
  | { ok: false; reason: string; status: number | null };

export interface OcrUsage {
  promptTokens?: number;
  completionTokens?: number;
  imageTokens?: number;
}

export async function ocrImage(
  cfg: AiVisionConfig,
  input: { bytes: Buffer; mime: string },
  fetchImpl: typeof fetch = fetch
): Promise<OcrResult> {
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:${input.mime};base64,${input.bytes.toString('base64')}` },
          },
        ],
      },
    ],
    // 一页密密麻麻的字帖/表格可能要上千字，留足空间；思考已关掉，不会被推理吃掉
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
      return { ok: false, reason: describeHttpFailure(res.status, raw), status: res.status };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: '模型返回的不是 JSON（网关行为可能变了，先跑 npm run probe:ai）', status: res.status };
    }
    const j = parsed as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { image_tokens?: number } };
    };
    const content = j.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? normalizeOcrText(content) : '';
    if (!text) return { ok: false, reason: '模型没有返回文字', status: res.status };
    const usage: OcrUsage = {};
    if (typeof j.usage?.prompt_tokens === 'number') usage.promptTokens = j.usage.prompt_tokens;
    if (typeof j.usage?.completion_tokens === 'number') usage.completionTokens = j.usage.completion_tokens;
    if (typeof j.usage?.prompt_tokens_details?.image_tokens === 'number') {
      usage.imageTokens = j.usage.prompt_tokens_details.image_tokens;
    }
    // 「无文字」是有效结论而不是失败：库里大量纯图（画作、器物照片）本来就一个字都没有
    return { ok: true, text, model: cfg.model, usage };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      return { ok: false, reason: `识别超时（超过 ${Math.round(cfg.timeoutMs / 1000)} 秒）`, status: null };
    }
    return { ok: false, reason: `请求失败：${err.message}`, status: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 把网关的错误翻译成人能看懂的一句（保持原文片段，便于排查） */
function describeHttpFailure(status: number, raw: string): string {
  let detail = raw.slice(0, 200);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } };
    if (j.error?.message) detail = j.error.message;
  } catch {
    /* 保留原文片段 */
  }
  if (status === 401 || status === 403) return `AI 凭据被拒（HTTP ${status}）：${detail}`;
  if (status === 429) return `调用被限流（HTTP 429）：${detail}`;
  if (status === 413) return `图片太大被网关拒绝（HTTP 413）：${detail}`;
  return `AI 接口返回 HTTP ${status}：${detail}`;
}

/** 「无文字」的判定：模型按提示词原样回这三个字时，界面不必把它当成一段内容 */
export function isNoTextResult(text: string): boolean {
  return /^无文字[。.]?$/.test(text.trim());
}

/** 未实现的能力（转录）也要给一致的返回形状，免得调用方写两套 */
export const KIND_LABEL: Record<RecognizedKind, string> = { ocr: '图片文字', asr: '语音转录' };
