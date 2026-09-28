// JSON 持久化：串行写入、临时文件 + 校验 + 备份 + rename 提交。
// 写入失败必须抛错，内存状态不得先当作成功。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface LoadResult<T> {
  doc: T | null;
  recoveredFrom: string | null;
  corruptedFile: string | null;
}

export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve();
  private keepBackups: number;
  /** 递增写序号，用于备份文件命名 */
  private writeSeq = 0;

  constructor(
    readonly filePath: string,
    private backupDir: string | null,
    private validate: (data: unknown) => T | null,
    keepBackups = 5
  ) {
    this.keepBackups = keepBackups;
  }

  /** 读取；损坏时尝试备份恢复。返回 null 表示没有任何可用数据（新库） */
  load(): LoadResult<T> {
    const primary = this.tryRead(this.filePath);
    if (primary.ok) return { doc: primary.doc, recoveredFrom: null, corruptedFile: null };
    if (!primary.exists) return { doc: null, recoveredFrom: null, corruptedFile: null };

    // 主文件损坏：找最近可用备份
    const backups = this.listBackups();
    for (const b of backups) {
      const r = this.tryRead(b);
      if (r.ok) return { doc: r.doc, recoveredFrom: b, corruptedFile: this.filePath };
    }
    return { doc: null, recoveredFrom: null, corruptedFile: this.filePath };
  }

  async save(doc: T): Promise<void> {
    // 串行化：同一 store 的写操作按序执行
    const run = this.queue.then(() => this.writeOnce(doc));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeOnce(doc: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);

    const json = JSON.stringify(doc, null, 2);
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 回读校验
    const check = this.tryRead(tmp);
    if (!check.ok) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw new Error(`写入校验失败: ${this.filePath}`);
    }

    // 备份现有文件
    if (this.backupDir && fs.existsSync(this.filePath)) {
      try {
        await fsp.mkdir(this.backupDir, { recursive: true });
        this.writeSeq++;
        const base = path.basename(this.filePath).replace(/\.json$/i, '');
        const backupName = `${base}-${Date.now()}-${this.writeSeq}.json`;
        await fsp.copyFile(this.filePath, path.join(this.backupDir, backupName));
        this.pruneBackups(base);
      } catch {
        /* 备份失败不阻断提交 */
      }
    }

    try {
      await fsp.rename(tmp, this.filePath);
    } catch (e) {
      // 某些文件系统 rename 覆盖失败时退化为 copy+replace。
      // 无论 copy 成败都要清 tmp：双失败时它会随失败次数累积在数据目录里（深审发现）。
      try {
        await fsp.copyFile(tmp, this.filePath);
      } catch {
        throw new Error(`提交失败: ${(e as Error).message}`);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
      }
    }
  }

  private listBackups(): string[] {
    const bdir = this.backupDir;
    if (!bdir) return [];
    try {
      const base = path.basename(this.filePath).replace(/\.json$/i, '');
      const files = fs
        .readdirSync(bdir)
        .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => path.join(bdir, f));
      return files;
    } catch {
      return [];
    }
  }

  private pruneBackups(base: string): void {
    if (!this.backupDir) return;
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files.slice(this.keepBackups)) {
        fs.rmSync(path.join(this.backupDir, f), { force: true });
      }
    } catch {
      /* 清理失败可忽略 */
    }
  }

  private tryRead(p: string): { ok: boolean; doc: T | null; exists: boolean } {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const doc = this.validate(parsed);
      if (doc === null) return { ok: false, doc: null, exists: true };
      return { ok: true, doc, exists: true };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return { ok: false, doc: null, exists: false };
      return { ok: false, doc: null, exists: true };
    }
  }
}
