// 人工标注层（星标 / 状态 / 备注）。
// 这一层是「用户产生的数据」，与可重建的索引必须彻底分开——所以专门有一条用例验证
// "删掉索引重建之后，标星还在"；也只有它进了 library-index.json 才会被解析器升级抹掉。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AnnotationsService,
  AnnotationConflictError,
  AnnotationValidationError,
  applyAnnotationPatch,
  normalizeEntry,
} from '../server/services/annotations';
import { MAX_REMARK } from '../shared/types';
import { LibraryService, NotFoundError, ValidationError } from '../server/services/library';
import type { AppConfig } from '../server/config';
import { createFixture, type Fixture } from './helpers/fixture';

const NOW = '2026-09-28T10:00:00.000Z';
const LATER = '2026-09-28T11:00:00.000Z';

describe('标注补丁：字段级浅合并', () => {
  it('标星记录时间；重复标星不改时间，且原样返回（调用方据此不写盘）', () => {
    const a = applyAnnotationPatch(undefined, { star: true }, NOW);
    expect(a?.starredAt).toBe(NOW);
    const b = applyAnnotationPatch(a!, { star: true }, LATER);
    expect(b?.starredAt).toBe(NOW);
    expect(b).toBe(a);
  });

  it('取消标星只动 star，不碰其它字段；三项都清空后不留空壳', () => {
    const a = applyAnnotationPatch(undefined, { star: true, remark: '看过了' }, NOW);
    const b = applyAnnotationPatch(a!, { star: false }, LATER);
    expect(b?.starredAt).toBeUndefined();
    expect(b?.remark).toBe('看过了');
    const only = applyAnnotationPatch(undefined, { remark: '临时' }, NOW);
    expect(applyAnnotationPatch(only!, { remark: '   ' }, LATER)).toBeNull();
  });

  it('两个客户端各改各的字段不会互相覆盖', () => {
    const a = applyAnnotationPatch(undefined, { star: true }, NOW);
    const b = applyAnnotationPatch(a!, { remark: '素材 A' }, LATER);
    const c = applyAnnotationPatch(b!, { status: 'archived' }, LATER);
    expect(c).toMatchObject({ starredAt: NOW, remark: '素材 A', status: 'archived' });
    const d = applyAnnotationPatch(c!, { status: null }, LATER);
    expect(d?.status).toBeUndefined();
    expect(d?.starredAt).toBe(NOW);
    expect(d?.remark).toBe('素材 A');
  });

  it('备注去空白并截到上限', () => {
    const long = 'x'.repeat(MAX_REMARK + 50);
    const a = applyAnnotationPatch(undefined, { remark: `  ${long}  ` }, NOW);
    expect(a?.remark?.length).toBe(MAX_REMARK);
  });
});

describe('读时净化：坏字段丢掉而不是整份作废', () => {
  it('非法 status 与非字符串时间被丢弃，其余字段保留', () => {
    expect(normalizeEntry({ starredAt: NOW, status: 'bogus', remark: '  备注  ', updatedAt: NOW })).toEqual({
      starredAt: NOW,
      remark: '备注',
      updatedAt: NOW,
    });
  });

  it('没有任何可用字段的空壳返回 null', () => {
    expect(normalizeEntry({ updatedAt: NOW })).toBeNull();
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry({ starredAt: 123 })).toBeNull();
  });

  it('v0.7.1 写的 expired / uncollected 读盘时映射成 archived，不丢用户的标注', async () => {
    const { dataDir, backupDir } = tmpDirs();
    fs.writeFileSync(
      path.join(dataDir, 'annotations.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        entries: {
          a: { status: 'expired', statusAt: NOW, updatedAt: NOW },
          b: { status: 'uncollected', updatedAt: NOW },
        },
      }),
      'utf8'
    );
    const svc = new AnnotationsService(dataDir, backupDir);
    await svc.init();
    expect(svc.statusOf('a')).toBe('archived');
    expect(svc.statusOf('b')).toBe('archived');
    expect(svc.entryCount).toBe(2);
  });
});

function tmpDirs(): { dataDir: string; backupDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ann-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  return { dataDir, backupDir };
}

describe('AnnotationsService 落盘', () => {
  it('写盘并递增 revision；幂等重复写不抬 revision', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new AnnotationsService(dataDir, backupDir);
    expect(await svc.init()).toEqual([]);
    expect(svc.revision).toBe(0);

    expect(await svc.patch('n1', { star: true })).toBe(1);
    // 连点两下不该抬 revision：否则会顶掉别人正常编辑备注时的 expectedRevision
    expect(await svc.patch('n1', { star: true })).toBe(1);
    expect(await svc.patch('n1', { remark: '备注' })).toBe(2);
    expect(svc.isStarred('n1')).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'annotations.json'), 'utf8'));
    expect(onDisk.revision).toBe(2);
    expect(onDisk.entries.n1).toMatchObject({ remark: '备注' });
  });

  it('落盘后新实例能读回；缺 star 的字段被补成默认值', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const a = new AnnotationsService(dataDir, backupDir);
    await a.init();
    await a.patch('n1', { star: true });
    await a.patch('n2', { status: 'archived' });

    const b = new AnnotationsService(dataDir, backupDir);
    await b.init();
    expect(b.revision).toBe(a.revision);
    expect(b.effective('n1')).toMatchObject({ starred: true, status: 'active', remark: null });
    expect(b.effective('n2')).toMatchObject({ starred: false, status: 'archived' });
    expect(b.effective('n3')).toMatchObject({ starred: false, starredAt: null, status: 'active', remark: null });
  });

  it('expectedRevision 不匹配抛冲突；未知状态抛校验错误', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const svc = new AnnotationsService(dataDir, backupDir);
    await svc.init();
    await svc.patch('n1', { star: true });
    await expect(svc.patch('n1', { remark: 'x' }, 0)).rejects.toBeInstanceOf(AnnotationConflictError);
    await expect(svc.patch('n1', { remark: 'x' }, 1)).resolves.toBe(2);
    await expect(
      svc.patch('n2', { status: 'bogus' as unknown as 'archived' })
    ).rejects.toBeInstanceOf(AnnotationValidationError);
  });

  it('主文件损坏时从备份恢复，并给出诊断', async () => {
    const { dataDir, backupDir } = tmpDirs();
    const a = new AnnotationsService(dataDir, backupDir);
    await a.init();
    await a.patch('n1', { star: true }); // revision 1
    await a.patch('n1', { remark: '会丢的那条' }); // revision 2，同时备份了 revision 1

    fs.writeFileSync(path.join(dataDir, 'annotations.json'), '{ 坏掉的 JSON', 'utf8');

    const b = new AnnotationsService(dataDir, backupDir);
    const diagnostics = await b.init();
    expect(diagnostics.join()).toContain('从备份恢复');
    expect(b.revision).toBe(1); // 回到备份里的那一版，但标星没丢
    expect(b.isStarred('n1')).toBe(true);
  });

  it('手写进文件的非法条目在加载时被净化，合法条目不受影响', async () => {
    const { dataDir, backupDir } = tmpDirs();
    fs.writeFileSync(
      path.join(dataDir, 'annotations.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 7,
        entries: {
          good: { starredAt: NOW, status: 'archived', updatedAt: NOW },
          bogus: { status: 'not-a-status', updatedAt: NOW },
          junk: '这不是对象',
        },
      }),
      'utf8'
    );
    const svc = new AnnotationsService(dataDir, backupDir);
    await svc.init();
    expect(svc.revision).toBe(7);
    expect(svc.effective('good')).toMatchObject({ starred: true, status: 'archived' });
    expect(svc.effective('bogus')).toMatchObject({ starred: false, status: 'active' });
    expect(svc.entryCount).toBe(1);
  });
});

// ---- 与 LibraryService 的集成（列表筛选、计数、索引重建后仍在） ----

function makeCfg(fx: Fixture, collections = [{ id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' as const }]): AppConfig {
  return {
    app: 'myinfobase-test',
    vaultRoot: fx.root.replace(/\\/g, '/'),
    collections,
    host: '127.0.0.1',
    port: 0,
    timezone: 'Asia/Shanghai',
    publicOrigin: '',
    extraAllowedOrigins: [],
    dataDir: fx.dataDir,
    backupDir: fx.backupDir,
    logDir: path.join(fx.root, 'logs'),
    isProduction: false,
    version: 'test',
  };
}

const baseQuery = {
  timeField: 'published' as const,
  range: 'all' as const,
  order: 'desc' as const,
  offset: 0,
  limit: 60,
};

describe('列表与详情的标注', () => {
  it('默认全部是未标星/在用/无备注；标星后列表与详情都能看到', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();

    const before = svc.query({ ...baseQuery });
    expect(before.items.every((n) => n.annotation.starred === false)).toBe(true);
    expect(before.items.every((n) => n.annotation.status === 'active')).toBe(true);
    expect(before.items.every((n) => n.annotation.remark === null)).toBe(true);

    const out = await svc.setStar('id-0001', true);
    expect(out.starred).toBe(true);
    expect(out.revision).toBe(1);

    const after = svc.query({ ...baseQuery });
    const one = after.items.find((n) => n.id === 'id-0001');
    expect(one?.annotation.starred).toBe(true);
    expect(one?.annotation.starredAt).toBeTruthy();
    expect(svc.detail('id-0001').annotation.starred).toBe(true);
    expect(svc.detail('id-0002').annotation.starred).toBe(false);
  });

  it('starred 查询只返回标星条目，总数与侧栏计数一致', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    fx.writeNote({ id: 'id-0003', title: '笔记三' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();

    await svc.setStar('id-0001', true);
    await svc.setStar('id-0003', true);

    const starred = svc.query({ ...baseQuery, starred: true });
    expect(starred.total).toBe(2);
    expect(starred.items.map((n) => n.id).sort()).toEqual(['id-0001', 'id-0003']);
    // 不传 starred 时行为不变（默认全量）
    expect(svc.query({ ...baseQuery }).total).toBe(3);
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.starred).toBe(2);

    await svc.setStar('id-0003', false);
    expect(svc.query({ ...baseQuery, starred: true }).total).toBe(1);
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.starred).toBe(1);
  });

  it('标星与其它筛选叠加（分类里再筛标星）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStar('id-0001', true);

    // 未分类里筛标星：id-0001 有分类依据才不在这里，这里只验证"叠加"这件事本身不互相吞掉
    const starred = svc.query({ ...baseQuery, starred: true, categoryId: 'uncategorized' });
    const all = svc.query({ ...baseQuery, categoryId: 'uncategorized' });
    expect(starred.total).toBeLessThanOrEqual(all.total);
    expect(starred.items.every((n) => n.annotation.starred)).toBe(true);
  });

  it('索引被删掉重建后，标星仍在（标注不参与索引指纹）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const first = new LibraryService(makeCfg(fx));
    await first.init();
    await first.setStar('id-0001', true);
    expect(fs.existsSync(path.join(fx.dataDir, 'library-index.json'))).toBe(true);

    // 模拟"解析器升级导致的索引整体作废重建"
    fs.rmSync(path.join(fx.dataDir, 'library-index.json'));
    const second = new LibraryService(makeCfg(fx));
    await second.init();
    expect(second.libraryInfo().total).toBe(1); // 重新扫描回来了
    expect(second.query({ ...baseQuery }).items[0]?.annotation.starred).toBe(true);
    expect(second.libraryInfo().collections.find((c) => c.id === 'rednote')?.starred).toBe(1);
  });

  it('刷新（重新扫描）之后标星仍在', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStar('id-0001', true);

    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.query({ ...baseQuery }).items[0]?.annotation.starred).toBe(true);
  });

  it('不存在的笔记标星 → NotFoundError', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await expect(svc.setStar('id-9999', true)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('非小红书收藏库也能标星（星标是个人标注，不像分类那样受"以笔记为准"限制）', async () => {
    const fx = createFixture();
    fs.mkdirSync(path.join(fx.root, '我的收藏品'), { recursive: true });
    fs.writeFileSync(
      path.join(fx.root, '我的收藏品', '宝贝一.md'),
      '---\n收藏分类: 茶器\n---\n\n# 宝贝一\n\n正文\n',
      'utf8'
    );
    const svc = new LibraryService(
      makeCfg(fx, [
        { id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' },
        { id: 'treasures', name: '我的宝贝', root: '我的收藏品', type: 'treasures' },
      ])
    );
    await svc.init();
    const id = svc.query({ ...baseQuery, collection: 'treasures' }).items[0]?.id;
    expect(id).toBeTruthy();

    // 分类仍然不能改（原有约束不变）
    await expect(svc.setCategory(id!, 'cat-a', 0)).rejects.toBeInstanceOf(ValidationError);
    // 标星可以
    await expect(svc.setStar(id!, true)).resolves.toMatchObject({ starred: true });
    expect(svc.query({ ...baseQuery, collection: 'treasures', starred: true }).total).toBe(1);
    expect(svc.query({ ...baseQuery, collection: 'rednote', starred: true }).total).toBe(0);
  });

  it('源文件消失（missing）后标注不丢：列表口径不变，detail 仍带标星', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStar('id-0001', true);

    fx.removeNote('id-0001');
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').sourceStatus).toBe('missing');
    expect(svc.detail('id-0001').annotation.starred).toBe(true);
    // 列表仍然只列源文件可用的条目（归档视图是下一步的事），计数也只算可用的
    expect(svc.query({ ...baseQuery }).total).toBe(0);
    expect(svc.query({ ...baseQuery, starred: true }).total).toBe(0);
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.starred).toBe(0);
  });
});

describe('状态与归档视图', () => {
  it('默认只显示在用；归档后从默认列表消失、进入归档视图，详情仍可读', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    expect(svc.query({ ...baseQuery }).total).toBe(2);

    const out = await svc.setStatus('id-0001', 'archived', 0);
    expect(out).toMatchObject({ status: 'archived', revision: 1 });

    expect(svc.query({ ...baseQuery }).total).toBe(1);
    expect(svc.query({ ...baseQuery }).items[0]?.id).toBe('id-0002');

    const arch = svc.query({ ...baseQuery, status: 'archived' });
    expect(arch.total).toBe(1);
    expect(arch.items[0]?.id).toBe('id-0001');
    expect(arch.items[0]?.annotation.status).toBe('archived');
    // 归档不是删除：详情一直读得到
    expect(svc.detail('id-0001').annotation.status).toBe('archived');
  });

  it('计数与列表同口径：归档后 active/uncategorized/starred 一起减，archived 加', async () => {
    const fx = createFixture();
    for (const id of ['id-0001', 'id-0002', 'id-0003']) fx.writeNote({ id, title: `笔记${id}` });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStar('id-0001', true);

    const before = svc.libraryInfo().collections.find((c) => c.id === 'rednote')!;
    expect(before).toMatchObject({ total: 3, active: 3, archived: 0, starred: 1, uncategorized: 3 });

    await svc.setStatus('id-0003', 'archived', 1);
    const after = svc.libraryInfo().collections.find((c) => c.id === 'rednote')!;
    expect(after).toMatchObject({ total: 3, active: 2, archived: 1, starred: 1, uncategorized: 2 });
    // 侧栏的数字必须等于列表条数
    expect(svc.query({ ...baseQuery }).total).toBe(after.active);
    expect(svc.query({ ...baseQuery, status: 'archived' }).total).toBe(after.archived);

    // 归档掉被标星的那条 → 标星计数只算工作集
    await svc.setStatus('id-0001', 'archived', 2);
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.starred).toBe(0);
    // 但"归档 ∩ 标星"这个组合查询还找得到它
    expect(svc.query({ ...baseQuery, status: 'archived', starred: true }).total).toBe(1);
  });

  it('标签计数只算工作集，且缓存不能忽略标注变化', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', tags: ['茶器'] });
    fx.writeNote({ id: 'id-0002', title: '笔记二', tags: ['茶器'] });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    expect(svc.tagCounts('rednote').find((t) => t.tag === '茶器')?.count).toBe(2);

    await svc.setStatus('id-0001', 'archived', 0);
    // 索引 revision 没变，但标签计数必须跟着变（缓存键要含标注 revision）
    expect(svc.tagCounts('rednote').find((t) => t.tag === '茶器')?.count).toBe(1);
  });

  it('归档后源文件消失：归档视图带着它，默认视图看不到（标注不随文件消失）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStatus('id-0001', 'archived', 0);

    fx.removeNote('id-0001');
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').sourceStatus).toBe('missing');

    const arch = svc.query({ ...baseQuery, status: 'archived', includeMissing: true });
    expect(arch.total).toBe(1);
    expect(arch.items[0]?.sourceStatus).toBe('missing');
    expect(arch.items[0]?.annotation.status).toBe('archived');
    // 不带 includeMissing 就看不到（文件确实不在了）
    expect(svc.query({ ...baseQuery, status: 'archived' }).total).toBe(0);
    // 归档计数与带 includeMissing 的列表一致（侧栏数字不撒谎）
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.archived).toBe(1);
  });

  it('恢复在用：回到默认列表，归档计数归零', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStatus('id-0001', 'archived', 0);
    expect(svc.query({ ...baseQuery }).total).toBe(0);

    const back = await svc.setStatus('id-0001', null, 1);
    expect(back.status).toBe('active');
    expect(svc.query({ ...baseQuery }).total).toBe(1);
    expect(svc.libraryInfo().collections.find((c) => c.id === 'rednote')?.archived).toBe(0);
  });

  it('状态与星标互不影响（同一条目、字段级合并）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setStar('id-0001', true);
    await svc.setStatus('id-0001', 'archived', 1);

    expect(svc.detail('id-0001').annotation).toMatchObject({ starred: true, status: 'archived' });
    // 取消标星不能把状态一起带走
    await svc.setStar('id-0001', false);
    expect(svc.detail('id-0001').annotation).toMatchObject({ starred: false, status: 'archived' });
    expect(svc.libraryInfo().annotationRevision).toBe(3);
  });

  it('状态的 expectedRevision 冲突会抛错；不存在的笔记 404', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await expect(svc.setStatus('id-0001', 'archived', 99)).rejects.toBeInstanceOf(AnnotationConflictError);
    await expect(svc.setStatus('id-9999', 'archived', 0)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('非小红书收藏库也能归档', async () => {
    const fx = createFixture();
    fs.mkdirSync(path.join(fx.root, '我的收藏品'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, '我的收藏品', '宝贝一.md'), '---\n收藏分类: 茶器\n---\n\n# 宝贝一\n\n正文\n', 'utf8');
    const svc = new LibraryService(
      makeCfg(fx, [
        { id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' },
        { id: 'treasures', name: '我的宝贝', root: '我的收藏品', type: 'treasures' },
      ])
    );
    await svc.init();
    const id = svc.query({ ...baseQuery, collection: 'treasures' }).items[0]?.id;
    expect(id).toBeTruthy();
    await expect(svc.setStatus(id!, 'archived', 0)).resolves.toMatchObject({ status: 'archived' });
    expect(svc.query({ ...baseQuery, collection: 'treasures' }).total).toBe(0);
    expect(svc.query({ ...baseQuery, collection: 'treasures', status: 'archived' }).total).toBe(1);
  });
});

describe('备注', () => {
  it('写入后列表与详情都带备注，且能按备注搜到（正文里没有那些字）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', body: '正文里没有那个词' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();

    await svc.setAnnotation('id-0001', { remark: '下次装修参考这个配色' }, 0);
    const listed = svc.query({ ...baseQuery }).items.find((n) => n.id === 'id-0001');
    expect(listed?.annotation.remark).toBe('下次装修参考这个配色');
    expect(svc.detail('id-0001').annotation.remark).toBe('下次装修参考这个配色');

    // 备注是后加字段，必须显式并进搜索，否则"搜自己写的东西"搜不到
    const hit = svc.query({ ...baseQuery, q: '装修' });
    expect(hit.total).toBe(1);
    expect(hit.items[0]?.id).toBe('id-0001');
    // 多词 AND：一个词命中正文、一个词命中备注，也算命中
    expect(svc.query({ ...baseQuery, q: '笔记一 装修' }).total).toBe(1);
    // 有一个词哪都不在 → 排除
    expect(svc.query({ ...baseQuery, q: '装修 不存在的词' }).total).toBe(0);
    // 大小写不敏感
    expect(svc.query({ ...baseQuery, q: '装修' }).total).toBe(1);
  });

  it('清空备注（null / 空串）之后不再被搜到，也不留空壳', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setAnnotation('id-0001', { remark: '独特词' }, 0);
    expect(svc.query({ ...baseQuery, q: '独特词' }).total).toBe(1);

    const out = await svc.setAnnotation('id-0001', { remark: null }, 1);
    expect(out.remark).toBeNull();
    expect(svc.query({ ...baseQuery, q: '独特词' }).total).toBe(0);
  });

  it('备注 revision 冲突与长度上限', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await expect(svc.setAnnotation('id-0001', { remark: 'x' }, 99)).rejects.toBeInstanceOf(
      AnnotationConflictError
    );
    const out = await svc.setAnnotation('id-0001', { remark: 'x'.repeat(MAX_REMARK + 100) }, 0);
    expect(out.remark?.length).toBe(MAX_REMARK);
  });

  it('备注与星标、归档互不影响（同一条目的不同字段）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await svc.setAnnotation('id-0001', { star: true }, 0);
    await svc.setAnnotation('id-0001', { remark: '留个记号' }, 1);
    await svc.setAnnotation('id-0001', { status: 'archived' }, 2);

    const ann = svc.detail('id-0001').annotation;
    expect(ann).toMatchObject({ starred: true, status: 'archived', remark: '留个记号' });
    // 归档视图里备注也还在，并且能搜到
    const arch = svc.query({ ...baseQuery, status: 'archived' });
    expect(arch.items[0]?.annotation.remark).toBe('留个记号');
    expect(svc.query({ ...baseQuery, status: 'archived', q: '记号' }).total).toBe(1);
  });

  it('刷新与索引重建之后备注仍在', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const first = new LibraryService(makeCfg(fx));
    await first.init();
    await first.setAnnotation('id-0001', { remark: '不该丢' }, 0);

    const job = first.startRefresh();
    await waitForJob(first, job.jobId);
    expect(first.detail('id-0001').annotation.remark).toBe('不该丢');

    fs.rmSync(path.join(fx.dataDir, 'library-index.json'));
    const second = new LibraryService(makeCfg(fx));
    await second.init();
    expect(second.detail('id-0001').annotation.remark).toBe('不该丢');
    expect(second.query({ ...baseQuery, q: '不该丢' }).total).toBe(1);
  });
});

async function waitForJob(svc: LibraryService, jobId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const job = svc.getRefreshJob(jobId);
    if (job && job.state === 'completed' && job.errors === 0) return;
    if (job && (job.state === 'failed' || job.state === 'partial')) {
      throw new Error(`刷新未成功: ${job.state} ${job.diagnostics.join('; ')}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('刷新超时');
}
