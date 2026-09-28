// 收藏库核心服务：内存索引、查询、详情、刷新任务、分类入口。
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  Category,
  CollectionDef,
  CollectionInfo,
  DerivedCategory,
  ExtraFieldInfo,
  LibraryInfo,
  NoteDetail,
  NoteListResult,
  NoteQuery,
  NoteSummary,
  RefreshJobInfo,
  TagCount,
} from '../../shared/types.js';
import { lastNDaysRangeMs, customRangeMs } from '../../shared/time.js';
import { projectRoot, type AppConfig } from '../config.js';
import { log } from '../log.js';
import { scanVault } from '../reader/scan.js';
import { PARSE_VERSION, type NoteRecord } from '../reader/parse.js';
import { classifyRednote } from './classify.js';
import { aiClassifyConfigFromEnv, classifyByAi } from './ai-classify.js';
import { JsonStore } from '../storage/json-store.js';
import {
  CategoriesService,
  CategoryConflictError,
  CategoryValidationError,
} from './categories.js';

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
    let items = this.doc.notes.filter((r) => r.sourceStatus === 'available' && r.collection === cid);

    const q = (params.q ?? '').trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      items = items.filter((r) => terms.every((t) => r.searchText.includes(t)));
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
      extra: r.extra,
    };
  }

  /** 单个收藏库信息（分类：rednote 走 seed，其余按派生值计数；表格字段按 extra 出现率） */
  collectionInfo(cid: string): CollectionInfo | null {
    const def = this.colMap.get(cid);
    if (!def) return null;
    const recs = this.doc.notes.filter((r) => r.collection === cid && r.sourceStatus === 'available');
    const catMap = new Map<string, number>();
    let uncategorized = 0;
    const extraCount = new Map<string, number>();
    if (cid === 'rednote') {
      const { counts, uncategorized: u } = this.categories.countEffective(recs.map((r) => r.id));
      for (const [k, v] of Object.entries(counts)) catMap.set(k, v);
      uncategorized = u;
    } else {
      for (const r of recs) {
        const c = r.derivedCategory;
        if (c) catMap.set(c, (catMap.get(c) ?? 0) + 1);
        else uncategorized++;
      }
    }
    if (def.type === 'treasures') {
      for (const r of recs) {
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
    return { id: def.id, name: def.name, total: recs.length, uncategorized, categories, extraFields };
  }

  /** 全部收藏库信息 */
  collectionInfos(): CollectionInfo[] {
    return this.cfg.collections
      .map((c) => this.collectionInfo(c.id))
      .filter((x): x is CollectionInfo => x !== null);
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
      indexStatus: this.job?.state === 'running' ? 'scanning' : this.doc.notes.length > 0 ? 'ready' : 'empty',
      diagnostics: [...this.bootDiagnostics, ...this.doc.diagnostics].slice(0, 50),
    };
  }

  listCategories(): Category[] {
    return this.categories.categories.slice().sort((a, b) => a.order - b.order);
  }

  private tagCountCache: Map<string, { revision: number; tags: TagCount[] }> = new Map();

  /** 指定收藏库的标签与使用次数（按次数降序），按 indexRevision 缓存 */
  tagCounts(cid = 'rednote'): TagCount[] {
    const cached = this.tagCountCache.get(cid);
    if (cached && cached.revision === this.doc.revision) return cached.tags;
    const m = new Map<string, number>();
    for (const r of this.doc.notes) {
      if (r.sourceStatus !== 'available' || r.collection !== cid) continue;
      for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    const tags = [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
    this.tagCountCache.set(cid, { revision: this.doc.revision, tags });
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
  private async autoClassify(notes: NoteRecord[], job?: InternalRefreshJob): Promise<void> {
    const rednote = notes.filter((n) => n.collection === 'rednote' && n.sourceStatus === 'available');
    if (rednote.length === 0) return;
    const aiCfg = aiClassifyConfigFromEnv();
    const validIds = new Set(this.categories.categories.map((c) => c.id));
    let byRule = 0;
    let byAi = 0;
    const result = await this.categories.ensureClassified(
      rednote.map((n) => ({ id: n.id, title: n.title, tags: n.tags, excerpt: n.excerpt })),
      async (item) => {
        const rule = classifyRednote(item.id, item.title, item.tags);
        if (rule) {
          byRule++;
          return rule;
        }
        if (!aiCfg) return null;
        const hit = await classifyByAi(aiCfg, item, validIds);
        if (hit) {
          byAi++;
          return hit;
        }
        return null;
      }
    );
    if (result.assigned > 0) {
      const msg = `自动分类 ${result.assigned} 篇（规则 ${byRule}${aiCfg ? ` / AI ${byAi}` : ''}），未分类 ${result.unclassified.length} 篇`;
      log.info(msg);
      if (job) job.diagnostics.push(msg);
    }
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

    const nextDoc: IndexDoc = {
      schemaVersion: 1,
      revision: this.doc.revision + 1,
      generatedAt: new Date().toISOString(),
      contentSource: this.cfg.vaultRoot,
      indexSig: this.indexSig(),
      notes: outcome.records,
      diagnostics: outcome.diagnostics.slice(0, 200),
      lastScan: {
        finishedAt: new Date().toISOString(),
        scanned: outcome.counts.scanned,
        added: outcome.counts.added,
        updated: outcome.counts.updated,
        skipped: outcome.counts.skipped,
        errors: outcome.counts.errors,
      },
    };

    // 枚举成功但零笔记且旧库非空 → 视为异常，不覆盖旧索引
    if (outcome.records.length === 0 && this.doc.notes.length > 0) {
      const msg = '扫描结果为空而旧库非空，拒绝覆盖旧索引';
      if (job) {
        job.state = 'failed';
        job.finishedAt = new Date().toISOString();
        job.diagnostics.push(msg);
      }
      log.error(msg);
      return;
    }

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

    await this.autoClassify(nextDoc.notes, job);

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

export { CategoryConflictError, CategoryValidationError };