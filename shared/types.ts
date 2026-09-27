// 前后端共享的 API 类型与常量。数据校验规则尽量同时给服务端使用。

export type MediaKind = 'image' | 'video' | 'audio';

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
  /** 所属收藏库（rednote / treasures / diary） */
  collection: string;
  title: string;
  excerpt: string;
  author: string;
  tags: string[];
  publishedAt: string | null;
  syncedAt: string | null;
  /** 生效主类；null = 未分类（仅 rednote 可人工修改） */
  categoryId: string | null;
  categorySource: 'override' | 'initial' | 'none' | 'derived';
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
  /** 结构化附加字段（treasures：价格/购买时间/朝代等，供表格展示） */
  extra?: ExtraFields;
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
  /** 人工覆盖 revision，PATCH 分类时作为 expectedRevision（仅 rednote） */
  categoryRevision: number;
  indexStatus: 'ready' | 'empty' | 'scanning';
  diagnostics: string[];
  /** 各收藏库信息（切换库/表格动态列用） */
  collections: CollectionInfo[];
}

export interface NoteQuery {
  /** 收藏库 id（rednote/treasures/diary）；缺省 rednote */
  collection?: string;
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

/** 收藏库定义（配置驱动；root 相对 vault 根） */
export interface CollectionDef {
  id: string;
  name: string;
  root: string;
  type: 'rednote' | 'treasures' | 'diary';
  /** 扫描排除的文件名正则（相对 collection 根） */
  exclude?: string[];
}

/** 附加结构化字段（表格用）：价格、购买时间、器型、朝代… */
export type ExtraFields = Record<string, string | number | null>;

/** 派生分类（我的收藏品=收藏分类，日记=主题） */
export interface DerivedCategory {
  id: string;
  name: string;
  count: number;
}

/** 表格字段：key 在 extra 中的出现次数（用于动态列） */
export interface ExtraFieldInfo {
  key: string;
  count: number;
}

/** 单个收藏库的汇总信息 */
export interface CollectionInfo {
  id: string;
  name: string;
  total: number;
  uncategorized: number;
  categories: CategoryCount[];
  /** 仅 treasures：可作为表格列的附加字段（按出现次数降序） */
  extraFields: ExtraFieldInfo[];
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
