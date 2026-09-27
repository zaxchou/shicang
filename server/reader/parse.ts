// 单篇笔记解析：按收藏库类型分派（rednote / treasures / diary）。
// 只读输入文件；所有结构化结果（标题、摘要、媒体、正文 HTML、表格附加字段）在此生成。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { CollectionDef, ExtraFields, MediaItem } from '../../shared/types.js';
import { shanghaiDate } from '../../shared/time.js';
import { imageSize } from './webp-size.js';

export interface NoteRecord {
  id: string;
  collection: string;
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
  /** 派生分类：treasures=收藏分类，diary=主题；rednote 不用（走 seed/override） */
  derivedCategory?: string | null;
  /** 表格附加字段（treasures：价格、购买时间、器型、朝代…） */
  extra?: ExtraFields;
}

export interface ParseInput {
  /** Obsidian vault 根（所有相对路径的最终锚点） */
  vaultRoot: string;
  collection: CollectionDef;
  absolutePath: string;
  /** 相对 collection.root（含 .md） */
  relativePath: string;
  /** 相对 vault 根（跨库唯一） */
  sourceRelativePath: string;
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
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.aac']);

/** treasures 表格字段顺序（同时决定表格列的默认排序） */
export const TREASURES_EXTRA_KEYS = [
  '价格', '购买时间', '作者品牌', '作者', '器型', '制作年份', '拓年份', '朝代', '时代',
  '书风', '画风', '撰写', '装裱', '尺寸', '工艺', '泥料', '艺术家', '说明', '价格区间',
];

marked.setOptions({ gfm: true, breaks: true });

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags.filter((t) => t !== 'img'),
    'img', 'video', 'source', 'del', 'ins',
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
    // flomo/收藏品偶尔有坏 YAML：diary 无 frontmatter 时允许整篇当正文
    if (input.collection.type === 'diary' && !raw.startsWith('---')) {
      parsed = matter('---\n---\n' + raw);
    } else {
      return { record: null, warnings, error: `frontmatter 解析失败: ${(e as Error).message}` };
    }
  }

  const fm = parsed.data as Record<string, unknown>;
  const base = {
    vaultRoot: input.vaultRoot,
    relativePath: input.relativePath,
    noteDir: path.dirname(input.absolutePath),
    sourceRelativePath: input.sourceRelativePath,
    mtimeMs: input.mtimeMs,
    size: input.size,
    collection: input.collection.id,
    raw,
  };
  let out: ParseOutcome;
  if (input.collection.type === 'treasures') out = parseTreasures(base, fm, input, warnings);
  else if (input.collection.type === 'diary') out = parseDiary(base, fm, input, warnings);
  else out = parseRednote(base, fm, input, warnings);

  if (out.record) out.record.sourceHash = sha(raw);
  return out;
}

interface ParseBase {
  vaultRoot: string;
  relativePath: string;
  noteDir: string;
  sourceRelativePath: string;
  mtimeMs: number;
  size: number;
  collection: string;
  raw: string;
}

function sha(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function mediaUrl(noteId: string, mediaId: string): string {
  return `/api/media/${encodeURIComponent(noteId)}/${encodeURIComponent(mediaId)}`;
}

/** 解析本地相对路径（相对笔记目录或 vault 根），返回相对 vault 的路径 */
function resolveLocal(vaultRoot: string, noteDir: string, rel: string): { abs: string; relToVault: string } | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^https?:\/\//i.test(norm)) return null;
  for (const cand of [path.resolve(noteDir, norm), path.resolve(vaultRoot, norm)]) {
    if (cand.startsWith(path.resolve(vaultRoot) + path.sep) && fs.existsSync(cand)) {
      return { abs: cand, relToVault: path.relative(path.resolve(vaultRoot), cand).replace(/\\/g, '/') };
    }
  }
  return null;
}

/** 登记媒体（按文件名作 id，重名加后缀）；读取图片尺寸 */
function registerLocal(
  media: MediaItem[],
  mediaIds: Set<string>,
  abs: string,
  relToVault: string
): MediaItem {
  const base = path.basename(relToVault);
  const ext = path.extname(base).toLowerCase();
  const kind = VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : 'image';
  let mid = base;
  let n = 2;
  while (mediaIds.has(mid)) mid = `${base}#${n++}`;
  mediaIds.add(mid);
  const item: MediaItem = { id: mid, kind, localRelativePath: relToVault, available: true };
  if (kind === 'image') {
    const dim = imageSize(abs);
    if (dim) {
      item.width = dim.width;
      item.height = dim.height;
    }
  }
  media.push(item);
  return item;
}

function normalizeDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// ======================================================================
// 类型 1：小红书收藏（RedNote 插件结构）
// ======================================================================
function parseRednote(base: ParseBase, fm: Record<string, unknown>, input: ParseInput, warnings: string[]): ParseOutcome {
  const id = typeof fm['resourceId'] === 'string' ? (fm['resourceId'] as string).trim() : '';
  if (!id) return { record: null, warnings, error: '缺少 resourceId，跳过（不采用文件名充当 ID）' };
  void input;

  const content = matterContent(base.raw);
  const { title, bodyWithoutH1 } = extractH1(content, base, id, warnings);
  const vault = base.vaultRoot;

  const media: MediaItem[] = [];
  const mediaIds = new Set<string>();
  let body = bodyWithoutH1.replace(/!\[\[([^\]\n]+)\]\]/g, (_a, targetRaw: string) => {
    const item = resolveEmbed(vault, String(targetRaw).trim(), id, media, mediaIds, warnings);
    if (!item) return '';
    return `![媒体](media://${item.id})`;
  });

  body = body.replace(/<video\b[^>]*>/gi, (tag) => {
    const m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const src = (m?.[2] ?? m?.[3] ?? '').trim();
    if (!/^https?:\/\//i.test(src)) {
      if (src) warnings.push('忽略非 http(s) 视频 src');
      return '';
    }
    if (!media.some((x) => x.kind === 'video' && x.remoteUrl === src)) {
      media.push({ id: `video-${media.length + 1}`, kind: 'video', remoteUrl: src });
    }
    return tag;
  });

  const bodyHtml = renderBody(body, id, media, mediaIds, warnings);
  const tags = normalizeTags(fm['tags']);
  const author = str(fm['author']) || '未知作者';
  const originalUrl = str(fm['url']);
  const publishedAt = normalizeDate(fm['postCreatedAt']);
  const syncedAt = normalizeDate(fm['syncedAt']);
  if (fm['postCreatedAt'] !== undefined && publishedAt === null) warnings.push('postCreatedAt 无法解析为日期');

  const cover = media.find((m) => m.kind === 'image' && m.available !== false && m.localRelativePath);
  const excerpt = buildExcerpt(bodyWithoutH1);

  return {
    record: {
      id,
      collection: base.collection,
      sourceRelativePath: base.sourceRelativePath,
      sourceMtimeMs: base.mtimeMs,
      sourceSize: base.size,
      sourceHash: null,
      title: title || '(无标题)',
      author,
      tags,
      excerpt,
      searchText: buildSearch([title, excerpt, bodyWithoutH1, author, tags.join(' ')]),
      publishedAt,
      syncedAt,
      originalUrl,
      bodyHtml,
      media,
      coverMediaId: cover ? cover.id : null,
      sourceStatus: 'available',
      warnings,
    },
    warnings,
    error: null,
  };
}

function resolveEmbed(
  vaultRoot: string,
  target: string,
  noteId: string,
  media: MediaItem[],
  mediaIds: Set<string>,
  warnings: string[]
): MediaItem | null {
  if (/^https?:\/\//i.test(target)) {
    warnings.push(`不支持远程嵌入: ${target.slice(0, 60)}`);
    return null;
  }
  const norm = target.replace(/\\/g, '/').replace(/^\.?\//, '');
  const candidates = [norm, norm.includes('/') ? norm.slice(norm.indexOf('/') + 1) : norm];
  let resolved: { abs: string; relToVault: string } | null = null;
  for (const c of candidates) {
    const joined = path.resolve(vaultRoot, c);
    if (joined.startsWith(path.resolve(vaultRoot) + path.sep) && fs.existsSync(joined)) {
      resolved = { abs: joined, relToVault: path.relative(path.resolve(vaultRoot), joined).replace(/\\/g, '/') };
      break;
    }
  }
  if (!resolved) {
    warnings.push(`嵌入媒体缺失或不支持: ${norm.slice(0, 80)}`);
    // 仅当路径在 vault 内但文件缺失时才登记为不可用；逃逸路径一律不登记
    const probe = path.resolve(vaultRoot, norm);
    if (probe.startsWith(path.resolve(vaultRoot) + path.sep)) {
      const base = path.basename(norm);
      const ext = path.extname(base).toLowerCase();
      if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
        let mid = base;
        let n = 2;
        while (mediaIds.has(mid)) mid = `${base}#${n++}`;
        mediaIds.add(mid);
        const item: MediaItem = { id: mid, kind: IMAGE_EXTS.has(ext) ? 'image' : 'video', localRelativePath: norm, available: false };
        media.push(item);
        return item;
      }
    }
    return null;
  }
  return registerLocal(media, mediaIds, resolved.abs, resolved.relToVault);
}

function renderBody(body: string, id: string, media: MediaItem[], mediaIds: Set<string>, warnings: string[]): string {
  void warnings;
  let html: string;
  try {
    html = marked.parse(body, { async: false }) as string;
  } catch (e) {
    warnings.push(`Markdown 渲染失败: ${(e as Error).message}`);
    html = '';
  }
  html = html
    .replace(/media:\/\/([^"\s<>]+)/g, (_a, midRaw: string) => {
      // marked 会把非 ASCII URL 百分号编码，需还原后再查媒体表
      let mid = String(midRaw);
      try {
        mid = decodeURIComponent(mid);
      } catch {
        /* 保持原样 */
      }
      return mediaIds.has(mid) ? mediaUrl(id, mid) : '';
    })
    .replace(/<video\b([^>]*)>/gi, (tag, attrs: string) => {
      let out = tag;
      if (!/\scontrols(\s|=|>)/i.test(attrs)) out = `<video controls${attrs}>`;
      if (!/\spreload(\s|=|>)/i.test(attrs)) out = out.replace(/^<video/i, '<video preload="metadata"');
      return out;
    });
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function extractH1(
  content: string,
  base: ParseBase,
  id: string,
  warnings: string[]
): { title: string; bodyWithoutH1: string } {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  if (m && m[1]) return { title: m[1].trim(), bodyWithoutH1: content.replace(m[0], '') };
  warnings.push('正文未找到 H1，标题回退为文件名');
  const b = path.basename(base.sourceRelativePath).replace(/\.md$/i, '');
  const cleaned = b.endsWith(`-${id}`) ? b.slice(0, b.length - id.length - 1) : b;
  return { title: cleaned, bodyWithoutH1: content };
}

// ======================================================================
// 类型 2：我的宝贝（收藏品：CSV 导入的结构化笔记）
// ======================================================================
function parseTreasures(
  base: ParseBase,
  fm: Record<string, unknown>,
  input: ParseInput,
  warnings: string[]
): ParseOutcome {
  const filename = path.basename(base.sourceRelativePath, '.md');
  const title = str(fm['CSV标题']) || filename;

  // 分类：frontmatter 收藏分类 > 规范分类文件夹名（我的收藏-X）；其它文件夹/顶层不猜
  const parentDir = path.dirname(base.relativePath);
  const folderMatch = /^我的收藏-(.+)$/.exec(path.basename(parentDir));
  const folder = folderMatch ? folderMatch[1] : '';
  const derivedCategory = str(fm['收藏分类']) || folder || null;

  const author = str(fm['作者品牌']) || str(fm['作者']) || str(fm['作者索引']) || '佚名';

  // 表格附加字段
  const extra: ExtraFields = {};
  for (const key of TREASURES_EXTRA_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null || v === '') continue;
    // YAML 可能把日期解析成 Date 对象（如 购买时间: 2026-09-04）
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      extra[key] = shanghaiDate(v.toISOString()) ?? v.toISOString().slice(0, 10);
      continue;
    }
    if (typeof v === 'number') extra[key] = v;
    else if (typeof v === 'string') {
      const t = v.trim();
      extra[key] = /^-?\d+(\.\d+)?$/.test(t) && (key.includes('价格') || key.includes('价'))
        ? Number(t)
        : t;
    }
  }

  const media: MediaItem[] = [];
  const mediaIds = new Set<string>();

  // 正文预处理：本地 md 图片改写为媒体路由；wiki 嵌入按裸文件名解析
  let body = input.relativePath ? matterContent(base.raw) : '';
  body = body.replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (full, alt: string, src: string, rest: string) => {
    if (/^https?:\/\//i.test(src)) return full; // 远程图保留
    const r = resolveLocal(base.vaultRoot, base.noteDir, src);
    if (!r) return full;
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault);
    return `![${alt || ''}](media://${item.id})`;
  });
  body = body.replace(/!\[\[([^\]\n]+)\]\]/g, (full, target: string) => {
    const t = String(target).trim();
    if (/^https?:\/\//i.test(t)) return full;
    const r =
      resolveLocal(base.vaultRoot, base.noteDir, t) ??
      resolveLocal(base.vaultRoot, base.noteDir, path.join('我的收藏品', 'Attachments', path.basename(t))) ??
      resolveLocal(base.vaultRoot, base.noteDir, path.join('Attachments', path.basename(t)));
    if (!r) {
      warnings.push(`嵌入图片缺失: ${t.slice(0, 60)}`);
      return '';
    }
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault);
    return `![图](media://${item.id})`;
  });

  // 封面：优先 frontmatter 封面图（vault 相对路径），否则正文第一张本地图
  let coverId: string | null = null;
  const coverPath = str(fm['封面图']);
  if (coverPath) {
    const r = resolveLocal(base.vaultRoot, base.noteDir, coverPath);
    if (r) coverId = registerLocal(media, mediaIds, r.abs, r.relToVault).id;
    else warnings.push(`封面图缺失: ${coverPath.slice(0, 60)}`);
  }
  if (!coverId) {
    const first = media.find((m) => m.kind === 'image');
    if (first) coverId = first.id;
  }

  const bodyHtml = renderBody(body, base.sourceRelativePath, media, mediaIds, warnings);
  const tags = normalizeTags(fm['tags']);
  const excerpt = buildExcerpt(body);
  const publishedAt = normalizeDate(fm['购买时间']);

  return {
    record: {
      id: base.sourceRelativePath,
      collection: base.collection,
      sourceRelativePath: base.sourceRelativePath,
      sourceMtimeMs: base.mtimeMs,
      sourceSize: base.size,
      sourceHash: null,
      title: title || filename,
      author,
      tags,
      excerpt,
      searchText: buildSearch([title, author, derivedCategory ?? '', tags.join(' '), Object.values(extra).join(' '), excerpt]),
      publishedAt,
      syncedAt: null,
      originalUrl: '',
      bodyHtml,
      media,
      coverMediaId: coverId,
      sourceStatus: 'available',
      warnings,
      derivedCategory,
      extra,
    },
    warnings,
    error: null,
  };
}

// ======================================================================
// 类型 3：日记（flomo 导出：文件名=日期_主题，FM 有 created_at/tags）
// ======================================================================
function parseDiary(
  base: ParseBase,
  fm: Record<string, unknown>,
  input: ParseInput,
  warnings: string[]
): ParseOutcome {
  const content = matterContent(base.raw);
  const created = normalizeDate(fm['created_at']);
  const updated = normalizeDate(fm['updated_at']);
  const tags = normalizeTags(fm['tags']);

  // 标题：日期 + 摘要（H1 优先，其次首个非空行）
  const h1 = /^#\s+(.+?)\s*$/m.exec(content)?.[1]?.trim();
  const firstLine =
    content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('---')) ?? '';
  const core = (h1 || firstLine || path.basename(base.sourceRelativePath, '.md')).slice(0, 80);
  const datePrefix = created ? (shanghaiDate(created) ?? '') : '';
  const title = datePrefix ? `${datePrefix} ${core}` : core;

  // 主题分类：FM tags 第一项 > 文件名第二段
  const fileName = path.basename(base.sourceRelativePath, '.md');
  const topicFromName = fileName.split('_')[1] ?? '';
  const derivedCategory = tags[0] || topicFromName || null;

  const media: MediaItem[] = [];
  const mediaIds = new Set<string>();

  let body = content;
  // 图片链接 [x](attachments/...) → 生成图片；音频等保留链接并改写为媒体路由
  body = body.replace(/\[([^\]]+)\]\((attachments\/[^)]+)\)/g, (full, text: string, href: string) => {
    const r = resolveLocal(base.vaultRoot, base.noteDir, href);
    if (!r) return full;
    const ext = path.extname(r.relToVault).toLowerCase();
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault);
    if (IMAGE_EXTS.has(ext)) return `![${text}](media://${item.id})`; // 图片转内联
    return `[${text}](${mediaUrl(base.sourceRelativePath, item.id)})`;
  });
  body = body.replace(/!\[([^\]]*)\]\((attachments\/[^)]+)\)/g, (full, alt: string, href: string) => {
    const r = resolveLocal(base.vaultRoot, base.noteDir, href);
    if (!r) return full;
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault);
    return `![${alt || ''}](media://${item.id})`;
  });

  const bodyHtml = renderBody(body, base.sourceRelativePath, media, mediaIds, warnings);
  const cover = media.find((m) => m.kind === 'image');
  const excerpt = buildExcerpt(body);

  return {
    record: {
      id: base.sourceRelativePath,
      collection: base.collection,
      sourceRelativePath: base.sourceRelativePath,
      sourceMtimeMs: base.mtimeMs,
      sourceSize: base.size,
      sourceHash: null,
      title,
      author: '我',
      tags,
      excerpt,
      searchText: buildSearch([title, derivedCategory ?? '', tags.join(' '), excerpt, content.slice(0, 400)]),
      publishedAt: created,
      syncedAt: updated,
      originalUrl: '',
      bodyHtml,
      media,
      coverMediaId: cover ? cover.id : null,
      sourceStatus: 'available',
      warnings,
      derivedCategory,
    },
    warnings,
    error: null,
  };
}

// ---------------- 公共小工具 ----------------
function matterContent(raw: string): string {
  try {
    return matter(raw).content;
  } catch {
    return raw.startsWith('---') ? raw.replace(/^---[\s\S]*?---/, '') : raw;
  }
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

function buildExcerpt(body: string): string {
  const text = plainText(body);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? compact.slice(0, 120) : compact;
}

function buildSearch(parts: string[]): string {
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
