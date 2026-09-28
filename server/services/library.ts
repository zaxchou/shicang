// 收藏库核心服务：内存索引、查询、详情、刷新任务、分类入口。
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  Category,
  CollectionDef,
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
import { classifyRednote } from './classify.js';
import { aiClassifyConfigFromEnv, classifyByAi } from './ai-classify.js';
import {
  MediaTextService,
  mediaHashOf,
  readMediaBytes,
} from './media-text.js';
import { aiVisionConfigFromEnv, ocrImage, OCR_IMAGE_MIMES } from './ai-vision.js';
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

  /** 索引指纹：收藏库结构（id/root/exclude）+ 解析器版本，任一变化即索引作废 */
  private indexSig(): string {
    return JSON.stringify({
      collections: this.cfg.collections.map((c) => ({ id: c.id, root: c.root, exclude: c.exclude ?? [] })),
      parseVersion: PARSE_VERSION,
    });
  }

  async init(): Promise<void> {
    const diagnostics: string[] = [];
    const seedPath = path.join(projectRoot(), 'data-seed', 'categories-seed.json');
    diagnostics.push(...(await this.categories.init(seedPath)));
    diagnostics.push(...(await this.annotations.init()));
    diagnostics.push(...(await this.mediaText.init()));

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

    // 无索引缓存（或结构失效）：自动全量扫描
    if (this.doc.notes.length === 0) {
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

  query(params: NoteQuery): NoteListResult {
    const cid = params.collection || 'rednote';
    // 归档视图要能看见源文件已消失的记录（"取消收藏已完成"那条链路），其它视图只看文件还在的
    const includeMissing = params.includeMissing === true;
    const view = params.status ?? 'active';
    let items = this.doc.notes.filter(
      (r) =>
        r.collection === cid &&
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

    if (params.categoryId === 'uncategorized') {
      // rednote 走 seed/override；其它库按派生分类（无派生值 = 未分类）
      items = items.filter((r) =>
        r.collection === 'rednote'
          ? this.categories.effective(r.id).categoryId === null
          : !r.derivedCategory
      );
    } else if (params.categoryId) {
      items = items.filter((r) =>
        r.collection === 'rednote'
          ? this.categories.effective(r.id).categoryId === params.categoryId
          : r.derivedCategory === params.categoryId
      );
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
    const derived = r.collection !== 'rednote';
    const ann = this.annotations.effective(r.id);
    return {
      id: r.id,
      collection: r.collection,
      title: r.title,
      excerpt: r.excerpt,
      author: r.author,
      tags: r.tags,
      publishedAt: r.publishedAt,
      syncedAt: r.syncedAt,
      categoryId: derived ? r.derivedCategory ?? null : eff.categoryId,
      categorySource: derived ? 'derived' : eff.source,
      mediaCount: r.media.filter((m) => m.kind === 'image').length,
      hasVideo: r.media.some((m) => m.kind === 'video'),
      cover,
      sourceStatus: r.sourceStatus,
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
    if (cid === 'rednote') {
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
    const categories: CollectionInfo['categories'] =
      cid === 'rednote'
        ? this.categories.categories
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((c) => ({ id: c.id, name: c.name, count: catMap.get(c.id) ?? 0 }))
        : [...catMap.entries()]
            .map(([name, count]) => ({ id: name, name, count }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const extraFields: ExtraFieldInfo[] = [...extraCount.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
    const starred = this.annotations.countStarred(work.map((r) => r.id));
    return {
      id: def.id,
      name: def.name,
      total: recs.length,
      active: work.length,
      archived,
      uncategorized,
      starred,
      categories,
      extraFields,
    };
  }

  /** 全部收藏库信息 */
  collectionInfos(): CollectionInfo[] {
    return this.cfg.collections
      .map((c) => this.collectionInfo(c.id))
      .filter((x): x is CollectionInfo => x !== null);
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

  private corpusCategoryOf(r: NoteRecord): { id: string | null; source: NoteSummary['categorySource'] } {
    if (r.collection === 'rednote') {
      const eff = this.categories.effective(r.id);
      return { id: eff.categoryId, source: eff.source };
    }
    return { id: r.derivedCategory ?? null, source: 'derived' };
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
    const result = await writeCorpus({
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
    });
    log.info(
      result.written
        ? `语料导出完成: ${result.manifest.counts.total} 篇 → ${result.dir}`
        : '语料导出: 内容未变，跳过写入'
    );
    return result;
  }

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
   * - **命中内容 hash 缓存的不再调用模型**，只补一条 ref（同一张图被两篇引用时走这里）。
   */
  async ocrNote(noteId: string, opts: { mediaId?: string } = {}): Promise<OcrRunResult> {
    const r = this.byId.get(noteId);
    if (!r) throw new NotFoundError(`未找到笔记 ${noteId}`);

    const cfg = aiVisionConfigFromEnv();
    const allTargets = this.ocrTargets(noteId);
    const targets = opts.mediaId ? allTargets.filter((m) => m.id === opts.mediaId) : allTargets;
    if (opts.mediaId && targets.length === 0) {
      throw new ValidationError(`这篇笔记里没有可识别的本地图片：${opts.mediaId}`);
    }

    const results: OcrRunResult['results'] = [];
    // 已经有结果的跳过（不重复烧额度）；但缓存命中要补 ref，所以下面按 hash 再判一次
    const pending = targets.filter((m) => !this.mediaText.hasFor(noteId, m.id));
    const limited = cfg ? pending.slice(0, cfg.maxPerNote) : [];

    if (!cfg) {
      for (const m of limited.length ? limited : pending.slice(0, 1)) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '未配置 AI 凭据（AI_CLASSIFY_API_KEY）' });
      }
      return { noteId, results, recognized: this.mediaTextFor(noteId), remaining: pending.length, model: null };
    }

    for (const m of limited) {
      const abs = this.resolveMediaAbs(m.localRelativePath!);
      if (!abs) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体路径越界，已拒绝读取' });
        continue;
      }
      const bytes = readMediaBytes(abs);
      if (!bytes) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: '媒体文件读不到' });
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

      const hash = mediaHashOf(bytes);
      const cached = this.mediaText.get(hash);
      if (cached) {
        // 同一份文件以前算过：只补 ref，不再调模型
        await this.mediaText.put({ ...cached, refs: [{ noteId, mediaId: m.id }] });
        results.push({ mediaId: m.id, ok: true, cached: true, text: cached.text });
        continue;
      }

      const out = await ocrImage(cfg, { bytes, mime });
      if (!out.ok) {
        results.push({ mediaId: m.id, ok: false, cached: false, reason: out.reason });
        continue;
      }
      await this.mediaText.put({
        mediaHash: hash,
        kind: 'ocr',
        text: out.text,
        model: out.model,
        at: new Date().toISOString(),
        refs: [{ noteId, mediaId: m.id }],
        usage: out.usage,
      });
      results.push({ mediaId: m.id, ok: true, cached: false, text: out.text });
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

  /** 识别文本条数（页面诊断/信息展示用） */
  get mediaTextEntryCount(): number {
    return this.mediaText.entryCount;
  }

  libraryInfo(): LibraryInfo {
    // 顶层字段保持 rednote 口径（兼容）；前端以 collections 为准
    const rnIds = this.doc.notes.filter((n) => n.collection === 'rednote').map((n) => n.id);
    const { counts, uncategorized } = this.categories.countEffective(rnIds);
    const cats: Category[] = this.categories.categories;
    return {
      app: this.cfg.app,
      version: this.cfg.version,
      total: this.doc.notes.length,
      uncategorized,
      collections: this.collectionInfos(),
      categories: cats
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, count: counts[c.id] ?? 0 })),
      lastScan: this.doc.lastScan,
      indexRevision: this.doc.revision,
      categoryRevision: this.categories.revision,
      annotationRevision: this.annotations.revision,
      mediaTextRevision: this.mediaText.revision,
      indexStatus: this.job?.state === 'running' ? 'scanning' : this.doc.notes.length > 0 ? 'ready' : 'empty',
      diagnostics: [...this.bootDiagnostics, ...this.doc.diagnostics].slice(0, 50),
    };
  }

  listCategories(): Category[] {
    return this.categories.categories.slice().sort((a, b) => a.order - b.order);
  }

  private tagCountCache: Map<string, { indexRevision: number; annotationRevision: number; tags: TagCount[] }> =
    new Map();

  /** 指定收藏库的标签与使用次数（按次数降序），按索引 + 标注两个 revision 缓存 */
  tagCounts(cid = 'rednote'): TagCount[] {
    const cached = this.tagCountCache.get(cid);
    // 标注 revision 必须一起参与缓存键：改状态会让条目标签计数变化，而索引 revision 不动
    if (cached && cached.indexRevision === this.doc.revision && cached.annotationRevision === this.annotations.revision) {
      return cached.tags;
    }
    const m = new Map<string, number>();
    for (const r of this.doc.notes) {
      // 与列表同一口径：归档/源文件消失的条目不参与标签计数
      if (!this.inWorkSet(r) || r.collection !== cid) continue;
      for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    const tags = [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
    this.tagCountCache.set(cid, {
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
    if (rec.collection !== 'rednote') {
      throw new ValidationError('仅小红书收藏支持在网页中修改分类（其它库的分类以 Obsidian 笔记为准）');
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
  private async runScan(mode: 'initial' | 'refresh', job?: InternalRefreshJob): Promise<void> {
    const p = this.scanChain.then(() => this.doScan(mode, job));
    this.scanChain = p.catch(() => undefined);
    return p;
  }

  /**
   * 刷新后的自动分类：只补「无任何分类依据」的小红书笔记。
   * 规则（classify.ts，v0.3.0 人工沉淀的三层规则）优先，未命中且配置了 AI 时走 AI 兜底；
   * 都不行就保持未分类。全程只写 initialAssignments，人工覆盖（overrides.json）永不触碰。
   */
  private async autoClassify(notes: NoteRecord[], job?: InternalRefreshJob): Promise<string | null> {
    const rednote = notes.filter((n) => n.collection === 'rednote' && n.sourceStatus === 'available');
    if (rednote.length === 0) return null;
    const aiCfg = aiClassifyConfigFromEnv();
    const validIds = new Set(this.categories.categories.map((c) => c.id));
    let byRule = 0;
    let byAi = 0;
    let aiDeferred = 0;
    const result = await this.categories.ensureClassified(
      rednote.map((n) => ({ id: n.id, title: n.title, tags: n.tags, excerpt: n.excerpt })),
      async (item) => {
        const rule = classifyRednote(item.id, item.title, item.tags);
        if (rule) {
          byRule++;
          return rule;
        }
        if (!aiCfg) return null;
        // 上限保护：超出后不再调用接口，保持未分类，下次刷新继续
        if (byAi + aiDeferred >= aiCfg.maxPerRefresh) {
          aiDeferred++;
          return null;
        }
        const hit = await classifyByAi(aiCfg, item, validIds);
        if (hit) byAi++;
        return hit;
      }
    );
    if (result.assigned === 0 && aiDeferred === 0) return null;
    const deferred = aiDeferred > 0 ? `；AI 本次上限 ${aiCfg?.maxPerRefresh} 次，剩余 ${aiDeferred} 篇留待下次刷新` : '';
    const msg = `自动分类 ${result.assigned} 篇（规则 ${byRule}${aiCfg ? ` / AI ${byAi}` : ''}），未分类 ${result.unclassified.length} 篇${deferred}`;
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
      return;
    }

    // 提交成功后才切换内存
    this.doc = nextDoc;
    this.rebuildMaps();

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