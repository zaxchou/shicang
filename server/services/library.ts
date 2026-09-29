// 收藏库核心服务：内存索引、查询、详情、刷新任务、分类入口。
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  Category,
  CategoryCount,
  CollectionDef,
  CollectionGroupInfo,
  CollectionInfo,
  CorpusManifest,
  CorpusRecord,
  ExtraFieldInfo,
  LibraryInfo,
  MediaItem,
  NoteDetail,
  NoteListResult,
  NoteQuery,
  NoteStatus,
  NoteSummary,
  OcrRunResult,
  RecognizedText,
  RefreshJobInfo,
  TagCount,
} from '../../shared/types.js';
import { lastNDaysRangeMs, customRangeMs } from '../../shared/time.js';
import { projectRoot, type AppConfig } from '../config.js';
import { log } from '../log.js';
import { scanVault } from '../reader/scan.js';
import { sniffImageMime } from '../reader/image-size.js';
import { PARSE_VERSION, type NoteRecord } from '../reader/parse.js';
import { classifyByRules } from './classify.js';
import { aiClassifyConfigFromEnv, classifyByAi } from './ai-classify.js';
import {
  MediaTextService,
  mediaFileSize,
  mediaHashOf,
  readMediaBytes,
} from './media-text.js';
import { aiVisionConfigFromEnv, ocrImage, OCR_IMAGE_MIMES, MAX_OCR_IMAGE_BYTES, type OcrUsage } from './ai-vision.js';import {
  aiAsrConfigFromEnv,
  transcribeAudio,
  transcodeToMp3,
  sniffAudioFormat,
  ffmpegAvailable,
  MAX_ASR_AUDIO_BYTES,
  type AsrUsage,
  type AudioFormat,
} from './ai-asr.js';
import {
  WebCoverService,
} from './web-cover.js';
import { JsonStore } from '../storage/json-store.js';
import {
  buildCorpusRecords,
  exportCorpus as writeCorpus,
  readCorpusManifest,
  type CorpusCollectionMeta,
  type CorpusExportResult,
} from './corpus.js';
import {
  CategoriesService,
  CategoryConflictError,
  CategoryValidationError,
} from './categories.js';
import {
  AnnotationsService,
  AnnotationConflictError,
  AnnotationValidationError,
} from './annotations.js';

/** 单次 OCR 调用的产物（单飞表里在途共享的就是它） */
type OcrFlightOutcome =
  | { ok: true; text: string; model: string; usage: OcrUsage }
  | { ok: false; reason: string };

/** 单次 ASR 调用的产物（同上，语音转录用） */
type AsrFlightOutcome =
  | { ok: true; text: string; model: string; usage: AsrUsage }
  | { ok: false; reason: string };

interface IndexDoc {
  schemaVersion: number;
  revision: number;
  generatedAt: string;
  contentSource: string;
  /** 索引指纹（收藏库结构 + 解析器版本；任一变化 → 索引作废重建） */
  indexSig?: string;
  notes: NoteRecord[];
  diagnostics: string[];
  lastScan: {
    finishedAt: string;
    scanned: number;
    added: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null;
}

interface InternalRefreshJob extends RefreshJobInfo {
  cancelled: boolean;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateIndexDoc(data: unknown): IndexDoc | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as IndexDoc;
  if (d.schemaVersion !== 1 || !Array.isArray(d.notes) || typeof d.revision !== 'number') return null;
  if (d.lastScan !== null && d.lastScan !== undefined && typeof d.lastScan !== 'object') return null;
  if (d.diagnostics !== undefined && !Array.isArray(d.diagnostics)) return null;
  const notes = d.notes.filter(
    (n): n is NoteRecord =>
      typeof n === 'object' &&
      n !== null &&
      typeof (n as NoteRecord).id === 'string' &&
      typeof (n as NoteRecord).title === 'string'
  );
  if (notes.length !== d.notes.length) return null;
  return { ...d, notes };
}

export class LibraryService {
  readonly cfg: AppConfig;
  private categories: CategoriesService;
  private annotations: AnnotationsService;
  private mediaText: MediaTextService;
  private webCover: WebCoverService;
  private indexStore: JsonStore<IndexDoc>;
  private doc: IndexDoc;
  private byId = new Map<string, NoteRecord>();
  private byPath = new Map<string, NoteRecord>();
  private job: InternalRefreshJob | null = null;
  /** 扫描串行链：初始扫描与手动刷新互斥，避免并发全盘扫描 */
  private scanChain: Promise<void> = Promise.resolve();
  private bootDiagnostics: string[] = [];

  private colMap = new Map<string, CollectionDef>();

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    for (const c of cfg.collections) this.colMap.set(c.id, c);
    this.categories = new CategoriesService(cfg.dataDir, cfg.backupDir);
    this.annotations = new AnnotationsService(cfg.dataDir, cfg.backupDir);
    this.mediaText = new MediaTextService(cfg.dataDir, cfg.backupDir);
    this.webCover = new WebCoverService(cfg.dataDir, cfg.backupDir);
    this.indexStore = new JsonStore<IndexDoc>(
      path.join(cfg.dataDir, 'library-index.json'),
      cfg.backupDir,
      validateIndexDoc
    );
    this.doc = {
      schemaVersion: 1,
      revision: 0,
      generatedAt: '',
      contentSource: cfg.vaultRoot,
      notes: [],
      diagnostics: [],
      lastScan: null,
    };
  }

  get indexRevision(): number {
    return this.doc.revision;
  }

  get categoriesService(): CategoriesService {
    return this.categories;
  }

  get annotationsService(): AnnotationsService {
    return this.annotations;
  }

  get sourceRoot(): string {
    return this.cfg.vaultRoot;
  }

  /**
   * 索引指纹：**内容源 + 收藏库结构（id/root/type/exclude）+ 解析器版本**，任一变化即索引作废。
   * 内容源必须进指纹：同一份 DATA_DIR 换了 SOURCE_ROOT（搬家 / 换盘 / 开发切生产）时，
   * 少了这一项就会继续用旧库的索引——列表看着正常，媒体却全 404，且没有任何提示（深审发现）。
   * `type` 也要进：它决定走哪个解析分支。
   */
  private indexSig(): string {
    return JSON.stringify({
      vaultRoot: this.cfg.vaultRoot,
      collections: this.cfg.collections.map((c) => ({
        id: c.id,
        root: c.root,
        type: c.type,
        exclude: c.exclude ?? [],
      })),
      parseVersion: PARSE_VERSION,
    });
  }

  async init(): Promise<void> {
    const diagnostics: string[] = [];
    const seedPath = path.join(projectRoot(), 'data-seed', 'categories-seed.json');
    diagnostics.push(...(await this.categories.init(seedPath)));
    diagnostics.push(...(await this.annotations.init()));
    diagnostics.push(...(await this.mediaText.init()));
    diagnostics.push(...(await this.webCover.init()));

    const loaded = this.indexStore.load();
    const sig = this.indexSig();
    if (loaded.doc && loaded.doc.indexSig !== sig) {
      diagnostics.push(
        loaded.doc.indexSig === undefined
          ? '索引缺少指纹（旧版本），作废并重建'
          : '收藏库结构或解析器版本已变化，索引作废并重建'
      );
      this.doc = { ...this.doc, revision: loaded.doc.revision }; // 保留 revision 序号
      loaded.doc = null as never;
    }
    if (loaded.doc) {
      this.doc = loaded.doc;
      this.rebuildMaps();
      if (loaded.recoveredFrom) {
        diagnostics.push(`library-index.json 损坏，已从备份恢复: ${path.basename(loaded.recoveredFrom)}`);
      }
    } else if (loaded.corruptedFile) {
      diagnostics.push('library-index.json 损坏且无可用备份，已重建索引（分类覆盖不受影响）');
    }
    this.bootDiagnostics = diagnostics;

    // 无索引缓存（或结构失效）：自动全量扫描。
    // **一篇可读笔记都没有时也要扫**：上一轮如果内容源没挂上，记录会全部保留成 missing，
    // notes.length 不为 0，于是修好挂载后重启不会自愈，用户看到的是空库（深审发现）。
    const noAvailable = this.doc.notes.every((n) => n.sourceStatus !== 'available');
    if (this.doc.notes.length === 0 || noAvailable) {
      if (noAvailable && this.doc.notes.length > 0) {
        diagnostics.push('索引里没有任何可读记录（内容源可能未挂载），已自动重新扫描');
        this.bootDiagnostics = diagnostics;
      }
      await this.runScan('initial');
    }
  }

  private rebuildMaps(): void {
    this.byId.clear();
    this.byPath.clear();
    for (const r of this.doc.notes) {
      this.byId.set(r.id, r);
      this.byPath.set(r.sourceRelativePath, r);
    }
  }

  // ---------- 查询 ----------

  /** query/tagCounts 的 collection 参数可能是**分组 id**（如 clippings）——解析成成员库 id 列表；普通库 id 返回 [它自己] */
  private scopeMemberIds(scope: string): string[] {
    const g = this.cfg.groups.find((x) => x.id === scope);
    return g ? [...g.collections] : [scope];
  }

  /** 分类口径由**类型**决定（按 type 不认 id，v0.14 的纪律）：rednote/web 走人工分类层
   *  （override > initial），宝贝/日记走解析派生值。过滤/计数/摘要/导出共用这一处判断。 */
  private isManagedCategory(collectionId: string): boolean {
    const t = this.colMap.get(collectionId)?.type;
    return t === 'rednote' || t === 'web';
  }

  /** 分类维（主题）的生效值：与 NoteSummary.categoryId 同一口径 */
  private categoryOf(r: NoteRecord): string | null {
    return this.isManagedCategory(r.collection)
      ? this.categories.effective(r.id).categoryId
      : (r.derivedCategory ?? null);
  }

  /** 来源维（仅 web 型）：值就是解析期的派生分类，换个位置露出，不动索引 */
  private sourceCategoryOf(r: NoteRecord): string | null {
    return this.colMap.get(r.collection)?.type === 'web' ? (r.derivedCategory ?? null) : null;
  }

  query(params: NoteQuery): NoteListResult {
    const cid = params.collection || 'rednote';
    // 组查询 = 成员合集（点「剪藏」看小红书+网页的全部笔记，搜索天然跨库）
    const members = this.scopeMemberIds(cid);
    // 归档视图要能看见源文件已消失的记录（"取消收藏已完成"那条链路），其它视图只看文件还在的
    const includeMissing = params.includeMissing === true;
    const view = params.status ?? 'active';
    let items = this.doc.notes.filter(
      (r) =>
        members.includes(r.collection) &&
        (includeMissing || r.sourceStatus === 'available') &&
        this.matchesStatus(r.id, view)
    );

    const q = (params.q ?? '').trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      // 三个来源逐词 OR：正文（索引里预处理的 searchText）、备注、识别文本。
      // 备注与识别文本都是"我们这边的加工产物"，不在 searchText 里，必须显式并进来——
      // 否则"搜自己写的备注""搜图里的字"都会搜不到，而那正是这两个功能存在的意义。
      // 注意是**每个词**各自三选一命中即可（不是"所有词命中同一个字段"）：多词 AND 的语义别改，
      // 否则"笔记一 装修"这种"一个词在正文、一个词在备注"的查询会突然失效。
      items = items.filter((r) => {
        const remark = this.annotations.remarkOf(r.id).toLowerCase();
        const recognized = this.mediaText.textFor(r.id).toLowerCase();
        return terms.every(
          (t) =>
            r.searchText.includes(t) ||
            (remark !== '' && remark.includes(t)) ||
            (recognized !== '' && recognized.includes(t))
        );
      });
    }

    // 分类维（主题）：rednote/web 走人工分类层，其余库按派生值；'uncategorized' 只作用于这一维
    if (params.categoryId === 'uncategorized') {
      items = items.filter((r) => this.categoryOf(r) === null);
    } else if (params.categoryId) {
      items = items.filter((r) => this.categoryOf(r) === params.categoryId);
    }
    // 来源维：与分类维正交（同时给 = AND）；非 web 型没有来源值，天然不命中
    if (params.source) {
      const src = params.source;
      items = items.filter((r) => this.sourceCategoryOf(r) === src);
    }

    if (params.tag) {
      const tag = params.tag;
      items = items.filter((r) => r.tags.includes(tag));
    }

    // 只看标星（与其它条件叠加：在某个分类里再筛标星是合理用法）
    if (params.starred) {
      items = items.filter((r) => this.annotations.isStarred(r.id));
    }

    if (params.range !== 'all') {
      let rangeMs: [number, number] | null;
      if (params.range === '7d') rangeMs = lastNDaysRangeMs(7);
      else if (params.range === '30d') rangeMs = lastNDaysRangeMs(30);
      else {
        if (!params.from) throw new ValidationError('自定义时间范围需要 from 参数');
        rangeMs = customRangeMs(params.from, params.to);
        if (!rangeMs) throw new ValidationError('日期格式无效，应为 YYYY-MM-DD');
      }
      const [start, end] = rangeMs;
      items = items.filter((r) => {
        const iso = params.timeField === 'published' ? r.publishedAt : r.syncedAt;
        if (!iso) return false;
        const t = Date.parse(iso);
        return Number.isFinite(t) && t >= start && t < end;
      });
    }

    const dir = params.order === 'asc' ? 1 : -1;
    items = items.slice().sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : null;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : null;
      if (ta === null && tb === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (ta === null) return 1; // null 恒排末尾
      if (tb === null) return -1;
      if (ta !== tb) return ta < tb ? -dir : dir;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const total = items.length;
    const page = items.slice(params.offset, params.offset + params.limit);
    return {
      items: page.map((r) => this.toSummary(r)),
      total,
      indexRevision: this.doc.revision,
    };
  }

  detail(id: string): NoteDetail {
    const r = this.byId.get(id);
    if (!r) throw new NotFoundError(`未找到笔记 ${id}`);
    return { ...this.toSummary(r), ...this.detailFields(r) };
  }

  hasNote(id: string): boolean {
    return this.byId.has(id);
  }

  /** 状态视图匹配：'archived' 就是归档（只有一个含义，没有细分） */
  private matchesStatus(noteId: string, view: NonNullable<NoteQuery['status']>): boolean {
    const s = this.annotations.statusOf(noteId);
    return view === 'active' ? s === 'active' : s === 'archived';
  }

  /**
   * 「工作集」判定：源文件可用且状态为在用。
   * **所有计数（分类 / 未分类 / 标星 / 标签 / 侧栏）都走这一条口径**——
   * 否则把一篇标成过期后，列表少了一篇而侧栏的数字不动，界面自相矛盾。
   */
  private inWorkSet(r: NoteRecord): boolean {
    return r.sourceStatus === 'available' && this.annotations.statusOf(r.id) === 'active';
  }

  private detailFields(r: NoteRecord): Pick<NoteDetail, 'bodyHtml' | 'media' | 'originalUrl' | 'sourceRelativePath'> {
    return {
      bodyHtml: r.bodyHtml,
      media: r.media,
      originalUrl: r.originalUrl,
      sourceRelativePath: r.sourceRelativePath,
    };
  }

  private toSummary(r: NoteRecord): NoteSummary {
    const eff = this.categories.effective(r.id);
    let cover: NoteSummary['cover'] = null;
    if (r.coverMediaId) {
      const m = r.media.find((x) => x.id === r.coverMediaId);
      if (m) {
        cover = {
          mediaId: m.id,
          url: mediaUrl(r.id, m.id),
          width: m.width ?? null,
          height: m.height ?? null,
          available: m.available !== false,
        };
      }
    }
    const managed = this.isManagedCategory(r.collection);
    const ann = this.annotations.effective(r.id);
    // 网页封面三态（JSON 里 undefined 键会消失，正好表达"还没试过"）：
    //   对象 = 已有封面；null = 试过、没有（负缓存期内，别让卡片反复探测）；
    //   undefined = 还没试过**或负缓存已过期**（网页库卡片按需探测一次——过期失败若仍钉死成 null，
    //   刷新页面/重启都不会再走 ensure 的重试，六小时 TTL 形同虚设，评审 R5）
    const wc = this.webCover.get(r.id);
    let webCover: NoteSummary['webCover'];
    if (wc && !wc.failedAt) {
      webCover = { url: `/api/web-cover/${encodeURIComponent(r.id)}`, durationSec: wc.durationSec };
    } else if (wc && wc.failedAt && !this.webCover.negativeExpired(wc.failedAt)) {
      webCover = null;
    } else {
      webCover = undefined;
    }
    return {
      id: r.id,
      collection: r.collection,
      title: r.title,
      excerpt: r.excerpt,
      author: r.author,
      tags: r.tags,
      publishedAt: r.publishedAt,
      syncedAt: r.syncedAt,
      categoryId: managed ? eff.categoryId : r.derivedCategory ?? null,
      categorySource: managed ? eff.source : 'derived',
      sourceCategory: this.sourceCategoryOf(r),
      mediaCount: r.media.filter((m) => m.kind === 'image').length,
      hasVideo: r.media.some((m) => m.kind === 'video'),
      cover,
      sourceStatus: r.sourceStatus,
      webCover,
      annotation: {
        starred: ann.starred,
        starredAt: ann.starredAt,
        status: ann.status,
        remark: ann.remark,
      },
      extra: r.extra,
    };
  }

  /** 单个收藏库信息（分类：rednote 走 seed，其余按派生值计数；表格字段按 extra 出现率） */
  collectionInfo(cid: string): CollectionInfo | null {
    const def = this.colMap.get(cid);
    if (!def) return null;
    const recs = this.doc.notes.filter((r) => r.collection === cid && r.sourceStatus === 'available');
    // 计数一律用工作集（见 inWorkSet 的说明），total 仍表示"文件还在的全部篇数"
    const work = recs.filter((r) => this.inWorkSet(r));
    const archived = this.doc.notes.filter(
      (r) => r.collection === cid && this.annotations.statusOf(r.id) !== 'active'
    ).length;
    const catMap = new Map<string, number>();
    let uncategorized = 0;
    const extraCount = new Map<string, number>();
    const managed = this.isManagedCategory(cid);
    if (managed) {
      const { counts, uncategorized: u } = this.categories.countEffective(work.map((r) => r.id));
      for (const [k, v] of Object.entries(counts)) catMap.set(k, v);
      uncategorized = u;
    } else {
      for (const r of work) {
        const c = r.derivedCategory;
        if (c) catMap.set(c, (catMap.get(c) ?? 0) + 1);
        else uncategorized++;
      }
    }
    if (def.type === 'treasures') {
      for (const r of work) {
        for (const k of Object.keys(r.extra ?? {})) extraCount.set(k, (extraCount.get(k) ?? 0) + 1);
      }
    }
    const categories: CollectionInfo['categories'] = managed
      ? this.categories.categories
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((c) => ({ id: c.id, name: c.name, count: catMap.get(c.id) ?? 0 }))
      : [...catMap.entries()]
          .map(([name, count]) => ({ id: name, name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    // 来源维：只有 web 型有（值=解析期派生）；不给"无来源"留行——手写笔记本来就没有来源
    const sourceCounts = new Map<string, number>();
    if (def.type === 'web') {
      for (const r of work) {
        const src = r.derivedCategory;
        if (src) sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
      }
    }
    const sources: CollectionInfo['sources'] = [...sourceCounts.entries()]
      .map(([name, count]) => ({ id: name, name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const extraFields: ExtraFieldInfo[] = [...extraCount.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
    const starred = this.annotations.countStarred(work.map((r) => r.id));
    return {
      id: def.id,
      name: def.name,
      // 前端按 type 而不是 id 决定解析相关的展示（网页列 / 卡片底片与封面探测）——
      // 微信公众号库与网页库同为 web 类型，硬编码 id 会让它整块失效
      type: def.type,
      total: recs.length,
      active: work.length,
      archived,
      uncategorized,
      starred,
      categories,
      sources,
      extraFields,
    };
  }

  /** 全部收藏库信息 */
  collectionInfos(): CollectionInfo[] {
    return this.cfg.collections
      .map((c) => this.collectionInfo(c.id))
      .filter((x): x is CollectionInfo => x !== null);
  }

  /** 分组的聚合信息：标量与两维计数都从成员 collectionInfo **按 id 求和**——
   *  组数字必须等于成员数字之和（另起一套算法就会出现"同一页两套数字"）。
   *  v0.16 起分类/来源也聚合：三个成员库共用类目表后组级主题在语义上成立，
   *  v0.12 的"组视图不显示分类/来源"决策随之撤销（用户批准）。 */
  groupInfo(gid: string): CollectionGroupInfo | null {
    const g = this.cfg.groups.find((x) => x.id === gid);
    if (!g) return null;
    const agg = { total: 0, active: 0, archived: 0, starred: 0, uncategorized: 0 };
    const catMap = new Map<string, CategoryCount>();
    const srcMap = new Map<string, CategoryCount>();
    const bump = (map: Map<string, CategoryCount>, rows: CategoryCount[]): void => {
      for (const row of rows) {
        const hit = map.get(row.id);
        if (hit) hit.count += row.count;
        else map.set(row.id, { ...row });
      }
    };
    for (const cid of g.collections) {
      const info = this.collectionInfo(cid);
      if (!info) continue;
      agg.total += info.total;
      agg.active += info.active;
      agg.archived += info.archived;
      agg.starred += info.starred;
      agg.uncategorized += info.uncategorized;
      bump(catMap, info.categories);
      bump(srcMap, info.sources);
    }
    // 分类顺序对齐类目表 order（派生型动态行排最后）；来源按数量降序——两处都与单库口径一致
    const orderOf = new Map(this.categories.categories.map((c) => [c.id, c.order]));
    const categories = [...catMap.values()].sort(
      (a, b) =>
        (orderOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN')
    );
    const sources = [...srcMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN')
    );
    return { id: g.id, name: g.name, collectionIds: [...g.collections], ...agg, categories, sources };
  }

  /** 全部分组信息（侧栏两级用） */
  groupInfos(): CollectionGroupInfo[] {
    return this.cfg.groups
      .map((g) => this.groupInfo(g.id))
      .filter((x): x is CollectionGroupInfo => x !== null);
  }

  // ---------- 语料导出（plan §18.3）----------

  /** catalog.md 的分类顺序与 id→name 映射直接复用侧栏口径，两边不会打架 */
  private corpusCollections(): CorpusCollectionMeta[] {
    return this.cfg.collections.map((def) => ({
      id: def.id,
      name: def.name,
      categories: (this.collectionInfo(def.id)?.categories ?? []).map((c) => ({ id: c.id, name: c.name })),
    }));
  }

  private corpusCategoryOf(r: NoteRecord): {
    id: string | null;
    source: NoteSummary['categorySource'];
    sourceCategory: string | null;
  } {
    if (this.isManagedCategory(r.collection)) {
      const eff = this.categories.effective(r.id);
      return { id: eff.categoryId, source: eff.source, sourceCategory: this.sourceCategoryOf(r) };
    }
    return { id: r.derivedCategory ?? null, source: 'derived', sourceCategory: null };
  }

  /**
   * 语料用的全部记录：**含已归档与源文件已消失的**。
   * 归档不等于删除（"现在对我来说没用了"，但笔记还是我的），源文件消失也不该让语料凭空少一篇；
   * 由 status / sourceStatus 字段交给外部管道自己决定要不要用。
   */
  corpusRecords(): CorpusRecord[] {
    return buildCorpusRecords(this.doc.notes, {
      collections: this.corpusCollections(),
      categoryIdOf: (r) => this.corpusCategoryOf(r),
      annotationOf: (id) => this.annotations.effective(id),
      // 识别文本（OCR/转录）在这里进入语料——这也是"识别能力接进来就是往里填"的那一步
      recognizedOf: (id) => this.mediaText.recognizedOf(id),
    });
  }

  /** 导出语料（corpus.jsonl / catalog.md / manifest.json）；内容没变时不写盘 */
  async exportCorpus(): Promise<CorpusExportResult> {
    // **串行化**：手动点「导出语料」可能正好撞上刷新后的自动导出。两个导出并发时
    // 临时文件名可能相同（同进程同毫秒）、manifest 的读-改-写也会互相覆盖，
    // 结果是半截的 corpus.jsonl（深审发现）。串起来后第二次通常是"内容未变 → 跳过"。
    return this.corpusQueue(async () =>
      writeCorpus({
        dir: this.cfg.exportDir,
        vaultRoot: this.cfg.vaultRoot,
        records: this.corpusRecords(),
        collections: this.corpusCollections(),
        meta: {
          app: this.cfg.app,
          appVersion: this.cfg.version,
          contentSource: this.cfg.vaultRoot,
          indexRevision: this.doc.revision,
          annotationRevision: this.annotations.revision,
          categoryRevision: this.categories.revision,
          parseVersion: PARSE_VERSION,
        },
      })
    ).then((result) => {
      log.info(
        result.written
          ? `语料导出完成: ${result.manifest.counts.total} 篇 → ${result.dir}`
          : '语料导出: 内容未变，跳过写入'
      );
      return result;
    });
  }

  /** 语料导出的写队列（见 exportCorpus 的说明） */
  private corpusQueue: <T>(fn: () => Promise<T>) => Promise<T> = (() => {
    let queue: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(fn);
      queue = run.catch(() => undefined);
      return run;
    };
  })();

  /** 上次导出的 manifest（读盘，重启后仍能看到）；从未导出或文件坏了返回 null */
  corpusManifest(): CorpusManifest | null {
    return readCorpusManifest(this.cfg.exportDir);
  }

  /** 导出目录（前端提示"文件在哪"用） */
  get corpusDir(): string {
    return this.cfg.exportDir;
  }

  // ---------- 识别文本（OCR / 转录，plan §18.2）----------

  /** 某笔记已有的识别文本（供详情面板展示） */
  mediaTextFor(noteId: string): RecognizedText[] {
    return this.mediaText.recognizedOf(noteId);
  }

  /** 该笔记里"可以识别的本地图片"（按笔记内出现顺序）；界面上按钮的可用性看它 */
  ocrTargets(noteId: string): MediaItem[] {
    const r = this.byId.get(noteId);
    if (!r) return [];
    return r.media.filter((m) => m.kind === 'image' && m.localRelativePath && m.available !== false);
  }

  /** 该笔记里"可以转录的本地音频"（flomo 语音；按出现顺序） */
  asrTargets(noteId: string): MediaItem[] {
    const r = this.byId.get(noteId);
    if (!r) return [];
    return r.media.filter((m) => m.kind === 'audio' && m.localRelativePath && m.available !== false);
  }

  /**
   * 把媒体解析成绝对路径，并做越界防护（与媒体路由同一条判据）。
   * 越界/缺失返回 null——OCR 要读磁盘，绝不能让登记的相对路径指到 vault 外面去。
   */
  private resolveMediaAbs(rel: string): string | null {
    const root = path.resolve(this.cfg.vaultRoot);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  /**
   * 按需识别一篇笔记的图片文字。
   * - 不传 mediaId = 识别这篇里还没有结果的图片（受 maxPerNote 限制）；
   * - 传了就只识别那一张；
   * - **命中内容 hash 缓存的不再调用模型**，只补一条 ref（同一张图被两篇引用时走这里）；
   * - shouldStop = 客户端断开/主动取消的信号：不再开新的调用，在途的自然收尾。
   */
  async ocrNote(
    noteId: string,
    opts: { mediaId?: string; shouldStop?: () => boolean } = {}
  ): Promise<OcrRunResult> {
    const r = this.byId.get(noteId);
    if (!r) throw new NotFoundError(`未找到笔记 ${noteId}`);

    const cfg = aiVisionConfigFromEnv();
    const allTargets = this.ocrTargets(noteId);
    const targets = opts.mediaId ? allTargets.filter((m) => m.id === opts.mediaId) : allTargets;
    if (opts.mediaId && targets.length === 0) {
      throw new ValidationError(`这篇笔记里没有可识别的本地图片：${opts.mediaId}`);
    }

    const results: OcrRunResult['results'] = [];
    /**
     * 待识别判定**按内容 hash，不按 mediaId**：早先用 `hasFor(noteId, mediaId)` 跳过，
     * 于是"文件在同名路径上被换掉"（重新同步、手动替换）时永远拿旧文本——内容 hash 缓存根本没被问到。
     * 现在每张都读盘算 hash：hash 命中就复用（不花钱），否则才调模型。
     * **上限只约束真正调用模型的张数**：命中缓存的不花额度，没理由占名额。
     */
    let modelBudget = cfg ? cfg.maxPerNote : 1;

    if (!cfg) {
      const first = targets[0];
      if (first) results.push({ mediaId: first.id, ok: false, cached: false, reason: '未配置 AI 凭据（AI_CLASSIFY_API_KEY）' });
      // remaining 按**这篇整体**算（与成功路径同一口径），不能按本次请求的目标数
      const left = allTargets.filter((m) => !this.mediaText.hasFor(noteId, m.id)).length;
      return { noteId, results, recognized: this.mediaTextFor(noteId), remaining: left, model: null };
    }

    for (const m of targets) {
      // 客户端断开/主动取消：不再开新的模型调用（在途的那次会自然结束并落缓存）
      if (opts.shouldStop?.()) break;
      if (modelBudget <= 0) break;
      const abs = this.resolveMediaAbs(m.localRelativePath!);
      if (!abs) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体路径越界，已拒绝读取' });
        continue;
      }
      // 媒体可能在读盘/调用期间随刷新被移出这篇笔记；落盘前都要复核，否则写出孤儿 ref（深审发现）
      const stillThere = (): boolean => !!this.byId.get(noteId)?.media.some((x) => x.id === m.id);
      // 先 stat + 文件头嗅探，白名单过了再整读：旧顺序是"无上限同步整读、读完才判类型"，
      // 一个被登记成图片的大文件（zip、截断文件）会先把内存吃满（深审发现）
      const size = mediaFileSize(abs);
      if (size === null) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件读不到' });
        continue;
      }
      if (size === 0) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件是空的' });
        continue;
      }
      if (size > MAX_OCR_IMAGE_BYTES) {
        results.push({
          mediaId: m.id,
          ok: false,
          cached: false,
          reason: `图片过大（${(size / 1048576).toFixed(1)} MB，上限 10 MB），跳过识别`,
        });
        continue;
      }
      const mime = sniffImageMime(abs);
      if (!mime || !OCR_IMAGE_MIMES.has(mime)) {
        results.push({
          mediaId: m.id,
          ok: false,
          cached: false,
          reason: mime ? `暂不支持识别 ${mime}（支持 webp / png / jpg / gif / bmp）` : '不是可识别的图片',
        });
        continue;
      }
      const bytes = await readMediaBytes(abs, MAX_OCR_IMAGE_BYTES);
      if (!bytes) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件读不到' });
        continue;
      }

      const hash = mediaHashOf(bytes);
      const cached = this.mediaText.get(hash);
      if (cached) {
        // 同一份文件以前算过（无论哪篇笔记算的）：只补 ref，不再调模型。
        // putIfPresent 而不是 put：判断与落盘之间用户可能已点删除，别把删掉的复活（深审发现）
        if (stillThere()) {
          await this.mediaText.putIfPresent({ ...cached, refs: [{ noteId, mediaId: m.id }] });
          results.push({ mediaId: m.id, ok: true, cached: true, text: cached.text });
        } else {
          results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体已随刷新移出这篇笔记' });
        }
        continue;
      }

      // 单飞：同一张图的并发识别共享一次模型调用——第二个请求不再各花一次钱（深审发现双倍花费）
      const flight = this.ocrFlights.get(hash);
      if (flight) {
        const joined = await flight.then(
          (x) => x,
          () => ({ ok: false as const, reason: '并发识别中断，请重试' })
        );
        if (joined.ok && stillThere()) {
          const now = this.mediaText.get(hash);
          if (now) {
            await this.mediaText.putIfPresent({ ...now, refs: [{ noteId, mediaId: m.id }] });
            results.push({ mediaId: m.id, ok: true, cached: true, text: now.text });
            continue;
          }
        }
        results.push({
          mediaId: m.id,
          ok: false,
          cached: true,
          reason: joined.ok ? '识别结果刚被删除，请重试' : joined.reason,
        });
        continue;
      }

      modelBudget--; // 只有真正发起调用才占名额（命中缓存/共享在途调用的不花额度）
      // 单飞的门要等**落盘完成**才开：只等模型的话，"模型已回、缓存还没提交"的窗口里，
      // 第二个请求缓存未命中、单飞表也已摘除，照样再打一次模型——实测就是这么双倍花费的。
      let release!: (v: OcrFlightOutcome) => void;
      const gate = new Promise<OcrFlightOutcome>((r) => {
        release = r;
      });
      this.ocrFlights.set(hash, gate);
      let settled: OcrFlightOutcome = { ok: false, reason: '识别中断，请重试' };
      try {
        const out = await ocrImage(cfg, { bytes, mime });
        settled = out.ok ? { ok: true, text: out.text, model: out.model, usage: out.usage } : { ok: false, reason: out.reason };
        if (settled.ok) {
          if (!stillThere()) {
            settled = { ok: false, reason: '媒体已随刷新移出这篇笔记' };
          } else {
            // 同一张图被换过内容时，先把指向这个 mediaId 的**旧结果**摘掉，
            // 否则新旧两条都挂在同一个 mediaId 上：界面会出现两条"图 N"，数字也对不上。
            const stale = this.mediaText
              .forNote(noteId)
              .some((e) => e.mediaHash !== hash && e.refs.some((r) => r.noteId === noteId && r.mediaId === m.id));
            if (stale) await this.mediaText.removeRef(noteId, m.id);
            await this.mediaText.put({
              mediaHash: hash,
              kind: 'ocr',
              text: settled.text,
              model: settled.model,
              at: new Date().toISOString(),
              refs: [{ noteId, mediaId: m.id }],
              usage: settled.usage,
            });
          }
        }
      } finally {
        // 先摘表（新来者会走缓存命中，因为 put 已提交）、再放行等待者；任何一步抛错都要放行
        this.ocrFlights.delete(hash);
        release(settled);
      }

      if (!settled.ok) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: settled.reason });
        continue;
      }
      results.push({ mediaId: m.id, ok: true, cached: false, text: settled.text });
    }

    const okCount = results.filter((x) => x.ok).length;
    if (okCount) {
      log.info(`OCR 完成: ${noteId} 识别 ${okCount} 张（缓存 ${results.filter((x) => x.cached).length} 张）`);
    }
    // 处理完之后再数：**这篇笔记整体还剩几张没识别**，与"本次请求了几张"无关——
    // 界面按这个数显示「识别其余 N 张」，按请求批次算会显示成 0，那是错的。
    const remaining = allTargets.filter((m) => !this.mediaText.hasFor(noteId, m.id)).length;
    return { noteId, results, recognized: this.mediaTextFor(noteId), remaining, model: cfg.model };
  }

  /** 删掉某笔记某张图的识别结果（识别错了想重来）；返回是否删掉了 */
  async clearMediaText(noteId: string, mediaId: string): Promise<boolean> {
    return this.mediaText.removeRef(noteId, mediaId);
  }

  /** 单飞表：同内容 hash 的并发 OCR 共享一次模型调用（键为内容 hash，完成后即摘） */
  private ocrFlights = new Map<string, Promise<OcrFlightOutcome>>();

  /** 单飞表（转录）：同内容 hash 的并发转录共享一次模型调用；门要等落盘完成才开（与 OCR 同理） */
  private asrFlights = new Map<string, Promise<AsrFlightOutcome>>();

  /**
   * 按需转录一篇笔记的本地音频（plan §18.2 下半）。结构与 ocrNote 同构：
   * - 不传 mediaId = 转录还没有结果的段（受 AI_ASR_MAX_PER_NOTE 限制，按秒计费必须有上限）；
   * - **缓存键是原始音频的内容 hash**（m4a 原文件），转码产物不落盘——media-text 挡住重复付费；
   * - 网关只收 wav/mp3：其它格式在单飞门内先 ffmpeg 转码（并发只转一次）。
   */
  async transcribeNote(
    noteId: string,
    opts: { mediaId?: string; shouldStop?: () => boolean } = {}
  ): Promise<OcrRunResult> {
    const r = this.byId.get(noteId);
    if (!r) throw new NotFoundError(`未找到笔记 ${noteId}`);

    const cfg = aiAsrConfigFromEnv();
    const allTargets = this.asrTargets(noteId);
    const targets = opts.mediaId ? allTargets.filter((m) => m.id === opts.mediaId) : allTargets;
    if (opts.mediaId && targets.length === 0) {
      throw new ValidationError(`这篇笔记里没有可转录的本地音频：${opts.mediaId}`);
    }

    const results: OcrRunResult['results'] = [];
    let modelBudget = cfg ? cfg.maxPerNote : 1;

    if (!cfg) {
      const first = targets[0];
      if (first) results.push({ mediaId: first.id, ok: false, cached: false, reason: '未配置 AI 凭据（AI_CLASSIFY_API_KEY）' });
      const left = allTargets.filter((m) => !this.mediaText.hasFor(noteId, m.id)).length;
      return { noteId, results, recognized: this.mediaTextFor(noteId), remaining: left, model: null };
    }

    for (const m of targets) {
      if (opts.shouldStop?.()) break;
      if (modelBudget <= 0) break;
      const abs = this.resolveMediaAbs(m.localRelativePath!);
      if (!abs) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体路径越界，已拒绝读取' });
        continue;
      }
      const stillThere = (): boolean => !!this.byId.get(noteId)?.media.some((x) => x.id === m.id);
      const size = mediaFileSize(abs);
      if (size === null) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件读不到' });
        continue;
      }
      if (size === 0) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件是空的' });
        continue;
      }
      if (size > MAX_ASR_AUDIO_BYTES) {
        results.push({
          mediaId: m.id,
          ok: false,
          cached: false,
          reason: `音频过大（${(size / 1048576).toFixed(1)} MB，上限 50 MB），跳过转录`,
        });
        continue;
      }
      const bytes = await readMediaBytes(abs, MAX_ASR_AUDIO_BYTES);
      if (!bytes) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件读不到' });
        continue;
      }

      const hash = mediaHashOf(bytes);
      const cached = this.mediaText.get(hash);
      if (cached) {
        // 同一段音频以前转过（无论哪篇引用）：只补 ref；已被删除的不复活（putIfPresent）
        if (stillThere()) {
          await this.mediaText.putIfPresent({ ...cached, refs: [{ noteId, mediaId: m.id }] });
          results.push({ mediaId: m.id, ok: true, cached: true, text: cached.text });
        } else {
          results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体已随刷新移出这篇笔记' });
        }
        continue;
      }

      const flight = this.asrFlights.get(hash);
      if (flight) {
        const joined = await flight.then(
          (x) => x,
          () => ({ ok: false as const, reason: '并发转录中断，请重试' })
        );
        if (joined.ok && stillThere()) {
          const now = this.mediaText.get(hash);
          if (now) {
            await this.mediaText.putIfPresent({ ...now, refs: [{ noteId, mediaId: m.id }] });
            results.push({ mediaId: m.id, ok: true, cached: true, text: now.text });
            continue;
          }
        }
        results.push({
          mediaId: m.id,
          ok: false,
          cached: true,
          reason: joined.ok ? '转录结果刚被删除，请重试' : joined.reason,
        });
        continue;
      }

      modelBudget--; // 只有真正发起调用才占名额（命中缓存/共享在途的不花额度）
      let release!: (v: AsrFlightOutcome) => void;
      const gate = new Promise<AsrFlightOutcome>((r2) => {
        release = r2;
      });
      this.asrFlights.set(hash, gate);
      let settled: AsrFlightOutcome = { ok: false, reason: '转录中断，请重试' };
      try {
        // 网关只收 wav/mp3：m4a 等先本地转码——放在单飞门内，等的那一位连转码都只做一次
        let format: AudioFormat | null = sniffAudioFormat(bytes);
        let sendBytes = bytes;
        if (!format) {
          if (!(await ffmpegAvailable())) {
            settled = {
              ok: false,
              reason: '服务端缺少 ffmpeg，无法转码 m4a 等格式（生产镜像已内置；本机开发请安装 ffmpeg）',
            };
          } else {
            const mp3 = await transcodeToMp3(abs);
            if (!mp3) {
              settled = { ok: false, reason: '音频转码失败（ffmpeg 处理不了这个文件）' };
            } else {
              sendBytes = mp3;
              format = 'mp3';
            }
          }
        }
        if (format) {
          const out = await transcribeAudio(cfg, { bytes: sendBytes, format });
          if (!out.ok) {
            settled = { ok: false, reason: out.reason };
          } else if (!stillThere()) {
            settled = { ok: false, reason: '媒体已随刷新移出这篇笔记' };
          } else {
            // 同一段音频被换过内容时，先摘掉指向这个 mediaId 的旧结果（与 OCR 同一条纪律）
            const stale = this.mediaText
              .forNote(noteId)
              .some((e) => e.mediaHash !== hash && e.refs.some((x) => x.noteId === noteId && x.mediaId === m.id));
            if (stale) await this.mediaText.removeRef(noteId, m.id);
            await this.mediaText.put({
              mediaHash: hash,
              kind: 'asr',
              text: out.text,
              model: out.model,
              at: new Date().toISOString(),
              refs: [{ noteId, mediaId: m.id }],
              usage: out.usage,
            });
            settled = { ok: true, text: out.text, model: out.model, usage: out.usage };
          }
        }
      } finally {
        // 先摘表（新来者会走缓存命中，put 已提交）、再放行等待者；任何一步抛错都要放行
        this.asrFlights.delete(hash);
        release(settled);
      }

      if (!settled.ok) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: settled.reason });
        continue;
      }
      results.push({ mediaId: m.id, ok: true, cached: false, text: settled.text });
    }

    const okCount = results.filter((x) => x.ok).length;
    if (okCount) {
      log.info(`ASR 完成: ${noteId} 转录 ${okCount} 段（缓存 ${results.filter((x) => x.cached).length} 段）`);
    }
    // 与 OCR 同口径：按**这篇整体**还剩几段没算，而不是本次请求了几段
    const remaining = allTargets.filter((m) => !this.mediaText.hasFor(noteId, m.id)).length;
    return { noteId, results, recognized: this.mediaTextFor(noteId), remaining, model: cfg.model };
  }

  /** 识别文本条数（页面诊断/信息展示用） */
  get mediaTextEntryCount(): number {
    return this.mediaText.entryCount;
  }

  /**
   * 确保某篇的网页封面存在（B 站走 API、其它站点取正文首图），返回可直接下发的文件信息。
   * 抓取失败/无来源返回 null——**永不报错**，卡片拿不到图就不显示图。
   */
  async ensureWebCover(noteId: string): Promise<{ abs: string; contentType: string } | null> {
    const rec = this.byId.get(noteId);
    if (!rec) throw new NotFoundError(`未找到笔记 ${noteId}`);
    await this.webCover.ensure(rec);
    const abs = this.webCover.filePathOf(noteId);
    if (!abs) return null;
    const entry = this.webCover.get(noteId);
    return { abs, contentType: entry?.contentType ?? 'image/jpeg' };
  }

  /** 封面元信息（时长等；给卡片的 &meta=1 轻量探测用） */
  webCoverMeta(noteId: string): { durationSec: number | null } | null {
    const e = this.webCover.get(noteId);
    if (!e || e.failedAt) return null;
    return { durationSec: e.durationSec };
  }

  libraryInfo(): LibraryInfo {
    // 顶层字段保持 rednote 口径（兼容）；前端以 collections 为准。
    // **口径必须与 collectionInfo 一致（工作集）**：否则归档一篇之后，顶层的分类计数不动、
    // 而 collections 里的动，"同一页上两套数字"正是这条纪律要避免的（深审发现）。
    const rnIds = this.doc.notes.filter((n) => n.collection === 'rednote' && this.inWorkSet(n)).map((n) => n.id);
    const { counts, uncategorized } = this.categories.countEffective(rnIds);
    const cats: Category[] = this.categories.categories;
    return {
      app: this.cfg.app,
      version: this.cfg.version,
      total: this.doc.notes.length,
      uncategorized,
      collections: this.collectionInfos(),
      groups: this.groupInfos(),
      categories: cats
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, count: counts[c.id] ?? 0 })),
      lastScan: this.doc.lastScan,
      indexRevision: this.doc.revision,
      categoryRevision: this.categories.revision,
      annotationRevision: this.annotations.revision,
      mediaTextRevision: this.mediaText.revision,
      indexStatus:
        this.scansPending > 0 || this.job?.state === 'running'
          ? 'scanning'
          : this.doc.notes.length > 0
            ? 'ready'
            : 'empty',
      diagnostics: [...this.bootDiagnostics, ...this.doc.diagnostics].slice(0, 50),
    };
  }

  listCategories(): Category[] {
    return this.categories.categories.slice().sort((a, b) => a.order - b.order);
  }

  private tagCountCache: Map<string, { indexRevision: number; annotationRevision: number; tags: TagCount[] }> =
    new Map();

  /** 指定收藏库（或分组）的标签与使用次数（按次数降序），按索引 + 标注两个 revision 缓存 */
  tagCounts(scope = 'rednote'): TagCount[] {
    // 组查询跨成员聚合（剪藏组 = 小红书 + 网页的标签合在一起）；缓存键用成员列表而不是原始参数，
    // 这样"同名组"与"同名库"不会串（配置校验已禁止撞名，这里再兜一层）
    const members = this.scopeMemberIds(scope);
    const key = members.join('\u0001');
    const cached = this.tagCountCache.get(key);
    // 标注 revision 必须一起参与缓存键：改状态会让条目标签计数变化，而索引 revision 不动
    if (cached && cached.indexRevision === this.doc.revision && cached.annotationRevision === this.annotations.revision) {
      return cached.tags;
    }
    const m = new Map<string, number>();
    for (const r of this.doc.notes) {
      // 与列表同一口径：归档/源文件消失的条目不参与标签计数
      if (!this.inWorkSet(r) || !members.includes(r.collection)) continue;
      for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    const tags = [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
    this.tagCountCache.set(key, {
      indexRevision: this.doc.revision,
      annotationRevision: this.annotations.revision,
      tags,
    });
    return tags;
  }

  // ---------- 分类修改 ----------

  async setCategory(
    noteId: string,
    categoryId: string | null,
    expectedRevision: number
  ): Promise<{ revision: number; categoryId: string | null; source: 'override' | 'initial' | 'none' }> {
    const rec = this.byId.get(noteId);
    if (!rec) throw new NotFoundError(`未找到笔记 ${noteId}`);
    // rednote 与 web 型（网页/微信公众号）共用人工分类层；宝贝/日记的分类来自 Obsidian 笔记本身，不许在这里改
    if (!this.isManagedCategory(rec.collection)) {
      throw new ValidationError('该收藏库不支持在网页中修改分类（宝贝/日记的分类以 Obsidian 笔记为准）');
    }
    const revision = await this.categories.setOverride(noteId, categoryId, expectedRevision);
    const eff = this.categories.effective(noteId);
    return { revision, categoryId: eff.categoryId, source: eff.source };
  }

  // ---------- 人工标注（星标 / 状态 / 备注） ----------

  /**
   * 改一条笔记的人工标注（星标 / 状态），一次写盘合并所有出现的字段，返回新 revision。
   * 星标是卡片上的单字段幂等动作，可不传 expectedRevision（连点不会互相冲突）；
   * 状态是在详情面板里"看一眼再改"的编辑，带 revision——冲突返 409 让前端重新读一次。
   */
  async setAnnotation(
    noteId: string,
    patch: { star?: boolean; status?: 'archived' | null; remark?: string | null },
    expectedRevision?: number
  ): Promise<{ revision: number; starred: boolean; status: NoteStatus; remark: string | null }> {
    if (!this.byId.has(noteId)) throw new NotFoundError(`未找到笔记 ${noteId}`);
    const revision = await this.annotations.patch(noteId, patch, expectedRevision);
    return {
      revision,
      starred: this.annotations.isStarred(noteId),
      status: this.annotations.statusOf(noteId),
      remark: this.annotations.remarkOf(noteId) || null,
    };
  }

  /**
   * 批量归档 / 取回 / 标星。只处理索引里真实存在的 id（不存在的静默跳过，返回实际改动条数），
   * 一次写盘、一次 revision。
   */
  async setAnnotationMany(
    ids: string[],
    patch: { star?: boolean; status?: 'archived' | null }
  ): Promise<{ revision: number; updated: number }> {
    const known = ids.filter((id) => this.byId.has(id));
    if (known.length === 0) return { revision: this.annotations.revision, updated: 0 };
    return this.annotations.patchMany(known, patch);
  }

  /** 标星 / 取消标星。三个收藏库都可标（个人标注，不像分类那样受"以笔记为准"限制） */
  async setStar(
    noteId: string,
    star: boolean,
    expectedRevision?: number
  ): Promise<{ revision: number; starred: boolean }> {
    const out = await this.setAnnotation(noteId, { star }, expectedRevision);
    return { revision: out.revision, starred: out.starred };
  }

  /** 写备注（纯文本；传 null 或空串即清空）。与状态一样带 expectedRevision */
  async setRemark(
    noteId: string,
    remark: string | null,
    expectedRevision: number
  ): Promise<{ revision: number; remark: string | null }> {
    const out = await this.setAnnotation(noteId, { remark }, expectedRevision);
    return { revision: out.revision, remark: out.remark };
  }

  /** 改状态：在用（传 null）/ 已过期 / 已取消收藏。三个收藏库都可改 */
  async setStatus(
    noteId: string,
    status: Exclude<NoteStatus, 'active'> | null,
    expectedRevision: number
  ): Promise<{ revision: number; status: NoteStatus }> {
    const out = await this.setAnnotation(noteId, { status }, expectedRevision);
    return { revision: out.revision, status: out.status };
  }

  // ---------- 刷新 ----------

  /** 启动时自动刷一次（AUTO_REFRESH_ON_BOOT，默认开）：与手动刷新共用同一条单飞/任务/落盘链路，
   *  只是触发者是启动流程——关闭开关返回 null，不建 job。 */
  startBootRefresh(): RefreshJobInfo | null {
    if (!this.cfg.autoRefreshOnBoot) return null;
    return this.startRefresh();
  }

  startRefresh(): RefreshJobInfo {
    if (this.job && this.job.state === 'running') return this.toJobInfo(this.job);
    const job: InternalRefreshJob = {
      jobId: crypto.randomUUID(),
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      diagnostics: [],
      cancelled: false,
    };
    this.job = job;
    void this.runScan('refresh', job).catch((e) => {
      job.state = 'failed';
      job.finishedAt = new Date().toISOString();
      job.diagnostics.push(`刷新失败: ${(e as Error).message}`);
    });
    return this.toJobInfo(job);
  }

  getRefreshJob(jobId: string): RefreshJobInfo | null {
    if (!this.job || this.job.jobId !== jobId) return null;
    return this.toJobInfo(this.job);
  }

  get latestJob(): RefreshJobInfo | null {
    return this.job ? this.toJobInfo(this.job) : null;
  }

  private toJobInfo(j: InternalRefreshJob): RefreshJobInfo {
    const { cancelled: _c, ...info } = j;
    void _c;
    return { ...info, diagnostics: info.diagnostics.slice(0, 50) };
  }

  /** 扫描并在成功持久化后切换内存索引。initial 模式用于首次启动。所有扫描经 scanChain 串行。 */
  /** 排队中 + 运行中的扫描数。启动扫描不建 job，此前 indexStatus 全程 'empty'，前端据此判定"不用轮询"，
   * 扫完也没有任何东西会重拉列表——开机全量重建后界面停在空库（深审发现）。 */
  private scansPending = 0;

  private async runScan(mode: 'initial' | 'refresh', job?: InternalRefreshJob): Promise<void> {
    this.scansPending++; // 入链之前就计数：排队中的扫描也算"在忙"，间隙里状态不许闪回 ready
    try {
      const p = this.scanChain.then(() => this.doScan(mode, job));
      this.scanChain = p.catch(() => undefined);
      return await p;
    } finally {
      this.scansPending--;
    }
  }

  /**
   * 刷新后的自动分类：只补「无任何分类依据」的笔记（rednote 与 web 型——网页/微信公众号，
   * v0.15.0 起两库共用同一份类目表与同一条管道；宝贝/日记的分类来自笔记本身，不参与）。
   * 规则（classify.ts，v0.3.0 人工沉淀的三层规则）优先，未命中且配置了 AI 时走 AI 兜底；
   * 都不行就保持未分类。全程只写 initialAssignments，人工覆盖（overrides.json）永不触碰。
   */
  private async autoClassify(notes: NoteRecord[], job?: InternalRefreshJob): Promise<string | null> {
    const targets = notes.filter((n) => {
      const t = this.colMap.get(n.collection)?.type;
      return (t === 'rednote' || t === 'web') && n.sourceStatus === 'available';
    });
    if (targets.length === 0) return null;
    const aiCfg = aiClassifyConfigFromEnv();
    const validIds = new Set(this.categories.categories.map((c) => c.id));
    let byRule = 0;
    let byAi = 0;
    let aiAttempted = 0;
    let aiDeferred = 0;
    const result = await this.categories.ensureClassified(
      targets.map((n) => ({ id: n.id, title: n.title, tags: n.tags, excerpt: n.excerpt })),
      async (item) => {
        const rule = classifyByRules(item.id, item.title, item.tags);
        if (rule) {
          byRule++;
          return rule;
        }
        if (!aiCfg) return null;
        // 上限保护按「发出的请求」计数，失败也占额度——失败响应同样发过请求（可能已计费），
        // 不占额度的话模型持续返回无效/供应商故障时，一次刷新会把全部待分类笔记都打出去
        if (aiAttempted >= aiCfg.maxPerRefresh) {
          aiDeferred++;
          return null;
        }
        aiAttempted++;
        const rec = this.byId.get(item.id);
        const subject =
          this.colMap.get(rec?.collection ?? '')?.type === 'web' ? '这条网页剪藏（文章）' : '这条小红书笔记';
        const hit = await classifyByAi(aiCfg, item, validIds, {
          subject,
          categories: this.categories.categories,
        });
        if (hit) byAi++;
        return hit;
      }
    );
    const aiFailed = aiAttempted - byAi;
    if (result.assigned === 0 && aiDeferred === 0 && aiFailed === 0) return null;
    const deferred = aiDeferred > 0 ? `；AI 本次上限 ${aiCfg?.maxPerRefresh} 次，剩余 ${aiDeferred} 篇留待下次刷新` : '';
    const failed = aiFailed > 0 ? `，AI 无效响应 ${aiFailed} 次` : '';
    const msg = `自动分类 ${result.assigned} 篇（规则 ${byRule}${aiCfg ? ` / AI ${byAi}` : ''}），未分类 ${result.unclassified.length} 篇${failed}${deferred}`;
    log.info(msg);
    if (job) job.diagnostics.push(msg);
    return msg;
  }

  private async doScan(mode: 'initial' | 'refresh', job?: InternalRefreshJob): Promise<void> {
    const startedAt = new Date();
    if (mode === 'refresh') log.info(`刷新开始: ${startedAt.toISOString()}`);
    const outcome = await scanVault(this.cfg.vaultRoot, this.cfg.collections, this.byPath, (done, total) => {
      if (job && done % 100 === 0) {
        job.scanned = done;
        job.diagnostics.push(`扫描进度 ${done}/${total}`);
      }
    });

    // 可用条目从「有」变成「零」→ 极可能是内容源挂载空了（而不是用户真的清空了库）：
    // 给醒目提示，但**不**硬拒绝——消失的文件会以 missing 保留、分类不丢，修好挂载再刷新就回来；
    // 硬失败会让"确实删光了笔记"的用户永远刷不过去，没有出路。
    // （判据用 available 而不是 records：消失的文件会被标成 missing 保留，records 永远不会为空。）
    const availableBefore = this.doc.notes.filter((n) => n.sourceStatus === 'available').length;
    const availableNow = outcome.records.filter((n) => n.sourceStatus === 'available').length;
    const wipeWarning =
      availableNow === 0 && availableBefore > 0
        ? `本次扫描一篇可读笔记都没读到（旧库 ${availableBefore} 篇）：请检查内容源挂载与文件权限；旧记录已标记为 missing 并保留分类`
        : null;
    if (wipeWarning) {
      log.warn(wipeWarning);
      if (job) job.diagnostics.push(wipeWarning);
    }

    const nextDoc: IndexDoc = {
      schemaVersion: 1,
      revision: this.doc.revision + 1,
      generatedAt: new Date().toISOString(),
      contentSource: this.cfg.vaultRoot,
      indexSig: this.indexSig(),
      notes: outcome.records,
      diagnostics: (wipeWarning ? [wipeWarning, ...outcome.diagnostics] : outcome.diagnostics).slice(0, 200),
      lastScan: {
        finishedAt: new Date().toISOString(),
        scanned: outcome.counts.scanned,
        added: outcome.counts.added,
        updated: outcome.counts.updated,
        skipped: outcome.counts.skipped,
        errors: outcome.counts.errors,
      },
    };

    try {
      await this.indexStore.save(nextDoc);
    } catch (e) {
      const msg = `索引持久化失败: ${(e as Error).message}`;
      if (job) {
        job.state = 'failed';
        job.finishedAt = new Date().toISOString();
        job.diagnostics.push(msg);
      }
      log.error(msg);
      // 首扫/自愈扫失败必须让 init 失败：吞掉的话服务"就绪"而索引是空的，
      // 用户只看到空库且 diagnostics 里一个字都没有（深审发现）。刷新模式已有 job.diagnostics 兜底。
      if (!job) throw new Error(msg);
      return;
    }

    // 提交成功后才切换内存
    this.doc = nextDoc;
    this.rebuildMaps();

    // 顺手修剪识别文本里的孤儿引用（笔记换掉/删掉了某个附件）：刷新时做一次，成本一次读+至多一次写。
    try {
      const dropped = await this.mediaText.pruneRefs((noteId, mediaId) => {
        const rec = this.byId.get(noteId);
        return !!rec && rec.media.some((m) => m.id === mediaId);
      });
      if (dropped > 0) log.info(`识别文本清理: 摘掉 ${dropped} 条失效引用（附件已不在索引里）`);
    } catch (e) {
      log.warn(`识别文本清理失败（不影响刷新）: ${(e as Error).message}`);
    }

    const classifyMsg = await this.autoClassify(nextDoc.notes, job);
    // 首扫没有 job（诊断只走 onProgress），把自动分类结果放进页面诊断；
    // 只留在内存里（不再多写一次索引文件），重启后从日志里查
    if (classifyMsg && !job) this.doc.diagnostics = [classifyMsg, ...this.doc.diagnostics].slice(0, 200);

    // 刷新后重导语料。**导出失败绝不能拖垮刷新**——语料是派生产物，索引才是主线；
    // 内容没变时 exportCorpus 自己会跳过写入，所以这里的开销通常只是读一遍内存。
    if (this.cfg.exportAfterRefresh) {
      try {
        await this.exportCorpus();
      } catch (e) {
        const msg = `语料导出失败: ${(e as Error).message}`;
        log.warn(msg);
        if (job) job.diagnostics.push(msg);
      }
    }

    if (job) {
      job.state = outcome.counts.errors > 0 ? 'partial' : 'completed';
      job.finishedAt = new Date().toISOString();
      job.scanned = outcome.counts.scanned;
      job.added = outcome.counts.added;
      job.updated = outcome.counts.updated;
      job.skipped = outcome.counts.skipped;
      job.errors = outcome.counts.errors;
      job.diagnostics.push(...outcome.diagnostics.slice(0, 20));
    }
    log.info(
      `扫描完成: scanned=${outcome.counts.scanned} added=${outcome.counts.added} updated=${outcome.counts.updated} errors=${outcome.counts.errors}`
    );
    void startedAt;
  }
}

function mediaUrl(noteId: string, mediaId: string): string {
  return `/api/media/${encodeURIComponent(noteId)}/${encodeURIComponent(mediaId)}`;
}

export { CategoryConflictError, CategoryValidationError, AnnotationConflictError, AnnotationValidationError };