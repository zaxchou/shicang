// 扫描完整性：这些路径此前完全没有测试，而它们的失效方式是"库悄悄变了样子"——
// 记录被复制、该移除的没移除、整体消失时把索引覆盖成空。
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LibraryService } from '../server/services/library';
import type { AppConfig } from '../server/config';
import { createFixture, type Fixture } from './helpers/fixture';

function makeCfg(fx: Fixture, collections?: AppConfig['collections']): AppConfig {
  return {
    app: 'myinfobase-test',
    vaultRoot: fx.root.replace(/\\/g, '/'),
    collections:
      collections ?? [{ id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' }],
    groups: [],
    host: '127.0.0.1',
    port: 0,
    timezone: 'Asia/Shanghai',
    publicOrigin: '',
    extraAllowedOrigins: [],
    dataDir: fx.dataDir,
    backupDir: fx.backupDir,
    exportDir: fx.exportDir,
    exportAfterRefresh: false,
    autoRefreshOnBoot: false,
    vaultWriteEnabled: false,
    logDir: path.join(fx.root, 'logs'),
    isProduction: false,
    version: 'test',
  };
}

const TREASURES: AppConfig['collections'] = [
  { id: 'treasures', name: '我的宝贝', root: '我的收藏品', type: 'treasures' },
];

function writeTreasure(fx: Fixture, name: string, raw: string): void {
  const dir = path.join(fx.root, '我的收藏品');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), raw, 'utf8');
}

async function boot(cfg: AppConfig): Promise<LibraryService> {
  const svc = new LibraryService(cfg);
  await svc.init();
  return svc;
}

async function refresh(svc: LibraryService) {
  const job = svc.startRefresh();
  for (let i = 0; i < 200; i++) {
    const cur = svc.getRefreshJob(job.jobId);
    if (cur && cur.state !== 'running') return cur;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('刷新任务超时');
}

describe('扫描完整性', () => {
  it('快路径（mtime/size 未变）真的生效：skipped 计数、updated 为 0', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'id-0001', title: '一' });
    fx.writeNote({ id: 'id-0002', title: '二' });
    const svc = await boot(makeCfg(fx));

    const job = await refresh(svc);
    expect(job.state).toBe('completed');
    expect(job.errors).toBe(0);
    expect(job.updated).toBe(0);
    expect(job.added).toBe(0);
    expect(job.skipped).toBe(2); // 两个文件都走了"未变化直接复用旧记录"
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('有意跳过的笔记被移出库（不是标记 missing，也不留两条记录）', async () => {
    const fx = createFixture('myinfobase-scan');
    const cfg = makeCfg(fx, TREASURES);
    writeTreasure(fx, '圆砚.md', '---\n收藏分类: 文房\n---\n\n# 圆砚\n\n正文\n');
    writeTreasure(fx, '梯形砚.md', '---\n收藏分类: 文房\n---\n\n# 梯形砚\n\n正文\n');
    const svc = await boot(cfg);
    expect(svc.libraryInfo().total).toBe(2);

    // 同一个文件变成空笔记 → 命中"有意跳过"
    writeTreasure(fx, '梯形砚.md', '');
    const job = await refresh(svc);

    expect(job.state).toBe('completed');
    expect(svc.libraryInfo().total).toBe(1);
    expect(() => svc.detail('我的收藏品/梯形砚.md')).toThrow(/未找到/);
    expect(job.diagnostics.some((d) => d.includes('已从库中移除'))).toBe(true);
    expect(job.diagnostics.some((d) => d.includes('源文件已消失'))).toBe(false);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('ID 冲突：旧记录只保留一条，且不会反过来变成 missing', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'id-0001', title: '甲', fileName: 'a.md' });
    fx.writeNote({ id: 'id-0002', title: '乙', fileName: 'b.md' });
    const svc = await boot(makeCfg(fx));
    expect(svc.libraryInfo().total).toBe(2);

    // b.md 的 resourceId 改成与 a.md 相同 → 冲突
    fx.writeNote({ id: 'id-0001', title: '乙', fileName: 'b.md' });
    const job = await refresh(svc);

    // 冲突计入 errors（用户能看到"这次刷新有 1 个问题"），因此是 partial 而不是 completed
    expect(job.state).toBe('partial');
    expect(job.errors).toBe(1);
    expect(
      svc.libraryInfo().total
    ).toBe(2); // 旧实现会变成 3：同一路径既"保留旧记录"又被当成消失补一条
    expect(job.diagnostics.some((d) => d.includes('冲突'))).toBe(true);
    expect(svc.detail('id-0002').sourceStatus).toBe('available'); // 旧实现里 byId 会指向 missing 副本

    // 再刷一次：冲突仍然只有一个"胜者"，不会因为快路径漏登记 ID 而把输家收进来
    const again = await refresh(svc);
    expect(again.errors).toBe(1); // 冲突依旧报错（源数据确实有问题）
    expect(svc.libraryInfo().total).toBe(2);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  // 改名 = 新路径接管同一稳定 ID：旧路径的 missing 副本不能再进索引，
  // 否则 rebuildMaps 后写覆盖先写，详情会指向旧路径/源缺失（评审 R2）。
  it('改名后同 ID 只留一条且详情指向新路径；再刷与重启都不复发', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'stable-note-1', title: '旧标题', fileName: 'old.md', images: 0 });
    const svc = await boot(makeCfg(fx));
    expect(svc.libraryInfo().total).toBe(1);

    fs.renameSync(
      path.join(fx.sourceRoot, 'Bookmarks', 'old.md'),
      path.join(fx.sourceRoot, 'Bookmarks', 'new.md')
    );
    const job = await refresh(svc);
    expect(job.state).toBe('completed'); // 改名不是错误
    expect(job.errors).toBe(0);

    const rows = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'library-index.json'), 'utf8')).notes as Array<{
      id: string;
      sourceRelativePath: string;
      sourceStatus: string;
    }>;
    const same = rows.filter((n) => n.id === 'stable-note-1');
    expect(same).toHaveLength(1);
    expect(same[0]!.sourceRelativePath).toContain('new.md');
    expect(same[0]!.sourceStatus).toBe('available');
    expect(svc.detail('stable-note-1').sourceRelativePath).toContain('new.md');
    expect(svc.detail('stable-note-1').sourceStatus).toBe('available');
    expect(svc.libraryInfo().total).toBe(1);

    // 再刷一次（幂等）与重启（重新加载落盘索引）都不复发
    const again = await refresh(svc);
    expect(again.state).toBe('completed');
    expect(svc.libraryInfo().total).toBe(1);
    const reloaded = await boot(makeCfg(fx));
    expect(reloaded.libraryInfo().total).toBe(1);
    expect(reloaded.detail('stable-note-1').sourceStatus).toBe('available');
    expect(reloaded.detail('stable-note-1').sourceRelativePath).toContain('new.md');
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('全部源文件消失：记录以 missing 保留（分类不丢），并给出醒目提示', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'id-0001', title: '一' });
    fx.writeNote({ id: 'id-0002', title: '二' });
    const svc = await boot(makeCfg(fx));
    expect(svc.libraryInfo().total).toBe(2);

    fs.rmSync(path.join(fx.sourceRoot, 'Bookmarks'), { recursive: true, force: true });
    fs.mkdirSync(path.join(fx.sourceRoot, 'Bookmarks'), { recursive: true });

    const job = await refresh(svc);
    expect(job.state).toBe('completed'); // 不硬失败：硬失败会让"真的清空了库"的用户没有出路
    expect(job.diagnostics.some((d) => d.includes('一篇可读笔记都没读到'))).toBe(true);
    expect(svc.libraryInfo().total).toBe(2); // 记录仍在（missing），分类保留
    expect(svc.libraryInfo().diagnostics.some((d) => d.includes('一篇可读笔记都没读到'))).toBe(true);
    const list = svc.query({
      q: '',
      categoryId: null,
      timeField: 'published',
      range: 'all',
      order: 'desc',
      offset: 0,
      limit: 10,
    });
    expect(list.total).toBe(0); // 列表里不显示 missing 条目

    // 源文件回来后，刷新即恢复
    fx.writeNote({ id: 'id-0001', title: '一' });
    fx.writeNote({ id: 'id-0002', title: '二' });
    const back = await refresh(svc);
    expect(back.errors).toBe(0);
    expect(
      svc.query({ q: '', categoryId: null, timeField: 'published', range: 'all', order: 'desc', offset: 0, limit: 10 }).total
    ).toBe(2);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('categories.json 里 initialAssignments 为 null 时按损坏处理，不崩', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'id-0001', title: '一' });
    fs.writeFileSync(
      path.join(fx.dataDir, 'categories.json'),
      JSON.stringify({ schemaVersion: 1, categories: [], initialAssignments: null }),
      'utf8'
    );
    const svc = await boot(makeCfg(fx));
    const info = svc.libraryInfo();
    expect(info.diagnostics.some((d) => d.includes('categories.json 损坏'))).toBe(true);
    expect(svc.detail('id-0001').categoryId).toBeNull();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });
});

describe('自动分类覆盖 web 型（v0.15.0 双维度）', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function writeWebNote(fx: Fixture, name: string, raw: string): void {
    const dir = path.join(fx.root, 'Clippings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), raw, 'utf8');
  }
  const WEB_CFG: AppConfig['collections'] = [{ id: 'web', name: '网页', root: 'Clippings', type: 'web' }];

  it('首扫即按规则给 web 笔记写 initialAssignments（规则命中，不花 AI）', async () => {
    const fx = createFixture('myinfobase-scan');
    writeWebNote(fx, '旅行见闻.md', '这是一篇讲旅行与美食探店的剪藏。');
    writeWebNote(fx, '无规则命中.md', 'qqq 没有任何规则词。');
    fs.writeFileSync(
      path.join(fx.dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [{ id: 'life', name: '生活', description: '旅行见闻', order: 1 }],
        initialAssignments: {},
      }),
      'utf8'
    );
    delete process.env.AI_CLASSIFY_API_KEY; // 没有 AI 也要能靠规则分类
    const svc = await boot(makeCfg(fx, WEB_CFG));
    const list = svc.query({
      q: '', timeField: 'published', range: 'all', order: 'desc', offset: 0, limit: 10, collection: 'web',
    });
    const hit = list.items.find((i) => i.title === '旅行见闻');
    expect(hit!.categoryId).toBe('life');
    expect(hit!.categorySource).toBe('initial'); // 走的是人工分类层，不是 derived
    expect(hit!.sourceCategory).toBeNull(); // 无 frontmatter → 无来源，两个维度互不相干
    // 无 frontmatter 的笔记标题取自文件名（不是正文首词）
    expect(list.items.find((i) => i.title === '无规则命中')!.categoryId).toBeNull();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('文件一个没变的刷新也会跑自动分类（AI 兜底补上首扫漏下的 web 笔记）', async () => {
    const fx = createFixture('myinfobase-scan');
    writeWebNote(fx, '无规则命中.md', 'qqq 没有任何规则词。');
    fs.writeFileSync(
      path.join(fx.dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [{ id: 'life', name: '生活', description: '', order: 1 }],
        initialAssignments: {},
      }),
      'utf8'
    );
    const q = { q: '', timeField: 'published' as const, range: 'all' as const, order: 'desc' as const, offset: 0, limit: 10, collection: 'web' };
    let calls = 0;
    const realFetch = globalThis.fetch;
    try {
      // 第一步：没有 AI key 时首扫（规则也不中）→ 保持未分类
      delete process.env.AI_CLASSIFY_API_KEY;
      const svc = await boot(makeCfg(fx, WEB_CFG));
      expect(svc.query(q).items[0]!.categoryId).toBeNull();
      // 第二步：配好 AI，刷新——**这次一个文件都没变**（快路径 skipped=1），
      // 分类仍要跑，否则线上那些"扫完才配好 key / 格式后来才支持"的笔记会永远停在未分类
      process.env.AI_CLASSIFY_API_KEY = 'test-key';
      process.env.AI_CLASSIFY_MAX_PER_REFRESH = '10';
      globalThis.fetch = (async () => {
        calls++;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"categoryId":"life","reason":"测试"}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;
      const job = await refresh(svc);
      expect(job.state).toBe('completed');
      expect(calls).toBe(1);
      const after = svc.query(q).items[0]!;
      expect(after.categoryId).toBe('life');
      expect(after.categorySource).toBe('initial');
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe('AI 分类兜底的上限保护', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('一次刷新最多调用 AI_CLASSIFY_MAX_PER_REFRESH 次，其余留待下次', async () => {
    const fx = createFixture('myinfobase-scan');
    // 标题刻意不含任何规则关键词，逼它走 AI 分支
    for (const id of ['id-0001', 'id-0002', 'id-0003']) {
      fx.writeNote({ id, title: 'qqq', fileName: `${id}.md` });
    }
    fs.writeFileSync(
      path.join(fx.dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [{ id: 'life', name: '生活', description: '', order: 1 }],
        initialAssignments: {},
      }),
      'utf8'
    );
    process.env.AI_CLASSIFY_API_KEY = 'test-key';
    process.env.AI_CLASSIFY_MODEL = 'test-model';
    process.env.AI_CLASSIFY_MAX_PER_REFRESH = '1';

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"categoryId":"life","reason":"测试"}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const svc = await boot(makeCfg(fx));
      expect(calls).toBe(1); // 首扫时自动分类：3 篇里只允许调 1 次
      const info = svc.libraryInfo();
      expect(info.uncategorized).toBe(2);
      expect(info.diagnostics.some((d) => d.includes('上限'))).toBe(true);

      // 下一次刷新继续补 1 篇（上限按次计算，不是一次性开关）
      const job = await refresh(svc);
      expect(job.state).toBe('completed');
      expect(calls).toBe(2);
      expect(svc.libraryInfo().uncategorized).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // 预算必须按「发出的请求数」计，不按「成功数」计：失败响应同样发出过请求（可能已计费），
  // 不占额度的话，模型/供应商持续出错时一次刷新会把全部待分类笔记都打出去（评审 R1）。
  it('AI 返回无效类目 / 401 / 网络错误时，请求次数仍不超过上限', async () => {
    const modes: Array<[string, () => Promise<Response>]> = [
      [
        '无效类目',
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '{"categoryId":"不存在的类","reason":"x"}' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ],
      ['HTTP 401', async () => new Response('denied', { status: 401 })],
      [
        '网络抛错',
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
    ];
    for (const [label, stub] of modes) {
      const fx = createFixture('myinfobase-scan');
      for (const id of ['id-0001', 'id-0002', 'id-0003']) {
        fx.writeNote({ id, title: 'qqq', fileName: `${id}.md` });
      }
      fs.writeFileSync(
        path.join(fx.dataDir, 'categories.json'),
        JSON.stringify({
          schemaVersion: 1,
          categories: [{ id: 'life', name: '生活', description: '', order: 1 }],
          initialAssignments: {},
        }),
        'utf8'
      );
      process.env.AI_CLASSIFY_API_KEY = 'test-key';
      process.env.AI_CLASSIFY_MODEL = 'test-model';
      process.env.AI_CLASSIFY_MAX_PER_REFRESH = '1';

      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls++;
        return stub();
      }) as typeof fetch;

      try {
        const svc = await boot(makeCfg(fx));
        expect(calls, `模式「${label}」首扫请求数`).toBe(1);
        expect(svc.libraryInfo().uncategorized, `模式「${label}」应全部未分类`).toBe(3);
        const job = await refresh(svc);
        expect(job.state).toBe('completed');
        expect(calls, `模式「${label}」刷新后累计请求数`).toBe(2); // 每次刷新重新给 1 次预算
        expect(svc.libraryInfo().uncategorized).toBe(3);
      } finally {
        globalThis.fetch = realFetch;
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    }
  });

  it('超时环境变量写错（NaN）时回退默认值，不会变成"立即超时"', async () => {
    const { aiClassifyConfigFromEnv } = await import('../server/services/ai-classify');
    const cfg = aiClassifyConfigFromEnv({
      AI_CLASSIFY_API_KEY: 'k',
      AI_CLASSIFY_TIMEOUT_MS: 'abc',
      AI_CLASSIFY_MAX_PER_REFRESH: '-5',
    } as NodeJS.ProcessEnv);
    expect(cfg?.timeoutMs).toBe(30000);
    expect(cfg?.maxPerRefresh).toBe(40);
  });
});

describe('启动时自动刷一次（startBootRefresh，v0.16）', () => {
  it('开启：返回 job、单飞复用、快路径跑完 added=0；关闭：返回 null', async () => {
    const fx = createFixture('myinfobase-scan');
    fx.writeNote({ id: 'id-0001', title: '一' });
    const baseCfg = makeCfg(fx);

    const svc = new LibraryService({ ...baseCfg, autoRefreshOnBoot: true });
    await svc.init();
    const job = svc.startBootRefresh();
    expect(job).not.toBeNull();
    expect(job!.state).toBe('running');
    // 单飞：running 期间再调返回同一个 job，不会并发起第二轮扫描
    expect(svc.startBootRefresh()).toEqual(job);

    let done = job!;
    for (let i = 0; i < 200; i++) {
      const cur = svc.getRefreshJob(job!.jobId);
      if (cur && cur.state !== 'running') {
        done = cur;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(done.state).toBe('completed');
    expect(done.added).toBe(0); // 首扫已建索引 → 启动自刷是快路径，不重复导入
    expect(svc.libraryInfo().lastScan?.finishedAt).toBeTruthy(); // 侧栏"最近刷新"有得可看

    // 关闭：不建 job，直接 null
    const svc2 = new LibraryService({ ...baseCfg, autoRefreshOnBoot: false });
    await svc2.init();
    expect(svc2.startBootRefresh()).toBeNull();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });
});
