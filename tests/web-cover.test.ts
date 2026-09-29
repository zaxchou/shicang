// 网页剪藏封面（B 站缩略图 / 正文首图）测试：bvid 提取、SSRF 守卫、抓取缓存与负缓存、
// 首图回退、HTTP 路由与摘要合并。
// **全程 mock fetch**——绝不在测试里访问 bilibili 或任何第三方站点。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import {
  bvidFromUrl,
  firstRemoteImage,
  publicHttpUrl,
  WebCoverService,
} from '../server/services/web-cover';
import type { NoteRecord } from '../server/reader/parse';
import { LibraryService } from '../server/services/library';
import { apiRouter } from '../server/routes/api';
import type { AppConfig } from '../server/config';
import { createFixture, type Fixture } from './helpers/fixture';

function tmpBase(prefix = 'cover-'): { base: string; dataDir: string; backupDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, 'data');
  const backupDir = path.join(base, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  return { base, dataDir, backupDir };
}

const IMG_BYTES = Buffer.from('fake-jpeg-bytes-0123456789');

function mkNote(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'Clippings/测试剪藏.md',
    collection: 'web',
    sourceRelativePath: 'Clippings/测试剪藏.md',
    sourceMtimeMs: 1,
    sourceSize: 1,
    sourceHash: null,
    title: '测试剪藏',
    author: '某人',
    tags: [],
    excerpt: '',
    searchText: '',
    publishedAt: null,
    syncedAt: null,
    originalUrl: '',
    bodyHtml: '<p>正文</p>',
    media: [],
    coverMediaId: null,
    sourceStatus: 'available',
    warnings: [],
    ...over,
  };
}

/** 假网关：api.bilibili.com 返回封面 JSON，图片 CDN 返回图片字节；calls 记录全部请求。
 *  **非 https 的请求（本地测试 HTTP）原样放行**——绝不能把测试自己的 fetch 也吞掉。 */
function stubNet(opts: { apiOk?: boolean; pic?: string; duration?: number; imageOk?: boolean; contentType?: string; big?: boolean } = {}) {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const apiOk = opts.apiOk ?? true;
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (!u.startsWith('https://')) return realFetch(url as never, init);
    if (u.startsWith('https://api.bilibili.com/')) {
      if (!apiOk) return new Response('blocked', { status: 500 });
      return new Response(
        JSON.stringify({ code: 0, data: { pic: opts.pic ?? 'http://i0.hdslb.com/bfs/archive/abc.jpg', duration: opts.duration ?? 9611 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // 图片请求
    if (opts.imageOk === false) return new Response('nope', { status: 403 });
    const body = opts.big ? Buffer.alloc(7 * 1024 * 1024, 1) : IMG_BYTES;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'Content-Type': opts.contentType ?? 'image/jpeg' },
    });
  });
  return { fake: fake as unknown as typeof fetch, calls };
}

/** 重定向路由桩：按 URL 查表返回响应；redirect 未显式设为 'manual' 时**自行跟随**
 *（模拟原生 fetch 的默认行为——自动跟随正是评审 R3 的漏洞面），每次请求记进 hits。 */
function redirectNet(routes: Record<string, { status: number; location?: string; body?: Buffer; contentType?: string }>) {
  const hits: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const redirect = init?.redirect ?? 'follow';
    let cur = String(url);
    for (let i = 0; i < 30; i++) {
      hits.push(cur);
      const r = routes[cur];
      if (!r) return new Response('not found', { status: 404 });
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (redirect === 'manual') {
          return new Response(null, { status: r.status, headers: { Location: r.location } });
        }
        if (redirect === 'error') throw new TypeError('redirect denied');
        cur = new URL(r.location, cur).href; // follow：无条件跟随（含私网目标）
        continue;
      }
      return new Response(r.body ?? new Uint8Array(), {
        status: r.status,
        headers: { 'Content-Type': r.contentType ?? 'image/jpeg' },
      });
    }
    return new Response('too many', { status: 508 });
  }) as unknown as typeof fetch;
  return { fake, hits };
}

describe('bvidFromUrl / publicHttpUrl / firstRemoteImage', () => {
  it('BV 号提取：带查询串/纯路径都行，非视频链接返回 null', () => {
    expect(bvidFromUrl('https://www.bilibili.com/video/BV1s6pgzLE3y/?spm_id_from=333.1387')).toBe('BV1s6pgzLE3y');
    expect(bvidFromUrl('https://www.bilibili.com/video/BV1s6pgzLE3y')).toBe('BV1s6pgzLE3y');
    expect(bvidFromUrl('https://mp.weixin.qq.com/s/abc')).toBeNull();
    expect(bvidFromUrl('')).toBeNull();
    expect(bvidFromUrl(null)).toBeNull();
  });

  it('SSRF 守卫：只放行公网 http(s)，localhost/.local/私网 IP/IPv6 字面量全拒绝', () => {
    expect(publicHttpUrl('https://i0.hdslb.com/x.jpg')?.hostname).toBe('i0.hdslb.com');
    expect(publicHttpUrl('http://s1.sinaimg.cn/x.jpg')?.hostname).toBe('s1.sinaimg.cn');
    expect(publicHttpUrl('ftp://example.com/x.jpg')).toBeNull();
    expect(publicHttpUrl('file:///etc/passwd')).toBeNull();
    expect(publicHttpUrl('http://localhost/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://nas.local/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://127.0.0.1/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://192.168.31.5/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://10.0.0.1/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://172.20.1.1/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://169.254.1.1/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://100.100.1.1/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://[::1]/x.jpg')).toBeNull();
  });

  it('正文首图：取第一张 http(s) 图、还原 &amp;、跳过 data: 与 media:', () => {
    expect(firstRemoteImage('<p><img src="data:image/svg+xml,%3Csvg"/><img src="https://a.com/x.jpg?a=1&amp;b=2"/></p>')).toBe(
      'https://a.com/x.jpg?a=1&b=2'
    );
    expect(firstRemoteImage('<img src="/api/media/n/i.webp"/>')).toBeNull();
    expect(firstRemoteImage('<p>没有图</p>')).toBeNull();
  });
});

describe('WebCoverService：抓取、缓存、负缓存、回退', () => {
  it('B 站：API 拿封面+时长 → 下载图片 → 落盘；第二次不再请求', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new WebCoverService(dataDir, backupDir);
    await svc.init();
    const note = mkNote({ originalUrl: 'https://www.bilibili.com/video/BV1s6pgzLE3y/?x=1' });
    const { fake, calls } = stubNet({ duration: 9611 });

    const e1 = await svc.ensure(note, fake);
    expect(e1).toMatchObject({ source: 'bilibili', durationSec: 9611, contentType: 'image/jpeg', failedAt: null });
    expect(calls[0]).toContain('api.bilibili.com/x/web-interface/view?bvid=BV1s6pgzLE3y');
    // 小图后缀 + https 归一
    expect(calls[1]).toBe('https://i0.hdslb.com/bfs/archive/abc.jpg@480w_270h_1c.webp');
    expect(svc.filePathOf(note.id)).toBeTruthy();
    expect(fs.readFileSync(svc.filePathOf(note.id)!).length).toBe(IMG_BYTES.length);
    expect(svc.revision).toBeGreaterThan(0);

    const before = calls.length;
    const e2 = await svc.ensure(note, fake);
    expect(e2).toEqual(e1);
    expect(calls.length).toBe(before); // 命中缓存，零请求
  });

  it('非 B 站：回退正文首图；首图是私网地址时不给封面（SSRF 守卫）', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new WebCoverService(dataDir, backupDir);
    await svc.init();
    const okNote = mkNote({ id: 'Clippings/微信.md', originalUrl: 'https://mp.weixin.qq.com/s/abc', bodyHtml: '<img src="https://mmbiz.qpic.cn/x.png"/>' });
    const { fake, calls } = stubNet();
    const e = await svc.ensure(okNote, fake);
    expect(e).toMatchObject({ source: 'first-image', durationSec: null });
    expect(calls).toEqual(['https://mmbiz.qpic.cn/x.png']); // 没有去打 B 站 API

    const badNote = mkNote({ id: 'Clippings/坏图.md', bodyHtml: '<img src="http://192.168.31.5/internal.png"/>' });
    const e2 = await svc.ensure(badNote, fake);
    expect(e2).toBeNull();
    expect(svc.get(badNote.id)?.failedAt).toBeTruthy();
  });

  // fetch 默认 redirect:'follow' 会把公网 302 直接带到内网目标，绕过 publicHttpUrl 的
  // 字面私网检查（评审 R3）——必须手动跟随、逐跳过闸、跳数封顶。
  it('公网 302 指向内网时拒绝跟随（内网零请求）；合法公网跳转仍可用；跳数有上限', async () => {
    // 场景 1：重定向目标是内网 → 一个请求都不发给内网，封面失败进负缓存
    const a = tmpBase();
    const s1 = new WebCoverService(a.dataDir, a.backupDir);
    await s1.init();
    const evil = mkNote({ id: 'Clippings/evil.md', bodyHtml: '<img src="https://public.example/x.jpg"/>' });
    const r1 = redirectNet({
      'https://public.example/x.jpg': { status: 302, location: 'http://127.0.0.1:18080/secret.png' },
      'http://127.0.0.1:18080/secret.png': { status: 200, body: IMG_BYTES, contentType: 'image/png' },
    });
    expect(await s1.ensure(evil, r1.fake)).toBeNull();
    expect(r1.hits.filter((u) => u.startsWith('http://127.0.0.1'))).toHaveLength(0);
    expect(r1.hits.filter((u) => u === 'https://public.example/x.jpg')).toHaveLength(1); // 每跳只请求一次
    expect(s1.get(evil.id)?.failedAt).toBeTruthy();

    // 场景 2：公网 → 公网的合法跳转照常可用（http→https、CDN 302 都靠它）
    const b = tmpBase();
    const s2 = new WebCoverService(b.dataDir, b.backupDir);
    await s2.init();
    const okNote = mkNote({ id: 'Clippings/ok.md', bodyHtml: '<img src="https://public.example/x.jpg"/>' });
    const r2 = redirectNet({
      'https://public.example/x.jpg': { status: 302, location: 'https://cdn.example/y.jpg' },
      'https://cdn.example/y.jpg': { status: 200, body: IMG_BYTES, contentType: 'image/jpeg' },
    });
    expect(await s2.ensure(okNote, r2.fake)).toMatchObject({ contentType: 'image/jpeg', failedAt: null });
    expect(r2.hits).toEqual(['https://public.example/x.jpg', 'https://cdn.example/y.jpg']);

    // 场景 3：重定向链超限（>3 跳）→ 放弃，不把下载变成无界跳转
    const c = tmpBase();
    const s3 = new WebCoverService(c.dataDir, c.backupDir);
    await s3.init();
    const loopNote = mkNote({ id: 'Clippings/loop.md', bodyHtml: '<img src="https://public.example/a.jpg"/>' });
    const r3 = redirectNet({
      'https://public.example/a.jpg': { status: 302, location: 'https://public.example/b.jpg' },
      'https://public.example/b.jpg': { status: 302, location: 'https://public.example/c.jpg' },
      'https://public.example/c.jpg': { status: 302, location: 'https://public.example/d.jpg' },
      'https://public.example/d.jpg': { status: 302, location: 'https://public.example/e.jpg' },
      'https://public.example/e.jpg': { status: 200, body: IMG_BYTES, contentType: 'image/jpeg' },
    });
    expect(await s3.ensure(loopNote, r3.fake)).toBeNull();
    expect(r3.hits.length).toBeLessThanOrEqual(4); // 初始请求 + 最多 3 跳
    expect(s3.get(loopNote.id)?.failedAt).toBeTruthy();
  });

  it('抓取失败（无来源 / 图错了 / 太大 / 非图片类型）都进负缓存，且 6 小时内不再重试', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new WebCoverService(dataDir, backupDir);
    await svc.init();
    const { fake, calls } = stubNet({ contentType: 'text/html' }); // 返回的不是图片

    const note = mkNote({ id: 'Clippings/失败.md', originalUrl: 'https://www.bilibili.com/video/BV1s6pgzLE3y' });
    expect(await svc.ensure(note, fake)).toBeNull();
    expect(svc.get(note.id)?.failedAt).toBeTruthy();
    const n1 = calls.length;
    expect(await svc.ensure(note, fake)).toBeNull(); // 负缓存：不再请求
    expect(calls.length).toBe(n1);

    // 无来源（没有 bvid 也没有首图）
    const plain = mkNote({ id: 'Clippings/无封面.md' });
    expect(await svc.ensure(plain, fake)).toBeNull();
    expect(svc.get(plain.id)?.failReason).toContain('没有可用的封面来源');
  });

  it('并发同一篇只抓一次（单飞）', async () => {
    const { dataDir, backupDir } = tmpBase();
    const svc = new WebCoverService(dataDir, backupDir);
    await svc.init();
    const note = mkNote({ originalUrl: 'https://www.bilibili.com/video/BV1s6pgzLE3y' });
    const { fake, calls } = stubNet();
    const [a, b] = await Promise.all([svc.ensure(note, fake), svc.ensure(note, fake)]);
    expect(a).toEqual(b);
    expect(calls.filter((u) => u.includes('api.bilibili.com')).length).toBe(1);
  });
});

describe('HTTP：GET /api/web-cover/:id 与摘要合并', () => {
  let fx: Fixture;
  let server: http.Server;
  let base: string;
  let svc: LibraryService;

  function makeCfg(fx2: Fixture): AppConfig {
    return {
      app: 'myinfobase-test',
      vaultRoot: fx2.root.replace(/\\/g, '/'),
      collections: [
        { id: 'rednote', name: '小红书', root: 'RedNote/Bookmarks', type: 'rednote' },
        { id: 'web', name: '网页', root: 'Clippings', type: 'web' },
      ],
      groups: [{ id: 'clippings', name: '剪藏', collections: ['rednote', 'web'] }],
      host: '127.0.0.1',
      port: 0,
      timezone: 'Asia/Shanghai',
      publicOrigin: '',
      extraAllowedOrigins: [],
      dataDir: fx2.dataDir,
      backupDir: fx2.backupDir,
      exportDir: fx2.exportDir,
      exportAfterRefresh: false,
      logDir: path.join(fx2.root, 'logs'),
      isProduction: false,
      version: 'test',
    };
  }

  async function waitForJob(s: LibraryService, jobId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const job = s.getRefreshJob(jobId);
      if (job && job.state !== 'running') {
        if (job.state !== 'completed') throw new Error(`刷新异常(${job.state}): ${job.diagnostics.join(' | ')}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('刷新任务超时');
  }

  beforeEach(async () => {
    fx = createFixture('cover-http-');
    fs.mkdirSync(path.join(fx.root, 'Clippings'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, 'Clippings', '陈天奇播客.md'), '---\ntitle: "陈天奇播客"\nsource: "https://www.bilibili.com/video/BV1s6pgzLE3y"\nauthor:\n  - "[[WhynotTV]]"\ncreated: 2026-05-02\ntags:\n  - "clippings"\n---\n\n简介\n', 'utf8');
    svc = new LibraryService(makeCfg(fx));
    await svc.init();
    await waitForJob(svc, svc.startRefresh().jobId);
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('首次请求按需抓取并返回图片；摘要里出现 webCover；未知笔记 404', async () => {
    const { fake } = stubNet({ duration: 9611 });
    vi.stubGlobal('fetch', fake); // 路由内部用默认 fetch → 由这里接管（绝不真访问 B 站）

    const noteId = 'Clippings/陈天奇播客.md';
    const res = await fetch(`${base}/api/web-cover/${encodeURIComponent(noteId)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect((await res.arrayBuffer()).byteLength).toBe(IMG_BYTES.length);

    // 摘要合并：列表里能看到封面 url 与时长（B 站 = 9611 秒 → h:mm:ss 由前端格式化）
    const list = (await (await fetch(`${base}/api/notes?collection=web`)).json()) as {
      items: Array<{ webCover?: { url: string; durationSec: number | null } | null }>;
    };
    expect(list.items[0]?.webCover?.url).toBe(`/api/web-cover/${encodeURIComponent(noteId)}`);
    expect(list.items[0]?.webCover?.durationSec).toBe(9611);

    // 轻量探测（卡片首屏用）：?meta=1 返回时长 JSON；没有封面的笔记连 meta 也是 404
    const meta = (await (await fetch(`${base}/api/web-cover/${encodeURIComponent(noteId)}?meta=1`)).json()) as {
      durationSec: number | null;
    };
    expect(meta.durationSec).toBe(9611);
    const metaMiss = await fetch(`${base}/api/web-cover/${encodeURIComponent('Clippings/宿命论.md')}?meta=1`);
    expect(metaMiss.status).toBe(404);

    const missing = await fetch(`${base}/api/web-cover/${encodeURIComponent('Clippings/没有这篇.md')}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOTE_NOT_FOUND');
  });

  // 摘要三态里，"试过没有"必须带上 6 小时负缓存的时钟：过期后要回到 undefined（可重探），
  // 否则失败条目被钉死成 null，刷新页面/重启都不会再走 ensure 的重试路径（评审 R5）。
  it('负缓存过期的失败条目回到可探测态（undefined）；未过期仍是 null', async () => {
    const noteId = 'Clippings/陈天奇播客.md';
    const writeFailedCover = (failedAt: string) => {
      fs.writeFileSync(
        path.join(fx.dataDir, 'web-covers.json'),
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          entries: {
            [noteId]: {
              noteId,
              file: 'probe.jpg',
              contentType: 'image/jpeg',
              durationSec: null,
              source: 'first-image',
              at: '2020-01-01T00:00:00Z',
              failedAt,
            },
          },
        }),
        'utf8'
      );
    };
    const q = {
      q: '',
      categoryId: null,
      timeField: 'published' as const,
      range: 'all' as const,
      order: 'desc' as const,
      offset: 0,
      limit: 10,
      collection: 'web',
    };

    // 刚失败（未过期）→ null：卡片不得反复探测
    writeFailedCover(new Date().toISOString());
    const s1 = new LibraryService(makeCfg(fx));
    await s1.init();
    expect(s1.query(q).items[0]!.webCover).toBeNull();

    // 过期失败（2020 年）→ undefined：允许重新探测，走 ensure 的重试
    writeFailedCover('2020-01-01T00:00:00Z');
    const s2 = new LibraryService(makeCfg(fx));
    await s2.init();
    expect(s2.query(q).items[0]!.webCover).toBeUndefined();
  });
});
