// 分类定义、首批分配（seed）与人工覆盖。
// 优先级：override > initialAssignment > 未分类。categoryId=null 表示明确"未分类"。
import path from 'node:path';
import fs from 'node:fs';
import type { Category } from '../../shared/types.js';
import { JsonStore } from '../storage/json-store.js';

export interface InitialAssignment {
  categoryId: string;
  rationale: string;
  classifiedAt: string;
}

export interface CategoryDoc {
  schemaVersion: number;
  categories: Category[];
  initialAssignments: Record<string, InitialAssignment>;
}

export interface OverrideEntry {
  categoryId: string | null;
  updatedAt: string;
}

export interface OverrideDoc {
  schemaVersion: number;
  revision: number;
  overrides: Record<string, OverrideEntry>;
}

/** 待自动分类的一条笔记（刷新后仍无分类的小红书笔记） */
export interface ClassifyInput {
  id: string;
  title: string;
  tags: string[];
  excerpt: string;
}

export interface EffectiveCategory {
  categoryId: string | null;
  source: 'override' | 'initial' | 'none';
}

export class CategoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryConflictError';
  }
}

export class CategoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryValidationError';
  }
}

/** 非空对象判定：`typeof null === 'object'`，JSON 里写出 `"overrides": null` 时不能放行 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateCategoryDoc(data: unknown): CategoryDoc | null {
  if (!isRecord(data)) return null;
  const d = data as unknown as CategoryDoc;
  if (d.schemaVersion !== 1 || !Array.isArray(d.categories) || !isRecord(d.initialAssignments)) return null;
  return d;
}

function validateOverrideDoc(data: unknown): OverrideDoc | null {
  if (!isRecord(data)) return null;
  const d = data as unknown as OverrideDoc;
  if (d.schemaVersion !== 1 || typeof d.revision !== 'number' || !isRecord(d.overrides)) return null;
  return d;
}

export class CategoriesService {
  private catDoc: CategoryDoc = { schemaVersion: 1, categories: [], initialAssignments: {} };
  private ovrDoc: OverrideDoc = { schemaVersion: 1, revision: 0, overrides: {} };
  private catStore!: JsonStore<CategoryDoc>;
  private ovrStore!: JsonStore<OverrideDoc>;
  private categoryIds = new Set<string>();
  /** 分类覆盖的写队列：读-改-写必须串行，见 setOverride 的说明 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, backupDir: string) {
    this.catStore = new JsonStore<CategoryDoc>(
      path.join(dataDir, 'categories.json'),
      backupDir,
      validateCategoryDoc
    );
    this.ovrStore = new JsonStore<OverrideDoc>(
      path.join(dataDir, 'overrides.json'),
      backupDir,
      validateOverrideDoc
    );
  }

  /**
   * 加载；categories.json 缺失时从 seed 初始化（seed 仅在未初始化时导入）。
   * @returns diagnostics
   */
  async init(seedPath: string | null): Promise<string[]> {
    const diagnostics: string[] = [];
    const loadedCat = this.catStore.load();
    if (loadedCat.doc) {
      this.catDoc = loadedCat.doc;
      if (loadedCat.recoveredFrom) {
        diagnostics.push(`categories.json 损坏，已从备份恢复: ${path.basename(loadedCat.recoveredFrom)}`);
      }
    } else if (loadedCat.corruptedFile) {
      diagnostics.push(`categories.json 损坏且无可用备份，按空分类处理（损坏文件保留待排查）`);
    } else if (seedPath && fs.existsSync(seedPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as unknown;
        const validated = validateCategoryDoc(raw);
        if (validated) {
          await this.catStore.save(validated);
          this.catDoc = validated;
          diagnostics.push(`已从 seed 初始化分类: ${path.basename(seedPath)}（${validated.categories.length} 类）`);
        } else {
          diagnostics.push(`seed 文件校验失败，未导入: ${path.basename(seedPath)}`);
        }
      } catch (e) {
        diagnostics.push(`seed 读取失败: ${(e as Error).message}`);
      }
    } else {
      diagnostics.push('未找到分类 seed，全部笔记将进入未分类');
    }
    this.rebuildIndex();

    const loadedOvr = this.ovrStore.load();
    if (loadedOvr.doc) {
      this.ovrDoc = loadedOvr.doc;
      if (loadedOvr.recoveredFrom) {
        diagnostics.push(`overrides.json 损坏，已从备份恢复: ${path.basename(loadedOvr.recoveredFrom)}`);
      }
    } else if (loadedOvr.corruptedFile) {
      diagnostics.push(`overrides.json 损坏且无可用备份；新覆盖将重建（旧文件保留待排查）`);
    }
    return diagnostics;
  }

  private rebuildIndex(): void {
    this.categoryIds = new Set(this.catDoc.categories.map((c) => c.id));
  }

  get revision(): number {
    return this.ovrDoc.revision;
  }

  get categories(): Category[] {
    return this.catDoc.categories;
  }

  get initialAssignments(): Record<string, InitialAssignment> {
    return this.catDoc.initialAssignments;
  }

  effective(noteId: string): EffectiveCategory {
    const ovr = this.ovrDoc.overrides[noteId];
    if (ovr) return { categoryId: ovr.categoryId, source: 'override' };
    const init = this.catDoc.initialAssignments[noteId];
    if (init) return { categoryId: init.categoryId, source: 'initial' };
    return { categoryId: null, source: 'none' };
  }

  /**
   * 人工覆盖；expectedRevision 冲突抛 CategoryConflictError。
   * 两点与标注层对齐（2026-09-28 深审发现）：
   * ① **整段读-改-写串行化**——否则两个并发请求基于同一份旧快照算出新文档，后写的覆盖先写的，
   *    两边还都返回成功（实测：并发给两篇设不同分类 → 只存下 1 条，两个响应都报 revision 1）；
   * ② **无实质变化不写盘、不抬 revision**——否则"点了当前已选的分类"会白写一次，
   *    还会让另一个已读到旧 revision 的标签页莫名撞 409。
   */
  async setOverride(noteId: string, categoryId: string | null, expectedRevision: number): Promise<number> {
    return this.enqueue(async () => {
      if (expectedRevision !== this.ovrDoc.revision) {
        throw new CategoryConflictError(`分类数据已被其他操作更新（当前 revision ${this.ovrDoc.revision}）`);
      }
      if (categoryId !== null && !this.categoryIds.has(categoryId)) {
        throw new CategoryValidationError(`未知的分类 ID: ${categoryId}`);
      }
      // 判"有没有变化"只看**覆盖值**：把 seed 分来的分类显式钉成覆盖是一次真实的改变（此后不再被 seed 覆盖）
      const prev = this.ovrDoc.overrides[noteId];
      if (prev && (prev.categoryId ?? null) === categoryId) return this.ovrDoc.revision;

      const next: OverrideDoc = {
        schemaVersion: 1,
        revision: this.ovrDoc.revision + 1,
        overrides: {
          ...this.ovrDoc.overrides,
          [noteId]: { categoryId, updatedAt: new Date().toISOString() },
        },
      };
      await this.ovrStore.save(next);
      this.ovrDoc = next;
      return next.revision;
    });
  }

  /** 队列：同一 store 的读-改-写按顺序执行（与 AnnotationsService 同一套做法） */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 为「既无 seed/初始分类、也无人工覆盖」的笔记补初始分类（刷新管道调用）。
   * classify 返回 null 表示分不出（记录原因，保持未分类）。
   * 只新增 initialAssignments，永不修改 overrides —— 人工分类永远优先。
   */
  async ensureClassified(
    items: ClassifyInput[],
    classify: (item: ClassifyInput) => Promise<{ categoryId: string; rationale: string } | null>
  ): Promise<{ assigned: number; unclassified: string[] }> {
    const pending = items.filter((it) => {
      const ovr = this.ovrDoc.overrides[it.id];
      if (ovr) return false;
      return !this.catDoc.initialAssignments[it.id];
    });
    const unclassified: string[] = [];
    const additions: Array<[string, InitialAssignment]> = [];
    for (const it of pending) {
      const r = await classify(it); // 串行：AI 兜底时控制并发，避免一次刷新打爆配额
      if (r && this.categoryIds.has(r.categoryId)) {
        additions.push([
          it.id,
          { categoryId: r.categoryId, rationale: r.rationale, classifiedAt: new Date().toISOString() },
        ]);
      } else {
        unclassified.push(it.id);
      }
    }
    if (additions.length > 0) {
      const next: CategoryDoc = {
        ...this.catDoc,
        initialAssignments: {
          ...this.catDoc.initialAssignments,
          ...Object.fromEntries(additions),
        },
      };
      await this.catStore.save(next);
      this.catDoc = next;
      this.rebuildIndex();
    }
    return { assigned: additions.length, unclassified };
  }

  /** 每个分类的有效计数（含未分类） */
  countEffective(noteIds: string[]): { counts: Record<string, number>; uncategorized: number } {
    const counts: Record<string, number> = {};
    let uncategorized = 0;
    for (const id of noteIds) {
      const eff = this.effective(id);
      if (eff.categoryId === null) uncategorized++;
      else counts[eff.categoryId] = (counts[eff.categoryId] ?? 0) + 1;
    }
    return { counts, uncategorized };
  }
}
