// 目录枚举与增量扫描（多收藏库）：并发受控、读写前后校验、失败保留旧记录。
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectionDef } from '../../shared/types.js';
import { parseNote, type NoteRecord } from './parse.js';

export interface FileMeta {
  /** 相对 vault 根（跨库唯一，作为索引键） */
  relPath: string;
  /** 相对 collection 根（含 .md） */
  relInCollection: string;
  collection: string;
  mtimeMs: number;
  size: number;
}

export interface ScanCounts {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ScanOutcome {
  records: NoteRecord[];
  diagnostics: string[];
  counts: ScanCounts;
  enumerated: boolean;
}

const CONCURRENCY = 6;
const STAT_RETRY = 2;
const RETRY_DELAY_MS = 150;

/** 递归枚举一个 collection 下的 .md；排除 dot 项与 exclude 正则 */
async function enumerateCollection(
  rootAbs: string,
  collection: CollectionDef,
  vaultRoot: string
): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  const excludes = (collection.exclude ?? []).map((p) => new RegExp(p));
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`目录无法读取: ${dir} (${(e as Error).message})`);
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === 'attachments') continue; // flomo 附件目录（只有媒体）
        await walk(path.join(dir, ent.name), rel);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        if (excludes.some((re) => re.test(rel))) continue;
        const st = await fs.stat(path.join(dir, ent.name));
        out.push({
          relPath: `${collection.root}/${rel}`,
          relInCollection: rel,
          collection: collection.id,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  };
  await walk(rootAbs, '');
  void vaultRoot;
  return out;
}

/**
 * 全量枚举所有收藏库 + 增量解析。
 * 任一库根目录缺失即抛错（保留旧索引，不把缺挂载当空库）。
 */
export async function scanVault(
  vaultRoot: string,
  collections: CollectionDef[],
  existingByPath: Map<string, NoteRecord>,
  onProgress?: (done: number, total: number) => void
): Promise<ScanOutcome> {
  const diagnostics: string[] = [];
  const counts: ScanCounts = { scanned: 0, added: 0, updated: 0, skipped: 0, errors: 0 };

  const files: FileMeta[] = [];
  for (const c of collections) {
    const rootAbs = path.join(vaultRoot, c.root);
    try {
      await fs.access(rootAbs);
    } catch {
      throw new Error(`内容目录缺失或不可读: ${c.root}`);
    }
    const got = await enumerateCollection(rootAbs, c, vaultRoot);
    files.push(...got);
    diagnostics.push(`[${c.name}] 枚举 ${got.length} 篇`);
  }

  const byPath = new Map<string, NoteRecord>();
  const records: NoteRecord[] = [];
  const idOwner = new Map<string, NoteRecord>();
  /** 本次有意跳过的路径：不算 missing，也不保留旧记录（诊断说的是"已从库中移除"） */
  const intentionalSkips = new Set<string>();
  let done = 0;
  const colMap = new Map(collections.map((c) => [c.id, c]));

  const queue = files.slice();
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const meta = queue.shift();
      if (!meta) return;
      done++;
      if (done % 100 === 0) onProgress?.(done, files.length);

      const prev = existingByPath.get(meta.relPath);
      if (
        prev &&
        prev.sourceStatus === 'available' &&
        Math.abs(prev.sourceMtimeMs - meta.mtimeMs) < 1 &&
        prev.sourceSize === meta.size
      ) {
        // 快路径也必须登记 ID：否则下一轮刷新时，与它撞 ID 的文件会因为"先入者没登记"被当成首个
        // 占用者收进索引，同一 ID 出现两条记录（实测可复现，真实库里目前没有重复 resourceId）
        idOwner.set(prev.id, prev);
        byPath.set(meta.relPath, prev);
        records.push(prev);
        counts.skipped++;
        continue;
      }

      const abs = path.join(vaultRoot, ...meta.relPath.split('/'));
      const outcome = await readAndParseStable(abs, meta, vaultRoot, colMap.get(meta.collection)!);
      if (outcome.skippedReason) {
        // 有意跳过（收藏索引页/空笔记等）：不算错误；若之前在库里则这次直接移除
        counts.skipped++;
        intentionalSkips.add(meta.relPath);
        if (prev) diagnostics.push(`${meta.relPath}: ${outcome.skippedReason}；已从库中移除`);
        continue;
      }
      if (outcome.error || !outcome.record) {
        counts.errors++;
        if (prev) {
          byPath.set(meta.relPath, prev);
          records.push(prev);
          diagnostics.push(`${meta.relPath}: ${outcome.error ?? '解析为空'}；保留旧记录`);
        } else {
          // 这里**不再计 skipped**：skipped 的语义是"有意跳过"（索引页/空笔记），
          // 一个坏文件同时算进 errors 与 skipped 会让刷新诊断里两个数字都失真（深审发现）
          diagnostics.push(`${meta.relPath}: ${outcome.error ?? '解析为空'}；跳过`);
        }
        continue;
      }
      const rec = outcome.record;
      // 重复 ID（仅 rednote 类有业务意义的 resourceId）：保留先入
      const owner = idOwner.get(rec.id);
      if (owner && owner.sourceRelativePath !== rec.sourceRelativePath) {
        counts.errors++;
        diagnostics.push(`${meta.relPath}: ID 与 ${owner.sourceRelativePath} 冲突，保留先入记录`);
        // 旧记录继续留在库里（否则本次扫描会把它当"文件已消失"再补一条，同一路径出现两条记录）；
        // 但它的 ID 若已被别人占用，就只能一并移除，避免索引里出现重复 ID
        if (prev) {
          if (idOwner.has(prev.id)) {
            diagnostics.push(`${meta.relPath}: 旧记录的 ID ${prev.id} 也被占用，本次一并移除`);
          } else {
            byPath.set(meta.relPath, prev);
            records.push(prev);
            idOwner.set(prev.id, prev);
          }
        }
        continue;
      }
      idOwner.set(rec.id, rec);
      counts.scanned++;
      byPath.set(meta.relPath, rec);
      records.push(rec);
      if (prev) counts.updated++;
      else counts.added++;
    }
  });
  await Promise.all(workers);

  // 完整枚举成功后：旧索引中已消失的文件标记 missing（保留记录与分类）。
  // 有意跳过的文件除外——它们不是"消失"，而是不再算库内条目。
  // ID 已被新路径接管的也除外（改名/移动：resourceId 不随路径变，新记录就是同一篇笔记）——
  // 否则同 ID 会出现 available + missing 两条，rebuildMaps 后写覆盖先写，详情会指向旧路径（评审 R2）。
  for (const [rel, rec] of existingByPath) {
    if (byPath.has(rel) || intentionalSkips.has(rel)) continue;
    if (idOwner.has(rec.id)) {
      diagnostics.push(`${rel}: 源文件已消失，但 ID 已由新路径接管（改名/移动），不补 missing`);
      continue;
    }
    const missing: NoteRecord = { ...rec, sourceStatus: 'missing' };
    byPath.set(rel, missing);
    records.push(missing);
    diagnostics.push(`${rel}: 源文件已消失，标记为 missing（保留记录与人工分类）`);
  }

  return { records, diagnostics, counts, enumerated: true };
}

/** 稳定解析单个文件（stat→parse→stat 双检）。scanVault 增量路径与编辑写回的单篇重解析（v0.17）共用。 */
export async function readAndParseStable(
  abs: string,
  meta: FileMeta,
  vaultRoot: string,
  collection: CollectionDef
): Promise<{ record: NoteRecord | null; error: string | null; skippedReason: string | null }> {
  for (let attempt = 0; attempt <= STAT_RETRY; attempt++) {
    let before: { mtimeMs: number; size: number };
    try {
      const st = await fs.stat(abs);
      before = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      return { record: null, error: `stat 失败: ${(e as Error).message}`, skippedReason: null };
    }
    const outcome = parseNote({
      vaultRoot,
      collection,
      absolutePath: abs,
      relativePath: meta.relInCollection,
      sourceRelativePath: meta.relPath,
      mtimeMs: before.mtimeMs,
      size: before.size,
    });
    let after: { mtimeMs: number; size: number };
    try {
      const st = await fs.stat(abs);
      after = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { record: null, error: '读取后 stat 失败（文件可能被移走）', skippedReason: null };
    }
    const stable = Math.abs(before.mtimeMs - after.mtimeMs) < 1 && before.size === after.size;
    if (outcome.error) return { record: null, error: outcome.error, skippedReason: null };
    if (outcome.skippedReason) {
      return { record: null, error: null, skippedReason: outcome.skippedReason };
    }
    if (stable && outcome.record) return { record: outcome.record, error: null, skippedReason: null };
    if (attempt < STAT_RETRY) await sleep(RETRY_DELAY_MS);
    else return { record: null, error: '文件持续变化（可能正被写入），本次跳过', skippedReason: null };
  }
  return { record: null, error: 'unreachable', skippedReason: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
