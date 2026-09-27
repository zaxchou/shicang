// 前后端共享的 API 类型与常量。数据校验规则尽量同时给服务端使用。

export type MediaKind = 'image' | 'video';

export interface MediaItem {
  /** 笔记内唯一媒体 ID（如 image-1.webp） */
  id: string;
  kind: MediaKind;
  /** 相对内容源根的路径（仅本地媒体） */
  localRelativePath?: string;
  /** 远程地址（仅远程媒体，如视频） */
  remoteUrl?: string;
  width?: number;
  height?: number;
  /** 本地文件是否确实存在 */
  available?: boolean;
}

/** 列表条目：不含正文 HTML 与全部媒体 */
export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  author: string;
  tags: string[];
  publishedAt: string | null;
  syncedAt: string | null;
  /** 生效主类；null = 未分类 */
  categoryId: string | null;
  categorySource: 'override' | 'initial' | 'none';
  mediaCount: number;
  hasVideo: boolean;
  cover: {
    mediaId: string;
    url: string;
    width: number | null;
    height: number | null;
    available: boolean;
  } | null;
  sourceStatus: 'available' | 'missing';
}

export interface NoteDetail extends NoteSummary {
  /** 服务端渲染并消毒后的正文 HTML */
  bodyHtml: string;
  media: MediaItem[];
  originalUrl: string;
  sourceRelativePath: string;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  order: number;
}

export interface CategoryCount {
  id: string;
  name: string;
  count: number;
}

export interface LibraryInfo {
  app: string;
  version: string;
  total: number;
  uncategorized: number;
  categories: CategoryCount[];
  lastScan: {
    finishedAt: string | null;
    scanned: number;
    added: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null;
  indexRevision: number;
  /** 人工覆盖 revision，PATCH 分类时作为 expectedRevision */
  categoryRevision: number;
  indexStatus: 'ready' | 'empty' | 'scanning';
  diagnostics: string[];
}

export interface NoteQuery {
  q?: string;
  categoryId?: string | null; // 'uncategorized' 表示未分类
  /** 精确标签过滤（与 q、分类、时间条件叠加） */
  tag?: string | null;
  timeField: 'published' | 'synced';
  range: 'all' | '7d' | '30d' | 'custom';
  from?: string; // YYYY-MM-DD，custom 时有效
  to?: string;
  order: 'desc' | 'asc';
  offset: number;
  limit: number;
}

/** 标签与使用次数 */
export interface TagCount {
  tag: string;
  count: number;
}

export interface NoteListResult {
  items: NoteSummary[];
  total: number;
  indexRevision: number;
}

export interface RefreshJobInfo {
  jobId: string;
  state: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  diagnostics: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const DEFAULT_PAGE_SIZE = 60;
export const MAX_PAGE_SIZE = 100;

export const UNCATEGORIZED_ID = 'uncategorized';
