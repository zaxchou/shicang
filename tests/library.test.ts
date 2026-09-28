import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LibraryService, CategoryConflictError } from '../server/services/library';
import type { AppConfig } from '../server/config';
import { createFixture, type Fixture } from './helpers/fixture';

function makeCfg(fx: Fixture): AppConfig {
  return {
    app: 'myinfobase-test',
    vaultRoot: fx.root.replace(/\\/g, '/'),
    collections: [{ id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' }],
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

async function boot(fx: Fixture): Promise<LibraryService> {
  const svc = new LibraryService(makeCfg(fx));
  await svc.init();
  return svc;
}

describe('扫描与幂等刷新', () => {
  it('首扫导入全部笔记，二扫新增 0', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', postCreatedAt: '2026-06-01T10:00:00.000Z' });
    fx.writeNote({ id: 'id-0002', title: '笔记二', postCreatedAt: '2026-06-02T10:00:00.000Z' });
    const svc = await boot(fx);
    expect(svc.libraryInfo().total).toBe(2);

    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    const info = svc.libraryInfo();
    expect(info.lastScan?.added).toBe(0);
    expect(info.total).toBe(2);
  });

  it('新增一篇只出现一次；连续刷新两次第二次为 0', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = await boot(fx);
    expect(svc.libraryInfo().total).toBe(1);

    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    let job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.libraryInfo().total).toBe(2);

    job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.libraryInfo().lastScan?.added).toBe(0);
    expect(svc.libraryInfo().total).toBe(2);
  });

  it('源文件变化被更新；消失被标记 missing；重启后恢复', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '原标题', fileName: 'note-id-0001.md' });
    const svc = await boot(fx);
    expect(svc.detail('id-0001').title).toBe('原标题');

    // 修改（同名文件覆盖写入）
    fx.writeNote({ id: 'id-0001', title: '新标题', fileName: 'note-id-0001.md' });
    let job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').title).toBe('新标题');

    // 删除
    fx.removeNote('id-0001');
    job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').sourceStatus).toBe('missing');
    expect(svc.libraryInfo().total).toBe(1); // 记录保留

    // 重启（新实例加载已持久化索引）
    const svc2 = await boot(fx);
    expect(svc2.detail('id-0001').sourceStatus).toBe('missing');
  });

  it('重复 resourceId 冲突保留先入记录并报告', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'dup-0001', title: '甲' });
    fx.writeNote({ id: 'dup-0001', title: '乙' }, );
    const svc = await boot(fx);
    expect(svc.libraryInfo().total).toBe(1);
    expect(svc.libraryInfo().diagnostics.join()).toContain('冲突');
  });
});

describe('查询过滤与排序', () => {
  it('q 多词 AND 覆盖标题正文作者 tags', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'q-0001', title: '山水画教程', tags: ['国画'], body: '# 山水画教程\n\n黄勤老师讲解 用笔\n' });
    fx.writeNote({ id: 'q-0002', title: 'AI 工具', author: '张三', body: '# AI 工具\n\n内容无关\n' });
    const svc = await boot(fx);
    const all = svc.query(baseQuery({}));
    expect(all.total).toBe(2);
    expect(svc.query(baseQuery({ q: '山水 用笔' })).total).toBe(1);
    expect(svc.query(baseQuery({ q: '张三' })).items[0]!.id).toBe('q-0002');
    expect(svc.query(baseQuery({ q: '国画' })).items[0]!.id).toBe('q-0001');
  });

  it('发布时间排序 desc/asc，null 恒排末尾，同时间按 id 稳定', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 't-0002', postCreatedAt: '2026-06-02T10:00:00.000Z' });
    fx.writeNote({ id: 't-0001', postCreatedAt: '2026-06-02T10:00:00.000Z' });
    fx.writeNote({ id: 't-0003', postCreatedAt: '2026-06-01T10:00:00.000Z' });
    fx.writeNote({ id: 't-0004', postCreatedAt: null });
    const svc = await boot(fx);
    const desc = svc.query(baseQuery({ order: 'desc' })).items.map((i) => i.id);
    expect(desc).toEqual(['t-0001', 't-0002', 't-0003', 't-0004']);
    const asc = svc.query(baseQuery({ order: 'asc' })).items.map((i) => i.id);
    expect(asc).toEqual(['t-0003', 't-0001', 't-0002', 't-0004']);
  });

  it('时间过滤按上海日历日；同步时间过滤独立于排序', async () => {
    const fx = createFixture();
    // 2026-06-01 16:30Z = 上海 6/2；syncedAt 6/10
    fx.writeNote({
      id: 'd-0001',
      postCreatedAt: '2026-06-01T16:30:00.000Z',
      syncedAt: '2026-06-10T02:00:00.000Z',
    });
    fx.writeNote({
      id: 'd-0002',
      postCreatedAt: '2026-06-05T10:00:00.000Z',
      syncedAt: '2026-06-01T02:00:00.000Z',
    });
    fx.writeNote({ id: 'd-0003', postCreatedAt: null, syncedAt: null });
    const svc = await boot(fx);

    // 发布时间 6/2 当天（上海）
    const pub = svc.query(baseQuery({ range: 'custom', from: '2026-06-02', to: '2026-06-02' }));
    expect(pub.items.map((i) => i.id)).toEqual(['d-0001']);
    // 同步时间 6/10，排序仍按发布时间
    const sync = svc.query(baseQuery({ timeField: 'synced', range: 'custom', from: '2026-06-10', to: '2026-06-10' }));
    expect(sync.items.map((i) => i.id)).toEqual(['d-0001']);
    // null 日期不进入有时间限制的结果
    const all = svc.query(baseQuery({ range: 'custom', from: '2026-01-01', to: '2026-12-31' }));
    expect(all.items.map((i) => i.id)).toEqual(['d-0002', 'd-0001']);
    // 全部时间时包含 null
    expect(svc.query(baseQuery({})).total).toBe(3);
  });

  it('标签过滤与 tagCounts 计数', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'g-0001', title: '笔记一', tags: ['国画', '山水'] });
    fx.writeNote({ id: 'g-0002', title: '笔记二', tags: ['国画'] });
    fx.writeNote({ id: 'g-0003', title: '笔记三', tags: ['书法'] });
    const svc = await boot(fx);

    const tags = svc.tagCounts();
    expect(tags[0]).toEqual({ tag: '国画', count: 2 });
    expect(tags.find((t) => t.tag === '书法')).toEqual({ tag: '书法', count: 1 });

    const byTag = svc.query(baseQuery({ tag: '国画' }));
    expect(byTag.total).toBe(2);
    expect(svc.query(baseQuery({ tag: '国画', q: '笔记二' })).total).toBe(1); // tag 与搜索叠加
    expect(svc.query(baseQuery({ tag: '不存在的标签' })).total).toBe(0);

    // 刷新后计数缓存随 revision 失效
    fx.writeNote({ id: 'g-0004', title: '笔记四', tags: ['国画'] });
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.tagCounts().find((t) => t.tag === '国画')?.count).toBe(3);
  });

  it('分页 offset/limit 正确', async () => {
    const fx = createFixture();
    for (let i = 1; i <= 5; i++) {
      fx.writeNote({ id: `p-000${i}`, postCreatedAt: `2026-06-0${i}T10:00:00.000Z` });
    }
    const svc = await boot(fx);
    const page1 = svc.query(baseQuery({ limit: 2, offset: 0 }));
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page3 = svc.query(baseQuery({ limit: 2, offset: 4 }));
    expect(page3.items).toHaveLength(1);
  });
});

describe('分类优先级与冲突', () => {
  function writeSeed(fx: Fixture) {
    fs.writeFileSync(
      path.join(fx.dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [
          { id: 'cat-a', name: '甲类', description: '', order: 1 },
          { id: 'cat-b', name: '乙类', description: '', order: 2 },
        ],
        initialAssignments: {
          'id-0001': { categoryId: 'cat-a', rationale: 'seed', classifiedAt: '2026-01-01T00:00:00.000Z' },
          'id-0002': { categoryId: 'cat-b', rationale: 'seed', classifiedAt: '2026-01-01T00:00:00.000Z' },
        },
      }),
      'utf8'
    );
  }

  it('initial → 人工覆盖 → 刷新 → 重启，覆盖始终保留', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    writeSeed(fx);
    const svc = await boot(fx);
    expect(svc.detail('id-0001').categorySource).toBe('initial');

    // 人工改类
    const rev1 = await svc.setCategory('id-0001', 'cat-b', 0);
    expect(rev1.source).toBe('override');

    // 刷新不覆盖
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').categoryId).toBe('cat-b');

    // 重启保留
    const svc2 = await boot(fx);
    expect(svc2.detail('id-0001').categoryId).toBe('cat-b');
    expect(svc2.detail('id-0002').categorySource).toBe('initial');
  });

  it('人工置未分类（null）不被 seed 恢复', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    writeSeed(fx);
    const svc = await boot(fx);
    await svc.setCategory('id-0001', null, 0);
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    const svc2 = await boot(fx);
    const eff = svc2.detail('id-0001');
    expect(eff.categoryId).toBeNull();
    expect(eff.categorySource).toBe('override');
  });

  it('expectedRevision 冲突报错；非法类别报错', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    writeSeed(fx);
    const svc = await boot(fx);
    await svc.setCategory('id-0001', 'cat-b', 0);
    await expect(svc.setCategory('id-0001', 'cat-a', 0)).rejects.toBeInstanceOf(CategoryConflictError);
    await expect(svc.setCategory('id-0001', 'cat-x', 1)).rejects.toThrow('未知');
  });

  it('刷新期间修改分类，两项结果都保留', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    writeSeed(fx);
    const svc = await boot(fx);
    const job = svc.startRefresh();
    await svc.setCategory('id-0001', 'cat-b', 0);
    await waitForJob(svc, job.jobId);
    expect(svc.detail('id-0001').categoryId).toBe('cat-b');
    expect(svc.libraryInfo().total).toBe(1);
  });

  it('未分类计数正确', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    writeSeed(fx); // 只有 id-0001/0002 中的映射
    const svc = await boot(fx);
    const info = svc.libraryInfo();
    expect(info.uncategorized).toBe(0);
    await svc.setCategory('id-0001', null, info.categoryRevision);
    expect(svc.libraryInfo().uncategorized).toBe(1);
  });
});

function baseQuery(patch: Record<string, unknown>) {
  return {
    q: '',
    categoryId: null,
    timeField: 'published' as const,
    range: 'all' as const,
    order: 'desc' as const,
    offset: 0,
    limit: 60,
    ...patch,
  };
}

/**
 * 等待刷新结束，并且要求它是"正常完成"。
 * 只等 state !== 'running' 的话，失败的刷新和成功的一样能让测试通过——
 * 断言分类没被覆盖的用例在"刷新其实全挂了"的情况下也会绿。
 */
async function waitForJob(svc: LibraryService, jobId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const job = svc.getRefreshJob(jobId);
    if (job && job.state !== 'running') {
      if (job.state !== 'completed') {
        throw new Error(`刷新未正常完成（${job.state}）：${job.diagnostics.join(' | ')}`);
      }
      expect(job.errors).toBe(0);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('刷新任务超时');
}
