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

function validateCategoryDoc(data: unknown): CategoryDoc | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as CategoryDoc;
  if (d.schemaVersion !== 1 || !Array.isArray(d.categories) || typeof d.initialAssignments !== 'object') return null;
  return d;
}

function validateOverrideDoc(data: unknown): OverrideDoc | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as OverrideDoc;
  if (d.schemaVersion !== 1 || typeof d.revision !== 'number' || typeof d.overrides !== 'object') return null;
  return d;
}

export class CategoriesService {
  private catDoc: CategoryDoc = { schemaVersion: 1, categories: [], initialAssignments: {} };
  private ovrDoc: OverrideDoc = { schemaVersion: 1, revision: 0, overrides: {} };
  private catStore!: JsonStore<CategoryDoc>;
  private ovrStore!: JsonStore<OverrideDoc>;
  private categoryIds = new Set<string>();

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

  /** 人工覆盖；expectedRevision 冲突抛 CategoryConflictError */
  async setOverride(noteId: string, categoryId: string | null, expectedRevision: number): Promise<number> {
    if (expectedRevision !== this.ovrDoc.revision) {
      throw new CategoryConflictError(`分类数据已被其他操作更新（当前 revision ${this.ovrDoc.revision}）`);
    }
    if (categoryId !== null && !this.categoryIds.has(categoryId)) {
      throw new CategoryValidationError(`未知的分类 ID: ${categoryId}`);
    }
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
