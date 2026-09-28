// HTTP 层测试：媒体路由（Range/ETag/越界/缺失）与 API 路由（Origin 守卫、查询校验、错误码）。
// 这些行为此前只有服务层测试，路由本身没有任何用例——而 Range 解析、路径越界、Origin 守卫
// 全都在路由里，回归了也不会被发现。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { LibraryService } from '../server/services/library';
import { apiRouter } from '../server/routes/api';
import { mediaRouter } from '../server/routes/media';
import type { AppConfig } from '../server/config';
import { createFixture, tinyPng, tinyWebp, type Fixture } from './helpers/fixture';

const ALLOWED_ORIGIN = 'http://localhost:4317';

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

/** 在索引文件里追加一条手工构造的媒体（模拟历史数据里的越界/缺失/无扩展名条目） */
function patchIndexMedia(fx: Fixture, noteId: string, mutate: (rec: Record<string, unknown>) => void): void {
  const f = path.join(fx.dataDir, 'library-index.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rec = doc.notes.find((n: { id: string }) => n.id === noteId);
  if (!rec) throw new Error(`索引里没有 ${noteId}`);
  mutate(rec);
  fs.writeFileSync(f, JSON.stringify(doc), 'utf8');
}

describe('HTTP 路由', () => {
  let fx: Fixture;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    fx = createFixture('myinfobase-http');
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
        },
      }),
      'utf8'
    );
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    fx.writeNote({ id: 'id-0002', title: '笔记二' });

    const svc = new LibraryService(makeCfg(fx));
    await svc.init();

    // 追加测试用媒体：越界路径 / 缺失文件 / 无扩展名真 PNG / 音频
    fs.writeFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'raw-image'), tinyPng(9, 6));
    patchIndexMedia(fx, 'id-0001', (rec) => {
      const media = rec.media as Array<Record<string, unknown>>;
      media.push({ id: 'escape.webp', kind: 'image', localRelativePath: '../../secret.webp', available: true });
      media.push({ id: 'gone.webp', kind: 'image', localRelativePath: 'RedNote/Media/id-0001/gone.webp', available: false });
      media.push({ id: 'raw-image', kind: 'image', localRelativePath: 'RedNote/Media/id-0001/raw-image', available: true });
      media.push({ id: 'voice.m4a', kind: 'audio', localRelativePath: 'RedNote/Media/id-0001/voice.m4a', available: true });
      fs.writeFileSync(path.join(fx.sourceRoot, 'Media', 'id-0001', 'voice.m4a'), Buffer.from([0, 0, 0, 0x20]));
    });
    patchIndexMedia(fx, 'id-0002', (rec) => {
      rec.sourceStatus = 'missing'; // 列表应过滤掉，detail 仍可查
    });

    // 重新加载被改造过的索引
    const svc2 = new LibraryService(makeCfg(fx));
    await svc2.init();

    const app = express();
    app.use('/api/media', mediaRouter(() => svc2));
    app.use(
      '/api',
      apiRouter({
        library: () => svc2,
        allowedOrigins: () => [ALLOWED_ORIGIN],
        isReady: () => true,
      })
    );
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    void svc;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  describe('媒体路由', () => {
    it('正常返回图片：200 + 正确 MIME + ETag', async () => {
      const res = await fetch(`${base}/api/media/id-0001/image-1.webp`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('etag')).toBeTruthy();
      expect((await res.arrayBuffer()).byteLength).toBe(tinyWebp(4, 3).length);
    });

    it('无扩展名的真实 PNG：按文件头定 Content-Type（不能是 octet-stream）', async () => {
      const res = await fetch(`${base}/api/media/id-0001/raw-image`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    });

    it('音频附件：内联播放需要的 MIME', async () => {
      const res = await fetch(`${base}/api/media/id-0001/voice.m4a`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mp4');
    });

    it('suffix range bytes=-2 返回最后 2 字节', async () => {
      const full = await fetch(`${base}/api/media/id-0001/image-1.webp`);
      const bytes = Buffer.from(await full.arrayBuffer());
      const res = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { Range: 'bytes=-2' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${bytes.length - 2}-${bytes.length - 1}/${bytes.length}`);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(-2));
    });

    it('前方 range bytes=2- 与整段 range 都正确', async () => {
      const full = await fetch(`${base}/api/media/id-0001/image-1.webp`);
      const bytes = Buffer.from(await full.arrayBuffer());
      const mid = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { Range: 'bytes=2-' } });
      expect(mid.status).toBe(206);
      expect(Buffer.from(await mid.arrayBuffer())).toEqual(bytes.subarray(2));

      const bounded = await fetch(`${base}/api/media/id-0001/image-1.webp`, {
        headers: { Range: `bytes=0-${bytes.length - 1}` },
      });
      expect(bounded.status).toBe(206);
      expect(Buffer.from(await bounded.arrayBuffer())).toEqual(bytes);
    });

    it('越界 range 与非法 range 返回 416', async () => {
      const a = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { Range: 'bytes=999999-' } });
      expect(a.status).toBe(416);
      expect(a.headers.get('content-range')).toMatch(/^bytes \*\//);
      const b = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { Range: 'bytes=-' } });
      expect(b.status).toBe(416);
      const c = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { Range: 'bytes=abc-def' } });
      expect(c.status).toBe(200); // 无法解析的 Range 按整文件处理
    });

    it('If-None-Match 命中返回 304 且无响应体', async () => {
      const first = await fetch(`${base}/api/media/id-0001/image-1.webp`);
      const etag = first.headers.get('etag') as string;
      const res = await fetch(`${base}/api/media/id-0001/image-1.webp`, { headers: { 'If-None-Match': etag } });
      expect(res.status).toBe(304);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });

    it('HEAD 返回头部无响应体', async () => {
      const res = await fetch(`${base}/api/media/id-0001/image-1.webp`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });

    it('localRelativePath 越界 → 403', async () => {
      const res = await fetch(`${base}/api/media/id-0001/escape.webp`);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('MEDIA_FORBIDDEN');
    });

    it('available:false 与文件不存在都返回 404', async () => {
      const gone = await fetch(`${base}/api/media/id-0001/gone.webp`);
      expect(gone.status).toBe(404);
      const noId = await fetch(`${base}/api/media/id-0001/nope.webp`);
      expect(noId.status).toBe(404);
    });

    it('未登记的笔记 404', async () => {
      const res = await fetch(`${base}/api/media/id-9999/image-1.webp`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('NOTE_NOT_FOUND');
    });
  });

  describe('API 路由', () => {
    it('health 返回版本与就绪状态', async () => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      expect((await res.json()).ready).toBe(true);
    });

    it('外来 Origin 的变更请求被拒（403），白名单 Origin 与无 Origin 放行', async () => {
      const evil = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
      expect(evil.status).toBe(403);
      expect((await evil.json()).error.code).toBe('ORIGIN_FORBIDDEN');

      // 放行路径用 PATCH + 过期 revision 验证：拿到 409（而不是 403）就说明 Origin 通过了守卫，
      // 同时不会像 POST /refresh 那样在后台真的跑一次扫描、把索引改掉
      const patch = (headers: Record<string, string>) =>
        fetch(`${base}/api/notes/id-0001/category`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ categoryId: 'cat-b', expectedRevision: 99 }),
        });

      const allowed = await patch({ Origin: ALLOWED_ORIGIN });
      expect(allowed.status).toBe(409);

      const trailingSlash = await patch({ Origin: `${ALLOWED_ORIGIN}/` });
      expect(trailingSlash.status).toBe(403); // 白名单是字符串精确匹配，带尾斜杠不算

      const noOrigin = await patch({});
      expect(noOrigin.status).toBe(409); // 地址栏/同源脚本不带 Origin 时放行
    });

    it('GET 不校验 Origin（跨站读也要能拿到自己的数据）', async () => {
      const res = await fetch(`${base}/api/library`, { headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
    });

    it('查询参数校验：limit 上界 1000、非法 range/from 400', async () => {
      expect((await fetch(`${base}/api/notes?limit=1000`)).status).toBe(200);
      expect((await fetch(`${base}/api/notes?limit=1001`)).status).toBe(400);
      expect((await fetch(`${base}/api/notes?range=bogus`)).status).toBe(400);
      expect((await fetch(`${base}/api/notes?from=2026-6-1`)).status).toBe(400);
      expect((await fetch(`${base}/api/notes?range=custom`)).status).toBe(400);
      expect((await fetch(`${base}/api/notes?range=custom&from=2026-06-01`)).status).toBe(200);
    });

    it('列表过滤掉 missing 记录，detail 仍可查', async () => {
      const list = await fetch(`${base}/api/notes?limit=100`);
      const body = await list.json();
      expect(body.items.map((n: { id: string }) => n.id)).not.toContain('id-0002');
      const detail = await fetch(`${base}/api/notes/id-0002`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).sourceStatus).toBe('missing');
    });

    it('未分类筛选不把 missing 记录算进来', async () => {
      const res = await fetch(`${base}/api/notes?category=uncategorized`);
      const body = await res.json();
      // id-0002 才是未分类的，但它此刻是 missing（源文件被标为消失）→ 列表里不该出现
      expect(body.total).toBe(0);
    });

    it('PATCH 分类：revision 冲突 409 / 未知类别 400 / 未知笔记 404', async () => {
      const conflict = await fetch(`${base}/api/notes/id-0001/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ categoryId: 'cat-b', expectedRevision: 99 }),
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error.code).toBe('REVISION_CONFLICT');

      const badCat = await fetch(`${base}/api/notes/id-0001/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ categoryId: 'cat-x', expectedRevision: 0 }),
      });
      expect(badCat.status).toBe(400);
      expect((await badCat.json()).error.code).toBe('INVALID_CATEGORY');

      const notFound = await fetch(`${base}/api/notes/id-9999/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ categoryId: 'cat-a', expectedRevision: 0 }),
      });
      expect(notFound.status).toBe(404);
      expect((await notFound.json()).error.code).toBe('NOTE_NOT_FOUND');
    });

    it('非法请求体与非 JSON 请求体都是 400', async () => {
      const bad = await fetch(`${base}/api/notes/id-0001/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ categoryId: 5 }),
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe('INVALID_BODY');

      const broken = await fetch(`${base}/api/notes/id-0001/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{not json',
      });
      expect(broken.status).toBe(400);
      expect((await broken.json()).error.code).toBe('BAD_JSON');
    });

    it('超过 64KB 的请求体返回 413，而不是兜底 500', async () => {
      // 实测：不单独处理 entity.too.large 会落到 500「服务器内部错误」，日志里还留一条 ERROR
      const big = '[' + '1,'.repeat(40000) + '1]';
      const res = await fetch(`${base}/api/notes/id-0001/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: big,
      });
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('越界路径一律 404，不做文件系统访问', async () => {
      for (const p of [
        '/api/notes/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
        '/api/notes/%00abc',
        '/api/media/%2E%2E%2F%2E%2E%2Fconfig%2Fapp.json/640',
        '/api/refresh/%2E%2E%2Fetc',
      ]) {
        const res = await fetch(base + p);
        expect(res.status, p).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
      }
    });

    it('未知 API 路径返回 JSON 404（不会被媒体路由或前端兜底吃掉）', async () => {
      const res = await fetch(`${base}/api/nope`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('NOT_FOUND');
    });

    // 放在最后：它会在后台真的跑一次扫描并重写索引，前面的断言都要求初始状态
    it('POST /refresh 启动真实刷新，missing 标记按文件实际存在与否重算', async () => {
      const res = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: ALLOWED_ORIGIN } });
      expect(res.status).toBe(202);
      const { job } = await res.json();
      const jobId = job.jobId as string;

      let final = job;
      for (let i = 0; i < 200 && final.state === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        final = (await (await fetch(`${base}/api/refresh/${jobId}`)).json()).job;
      }
      expect(final.state).toBe('completed');
      expect(final.errors).toBe(0);

      const detail = await fetch(`${base}/api/notes/id-0002`);
      expect((await detail.json()).sourceStatus).toBe('available');
      const uncategorized = await (await fetch(`${base}/api/notes?category=uncategorized`)).json();
      expect(uncategorized.total).toBe(1);
    });
  });
});
