// 深度审查（2026-09-28）与 2026-09-29 评审修掉的问题的回归用例。
// 每条都对应一个**先复现过**的真实缺陷，写下来是为了不让它们悄悄回来。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { apiRouter } from '../server/routes/api';
import { mediaRouter } from '../server/routes/media';
import type { AppConfig } from '../server/config';
import { AnnotationsService } from '../server/services/annotations';
import { CategoriesService } from '../server/services/categories';
import { MediaTextService } from '../server/services/media-text';
import { LibraryService } from '../server/services/library';
import { assertOutsideVault, isInsideDir } from '../server/storage/vault-guard';
import { createFixture, tinyWebp, type Fixture } from './helpers/fixture';

function tmpBase(prefix = 'review-'): { base: string; dataDir: string; backupDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, 'data');
  const backupDir = path.join(base, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  return { base, dataDir, backupDir };
}

function makeCfg(fx: Fixture, over: Partial<AppConfig> = {}): AppConfig {
  return {
    app: 'myinfobase-test',
    vaultRoot: fx.root.replace(/\\/g, '/'),
collections: [{ id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' }],
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
    logDir: path.join(fx.root, 'logs'),
    isProduction: false,
    version: 'test',
    ...over,
  };
}

async function waitForJob(svc: LibraryService, jobId: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const job = svc.getRefreshJob(jobId);
    if (job && job.state !== 'running') {
      if (job.state !== 'completed') throw new Error(`刷新异常(${job.state}): ${job.diagnostics.join(' | ')}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('刷新任务超时');
}

function baseQuery() {
  return {
    collection: 'rednote',
    timeField: 'published' as const,
    range: 'all' as const,
    order: 'desc' as const,
    offset: 0,
    limit: 60,
    status: 'active' as const,
  };
}

// ---------- 丢失更新 ----------

describe('并发写入不丢更新（深审复现过：并发标星两篇只存下 1 条）', () => {
  it('标注：并行标星两条（星标不带 revision）→ 两条都落盘，revision 依次递增', async () => {
    const { dataDir, backupDir } = tmpBase();
    const ann = new AnnotationsService(dataDir, backupDir);
    await ann.init();

    // 星标是单字段幂等动作，接口按设计不带 expectedRevision：这正是"两个标签页各标一条"的真实路径
    const [r1, r2] = await Promise.all([ann.patch('noteA', { star: true }), ann.patch('noteB', { star: true })]);
    expect(r1).toBe(1);
    expect(r2).toBe(2); // 第二次必须看到第一次的结果，不能都报 1
    expect(ann.entryCount).toBe(2);
    expect(ann.isStarred('noteA')).toBe(true);
    expect(ann.isStarred('noteB')).toBe(true);
  });

  it('标注：两条都拿着同一个旧 revision → 第二条必须**明确报冲突**，而不是静默覆盖', async () => {
    const { dataDir, backupDir } = tmpBase();
    const ann = new AnnotationsService(dataDir, backupDir);
    await ann.init();

    const results = await Promise.allSettled([
      ann.patch('noteA', { remark: 'A 写的' }, 0),
      ann.patch('noteB', { remark: 'B 写的' }, 0),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message ?? '').includes('revision')
    ).length;
    // 修复前的行为是"两条都 fulfilled，但只存下 1 条"——那才是丢数据；
    // 现在要么都成功、要么后到的如实 409，绝不会两边都报成功却少了一条
    expect(ok + conflicts).toBe(2);
    if (conflicts === 1) expect(ann.entryCount).toBe(1);
    else expect(ann.entryCount).toBe(2);
  });

  it('标注：并行写 10 条，一条都不能丢，revision 递增到 10', async () => {
    const { dataDir, backupDir } = tmpBase();
    const ann = new AnnotationsService(dataDir, backupDir);
    await ann.init();
    await Promise.all(Array.from({ length: 10 }, (_, i) => ann.patch(`n${i}`, { star: true }, undefined)));
    expect(ann.entryCount).toBe(10);
    expect(ann.revision).toBe(10);
  });

  it('分类：并行设不同分类 → 第二条明确报冲突（此前是两边都成功却丢一条）', async () => {
    const { dataDir, backupDir } = tmpBase();
    fs.writeFileSync(
      path.join(dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [
          { id: 'cat-a', name: '甲类', description: '', order: 1 },
          { id: 'cat-b', name: '乙类', description: '', order: 2 },
        ],
        initialAssignments: {},
        overrides: {},
      }),
      'utf8'
    );
    const cat = new CategoriesService(dataDir, backupDir);
    await cat.init(path.join(dataDir, 'no-seed.json'));

    const results = await Promise.allSettled([
      cat.setOverride('noteA', 'cat-a', 0),
      cat.setOverride('noteB', 'cat-b', 0),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 先到的成功
    expect(rejected).toHaveLength(1); // 后到的如实报冲突（界面会提示刷新重试）
    expect(String((rejected[0] as PromiseRejectedResult).reason.message)).toMatch(/revision/);
    // 关键：成功那一条必须真的落盘（不会因为并发而丢）
    const applied = [cat.effective('noteA').categoryId, cat.effective('noteB').categoryId].filter(Boolean);
    expect(applied).toHaveLength(1);
    // 后续用最新 revision 再写另一条，能正常成功
    const ok = await cat.setOverride('noteB', 'cat-b', cat.revision);
    expect(ok).toBeGreaterThan(1);
    expect(cat.effective('noteB').categoryId).toBe('cat-b');
  });

  it('分类：重复写同一个覆盖值不写盘、不抬 revision', async () => {
    const { dataDir, backupDir } = tmpBase();
    fs.writeFileSync(
      path.join(dataDir, 'categories.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [{ id: 'cat-a', name: '甲类', description: '', order: 1 }],
        initialAssignments: {},
        overrides: {},
      }),
      'utf8'
    );
    const cat = new CategoriesService(dataDir, backupDir);
    await cat.init(path.join(dataDir, 'no-seed.json'));

    const first = await cat.setOverride('noteA', 'cat-a', 0);
    const again = await cat.setOverride('noteA', 'cat-a', first); // 界面点当前已选的分类
    expect(again).toBe(first); // 不变
    // 显式改成 null 仍然是一次真实改动
    expect(await cat.setOverride('noteA', null, again)).toBe(first + 1);
  });
});

// ---------- 识别文本存储的写盘顺序 ----------

describe('识别文本：写盘失败时内存不得抢先成功', () => {
  it('落盘失败 → 内存保持在旧状态，修好之后能重试成功', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();

    // 让目标文件路径被一个目录占住 → rename/copy 都会失败
    const target = path.join(dataDir, 'media-text.json');
    fs.mkdirSync(target, { recursive: true });

    const entry = {
      mediaHash: 'h1',
      kind: 'ocr' as const,
      text: '第一次',
      model: 'm',
      at: new Date().toISOString(),
      refs: [{ noteId: 'n1', mediaId: 'image-1.webp' }],
    };
    await expect(svc.put(entry)).rejects.toThrow();
    // 关键：内存里不能留下盘上没有的结果，否则后续会判成"已有、无需再写"，永远不重试
    expect(svc.entryCount).toBe(0);
    expect(svc.get('h1')).toBeNull();
    expect(svc.revision).toBe(0);

    fs.rmSync(target, { recursive: true, force: true });
    const retry = await svc.put(entry);
    expect(retry).toEqual({ changed: true, revision: 1 });
    expect(svc.get('h1')?.text).toBe('第一次');
  });

  it('修剪孤儿引用：refs 全失效的条目整条删掉，只失效一部分的只摘那一条', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    await svc.put({
      mediaHash: 'h1',
      kind: 'ocr',
      text: 'A',
      model: 'm',
      at: 't',
      refs: [{ noteId: 'n1', mediaId: 'image-1.webp' }],
    });
    await svc.put({
      mediaHash: 'h2',
      kind: 'ocr',
      text: 'B',
      model: 'm',
      at: 't',
      refs: [
        { noteId: 'n1', mediaId: 'image-2.webp' },
        { noteId: 'n2', mediaId: 'image-1.webp' },
      ],
    });

    const dropped = await svc.pruneRefs((noteId) => noteId === 'n2');
    expect(dropped).toBe(2); // n1/image-1 与 n1/image-2 各一条
    expect(svc.get('h1')).toBeNull(); // refs 全没了 → 整条删
    expect(svc.get('h2')?.refs).toEqual([{ noteId: 'n2', mediaId: 'image-1.webp' }]);
    expect(svc.recognizedOf('n1')).toEqual([]);
    expect(svc.recognizedOf('n2')).toHaveLength(1);

    // 没有失效引用时不动盘（幂等）
    expect(await svc.pruneRefs(() => true)).toBe(0);
  });
});

// ---------- OCR：内容变了要重新识别 ----------

describe('OCR 按内容 hash 判定，图片被换掉会重新识别', () => {
  beforeEach(() => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'test-key');
    vi.stubEnv('AI_VISION_MODEL', 'vision-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('同名图片内容换了 → 再点识别会重新调模型，旧结果不残留', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', images: 1 });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);

    const seen: string[] = [];
    let round = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (!String(url).includes('/chat/completions') || !String(init?.body ?? '').includes('image_url')) {
          return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
        }
        round++;
        const text = `第 ${round} 次识别`;
        seen.push(text);
        return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
      })
    );

    const first = await svc.ocrNote('id-0001');
    expect(first.results[0]).toMatchObject({ ok: true, cached: false, text: '第 1 次识别' });

    // 同一路径换掉内容（重新同步 / 手动替换）
    fx.writeMedia('id-0001', 'image-1.webp', tinyWebp(9, 9));
    await waitForJob(svc, svc.startRefresh().jobId);

    const second = await svc.ocrNote('id-0001');
    expect(second.results[0]).toMatchObject({ ok: true, cached: false, text: '第 2 次识别' });
    // 旧结果必须被摘掉，否则同一个 mediaId 会挂两条 → 界面出现两个「图 1」、数字也对不上
    const items = svc.mediaTextFor('id-0001');
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('第 2 次识别');
  });

  it('刷新后自动修剪孤儿引用（附件被换掉后，"识别其余 N 张"的算法不再被虚高数字顶掉）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', images: 2 });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) =>
        !String(url).includes('/chat/completions') || !String(init?.body ?? '').includes('image_url')
          ? new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 })
          : new Response(JSON.stringify({ choices: [{ message: { content: '图里的字' } }] }), { status: 200 })
      )
    );
    await svc.ocrNote('id-0001');
    expect(svc.mediaTextFor('id-0001')).toHaveLength(2);

    // 笔记改成只引用第一张图
    fx.writeNote({ id: 'id-0001', title: '笔记一', images: 1 });
    await waitForJob(svc, svc.startRefresh().jobId);

    const after = svc.mediaTextFor('id-0001');
    expect(after).toHaveLength(1);
    expect(after[0]?.mediaId).toBe('image-1.webp');
  });
});

// ---------- 索引指纹与计数口径 ----------

describe('索引指纹与计数口径', () => {
  it('换了内容源（同一 dataDir）必须重建索引，而不是继续用旧库', async () => {
    const fx1 = createFixture('vault-one-');
    const fx2 = createFixture('vault-two-');
    fx1.writeNote({ id: 'id-0001', title: '旧库的笔记' });
    fx2.writeNote({ id: 'id-9999', title: '新库的笔记' });

    const first = new LibraryService(makeCfg(fx1));
    await first.init();
    expect(first.hasNote('id-0001')).toBe(true);

    // 同一份 dataDir，换 vault：指纹里必须含 vaultRoot，否则会沿用旧索引（列表正常、媒体全 404）
    const second = new LibraryService(makeCfg(fx2, { dataDir: fx1.dataDir, backupDir: fx1.backupDir }));
    await second.init();
    expect(second.hasNote('id-9999')).toBe(true);
    expect(second.hasNote('id-0001')).toBe(false);
  });

  it('顶层分类计数与侧栏口径一致（归档之后一起变小）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);

    expect(svc.libraryInfo().uncategorized).toBe(2);
    await svc.setStatus('id-0001', 'archived', svc.libraryInfo().annotationRevision);
    const info = svc.libraryInfo();
    expect(info.uncategorized).toBe(1); // 顶层字段也要跟着工作集走
    expect(info.collections[0]?.uncategorized).toBe(1);
  });

  it('索引里全是 missing 时启动会自愈重扫（内容源恢复挂载后不用手点刷新）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    expect(svc.query({ ...baseQuery() }).total).toBe(1);

    // 内容源"掉线"：文件消失 → 记录保留为 missing
    fx.removeNote('id-0001');
    await waitForJob(svc, svc.startRefresh().jobId);
    expect(svc.libraryInfo().total).toBe(1); // 记录还在
    expect(svc.query({ ...baseQuery() }).total).toBe(0); // 但已不可用

    // 恢复挂载（文件回来）后重启：应当自愈，而不是一直显示空库
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const rebooted = new LibraryService(makeCfg(fx));
    await rebooted.init();
    expect(rebooted.query({ ...baseQuery() }).total).toBe(1);
  });
});

// ---------- 语料导出 ----------

describe('语料导出：只改目录排版也要重写', () => {
  it('分类顺序变了（记录一条没动）→ catalog.md 必须跟着更新', async () => {
    const fx = createFixture('corpus-meta-');
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    // 两个分类，记录分属其一
    const cols = [
      { id: 'rednote', name: '小红书收藏', categories: [{ id: 'c1', name: '甲类' }, { id: 'c2', name: '乙类' }] },
    ];
    const svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);

    const record = { ...svc.corpusRecords()[0]!, categoryId: 'c1', categoryName: '甲类' };
    const { exportCorpus, buildCatalog } = await import('../server/services/corpus');
    const meta = {
      app: 'a',
      appVersion: '1',
      contentSource: fx.root,
      indexRevision: 1,
      annotationRevision: 0,
      categoryRevision: 0,
      parseVersion: 4,
    };
    const first = await exportCorpus({ dir: fx.exportDir, vaultRoot: fx.root, records: [record], collections: cols, meta });
    expect(first.written).toBe(true);

    // 记录完全没变，只把分类顺序倒过来
    const colsReordered = [
      { id: 'rednote', name: '小红书收藏', categories: [{ id: 'c2', name: '乙类' }, { id: 'c1', name: '甲类' }] },
    ];
    const second = await exportCorpus({
      dir: fx.exportDir,
      vaultRoot: fx.root,
      records: [record],
      collections: colsReordered,
      meta,
    });
    expect(second.written).toBe(true); // 早先会被判定"内容未变"而跳过，目录停在旧顺序
    const catalog = fs.readFileSync(path.join(fx.exportDir, 'catalog.md'), 'utf8');
    expect(catalog).toContain('甲类');
    // 排版函数本身按 collections 顺序输出小节
    const md = buildCatalog([record], { ...first.manifest, counts: first.manifest.counts }, colsReordered);
    expect(md.indexOf('### 乙类')).toBeLessThan(md.indexOf('### 甲类'));
  });
});

// ---------- vault 边界守卫 ----------

describe('vault 边界守卫（含 realpath）', () => {
  it('词法判断：vault 内、vault 本身都拒绝；外面放行', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-guard-'));
    expect(() => assertOutsideVault(path.join(vault, 'x'), vault)).toThrow(/落在内容源里/);
    expect(() => assertOutsideVault(vault, vault)).toThrow(/落在内容源里/);
    expect(isInsideDir(path.join(vault, 'a', 'b'), vault)).toBe(true);
    expect(isInsideDir(path.join(vault, '..', 'other'), vault)).toBe(false);
    expect(() => assertOutsideVault(path.join(vault, '..', 'outside'), vault)).not.toThrow();
  });

  it('软链接指向 vault 内部时也要拦住（纯词法比较拦不住）', ({ skip }) => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-real-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const link = path.join(outside, 'link-into-vault');
    // 词法判定无论如何都成立，不依赖建链——先把这条钉死
    expect(isInsideDir(link, vault)).toBe(false);
    try {
      fs.symlinkSync(vault, link, 'junction'); // Windows 上 junction 不需要管理员权限
    } catch {
      // 环境不支持建链接：**可见的跳过**，而不是 return 假装通过（深审发现的假绿）
      skip('环境不支持创建链接，realpath 分支本次未验证');
      return;
    }
    // 词法上看 link 在 vault 外面，但 realpath 后落在 vault 里
    expect(() => assertOutsideVault(link, vault)).toThrow(/落在内容源里/);
  });
});

// ---------- HTTP ----------

describe('HTTP：识别文本路由的边界', () => {
  let fx: Fixture;
  let server: http.Server;
  let base: string;
  let svc: LibraryService;

  beforeEach(async () => {
    fx = createFixture('review-http-');
    fx.writeNote({ id: 'id-0001', title: '笔记一', images: 1 });
    svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api/media', mediaRouter(() => svc)); // 与 index.ts 同序：媒体路由在 api 之前
    app.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('DELETE 不存在的笔记返回 404（而不是 200 removed:false）', async () => {
    const res = await fetch(`${base}/api/notes/no-such-note/media-text/image-1.webp`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error.code).toBe('NOTE_NOT_FOUND');
  });

  it('导出目录配到内容源里 → 明确的 EXPORT_DIR_IN_VAULT，而不是不透明的 500', async () => {
    const bad = new LibraryService(makeCfg(fx, { exportDir: path.join(fx.root, 'export') }));
    await bad.init();
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api', apiRouter({ library: () => bad, allowedOrigins: () => [], isReady: () => true }));
    const s2 = http.createServer(app);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${url}/api/export/corpus`, { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json() as any;
      expect(body.error.code).toBe('EXPORT_DIR_IN_VAULT');
      expect(body.error.message).toMatch(/落在内容源里/);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });

  it('0 字节媒体：如实下发空 body，而不是 createReadStream 同步抛错变成带堆栈的 HTML 500', async () => {
    fs.writeFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'image-1.webp'), '');
    const res = await fetch(`${base}/api/media/id-0001/image-1.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('初始化完成前：变更类请求 503 NOT_READY，GET 照常放行（防与 init 交叉写）', async () => {
    const app2 = express();
    app2.use(express.json({ limit: '64kb' }));
    app2.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => false }));
    const s2 = http.createServer(app2);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
    try {
      const get = await fetch(`${url}/api/notes?limit=1`);
      expect(get.status).toBe(200);
      const patch = await fetch(`${url}/api/notes/id-0001/annotation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ star: true }),
      });
      expect(patch.status).toBe(503);
      expect(((await patch.json()) as any).error.code).toBe('NOT_READY');
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });

  it('改状态/备注不带 expectedRevision → 400（API 层强制乐观并发）；星标仍可省', async () => {
    const noRev = await fetch(`${base}/api/notes/id-0001/annotation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(noRev.status).toBe(400);
    const star = await fetch(`${base}/api/notes/id-0001/annotation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ star: true }),
    });
    expect(star.status).toBe(200);
  });
});

describe('media-text：putIfPresent 不复活已删除的条目', () => {
  it('删掉之后补 ref 返回 changed:false，条目保持删除态', async () => {
    const { dataDir, backupDir } = tmpBase('pp-');
    const svc = new MediaTextService(dataDir, backupDir);
    await svc.init();
    const hash = 'h'.repeat(64);
    await svc.put({ mediaHash: hash, kind: 'ocr', text: '字', model: 'm', at: 't', refs: [{ noteId: 'n1', mediaId: 'i1' }] });
    expect(await svc.removeRef('n1', 'i1')).toBe(true);
    const res = await svc.putIfPresent({ mediaHash: hash, kind: 'ocr', text: '字', model: 'm', at: 't', refs: [{ noteId: 'n2', mediaId: 'i2' }] });
    expect(res.changed).toBe(false);
    expect(svc.get(hash)).toBeNull();
  });
});

describe('标注：__proto__ 这种键必须落成自己的属性', () => {
  it('patch 特殊 id 后能写进 JSON，重载后再改别的也不会把它挤掉', async () => {
    const { dataDir, backupDir } = tmpBase('proto-');
    const ann = new AnnotationsService(dataDir, backupDir);
    await ann.init();
    await ann.patch('__proto__', { star: true });
    const raw1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'annotations.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.hasOwn(raw1.entries, '__proto__')).toBe(true);

    const again = new AnnotationsService(dataDir, backupDir);
    await again.init();
    await again.patch('other-note', { star: true });
    const raw2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'annotations.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.hasOwn(raw2.entries, '__proto__')).toBe(true);
    expect(Object.hasOwn(raw2.entries, 'other-note')).toBe(true);
  });
});

// ---------- 2026-09-29 评审：发布脚本 ----------

// -SkipChecks 只该跳类型检查与测试。跳过构建的话，旧 dist 配上按当前 package.json 写的 VERSION
// 照样过健康门——"版本 9.9.9 已上线"背后跑的却是旧逻辑（评审 R4）。
// 假项目 + 真脚本：build 往 dist 写新哨兵，断言发布包里是新产物而不是预放的旧文件。
describe('release.ps1 -SkipChecks（评审 R4）', () => {
  it.skipIf(process.platform !== 'win32')(
    '-SkipChecks 下仍现场构建：发布包含的是新构建产物，不是旧 dist',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-probe-'));
      try {
        for (const sub of ['scripts', 'deploy', 'dist/server', 'dist/web', 'server']) {
          fs.mkdirSync(path.join(tmp, sub), { recursive: true });
        }
        fs.copyFileSync(
          fileURLToPath(new URL('../scripts/release.ps1', import.meta.url)),
          path.join(tmp, 'scripts', 'release.ps1')
        );
        fs.copyFileSync(
          fileURLToPath(new URL('../deploy/Dockerfile', import.meta.url)),
          path.join(tmp, 'deploy', 'Dockerfile')
        );
        fs.writeFileSync(
          path.join(tmp, 'package.json'),
          // pretty 输出：release.ps1 按 '"version": "x.y.z"'（冒号后带空格）计数，紧凑 JSON 匹配不上
          JSON.stringify(
            {
              name: 'release-probe',
              version: '9.9.9',
              engines: { node: '>=22' },
              scripts: {
                // 假构建：往 dist 写新哨兵；-SkipChecks 下它也必须执行
                build:
                  `node -e "require('fs').writeFileSync('dist/server/index.js','// NEW_BUILD_SENTINEL');` +
                  `require('fs').writeFileSync('dist/web/index.html','<p>NEW_BUILD_SENTINEL</p>')"`,
                typecheck: 'node -e ""',
                test: 'node -e ""',
              },
            },
            null,
            2
          )
        );
        // 版本归一断言依赖这个结构：根 1 次 + packages[""] 1 次
        fs.writeFileSync(
          path.join(tmp, 'package-lock.json'),
          JSON.stringify({ version: '9.9.9', packages: { '': { version: '9.9.9' } } }, null, 2)
        );
        fs.writeFileSync(path.join(tmp, 'dist', 'server', 'index.js'), '// OLD_BUILD_SENTINEL');
        fs.writeFileSync(path.join(tmp, 'dist', 'web', 'index.html'), '<p>OLD_BUILD_SENTINEL</p>');
        fs.writeFileSync(path.join(tmp, 'server', 'index.ts'), '// NEW_SOURCE_SENTINEL');

        const r = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, 'scripts', 'release.ps1'), '-SkipChecks'],
          { cwd: tmp, encoding: 'utf8', timeout: 120_000 }
        );
        expect(r.status, `发布脚本未成功：${r.stderr ?? ''}${r.stdout ?? ''}`).toBe(0);
        const packed = fs.readFileSync(path.join(tmp, 'releases', '9.9.9', 'dist', 'server', 'index.js'), 'utf8');
        expect(packed).toContain('NEW_BUILD_SENTINEL');
        expect(packed).not.toContain('OLD_BUILD_SENTINEL');
        const ver = fs.readFileSync(path.join(tmp, 'releases', '9.9.9', 'VERSION'), 'utf8').trim();
        expect(ver).toBe('9.9.9');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000
  );
});

// ---------- 2026-09-29 评审：部署健康检查 ----------

// "90 次 × 2 秒 = 三分钟"的前提是每次 wget 都很快返回；服务连上但不回包时，单次请求无限阻塞，
// 计数器不推进、承诺的截止时间失效，人工回滚判断被拖延（评审 R6）。
// 探针必须：每次请求自带超时 + 单调整体截止时间。
describe('deploy/health-wait.sh（评审 R6）', () => {
  const shAvailable = !spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }).error;
  const script = fileURLToPath(new URL('../deploy/health-wait.sh', import.meta.url));

  function listen(srv: http.Server): Promise<number> {
    return new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
    });
  }

  it.skipIf(!shAvailable)(
    '服务连上但不回包时探针按时退出；就绪即成功；版本不符立刻 exit 2',
    async () => {
      // 必须异步 spawn：spawnSync 会阻塞事件循环，本进程里的测试服务器就永远无法响应，
      // "正常服务"场景会假失败成超时。
      const run = (port: number, ver: string, total: number) =>
        new Promise<{ status: number | null; stderr: string; timedOut: boolean; elapsed: number }>((resolve) => {
          const t0 = Date.now();
          const child = spawn('sh', [script, String(port), ver, String(total)], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, 30_000);
          child.stderr.on('data', (d: Buffer) => {
            stderr += String(d);
          });
          const done = (status: number | null, err?: string) => {
            clearTimeout(timer);
            resolve({ status, stderr: stderr + (err ?? ''), timedOut, elapsed: Date.now() - t0 });
          };
          child.on('error', (e) => done(null, String(e)));
          child.on('close', (code) => done(code));
        });

      // 场景 1：挂起服务（收到请求但永不响应）→ 探针必须自己在截止时间内退出，而不是被 test timeout 杀掉
      const socks: Array<{ destroy(): void }> = [];
      const hang = http.createServer(() => undefined);
      hang.on('connection', (s) => {
        socks.push(s);
        s.setTimeout(120_000, () => s.destroy());
      });
      const hangPort = await listen(hang);
      const r1 = await run(hangPort, '9.9.9', 6);
      socks.forEach((s) => s.destroy());
      await new Promise<void>((r) => hang.close(() => r()));
      expect(r1.timedOut, '探针应自己退出，而不是挂到被杀掉').toBe(false);
      expect(r1.status).not.toBe(0);
      expect(r1.elapsed, `挂起场景耗时 ${r1.elapsed}ms`).toBeLessThan(15_000); // 截止 6s + 余量

      // 场景 2：正常就绪 → exit 0
      const ok = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ready: true, version: '9.9.9' }));
      });
      const okPort = await listen(ok);
      const r2 = await run(okPort, '9.9.9', 10);
      await new Promise<void>((r) => ok.close(() => r()));
      expect(r2.status, r2.stderr).toBe(0);
      expect(r2.elapsed).toBeLessThan(8_000);

      // 场景 3：就绪但版本不符 → 立刻 exit 2（这是"旧容器没换成功"的事故信号，不该等到超时）
      const wrong = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ready: true, version: '1.0.0' }));
      });
      const wrongPort = await listen(wrong);
      const r3 = await run(wrongPort, '9.9.9', 10);
      await new Promise<void>((r) => wrong.close(() => r()));
      expect(r3.status).toBe(2);
    },
    90_000
  );

  it('两种抓取工具都带请求超时（wget 与 curl 分支各自的短选项都在）', () => {
    const text = fs.readFileSync(script, 'utf8');
    // GNU wget 与 BusyBox wget 同形：-T 单次超时、-t 只试一次
    expect(text).toMatch(/wget.*-T \d+/);
    expect(text).toMatch(/wget.*-t 1/);
    // curl 分支（没有 wget 的开发机走它）：-m 单次最大时长
    expect(text).toMatch(/curl.*-m \d+/);
    // 单调整体截止：以剩余时间控制循环，而不是固定次数
    expect(text).toMatch(/date \+%s/);
  });
});
