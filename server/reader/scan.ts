// 目录枚举与增量扫描：并发受控、读写前后校验、失败保留旧记录。
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNote, type NoteRecord } from './parse.js';

export interface FileMeta {
  relPath: string;
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

/** 递归枚举 Bookmarks 下的 .md（排序保证确定性）；失败抛错 */
export async function enumerateNotes(bookmarksDir: string): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`目录无法读取: ${dir} (${(e as Error).message})`);
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const st = await fs.stat(abs);
        out.push({ relPath: rel, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  await walk(bookmarksDir, '');
  return out;
}

/**
 * 全量枚举 + 增量解析。
 * @param existingByPath 旧索引按路径的记录
 */
export async function scanLibrary(
  sourceRoot: string,
  existingByPath: Map<string, NoteRecord>,
  onProgress?: (done: number, total: number) => void
): Promise<ScanOutcome> {
  const diagnostics: string[] = [];
  const counts: ScanCounts = { scanned: 0, added: 0, updated: 0, skipped: 0, errors: 0 };
  const bookmarksDir = path.join(sourceRoot, 'Bookmarks');
  const files = await enumerateNotes(bookmarksDir);
  const enumerated = true;

  const byPath = new Map<string, NoteRecord>();
  const records: NoteRecord[] = [];
  let done = 0;

  const queue = files.slice();
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const meta = queue.shift();
      if (!meta) return;
      done++;
      if (done % 50 === 0) onProgress?.(done, files.length);

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

      const abs = path.join(bookmarksDir, ...meta.relPath.split('/'));
      const outcome = await readAndParseStable(abs, meta, sourceRoot);
      if (outcome.error) {
        counts.errors++;
        if (prev) {
          byPath.set(meta.relPath, prev);
          records.push(prev);
          diagnostics.push(`${meta.relPath}: ${outcome.error}；保留旧记录`);
        } else {
          counts.skipped++;
          diagnostics.push(`${meta.relPath}: ${outcome.error}；跳过`);
        }
        continue;
      }
      counts.scanned++;
      if (outcome.record) {
        const rec = outcome.record;
        const dup = records.find((r) => r.id === rec.id);
        if (dup) {
          counts.errors++;
          diagnostics.push(`${meta.relPath}: resourceId ${rec.id} 与 ${dup.sourceRelativePath} 冲突，保留先入索引记录`);
          byPath.set(meta.relPath, prev ?? rec);
          if (!prev) {
            // 冲突记录不入结果，避免 ID 重复
          } else {
            records.push(prev);
          }
          continue;
        }
        byPath.set(meta.relPath, rec);
        records.push(rec);
        if (prev) counts.updated++;
        else counts.added++;
      } else {
        counts.skipped++;
      }
    }
  });
  await Promise.all(workers);

  // 完整枚举成功后：旧索引中已从磁盘消失的文件标记 missing
  for (const [rel, rec] of existingByPath) {
    if (!byPath.has(rel)) {
      const missing: NoteRecord = { ...rec, sourceStatus: 'missing' };
      byPath.set(rel, missing);
      records.push(missing);
      diagnostics.push(`${rel}: 源文件已消失，标记为 missing（保留记录与分类）`);
    }
  }

  return { records, diagnostics, counts, enumerated };
}

async function readAndParseStable(
  abs: string,
  meta: FileMeta,
  sourceRoot: string
): Promise<{ record: import('./parse.js').NoteRecord | null; error: string | null }> {
  for (let attempt = 0; attempt <= STAT_RETRY; attempt++) {
    let before: { mtimeMs: number; size: number };
    try {
      const st = await fs.stat(abs);
      before = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      return { record: null, error: `stat 失败: ${(e as Error).message}` };
    }
    const outcome = parseNote({
      absolutePath: abs,
      relativePath: meta.relPath,
      sourceRoot,
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
    if (outcome.error) return outcome;
    if (stable && outcome.record) return outcome;
    if (attempt < STAT_RETRY) await sleep(RETRY_DELAY_MS);
    else return { record: null, error: '文件持续变化（可能正被写入），本次跳过' };
  }
  return { record: null, error: 'unreachable' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
