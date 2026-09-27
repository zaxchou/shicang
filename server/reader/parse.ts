// 单篇笔记解析：frontmatter + Markdown → NoteRecord。
// 只读输入文件；所有结构化结果（标题、摘要、媒体、正文 HTML）在此生成。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { MediaItem } from '../../shared/types.js';
import { imageSize } from './webp-size.js';

export interface NoteRecord {
  id: string;
  sourceRelativePath: string;
  sourceMtimeMs: number;
  sourceSize: number;
  sourceHash: string | null;
  title: string;
  author: string;
  tags: string[];
  excerpt: string;
  searchText: string;
  publishedAt: string | null;
  syncedAt: string | null;
  originalUrl: string;
  bodyHtml: string;
  media: MediaItem[];
  coverMediaId: string | null;
  sourceStatus: 'available' | 'missing';
  warnings: string[];
}

export interface ParseInput {
  absolutePath: string;
  relativePath: string; // 相对 Bookmarks 目录
  sourceRoot: string; // RedNote 目录
  mtimeMs: number;
  size: number;
}

export interface ParseOutcome {
  record: NoteRecord | null;
  warnings: string[];
  error: string | null;
}

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

marked.setOptions({ gfm: true, breaks: true });

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags.filter((t) => t !== 'img'),
    'img',
    'video',
    'source',
    'del',
    'ins',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'loading', 'width', 'height'],
    video: ['src', 'controls', 'poster', 'preload', 'width', 'height'],
    source: ['src', 'type'],
    td: ['align'],
    th: ['align'],
  },
  allowedSchemes: ['http', 'https'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
    }),
    // 详情正文图片懒加载（列表页已在组件层懒加载）
    img: (tagName, attribs) => ({
      tagName: 'img',
      attribs: { ...attribs, loading: 'lazy', decoding: 'async' },
    }),
  },
  disallowedTagsMode: 'discard',
};

export function parseNote(input: ParseInput): ParseOutcome {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(input.absolutePath, 'utf8');
  } catch (e) {
    return { record: null, warnings, error: `无法读取文件: ${(e as Error).message}` };
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    return { record: null, warnings, error: `frontmatter 解析失败: ${(e as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const id = typeof fm['resourceId'] === 'string' ? (fm['resourceId'] as string).trim() : '';
  if (!id) {
    return { record: null, warnings, error: '缺少 resourceId，跳过（不采用文件名充当 ID）' };
  }

  const bodyRaw = parsed.content;
  const { title, bodyWithoutH1 } = extractTitle(bodyRaw, input.relativePath, id, warnings);

  // 媒体收集 + 预处理 Markdown
  const media: MediaItem[] = [];
  const mediaIds = new Set<string>();
  let body = bodyWithoutH1.replace(/!\[\[([^\]\n]+)\]\]/g, (_all, targetRaw: string) => {
    const item = resolveEmbed(String(targetRaw).trim(), input, id, media, mediaIds, warnings);
    if (!item) return '';
    return `![媒体](media://${item.id})`;
  });

  // <video> 标签收集（保留在 HTML 中由消毒器放行）
  const videoUrls = new Set<string>();
  body = body.replace(/<video\b[^>]*>/gi, (tag) => {
    const m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const src = (m?.[2] ?? m?.[3] ?? '').trim();
    if (!/^https?:\/\//i.test(src)) {
      if (src) warnings.push(`忽略非 http(s) 视频 src`);
      return '';
    }
    videoUrls.add(src);
    if (media.length < 50) {
      const vid: MediaItem = { id: `video-${media.length + 1}`, kind: 'video', remoteUrl: src };
      if (!media.some((x) => x.kind === 'video' && x.remoteUrl === src)) media.push(vid);
    }
    return tag;
  });

  let bodyHtml: string;
  try {
    bodyHtml = marked.parse(body, { async: false }) as string;
  } catch (e) {
    warnings.push(`Markdown 渲染失败: ${(e as Error).message}`);
    bodyHtml = '';
  }

  // media:// → 实际媒体 API 路径；给视频补 poster 与 controls
  const cover = media.find((m) => m.kind === 'image' && m.available !== false && m.localRelativePath);
  const posterUrl = cover ? `/api/media/${encodeURIComponent(id)}/${encodeURIComponent(cover.id)}` : '';
  bodyHtml = bodyHtml
    .replace(/media:\/\/([^"\s<>]+)/g, (_a, mid: string) => {
      if (!mediaIds.has(mid)) return '';
      return `/api/media/${encodeURIComponent(id)}/${encodeURIComponent(mid)}`;
    })
    .replace(/<video\b([^>]*)>/gi, (tag, attrs: string) => {
      let out = tag;
      if (!/\scontrols(\s|=|>)/i.test(attrs)) out = `<video controls${attrs}>`;
      if (posterUrl && !/\sposter(\s|=|>)/i.test(attrs)) {
        out = out.replace(/^<video/i, `<video poster="${posterUrl}"`);
      }
      if (!/\spreload(\s|=|>)/i.test(attrs)) {
        out = out.replace(/^<video/i, `<video preload="metadata"`);
      }
      return out;
    });
  bodyHtml = sanitizeHtml(bodyHtml, SANITIZE_OPTIONS);

  const tags = normalizeTags(fm['tags']);
  const author = typeof fm['author'] === 'string' && fm['author'].trim() ? fm['author'].trim() : '未知作者';
  const originalUrl = typeof fm['url'] === 'string' ? (fm['url'] as string) : '';

  const publishedAt = normalizeIso(fm['postCreatedAt']);
  const syncedAt = normalizeIso(fm['syncedAt']);
  if (fm['postCreatedAt'] !== undefined && publishedAt === null) {
    warnings.push('postCreatedAt 无法解析为日期');
  }

  const excerpt = buildExcerpt(bodyWithoutH1);
  const searchText = buildSearchText([title, excerpt, bodyWithoutH1, author, tags.join(' ')]);

  let hash: string | null = null;
  try {
    hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  } catch {
    /* hash 仅用于诊断 */
  }

  const record: NoteRecord = {
    id,
    sourceRelativePath: input.relativePath,
    sourceMtimeMs: input.mtimeMs,
    sourceSize: input.size,
    sourceHash: hash,
    title: title || '(无标题)',
    author,
    tags,
    excerpt,
    searchText,
    publishedAt,
    syncedAt,
    originalUrl,
    bodyHtml,
    media,
    coverMediaId: cover ? cover.id : null,
    sourceStatus: 'available',
    warnings,
  };
  return { record, warnings, error: null };
}

function extractTitle(
  body: string,
  relativePath: string,
  id: string,
  warnings: string[]
): { title: string; bodyWithoutH1: string } {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  if (m && m[1]) {
    const title = m[1].trim();
    const bodyWithoutH1 = body.replace(m[0], '');
    return { title, bodyWithoutH1 };
  }
  warnings.push('正文未找到 H1，标题回退为文件名');
  const base = path.basename(relativePath).replace(/\.md$/i, '');
  const cleaned = base.endsWith(`-${id}`) ? base.slice(0, base.length - id.length - 1) : base;
  return { title: cleaned, bodyWithoutH1: body };
}

function resolveEmbed(
  target: string,
  input: ParseInput,
  noteId: string,
  media: MediaItem[],
  mediaIds: Set<string>,
  warnings: string[]
): MediaItem | null {
  if (/^https?:\/\//i.test(target)) {
    warnings.push(`不支持远程嵌入: ${target.slice(0, 60)}`);
    return null;
  }
  const sourceBase = path.basename(input.sourceRoot);
  const norm = target.replace(/\\/g, '/').replace(/^\.?\//, '');
  const candidates = [norm];
  if (norm.startsWith(`${sourceBase}/`)) candidates.push(norm.slice(sourceBase.length + 1));
  const decoded = safeDecode(norm);
  if (decoded !== norm) {
    candidates.push(decoded);
    if (decoded.startsWith(`${sourceBase}/`)) candidates.push(decoded.slice(sourceBase.length + 1));
  }

  let abs: string | null = null;
  let rel: string | null = null;
  for (const c of candidates) {
    const joined = path.resolve(input.sourceRoot, c);
    if (insideRoot(joined, input.sourceRoot) && fs.existsSync(joined)) {
      abs = joined;
      rel = normalizeRel(joined, input.sourceRoot);
      break;
    }
  }
  if (!abs || !rel) {
    warnings.push(`嵌入媒体缺失或不支持: ${norm.slice(0, 80)}`);
    // 路径在源内但文件不存在：仍登记为不可用，详情可提示"图片缺失"
    const primary = candidates[0] ?? '';
    if (insideRoot(path.resolve(input.sourceRoot, primary), input.sourceRoot)) {
      const relGuess = normalizeRel(path.resolve(input.sourceRoot, primary), input.sourceRoot);
      const ext = path.extname(relGuess).toLowerCase();
      const kind = VIDEO_EXTS.has(ext) ? 'video' : IMAGE_EXTS.has(ext) ? 'image' : null;
      if (kind && !relGuess.startsWith('..')) {
        let mid = path.basename(relGuess);
        let n2 = 2;
        while (mediaIds.has(mid)) mid = `${path.basename(relGuess)}#${n2++}`;
        mediaIds.add(mid);
        const item: MediaItem = { id: mid, kind, localRelativePath: relGuess, available: false };
        media.push(item);
        return item;
      }
    }
    return null;
  }

  const base = path.basename(rel);
  const ext = path.extname(base).toLowerCase();
  const kind = VIDEO_EXTS.has(ext) ? 'video' : IMAGE_EXTS.has(ext) ? 'image' : null;
  if (!kind) {
    warnings.push(`不支持的媒体类型: ${base}`);
    return null;
  }

  let mid = base;
  let n = 2;
  while (mediaIds.has(mid)) mid = `${base}#${n++}`;
  mediaIds.add(mid);

  const item: MediaItem = { id: mid, kind, localRelativePath: rel, available: true };
  if (kind === 'image') {
    const size = imageSize(abs);
    if (size) {
      item.width = size.width;
      item.height = size.height;
    }
  }
  media.push(item);
  return item;
}

function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t === 'string' && t.trim()) {
      const s = t.trim();
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 30);
}

function normalizeIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v).toISOString();
  }
  return null;
}

function buildExcerpt(body: string): string {
  const text = plainText(body);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? compact.slice(0, 120) : compact;
}

function buildSearchText(parts: string[]): string {
  return plainText(parts.join('\n')).toLowerCase();
}

function plainText(md: string): string {
  return md
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, ' ')
    .replace(/<video\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function insideRoot(abs: string, root: string): boolean {
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function normalizeRel(abs: string, root: string): string {
  return path.relative(path.resolve(root), abs).replace(/\\/g, '/');
}
