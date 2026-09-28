// 识别文本（OCR / 转录）的存储：runtime/data/media-text.json。
//
// 与 annotations.json 同一条纪律（用户/AI 产物是资产，绝不写回 Obsidian），但键不同：
//   · 标注按 noteId 存（你自己写的东西属于那篇笔记）；
//   · 识别文本按**媒体内容 hash** 存——同一张图、同一段音无论被哪篇笔记引用、
//     也不管索引重建多少次，都只算一次。源文件改名、笔记重排都不会让它失效。
// 一条 entry 里带 refs（哪些笔记的哪些媒体 id 指向它），所以"同一张图被两篇引用"时
// 第二篇也能直接看到已有结果，而不是再烧一次额度。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RecognizedKind, RecognizedText } from '../../shared/types.js';
import { JsonStore } from '../storage/json-store.js';

export const MEDIA_TEXT_SCHEMA_VERSION = 1;

const KINDS = new Set<RecognizedKind>(['ocr', 'asr']);

export interface MediaTextRef {
  noteId: string;
  mediaId: string;
}

export interface MediaTextUsage {
  promptTokens?: number;
  completionTokens?: number;
  imageTokens?: number;
  audioSeconds?: number;
}

export interface MediaTextEntry {
  mediaHash: string;
  kind: RecognizedKind;
  text: string;
  model: string;
  at: string;
  refs: MediaTextRef[];
  usage?: MediaTextUsage;
}

export interface MediaTextDoc {
  schemaVersion: number;
  revision: number;
  entries: Record<string, MediaTextEntry>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 内容 hash：识别结果的缓存键。用整份字节的 SHA-256，不掺路径与时间 */
export function mediaHashOf(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeRef(raw: unknown): MediaTextRef | null {
  if (!isRecord(raw)) return null;
  const noteId = typeof raw.noteId === 'string' ? raw.noteId.trim() : '';
  const mediaId = typeof raw.mediaId === 'string' ? raw.mediaId.trim() : '';
  if (!noteId || !mediaId) return null;
  return { noteId, mediaId };
}

/** 读时净化：坏字段丢掉而不是整份作废（与标注同一套容忍度） */
export function normalizeEntry(raw: unknown): MediaTextEntry | null {
  if (!isRecord(raw)) return null;
  const mediaHash = typeof raw.mediaHash === 'string' ? raw.mediaHash.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const at = typeof raw.at === 'string' ? raw.at.trim() : '';
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind as RecognizedKind) ? (raw.kind as RecognizedKind) : null;
  const refs = Array.isArray(raw.refs) ? raw.refs.map(normalizeRef).filter((r): r is MediaTextRef => r !== null) : [];
  // 没有正文就没有意义（OCR 出空串是常见结果，但也别当资产存着）；refs 至少要有一条才知道归属
  if (!mediaHash || !kind || !text.trim() || !refs.length) return null;
  const entry: MediaTextEntry = { mediaHash, kind, text, model, at, refs };
  if (isRecord(raw.usage)) {
    const usage: MediaTextUsage = {};
    for (const k of ['promptTokens', 'completionTokens', 'imageTokens', 'audioSeconds'] as const) {
      const v = raw.usage[k];
      if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v;
    }
    if (Object.keys(usage).length) entry.usage = usage;
  }
  return entry;
}

function validateDoc(data: unknown): MediaTextDoc | null {
  if (!isRecord(data)) return null;
  const d = data as unknown as MediaTextDoc;
  if (d.schemaVersion !== MEDIA_TEXT_SCHEMA_VERSION || typeof d.revision !== 'number' || !isRecord(d.entries)) {
    return null;
  }
  const entries: Record<string, MediaTextEntry> = {};
  for (const [hash, raw] of Object.entries(d.entries)) {
    const entry = normalizeEntry(raw);
    if (entry) entries[hash] = entry;
  }
  return { schemaVersion: MEDIA_TEXT_SCHEMA_VERSION, revision: d.revision, entries };
}

export class MediaTextService {
  private doc: MediaTextDoc = { schemaVersion: MEDIA_TEXT_SCHEMA_VERSION, revision: 0, entries: {} };
  private store: JsonStore<MediaTextDoc>;
  /** noteId → 该笔记关联的识别结果；put/加载后重建 */
  private byNote = new Map<string, MediaTextEntry[]>();
  /** 索引保持串行，避免同一 store 并发写 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, backupDir: string) {
    this.store = new JsonStore<MediaTextDoc>(
      path.join(dataDir, 'media-text.json'),
      backupDir,
      validateDoc
    );
  }

  async init(): Promise<string[]> {
    const diagnostics: string[] = [];
    const loaded = this.store.load();
    if (loaded.doc) {
      this.doc = loaded.doc;
      if (loaded.recoveredFrom) {
        diagnostics.push(`media-text.json 损坏，已从备份恢复: ${path.basename(loaded.recoveredFrom)}`);
      }
    } else if (loaded.corruptedFile) {
      diagnostics.push('media-text.json 损坏且无可用备份，识别文本按空处理；索引与标注不受影响');
    }
    this.rebuildIndex();
    return diagnostics;
  }

  get revision(): number {
    return this.doc.revision;
  }

  get entryCount(): number {
    return Object.keys(this.doc.entries).length;
  }

  /** 已识别的笔记数（界面上"这几篇有文字了"的口径） */
  get noteCount(): number {
    return this.byNote.size;
  }

  private rebuildIndex(): void {
    this.byNote = new Map();
    for (const entry of Object.values(this.doc.entries)) {
      for (const ref of entry.refs) {
        const list = this.byNote.get(ref.noteId);
        if (list) list.push(entry);
        else this.byNote.set(ref.noteId, [entry]);
      }
    }
  }

  get(mediaHash: string): MediaTextEntry | null {
    return this.doc.entries[mediaHash] ?? null;
  }

  /** 某笔记的全部识别结果（同一媒体只出现一次） */
  forNote(noteId: string): MediaTextEntry[] {
    return this.byNote.get(noteId) ?? [];
  }

  /**
   * 供全文搜索用的一串文本：把该笔记所有识别文本拼起来。
   * 每条都要在 query() 里调一次，所以不做对象分配、只拼字符串。
   */
  textFor(noteId: string): string {
    const list = this.byNote.get(noteId);
    if (!list?.length) return '';
    return list.map((e) => e.text).join('\n');
  }

  /** 转成 API/语料用的形态（mediaId 取这条 ref 自己的，不是别的笔记的） */
  recognizedOf(noteId: string): RecognizedText[] {
    const list = this.byNote.get(noteId);
    if (!list?.length) return [];
    const out: RecognizedText[] = [];
    for (const e of list) {
      for (const ref of e.refs) {
        if (ref.noteId !== noteId) continue;
        out.push({ kind: e.kind, mediaId: ref.mediaId, mediaHash: e.mediaHash, text: e.text, model: e.model, at: e.at });
      }
    }
    return out;
  }

  /** 该笔记的某个媒体是否已有识别结果（界面用来决定按钮文案） */
  hasFor(noteId: string, mediaId: string): boolean {
    return this.forNote(noteId).some((e) => e.refs.some((r) => r.noteId === noteId && r.mediaId === mediaId));
  }

  /**
   * 记下一条识别结果。
   * 已有同一 mediaHash 时**只补 refs**（不覆盖文本、不重算）——同一张图被第二篇引用时走这里。
   * 返回是否真的改动了文档。
   *
   * **先在副本上改、写盘成功后才替换内存**：早先的写法是先 push/delete 内存再落盘，
   * 一旦写盘失败（磁盘满 / NAS 掉线），内存里留着盘上没有的结果，而且因为 `get()` 现在能查到它，
   * 后续同一个 ref 会判成"已有、无需再写"，**永远不再重试**——正是"内存说成功、盘上没有"。
   */
  async put(entry: MediaTextEntry): Promise<{ changed: boolean; revision: number }> {
    return this.enqueue(async () => {
      const prev = this.doc.entries[entry.mediaHash];
      const entries = { ...this.doc.entries };
      if (prev) {
        const missing = entry.refs.filter(
          (r) => !prev.refs.some((x) => x.noteId === r.noteId && x.mediaId === r.mediaId)
        );
        if (missing.length === 0) return { changed: false, revision: this.doc.revision };
        entries[entry.mediaHash] = { ...prev, refs: [...prev.refs, ...missing] };
      } else {
        entries[entry.mediaHash] = entry;
      }
      await this.commit(entries);
      return { changed: true, revision: this.doc.revision };
    });
  }

  /** 删掉一条（识别错了想重来）；不存在则不动 */
  async remove(mediaHash: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.doc.entries[mediaHash]) return false;
      const entries = { ...this.doc.entries };
      delete entries[mediaHash];
      await this.commit(entries);
      return true;
    });
  }

  /**
   * 摘掉一个 ref（某篇笔记不再要这张图的结果）。
   * **最后一条 ref 被摘掉时整条 entry 一起删**——留着没有归属的 entry 既占地方，
   * 又会在读盘净化时被当成无主数据丢掉，两边行为不一致。
   */
  async removeRef(noteId: string, mediaId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const hit = Object.values(this.doc.entries).find((e) =>
        e.refs.some((r) => r.noteId === noteId && r.mediaId === mediaId)
      );
      if (!hit) return false;
      const rest = hit.refs.filter((r) => !(r.noteId === noteId && r.mediaId === mediaId));
      const entries = { ...this.doc.entries };
      if (rest.length === 0) delete entries[hit.mediaHash];
      else entries[hit.mediaHash] = { ...hit, refs: rest };
      await this.commit(entries);
      return true;
    });
  }

  /**
   * 按索引现状修剪 refs：丢掉指向"已不存在的 (noteId, mediaId)"的引用，一条 entry 的 refs 全没了就整条删。
   * 什么时候会脏：笔记删掉/换掉了某个附件，而这条识别结果还挂着旧 mediaId。
   * 不修剪的后果是**界面数字说谎**——`mediaText.length` 虚高，会把「识别其余 N 张」按钮顶掉，
   * 同时缩略图 404。刷新后调用一次即可（一次写盘）。
   */
  async pruneRefs(valid: (noteId: string, mediaId: string) => boolean): Promise<number> {
    return this.enqueue(async () => {
      const entries: Record<string, MediaTextEntry> = {};
      let dropped = 0;
      for (const [hash, e] of Object.entries(this.doc.entries)) {
        const refs = e.refs.filter((r) => valid(r.noteId, r.mediaId));
        dropped += e.refs.length - refs.length;
        if (refs.length > 0) entries[hash] = refs.length === e.refs.length ? e : { ...e, refs };
      }
      if (dropped === 0) return 0;
      await this.commit(entries);
      return dropped;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 提交一份新的 entries：**先写盘、成功后才换内存**（失败时内存保持旧状态，下次会重试） */
  private async commit(entries: Record<string, MediaTextEntry>): Promise<void> {
    const next: MediaTextDoc = { ...this.doc, revision: this.doc.revision + 1, entries };
    await this.store.save(next);
    this.doc = next;
    this.rebuildIndex();
  }
}

/** 备份文件是否存在的辅助（测试与排查用） */
export function mediaTextFile(dataDir: string): string {
  return path.join(dataDir, 'media-text.json');
}

/** 同步读一份媒体的字节（供内容 hash 与 base64）；读不到返回 null */
export function readMediaBytes(absPath: string): Buffer | null {
  try {
    if (!fs.statSync(absPath).isFile()) return null;
    return fs.readFileSync(absPath);
  } catch {
    return null;
  }
}
