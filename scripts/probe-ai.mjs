// AI 通道能力探测：确认「视觉（OCR）」与「语音识别（ASR）」在当前供应商的可用形态。
//
// 为什么要有这个脚本：plan.md §18.2 里的几条结论是**实测**出来的，不是照 OpenAI 文档抄的——
//   · 视觉走 POST /chat/completions + image_url（data URI），且直接接受 webp；
//   · ASR 走 POST /chat/completions + model=mimo-v2.5-asr + input_audio，
//     且 **content 里不能带文字部分**（网关会自己注入提示词）；
//   · ASR 的 input_audio.format **只收 wav / mp3**（2026-09-28 实测）——喂 m4a/mp4 会被
//     参数校验直接拒（"must be one of: wav, mp3"）；网关自己的解码器其实认 m4a/flac/ogg，
//     但参数层更严，且它按**内容真实格式**解码（m4a 字节冒充 wav 会返回 400）。
//     后果：库里 110 个语音备忘全是 m4a，**每次转录都必须先转码**（本机 ffmpeg 9.0.2 可做）；
//   · /v1/audio/transcriptions 在这个网关上是 404。
// 换供应商、换模型、或怀疑接口行为变了时，先跑这个脚本，别按习惯猜。
//
// 默认全部使用**脚本自己合成的素材**（1 秒正弦音 + 纯代码画的字母 L），
// 不上传任何用户内容、成本可忽略。要验证真实图片时显式传 --image <路径>，
// 那一步会把该文件提供给供应商——这是产品将来的正常行为，但由你显式触发。
// 库里全是 webp，想确认 webp 被接受就传一张：
//   node scripts/probe-ai.mjs --image "Z:/.../mynote/mynote/RedNote/Media/<id>/image-1.webp"
//
// 用法：
//   node scripts/probe-ai.mjs
//   node scripts/probe-ai.mjs --image <本地图片>
//
// 配置来源：环境变量优先，其次项目内 gitignored 的 deploy/production/.env。
// 密钥只用于请求头，**不打印**。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(SCRIPT_DIR);
const ENV_FILE = path.join(PROJECT_ROOT, 'deploy', 'production', '.env');

/** 从 .env 文本里取证；只取需要的键，值不进日志 */
function readEnvFile() {
  try {
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i <= 0 || line.trimStart().startsWith('#')) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = readEnvFile();
const get = (key, fallback = '') => (process.env[key] ?? fileEnv[key] ?? fallback).trim();

const API_KEY = get('AI_CLASSIFY_API_KEY');
const BASE_URL = get('AI_CLASSIFY_BASE_URL', 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
const VISION_MODEL = get('AI_VISION_MODEL') || get('AI_CLASSIFY_MODEL', 'mimo-v2.6-flash');
const ASR_MODEL = get('AI_ASR_MODEL', 'mimo-v2.5-asr');
const TIMEOUT_MS = 60000;

if (!API_KEY) {
  console.error('未找到 AI_CLASSIFY_API_KEY（环境变量或 deploy/production/.env）。');
  process.exit(2);
}

const results = [];
// ok 三态：true 通过 / false 失败 / null **跳过（没真跑）**。
// 跳过的项必须与通过区分开——否则"本机没有 ffmpeg"也会显示成一项 ✓，
// 让人以为 mp3 通路验证过了（深审发现）。
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok === true ? '✓' : ok === null ? '–' : '✗'} ${name}：${detail}`);
}

async function callChat(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function oneLine(s, n = 300) {
  return String(s).replace(/\s+/g, ' ').slice(0, n);
}

// ---------- 合成素材（不读任何用户文件） ----------

/** 1 秒 440Hz 正弦 WAV：只为验证「这个请求形态被接受」，内容是噪音，转出空结果属正常 */
function synthWav(rate = 16000) {
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 纯矩形画一个白色底 + 黑色大写 L 的 PNG：不依赖字体，用于验证模型能否"读出图里的字" */
function synthPngLetterL(size = 96) {
  const raw = Buffer.alloc(size * (1 + size * 3)); // 每行前缀一个 filter 字节
  const inside = (x, y) =>
    (x >= 20 && x < 34 && y >= 16 && y < 80) || // 竖
    (x >= 20 && x < 78 && y >= 66 && y < 80); // 横
  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 3) + 1;
    for (let x = 0; x < size; x++) {
      const v = inside(x, y) ? 0 : 255;
      const o = rowOff + x * 3;
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
    }
  }
  const pngChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0;
    if (typeof zlib.crc32 === 'function') crc = zlib.crc32(body);
    else {
      let c = ~0;
      for (const b of body) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      crc = ~c >>> 0;
    }
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  const known = {
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
  };
  return known[ext] ?? null;
}

// ---------- 探测项 ----------

console.log(`供应商 ${BASE_URL}`);
console.log(`视觉模型 ${VISION_MODEL}｜ASR 模型 ${ASR_MODEL}`);
console.log('');

// 1) 模型清单（判定"有没有 ASR/视觉专用模型"最省事的办法）
try {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let ids = [];
  try {
    ids = (JSON.parse(text).data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    /* 非 JSON，按失败处理 */
  }
  record(
    'GET /models',
    res.status === 200 && ids.length > 0,
    res.status === 200 && ids.length > 0 ? `${ids.length} 个：${ids.join(', ')}` : `HTTP ${res.status} ${oneLine(text, 120)}`
  );
} catch (e) {
  record('GET /models', false, `请求失败 ${e.message}`);
}

// 2) 视觉：合成 PNG（纯代码画的 L），验证 image_url + data URI 这条路
try {
  const png = synthPngLetterL();
  const { status, text } = await callChat({
    model: VISION_MODEL,
    max_tokens: 40,
    temperature: 0,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '图里的大写字母是什么？只输出该字母。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      },
    ],
  });
  let content = '';
  let imageTokens;
  try {
    const j = JSON.parse(text);
    content = j.choices?.[0]?.message?.content ?? '';
    imageTokens = j.usage?.prompt_tokens_details?.image_tokens;
  } catch {
    /* 下面按失败输出原文 */
  }
  // 通道是否通看 HTTP；识得对不对看回答内容（图里就该是大写 L）
  const ok = status === 200 && /L/i.test(content);
  record(
    '视觉 /chat/completions + image_url（合成 PNG，图中为大写 L）',
    ok,
    status === 200
      ? `HTTP 200，模型回答「${oneLine(content, 40)}」（应为 L），image_tokens=${imageTokens ?? '未返回'}`
      : `HTTP ${status} ${oneLine(text, 200)}`
  );
} catch (e) {
  record('视觉 /chat/completions + image_url', false, `请求失败 ${e.message}`);
}

// 3) 视觉：真实图片（仅 --image 时执行；这一步会把该文件提供给供应商）
const imageArgIdx = process.argv.indexOf('--image');
if (imageArgIdx !== -1) {
  const file = process.argv[imageArgIdx + 1];
  const mime = file ? mimeOf(file) : null;
  if (!file || !fs.existsSync(file)) {
    record('视觉 + 本地图片', false, `找不到文件：${file ?? '(未提供路径)'}`);
  } else if (!mime) {
    record('视觉 + 本地图片', false, `不认识的图片扩展名：${path.extname(file)}`);
  } else {
    try {
      const buf = fs.readFileSync(file);
      console.log(`  （本次会把 ${path.basename(file)}（${buf.length} 字节，${mime}）提供给供应商）`);
      const { status, text } = await callChat({
        model: VISION_MODEL,
        max_tokens: 200,
        temperature: 0,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '把这张图里的文字逐行转写出来，不要解释。' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
            ],
          },
        ],
      });
      let content = '';
      let imageTokens;
      try {
        const j = JSON.parse(text);
        content = j.choices?.[0]?.message?.content ?? '';
        imageTokens = j.usage?.prompt_tokens_details?.image_tokens;
      } catch {
        /* 按失败输出原文 */
      }
      // 判定只看"这个格式被不被接受"；转写内容对不对由人看（图里可能本来就没字）
      record(
        `视觉 + 本地 ${mime}`,
        status === 200,
        status === 200
          ? `HTTP 200（格式被接受），转写「${oneLine(content, 120) || '（空）'}」，image_tokens=${imageTokens ?? '未返回'}`
          : `HTTP ${status} ${oneLine(text, 200)}`
      );
    } catch (e) {
      record('视觉 + 本地图片', false, `请求失败 ${e.message}`);
    }
  }
}

// 4) ASR：audio-only 的 input_audio。**不能带 text part**（带上会被网关拒绝）
try {
  const wav = synthWav();
  const { status, text } = await callChat({
    model: ASR_MODEL,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }],
      },
    ],
  });
  let content = '';
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  } catch {
    /* 按失败输出原文 */
  }
  record(
    `ASR /chat/completions + input_audio（${ASR_MODEL}，合成 1 秒正弦音）`,
    status === 200,
    // 正弦音没有语义，转出"嗯"之类的填充词或空串都算通道正常
    status === 200 ? `HTTP 200（返回「${oneLine(content, 60)}」；合成音无语义，结果无意义属正常）` : `HTTP ${status} ${oneLine(text, 200)}`
  );
} catch (e) {
  record('ASR /chat/completions + input_audio', false, `请求失败 ${e.message}`);
}

// 4b) ASR 的 format 约束：参数层只放行 wav / mp3。
// 这里故意用合成 wav 的字节配 format='m4a'——参数校验在解码之前，所以它一定会先报
// "must be one of: wav, mp3"，正好把约束记录下来（成功条件是**拿到这个 400**，不是 200）。
try {
  const { status, text } = await callChat({
    model: ASR_MODEL,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: synthWav().toString('base64'), format: 'm4a' } }],
      },
    ],
  });
  const constrained = status === 400 && /must be one of:\s*wav,\s*mp3/i.test(text);
  record(
    'ASR format 约束（format=m4a 应被拒）',
    constrained,
    constrained
      ? 'HTTP 400「input_audio.format must be one of: wav, mp3」——源库全是 m4a，故转录前必须转码'
      : `预期 400 + 参数报错，实际 HTTP ${status} ${oneLine(text, 200)}`
  );
} catch (e) {
  record('ASR format 约束', false, `请求失败 ${e.message}`);
}

// 4c) mp3 通路：有 ffmpeg 才测（脚本要在无 ffmpeg 的机器上也能跑）。
// 为什么专门测 mp3 而不是 wav：库里的语音最长 9 分钟，wav 未压缩（16k 单声道约 32 KB/s
// → 9 分钟约 17 MB），mp3 64 kbps 只有 4.2 MB。转码的目标格式就是 mp3。
try {
  let ffmpegOk = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    ffmpegOk = false;
  }
  if (!ffmpegOk) {
    record('ASR format=mp3（ffmpeg 转码通路）', null, '跳过：本机没有 ffmpeg，无法合成 mp3（生产镜像需要它才能转码 m4a）');
  } else {
    const tmp = path.join(os.tmpdir(), `probe-ai-tone-${process.pid}.mp3`);
    try {
      execFileSync(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ar', '16000', '-ac', '1',
         '-c:a', 'libmp3lame', '-b:a', '64k', tmp],
        { stdio: 'ignore' }
      );
      const bytes = fs.readFileSync(tmp);
      const { status, text } = await callChat({
        model: ASR_MODEL,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: bytes.toString('base64'), format: 'mp3' } }],
          },
        ],
      });
      record(
        `ASR format=mp3（${(bytes.length / 1024).toFixed(1)} KB 合成 mp3）`,
        status === 200,
        status === 200 ? 'HTTP 200（mp3 通路可用，9 分钟语音约 4.2 MB）' : `HTTP ${status} ${oneLine(text, 200)}`
      );
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
} catch (e) {
  record('ASR format=mp3', false, `请求失败 ${e.message}`);
}

// 5) 反例：OpenAI 习惯的 /audio/transcriptions 在这家网关上是 404 —— 记录形态，避免下次误判
try {
  const form = new FormData();
  form.append('file', new Blob([synthWav()], { type: 'audio/wav' }), 'tone.wav');
  form.append('model', ASR_MODEL);
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 这是"对照项"没错，但不是"无论如何都算过"：它必须真是 404。
  // 哪天网关加上了这条路由，这里就该有人知道（那时可以改用标准形态）。
  const asExpected = res.status === 404;
  record(
    'POST /audio/transcriptions（对照：本网关应为 404）',
    asExpected,
    `HTTP ${res.status}${asExpected ? '（该网关无此路由，ASR 请用上面的 input_audio 形态）' : '（与预期不符：网关可能新增了这条路由，值得改用标准形态）'}`
  );
} catch (e) {
  record('POST /audio/transcriptions（对照）', false, `请求失败 ${e.message}`);
}

// ---------- 汇总 ----------

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null);
const passed = results.filter((r) => r.ok === true).length;
console.log('');
console.log(
  `共 ${results.length} 项：通过 ${passed}，跳过 ${skipped.length}${skipped.length ? '（' + skipped.map((s) => s.name).join('、') + '）' : ''}，失败 ${failed.length}${failed.length ? '：' + failed.map((f) => f.name).join('、') : ''}`
);
process.exit(failed.length === 0 ? 0 : 1);
