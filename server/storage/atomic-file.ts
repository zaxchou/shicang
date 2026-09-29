// 单个文本文件的原子写入：临时文件 + 回读校验 + rename 提交。
// 与 corpus.ts 的 writeFileAtomic 同款纪律（rename 覆盖失败时退化为 copy+replace，NAS 上真遇到过）；
// 独立成模块供编辑写回 vault（v0.17）使用——那是唯一往内容源写数据的通道，必须最稳。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function writeTextFileAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  const check = await fsp.readFile(tmp, 'utf8');
  if (check !== content) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new Error(`写入校验失败: ${file}`);
  }
  try {
    await fsp.rename(tmp, file);
  } catch {
    // rename 覆盖已有文件在某些文件系统/挂载上会失败（EXDEV/EPERM），退化为 copy+replace
    try {
      await fsp.copyFile(tmp, file);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}
