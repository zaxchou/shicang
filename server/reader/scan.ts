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
        byPath.set(meta.relPath, prev);
        records.push(prev);
        counts.skipped++;
        continue;
      }

      const abs = path.join(vaultRoot, ...meta.relPath.split('/'));
      const outcome = await readAndParseStable(abs, meta, vaultRoot, colMap.get(meta.collection)!);
      if (outcome.error || !outcome.record) {
        counts.errors++;
        if (prev) {
          byPath.set(meta.relPath, prev);
          records.push(prev);
          diagnostics.push(`${meta.relPath}: ${outcome.error ?? '解析为空'}；保留旧记录`);
        } else {
          counts.skipped++;
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
        if (prev) records.push(prev);
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

  // 完整枚举成功后：旧索引中已消失的文件标记 missing（保留记录与分类）
  for (const [rel, rec] of existingByPath) {
    if (!byPath.has(rel)) {
      const missing: NoteRecord = { ...rec, sourceStatus: 'missing' };
      byPath.set(rel, missing);
      records.push(missing);
      diagnostics.push(`${rel}: 源文件已消失，标记为 missing（保留记录与人工分类）`);
    }
  }

  return { records, diagnostics, counts, enumerated: true };
}

async function readAndParseStable(
  abs: string,
  meta: FileMeta,
  vaultRoot: string,
  collection: CollectionDef
): Promise<{ record: NoteRecord | null; error: string | null }> {
  for (let attempt = 0; attempt <= STAT_RETRY; attempt++) {
    let before: { mtimeMs: number; size: number };
    try {
      const st = await fs.stat(abs);
      before = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      return { record: null, error: `stat 失败: ${(e as Error).message}` };
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
      return { record: null, error: '读取后 stat 失败（文件可能被移走）' };
    }
    const stable = Math.abs(before.mtimeMs - after.mtimeMs) < 1 && before.size === after.size;
    if (outcome.error) return { record: null, error: outcome.error };
    if (stable && outcome.record) return { record: outcome.record, error: null };
    if (attempt < STAT_RETRY) await sleep(RETRY_DELAY_MS);
    else return { record: null, error: '文件持续变化（可能正被写入），本次跳过' };
  }
  return { record: null, error: 'unreachable' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
