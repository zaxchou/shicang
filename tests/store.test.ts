import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/storage/json-store';

interface Doc {
  schemaVersion: number;
  value: string;
}

const validate = (d: unknown): Doc | null => {
  if (typeof d !== 'object' || d === null) return null;
  const o = d as Doc;
  return o.schemaVersion === 1 && typeof o.value === 'string' ? o : null;
};

describe('JsonStore 持久化', () => {
  it('保存并回读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-store-'));
    const store = new JsonStore<Doc>(path.join(dir, 'a.json'), null, validate);
    await store.save({ schemaVersion: 1, value: 'hello' });
    expect(store.load().doc?.value).toBe('hello');
  });

  it('损坏时从最近备份恢复，损坏文件保留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-store-'));
    const backupDir = path.join(dir, 'bak');
    const store = new JsonStore<Doc>(path.join(dir, 'a.json'), backupDir, validate);
    await store.save({ schemaVersion: 1, value: 'good-1' });
    await store.save({ schemaVersion: 1, value: 'good-2' });
    await store.save({ schemaVersion: 1, value: 'good-3' });
    // 备份里最新的是 good-2（good-3 在主文件中）
    // 破坏主文件
    fs.writeFileSync(path.join(dir, 'a.json'), '{"schemaVersion":1,"value":"corrupt', 'utf8');
    const res = store.load();
    expect(res.doc?.value).toBe('good-2');
    expect(res.recoveredFrom).toBeTruthy();
    expect(res.corruptedFile).toBe(path.join(dir, 'a.json'));
    // 损坏文件仍在
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toContain('corrupt');
  });

  it('校验不通过的数据不覆盖旧文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-store-'));
    const store = new JsonStore<Doc>(path.join(dir, 'a.json'), null, validate);
    await store.save({ schemaVersion: 1, value: 'v1' });
    // 绕过类型写入非法文档
    await expect(store.save({ schemaVersion: 2, value: 1 } as unknown as Doc)).rejects.toThrow();
    expect(store.load().doc?.value).toBe('v1');
  });

  it('串行写入按序完成', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-store-'));
    const store = new JsonStore<Doc>(path.join(dir, 'a.json'), null, validate);
    await Promise.all([
      store.save({ schemaVersion: 1, value: 'a' }),
      store.save({ schemaVersion: 1, value: 'b' }),
      store.save({ schemaVersion: 1, value: 'c' }),
    ]);
    expect(store.load().doc?.value).toBe('c');
  });

  it('备份保留数量受限，且保留的是最新的几份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-store-'));
    const backupDir = path.join(dir, 'bak');
    const store = new JsonStore<Doc>(path.join(dir, 'a.json'), backupDir, validate, 3);
    for (let i = 0; i < 6; i++) await store.save({ schemaVersion: 1, value: `v${i}` });
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('a-'));
    // 恰好 3 份：写成 ≤3 的话，一个都不备份也能通过
    expect(backups.length).toBe(3);
    // 保留的必须是最新的 3 份（v2/v3/v4；v5 在主文件里）
    const values = backups
      .map((f) => JSON.parse(fs.readFileSync(path.join(backupDir, f), 'utf8')).value as string)
      .sort();
    expect(values).toEqual(['v2', 'v3', 'v4']);
  });
});
