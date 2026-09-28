// 人工标注层：星标 / 状态 / 备注。属于本项目「用户产生的数据」这一类，与 overrides.json 同级。
//
// 两条铁律：
// 1. 绝不存进 library-index.json —— 那份索引由 indexSig（collections 结构 + PARSE_VERSION）决定
//    是否整体重建，人工数据一旦进去就会被一次解析器升级悄悄抹掉。
// 2. 绝不写回 Obsidian 源笔记（源目录只读是整个项目的前提），二次加工只留在本项目。
//
// 一个文件、一条 revision 装齐三项，写入做字段级浅合并：三项总是一起编辑（详情面板里一处改），
// 拆成三个文件就有了三条冲突链；而浅合并让"两个客户端同时改不同字段"不会互相覆盖。
import path from 'node:path';
import { MAX_REMARK, type NoteStatus } from '../../shared/types.js';
import { JsonStore } from '../storage/json-store.js';

/** 单条笔记的标注；字段缺失 = 该字段从未标过 */
export interface AnnotationEntry {
  starredAt?: string;
  status?: Exclude<NoteStatus, 'active'>;
  statusAt?: string;
  remark?: string;
  remarkAt?: string;
  updatedAt: string;
}

export interface AnnotationDoc {
  schemaVersion: number;
  revision: number;
  entries: Record<string, AnnotationEntry>;
}

/**
 * 字段级补丁：**只有出现在对象里的键**才会被改动。
 * 清空用显式值表达（`star: false` / `status: null` / `remark: null`），不用 `undefined`——
 * 这样"没提这个字段"和"把它清掉"能区分开。
 */
export interface AnnotationPatch {
  star?: boolean;
  status?: Exclude<NoteStatus, 'active'> | null;
  remark?: string | null;
}

const STATUS_VALUES: ReadonlySet<string> = new Set(['archived']);

/**
 * v0.7.1 曾把归档拆成 `expired` / `uncollected` 两个理由，v0.7.3 合并成 `archived`。
 * 读盘时把旧值映射过来，用户之前标过的不会被丢掉。
 */
const LEGACY_STATUS: Record<string, 'archived'> = { expired: 'archived', uncollected: 'archived' };

export class AnnotationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationConflictError';
  }
}

export class AnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationValidationError';
  }
}

/** 非空对象判定：`typeof null === 'object'`，JSON 里写出 `"entries": null` 时不能放行 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * 读时净化单条标注：坏字段丢掉，而不是整份作废——用户数据宁可少一个字段也不能全丢。
 * 返回 null 表示这条没有任何可用的标注（空壳）。
 */
export function normalizeEntry(raw: unknown): AnnotationEntry | null {
  if (!isRecord(raw)) return null;
  const next: AnnotationEntry = { updatedAt: isoOrNull(raw.updatedAt) ?? '' };

  const starredAt = isoOrNull(raw.starredAt);
  if (starredAt) next.starredAt = starredAt;

  if (typeof raw.status === 'string') {
    const mapped = STATUS_VALUES.has(raw.status) ? raw.status : LEGACY_STATUS[raw.status];
    if (mapped) {
      next.status = mapped as AnnotationEntry['status'];
      const statusAt = isoOrNull(raw.statusAt);
      if (statusAt) next.statusAt = statusAt;
    }
  }

  const remark = typeof raw.remark === 'string' ? raw.remark.trim().slice(0, MAX_REMARK) : '';
  if (remark) {
    next.remark = remark;
    const remarkAt = isoOrNull(raw.remarkAt);
    if (remarkAt) next.remarkAt = remarkAt;
  }

  if (!next.starredAt && !next.status && !next.remark) return null;
  if (!next.updatedAt) next.updatedAt = next.starredAt ?? next.statusAt ?? next.remarkAt ?? '';
  return next;
}

function validateAnnotationDoc(data: unknown): AnnotationDoc | null {
  if (!isRecord(data)) return null;
  const d = data as unknown as AnnotationDoc;
  if (d.schemaVersion !== 1 || typeof d.revision !== 'number' || !isRecord(d.entries)) return null;
  const entries: Record<string, AnnotationEntry> = {};
  for (const [id, raw] of Object.entries(d.entries)) {
    const entry = normalizeEntry(raw);
    if (entry) entries[id] = entry;
  }
  return { schemaVersion: 1, revision: d.revision, entries };
}

/**
 * 纯函数：把补丁合到已有标注上。
 * - 重复标星不刷新 `starredAt`（幂等，连点不会把时间改来改去）
 * - **无实质变化时原样返回 `prev`**（连 `updatedAt` 都不动），调用方据此判断"不必写盘"，
 *   否则连点两下星标就会把 revision 抬高，让正在编辑备注的另一个客户端莫名撞 409
 */
export function applyAnnotationPatch(
  prev: AnnotationEntry | undefined,
  patch: AnnotationPatch,
  now: string
): AnnotationEntry | null {
  const next: AnnotationEntry = { ...(prev ?? { updatedAt: now }) };

  if (patch.star !== undefined) {
    if (patch.star) next.starredAt = prev?.starredAt ?? now;
    else delete next.starredAt;
  }
  if (patch.status !== undefined) {
    if (patch.status === null) {
      delete next.status;
      delete next.statusAt;
    } else {
      next.status = patch.status;
      next.statusAt = now;
    }
  }
  if (patch.remark !== undefined) {
    const text = (patch.remark ?? '').trim().slice(0, MAX_REMARK);
    if (text) {
      next.remark = text;
      next.remarkAt = now;
    } else {
      delete next.remark;
      delete next.remarkAt;
    }
  }

  if (next.starredAt === undefined && next.status === undefined && next.remark === undefined) return null;

  const changed =
    (prev?.starredAt ?? null) !== (next.starredAt ?? null) ||
    (prev?.status ?? null) !== (next.status ?? null) ||
    (prev?.remark ?? null) !== (next.remark ?? null);
  if (!changed) return prev ?? null;

  next.updatedAt = now;
  return next;
}

export class AnnotationsService {
  private doc: AnnotationDoc = { schemaVersion: 1, revision: 0, entries: {} };
  private store: JsonStore<AnnotationDoc>;

  constructor(dataDir: string, backupDir: string) {
    this.store = new JsonStore<AnnotationDoc>(
      path.join(dataDir, 'annotations.json'),
      backupDir,
      validateAnnotationDoc
    );
  }

  /** 加载；返回 diagnostics（与分类覆盖同一套恢复语义） */
  async init(): Promise<string[]> {
    const diagnostics: string[] = [];
    const loaded = this.store.load();
    if (loaded.doc) {
      this.doc = loaded.doc;
      if (loaded.recoveredFrom) {
        diagnostics.push(`annotations.json 损坏，已从备份恢复: ${path.basename(loaded.recoveredFrom)}`);
      }
    } else if (loaded.corruptedFile) {
      diagnostics.push('annotations.json 损坏且无可用备份，标注（星标/状态/备注）按空处理；分类与索引不受影响');
    }
    return diagnostics;
  }

  get revision(): number {
    return this.doc.revision;
  }

  get entryCount(): number {
    return Object.keys(this.doc.entries).length;
  }

  isStarred(noteId: string): boolean {
    return this.doc.entries[noteId]?.starredAt !== undefined;
  }

  /** 只要状态：计数与列表过滤都按每条调一次，避免为每个 id 建对象 */
  statusOf(noteId: string): NoteStatus {
    return this.doc.entries[noteId]?.status ?? 'active';
  }

  /** 只要备注：全文搜索要按条调用（备注是人工字段，不在索引的 searchText 里） */
  remarkOf(noteId: string): string {
    return this.doc.entries[noteId]?.remark ?? '';
  }

  /** 生效标注（补默认值，供 API 输出） */
  effective(noteId: string): {
    starred: boolean;
    starredAt: string | null;
    status: NoteStatus;
    remark: string | null;
  } {
    const e = this.doc.entries[noteId];
    return {
      starred: e?.starredAt !== undefined,
      starredAt: e?.starredAt ?? null,
      status: e?.status ?? 'active',
      remark: e?.remark ?? null,
    };
  }

  /**
   * 改一条笔记的标注（一次写盘合并所有字段），返回新 revision。
   * `expectedRevision` 用于"改之前先看一眼"的场景（备注/状态）；星标是单字段幂等动作，可以不传。
   */
  async patch(noteId: string, patch: AnnotationPatch, expectedRevision?: number): Promise<number> {
    if (patch.status !== undefined && patch.status !== null && !STATUS_VALUES.has(patch.status)) {
      throw new AnnotationValidationError(`未知的状态: ${String(patch.status)}`);
    }
    if (expectedRevision !== undefined && expectedRevision !== this.doc.revision) {
      throw new AnnotationConflictError(`标注数据已被其他操作更新（当前 revision ${this.doc.revision}）`);
    }

    const now = new Date().toISOString();
    const prev = this.doc.entries[noteId];
    const nextEntry = applyAnnotationPatch(prev, patch, now);
    // 无变化：applyAnnotationPatch 会把 prev 原样退回，据此避免写盘与 revision 虚增
    if ((prev ?? null) === nextEntry) return this.doc.revision;

    const entries = { ...this.doc.entries };
    if (nextEntry) entries[noteId] = nextEntry;
    else delete entries[noteId];

    const next: AnnotationDoc = { schemaVersion: 1, revision: this.doc.revision + 1, entries };
    await this.store.save(next); // 写失败必须抛错，内存不得先当作成功
    this.doc = next;
    return next.revision;
  }

  /** 给定 id 集合里有多少条标了星（侧栏按收藏库计数用） */
  countStarred(ids: Iterable<string>): number {
    let n = 0;
    for (const id of ids) if (this.isStarred(id)) n++;
    return n;
  }
}
