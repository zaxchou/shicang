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
  /**
   * 浏览器能否直接渲染（按文件头判定，不看扩展名）。
   * false 的不会选作封面：HEIC/TIFF 这类格式，以及「扩展名像图片但文件头不是图片」的
   * 坏文件（实测库里有 3 个下载失败时存下的 500 JSON 响应）。
   */
  displayable?: boolean;
}

/**
 * 人工标注状态：'active' 在用（默认，不落字段）/ 'archived' 已归档。
 * 「归档」只有一个含义——**现在对我来说没用了**（2026-09-28 用户澄清：不要把"过期""取消收藏"
 * 拆成两个理由，那只是同一个意思的两种说法，多一个概念就多一层困惑）。
 */
export type NoteStatus = 'active' | 'archived';

/** 人工标注层：星标 / 状态 / 备注。存 runtime 数据目录，绝不写回源笔记。 */
export interface NoteAnnotation {
  starred: boolean;
  /** 标星时间（ISO）；未标星为 null */
  starredAt: string | null;
  status: NoteStatus;
  remark: string | null;
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
  /** 生效**分类**（即"主题"：书法/AI 工具…）；null = 未分类。
   *  rednote/web 走人工分类层（override > initial），treasures/diary 走解析派生值 */
  categoryId: string | null;
  categorySource: 'override' | 'initial' | 'none' | 'derived';
  /** 生效**来源**（web/微信专属：哔哩哔哩/微信公众号…，解析期按正文链接域名派生、不可人工改）；其它库恒 null */
  sourceCategory: string | null;
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
  /** 网页剪藏的封面（B 站走 API、其它站点取正文首图；服务端按需抓取并缓存在数据目录）。
   *  列表/卡片只拿 url 与时长，图本身走 /api/web-cover/:noteId 按需拉（失败就当作没有封面） */
  webCover?: { url: string; durationSec: number | null } | null;
  /** 人工标注（星标/状态/备注）；与索引无关，索引重建不影响 */
  annotation: NoteAnnotation;
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
  /** 人工标注 revision，PATCH 状态/备注时作为 expectedRevision */
  annotationRevision: number;
  /** 识别文本（OCR/转录）revision：识别出新文字后变化，前端据此重新拉取 */
  mediaTextRevision: number;
  indexStatus: 'ready' | 'empty' | 'scanning';
  diagnostics: string[];
  /** 各收藏库信息（切换库/表格动态列用） */
  collections: CollectionInfo[];
  /** 收藏库分组（侧栏两级；query 的 collection 参数可传组 id） */
  groups: CollectionGroupInfo[];
}

export interface NoteQuery {
  /** 收藏库 id 或分组 id（如 clippings=剪藏组：查询覆盖组内全部成员）；缺省 rednote */
  collection?: string;
  q?: string;
  categoryId?: string | null; // 'uncategorized' 表示未分类（分类维=主题）
  /** 来源维过滤（web/微信：哔哩哔哩/微信公众号…）；与 categoryId 正交组合（AND） */
  source?: string | null;
  /** 精确标签过滤（与 q、分类、来源、时间条件叠加） */
  tag?: string | null;
  /** 只看已标星（与其它条件叠加） */
  starred?: boolean;
  /** 状态视图：默认 'active'（在用）；'archived' 是归档 */
  status?: 'active' | 'archived';
  /** 归档视图要带上源文件已消失的记录，否则标注会随文件一起"消失" */
  includeMissing?: boolean;
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
  type: 'rednote' | 'treasures' | 'diary' | 'web';
  /** 扫描排除的文件名正则（相对 collection 根） */
  exclude?: string[];
}

/** 收藏库分组（侧栏两级；点组名看全部成员的笔记，搜索跨成员）。
 * 纯视图层：不参与解析与索引指纹——改组名/换成员不会触发重建索引（新增"成员库"本身会） */
export interface CollectionGroupDef {
  id: string;
  name: string;
  /** 成员收藏库 id（按侧栏显示顺序） */
  collections: string[];
}

/** 分组的聚合信息（成员各计数之和；categories 不聚合——分类是各子库自己的概念） */
export interface CollectionGroupInfo {
  id: string;
  name: string;
  collectionIds: string[];
  total: number;
  active: number;
  archived: number;
  starred: number;
  uncategorized: number;
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
  /** 库类型（决定解析与表格列）；组视图的聚合体没有单一类型，故可选 */
  type?: CollectionDef['type'];
  /** 源文件可用的全部篇数（含归档） */
  total: number;
  /** 工作集：源文件可用且状态为"在用"——侧栏计数与默认列表都用这个口径 */
  active: number;
  /** 归档篇数：状态为已归档（含源文件已消失的） */
  archived: number;
  uncategorized: number;
  /** 已标星篇数（同样只算工作集） */
  starred: number;
  /** 分类维（主题）：rednote/web 是全类目表含 0 计数，其余库按派生值动态统计 */
  categories: CategoryCount[];
  /** 来源维（仅 web/微信有值，其它库空数组）：按来源派生值统计 */
  sources: CategoryCount[];
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

/** 一次「识别图片文字」的结果 */
export interface OcrRunResult {
  noteId: string;
  /** 逐张的结果：`cached` = 命中内容 hash 缓存（没再调模型） */
  results: Array<{ mediaId: string; ok: boolean; cached: boolean; text?: string; reason?: string }>;
  /** 识别后这篇笔记的全部识别文本（按媒体顺序，界面直接渲染） */
  recognized: RecognizedText[];
  /** 这篇笔记整体还有多少张图没识别（与本次请求了几张无关；界面按它显示「识别其余 N 张」） */
  remaining: number;
  /** 实际使用的视觉模型；未配置凭据时为 null */
  model: string | null;
}

/** 语料导出格式版本：corpus.jsonl 每条与前后的 manifest 都带它，外部管道据此判断兼容性 */
export const CORPUS_SCHEMA_VERSION = 1;

/** 识别文本的两类：ocr = 图片文字识别；asr = 语音/视频转录（转录尚未实现） */
export type RecognizedKind = 'ocr' | 'asr';

/**
 * OCR / 转录的产物。
 * 存 `runtime/data/media-text.json`，键是 `mediaHash`（媒体内容的 SHA-256）——同一份文件
 * 无论被几篇笔记引用、索引重建多少次，都只算一次。
 */
export interface RecognizedText {
  kind: RecognizedKind;
  /** 对应媒体 id（图片 image-1.webp / 语音文件名），**相对于当前这篇笔记** */
  mediaId: string;
  /** 媒体内容 hash：识别结果的缓存键，也是"这条文本属于哪份文件"的稳定标识 */
  mediaHash: string;
  text: string;
  model: string;
  at: string;
}

/** corpus.jsonl 的一行：一篇笔记的可索引形态 */
export interface CorpusRecord {
  schemaVersion: number;
  id: string;
  collection: string;
  collectionName: string;
  title: string;
  author: string;
  tags: string[];
  categoryId: string | null;
  categoryName: string | null;
  categorySource: NoteSummary['categorySource'];
  /** 来源维（仅 web/微信有值）；进 contentHash——改来源等价于改语义，需重算嵌入 */
  sourceCategory: string | null;
  starred: boolean;
  status: NoteStatus;
  remark: string | null;
  publishedAt: string | null;
  syncedAt: string | null;
  originalUrl: string;
  sourcePath: string;
  sourceStatus: 'available' | 'missing';
  mediaCount: number;
  hasVideo: boolean;
  extra: ExtraFields | null;
  /** 正文纯文本（从已消毒的 bodyHtml 提取） */
  text: string;
  recognized: RecognizedText[];
  /** 源 .md 原始字节的 SHA-256；null = 该笔记类型未记录（历史索引） */
  sourceHash: string | null;
  /**
   * 语义内容 hash：只覆盖**文本内容**（标题 / 作者 / 标签 / 分类 / 备注 / 正文 / 附加字段 / 识别文本）。
   * 星标、归档状态、时间、路径都不进这个 hash——归档一篇不该让外部 embedding 重算一遍。
   */
  contentHash: string;
}

export interface CorpusCounts {
  total: number;
  active: number;
  archived: number;
  starred: number;
  missing: number;
  byCollection: Array<{ id: string; name: string; count: number }>;
}

export interface CorpusManifest {
  schemaVersion: number;
  app: string;
  appVersion: string;
  generatedAt: string;
  contentSource: string;
  indexRevision: number;
  annotationRevision: number;
  categoryRevision: number;
  parseVersion: number;
  counts: CorpusCounts;
  files: {
    corpus: { path: string; bytes: number; lines: number };
    catalog: { path: string; bytes: number };
  };
  /** 全部 contentHash 排序后的摘要：不变 = 没有任何一篇需要外部管道重算 */
  contentDigest: string;
  /** `catalog.md` 的排版依赖（分类顺序/名称、解析器版本）的摘要：它变了也要重写目录 */
  metaDigest: string;
  /**
   * 全部**记录**（含星标/状态/时间等）的摘要，只用来判断"这次要不要重写文件"。
   * 不能拿 `contentDigest` 代替它：那个**有意不含**星标与归档状态，用它判断会让
   * "只归档一篇"被当成没有变化，`corpus.jsonl` 里的状态就停在旧值了。
   */
  digest: string;
}

export const DEFAULT_PAGE_SIZE = 60;
export const MAX_PAGE_SIZE = 100;

/** 备注长度上限：存储侧截断、服务端校验、前端 maxlength 共用同一个数 */
export const MAX_REMARK = 2000;

export const UNCATEGORIZED_ID = 'uncategorized';
