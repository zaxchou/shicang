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
import { imageSize, sniffImageMime } from './image-size.js';

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
  /** 有意跳过（收藏索引页 / 空笔记等非条目内容）：扫描计为 skipped，不算错误 */
  skippedReason?: string | null;
}

/**
 * 解析器版本：**改动解析逻辑（路径解析、媒体改写、字段提取）时必须 +1**。
 * 索引里记录该值，不一致就整体重建——否则解析已修好、用户看到的却还是旧索引，
 * 因为扫描按 mtime/size 跳过未变更的源文件（v0.5.1 修「正文图片不显示」时踩到）。
 */
export const PARSE_VERSION = 5;

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.avif', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.aac']);
/** 浏览器（Chrome/Firefox/Edge）无法直接显示：文件照常提供，但不选作封面 */
const NON_DISPLAYABLE_EXTS = new Set(['.heic', '.heif', '.tif', '.tiff']);

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
    collectionRoot: path.join(input.vaultRoot, input.collection.root),
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
  /** 收藏库根目录（vaultRoot/collection.root）：treasures 的 frontmatter 路径相对它 */
  collectionRoot: string;
  sourceRelativePath: string;
  mtimeMs: number;
  size: number;
  collection: string;
  raw: string;
}

/** 相对路径解析基准，按「笔记目录 → 笔记父目录 → 收藏库根 → vault 根」顺序尝试 */
interface ResolveBases {
  vaultRoot: string;
  dirs: string[];
}

function basesOf(base: ParseBase): ResolveBases {
  // 笔记父目录：藏品库常把附件放在分类文件夹的 Attachments/ 里，而条目可能在更深的子目录
  const parent = path.dirname(base.noteDir);
  return {
    vaultRoot: base.vaultRoot,
    dirs: [base.noteDir, parent, base.collectionRoot, base.vaultRoot],
  };
}

function sha(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function mediaUrl(noteId: string, mediaId: string): string {
  return `/api/media/${encodeURIComponent(noteId)}/${encodeURIComponent(mediaId)}`;
}

/**
 * 媒体 id 作为 markdown 链接目标时的安全形态。
 * 文件名常带空格（如 `Pasted image 20260426145213.png`）——不编码的话 marked 会把
 * `![图](media://Pasted image ….png)` 的链接在空格处截断，媒体查不到，图片直接消失。
 * `#`（重名后缀）不编码会被当成 fragment，括号会破坏链接边界，故一并编码。
 */
function mediaToken(id: string): string {
  return encodeURIComponent(id).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 解析本地相对路径（按 bases 顺序尝试每个基准目录），返回相对 vault 根的路径 */
function resolveLocal(rb: ResolveBases, rel: string): { abs: string; relToVault: string } | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || /^https?:\/\//i.test(norm)) return null;
  const rootAbs = path.resolve(rb.vaultRoot);
  for (const dir of rb.dirs) {
    const cand = path.resolve(dir, norm);
    if (cand.startsWith(rootAbs + path.sep) && fs.existsSync(cand)) {
      return { abs: cand, relToVault: path.relative(rootAbs, cand).replace(/\\/g, '/') };
    }
  }
  return null;
}

/**
 * 登记媒体（按文件名作 id，重名加后缀）；读取图片尺寸并判定浏览器可渲染性。
 * 尺寸与可渲染性都按**文件头**判断：藏品库既有名为 `640` 的无扩展名图片（WebP/PNG/JPEG），
 * 也有下载失败后存下来的 500 JSON 响应体（扩展名像图片、文件头不是）。
 */
function registerLocal(
  media: MediaItem[],
  mediaIds: Set<string>,
  abs: string,
  relToVault: string,
  warnings?: string[]
): MediaItem {
  // 同一文件被正文与封面重复引用时复用同一条，避免出现 `xxx.png#2` 这类冗余条目
  const seen = media.find((m) => m.localRelativePath === relToVault);
  if (seen) return seen;
  const base = path.basename(relToVault);
  const ext = path.extname(base).toLowerCase();
  const kind: MediaItem['kind'] = VIDEO_EXTS.has(ext)
    ? 'video'
    : AUDIO_EXTS.has(ext)
      ? 'audio'
      : 'image';
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
    const sniffed = sniffImageMime(abs);
    if (ext && IMAGE_EXTS.has(ext)) {
      item.displayable = true; // 已知图片扩展名（HEIC/TIFF 不在这个集合里）
    } else if (sniffed) {
      item.displayable = sniffed !== 'image/heic';
    } else {
      item.displayable = false;
      warnings?.push(`文件头不是可识别的图片格式，已排除封面候选: ${relToVault.slice(0, 80)}`);
    }
  }
  media.push(item);
  return item;
}

/** 浏览器无法直接渲染的图片格式：不能当封面（否则封面永远空白） */
function isDisplayableImage(relPath: string | undefined): boolean {
  if (!relPath) return false;
  return !NON_DISPLAYABLE_EXTS.has(path.extname(relPath).toLowerCase());
}

/** 封面候选：按登记时判定的可渲染性取（回退到扩展名黑名单，兼容旧数据） */
function coverCandidate(m: MediaItem): boolean {
  return m.kind === 'image' && m.available !== false && m.displayable !== false && isDisplayableImage(m.localRelativePath);
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

/** 规范化 markdown 图片目标：去掉 <...> 包裹与尾部的 "标题" */
function normalizeLinkDest(raw: string): string {
  let d = raw.trim();
  if (d.startsWith('<') && d.endsWith('>')) return d.slice(1, -1).trim();
  d = d.replace(/\s+("[^"]*"|'[^']*')\s*$/, '');
  return d.trim();
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
    return `![媒体](media://${mediaToken(item.id)})`;
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

  const cover = media.find(coverCandidate);
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
  return registerLocal(media, mediaIds, resolved.abs, resolved.relToVault, warnings);
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

  // 索引/总览页（vault 自己用「笔记类型」标注）与空笔记不是藏品条目：
  // 显式跳过而不是报错，扫描计为 skipped（此前混进库里，标题显示成 MOC/未命名页面）
  const noteType = str(fm['笔记类型']);
  if (/^收藏(多维|总)?索引$/.test(noteType)) {
    return { record: null, warnings, error: null, skippedReason: `收藏索引页（笔记类型=${noteType}）` };
  }
  if (!base.raw.trim()) {
    return { record: null, warnings, error: null, skippedReason: '空笔记' };
  }

  // 标题：CSV标题 > 正文 H1 > 文件名（MOC.md 这类无 frontmatter 的笔记，H1 才是真实标题）
  const h1 = /^#\s+(.+?)\s*$/m.exec(matterContent(base.raw))?.[1]?.trim();
  const title = str(fm['CSV标题']) || (h1 ? h1.slice(0, 60) : '') || filename;

  // 分类：frontmatter 收藏分类 > 路径里的分类段（我的收藏-X，允许藏在子目录下，
  // 如「我的收藏-书法/豪翰斋/MOC.md」也归书法）；两者都没有则未分类
  const segs = path.dirname(base.relativePath).split(/[\\/]+/);
  const seg = segs.map((x) => /^我的收藏-(.+)$/.exec(x)).find(Boolean);
  const folder = seg ? seg[1] : '';
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
  const rb = basesOf(base);

  // 正文预处理：本地 md 图片改写为媒体路由；wiki 嵌入按裸文件名解析
  let body = input.relativePath ? matterContent(base.raw) : '';
  body = body.replace(/!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\n]+?)\s*\)/g, (full, alt: string, rawDest: string) => {
    const src = normalizeLinkDest(rawDest);
    if (!src || /^https?:\/\//i.test(src)) return full; // 远程图保留
    // 直查各基准目录；再按 <基准>/Attachments/<文件名> 兜底（子目录笔记引用库级附件目录时）
    const r = resolveLocal(rb, src) ?? resolveLocal(rb, path.join('Attachments', path.basename(src)));
    if (!r) return full;
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault, warnings);
    return `![${alt || ''}](media://${mediaToken(item.id)})`;
  });
  body = body.replace(/!\[\[([^\]\n]+)\]\]/g, (full, target: string) => {
    const t = String(target).trim();
    if (/^https?:\/\//i.test(t)) return full;
    // `![[裸文件名]]`：先按各基准目录直查，再按笔记/收藏库下的 Attachments/<文件名> 兜底
    const r = resolveLocal(rb, t) ?? resolveLocal(rb, path.join('Attachments', path.basename(t)));
    if (!r) {
      warnings.push(`嵌入图片缺失: ${t.slice(0, 60)}`);
      return '';
    }
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault, warnings);
    return `![图](media://${mediaToken(item.id)})`;
  });

  // 封面：优先 frontmatter 封面图（相对笔记/收藏库/vault 的路径），否则正文第一张可显示的本地图
  let coverId: string | null = null;
  const coverPath = str(fm['封面图']);
  if (coverPath) {
    const r = resolveLocal(rb, coverPath);
    if (r) {
      const item = registerLocal(media, mediaIds, r.abs, r.relToVault, warnings);
      if (coverCandidate(item)) coverId = item.id;
      else warnings.push(`封面图不能用作封面（格式不支持或文件损坏），改用正文首图: ${coverPath.slice(0, 60)}`);
    } else if (!/^https?:\/\//i.test(coverPath)) {
      warnings.push(`封面图缺失: ${coverPath.slice(0, 60)}`);
    }
    // 远程封面：当前媒体模型只服务本地文件，静默回退到正文首图（不当作缺失告警）
  }
  if (!coverId) {
    const first = media.find(coverCandidate);
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
  const rb = basesOf(base);

  let body = content;
  // 图片链接 [x](attachments/...) → 生成图片；音频等保留链接并改写为媒体路由。
  // 前缀允许若干级目录：flomo 导出用的是 **vault 相对**路径 `flomo/attachments/…`（114 处语音全是这个形态），
  // 旧正则只认裸 `attachments/`，于是语音笔记的音频从来没被登记过——ASR 因此没有目标可转。
  body = body.replace(/\[([^\]]+)\]\(((?:[^/()]+\/)*attachments\/[^)]+)\)/g, (full, text: string, href: string) => {
    const r = resolveLocal(rb, href);
    if (!r) return full;
    const ext = path.extname(r.relToVault).toLowerCase();
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault, warnings);
    if (IMAGE_EXTS.has(ext)) return `![${text}](media://${mediaToken(item.id)})`; // 图片转内联
    return `[${text}](${mediaUrl(base.sourceRelativePath, item.id)})`;
  });
  body = body.replace(/!\[([^\]]*)\]\(((?:[^/()]+\/)*attachments\/[^)]+)\)/g, (full, alt: string, href: string) => {
    const r = resolveLocal(rb, href);
    if (!r) return full;
    const item = registerLocal(media, mediaIds, r.abs, r.relToVault, warnings);
    return `![${alt || ''}](media://${mediaToken(item.id)})`;
  });

  const bodyHtml = renderBody(body, base.sourceRelativePath, media, mediaIds, warnings);
  const cover = media.find(coverCandidate);
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
