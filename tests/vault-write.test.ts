// 编辑写回 vault（v0.17）：拾藏里改标题/正文 → 手术式改写源 .md → 单篇重解析进索引。
// 四种方言的标题落点各不相同（小红书=H1 行；网页/微信=fm title；宝贝=fm CSV标题；日记不可编辑）。
// 纪律：乐观并发（baseHash 对不上即拒绝且盘上不动）、写前备份、原子写、与刷新扫描互斥。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { LibraryService } from '../server/services/library';
import { apiRouter } from '../server/routes/api';
import type { AppConfig } from '../server/config';
import type { CollectionDef } from '../shared/types';

const COLLECTIONS: CollectionDef[] = [
  { id: 'rednote', name: '小红书', root: 'RedNote/Bookmarks', type: 'rednote' },
  { id: 'web', name: '网页', root: 'Clippings', type: 'web' },
  { id: 'treasures', name: '我的宝贝', root: '我的收藏品', type: 'treasures' },
  { id: 'diary', name: '日记', root: 'flomo', type: 'diary' },
];

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-vaultwrite-'));
  // 小红书：frontmatter + H1 标题 + 两段正文
  fs.mkdirSync(path.join(root, 'RedNote', 'Bookmarks'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'RedNote', 'Bookmarks', '原笔记-rid0001.md'),
    '---\nresourceId: "rid0001"\nauthor: "作者甲"\npostCreatedAt: 2026-06-01T10:00:00.000Z\ntags:\n  - 测试\n---\n\n# 原标题\n\n原正文第一段。\n\n原正文第二段。\n',
    'utf8'
  );
  // 网页：fm title + 正文
  fs.mkdirSync(path.join(root, 'Clippings'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Clippings', '网页一篇.md'),
    '---\ntitle: "网页原题"\nsource: "https://example.com/a"\ncreated: 2026-05-02\ntags:\n  - "clippings"\n---\n\n网页正文。\n',
    'utf8'
  );
  // 网页：无 fm title（标题回落正文 H1）
  fs.writeFileSync(
    path.join(root, 'Clippings', '手写网页.md'),
    '---\nsource: "https://example.com/b"\n---\n\n# 手写标题\n\n手写正文。\n',
    'utf8'
  );
  // 宝贝：CSV标题
  fs.mkdirSync(path.join(root, '我的收藏品'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '我的收藏品', '茶壶一只.md'),
    '---\n收藏分类: 茶器\nCSV标题: "茶壶原题"\n价格: 100\n---\n\n茶壶正文。\n',
    'utf8'
  );
  // 日记：无独立标题字段 → 本期不可编辑
  fs.mkdirSync(path.join(root, 'flomo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'flomo', '2026-09-29_随笔_测试.md'),
    '---\ncreated_at: "2026-09-29 10:00:00"\ntags: ["随笔"]\n---\n\n# 测试\n\n日记正文。\n',
    'utf8'
  );
  return root;
}

function makeCfg(root: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    app: 'test',
    vaultRoot: root.replace(/\\/g, '/'),
    collections: COLLECTIONS,
    groups: [],
    host: '127.0.0.1',
    port: 0,
    timezone: 'Asia/Shanghai',
    publicOrigin: '',
    extraAllowedOrigins: [],
    dataDir: path.join(root, 'data'),
    backupDir: path.join(root, 'backups'),
    exportDir: path.join(root, 'export'),
    exportAfterRefresh: false,
    autoRefreshOnBoot: false,
    vaultWriteEnabled: true,
    logDir: path.join(root, 'logs'),
    isProduction: false,
    version: 'test',
    ...over,
  };
}

async function boot(over: Partial<AppConfig> = {}) {
  const root = makeVault();
  const cfg = makeCfg(root, over);
  const svc = new LibraryService(cfg);
  await svc.init();
  return { svc, root, cfg };
}

function readVault(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

const Q = { q: '', timeField: 'published' as const, range: 'all' as const, order: 'desc' as const, offset: 0, limit: 100 };

async function refresh(svc: LibraryService) {
  const job = svc.startRefresh();
  for (let i = 0; i < 200; i++) {
    const cur = svc.getRefreshJob(job.jobId);
    if (cur && cur.state !== 'running') return cur;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('刷新任务超时');
}

describe('编辑写回 vault（v0.17）', () => {
  it('小红书：GET 拆出标题(H1)/正文；保存后盘上与索引同步更新，新词可搜旧词消失', async () => {
    const { svc, root } = await boot();
    const src = await svc.noteSource('rid0001');
    expect(src.editable).toBe(true);
    expect(src.titleMode).toBe('h1');
    expect(src.title).toBe('原标题');
    expect(src.body).toContain('原正文第一段。');
    expect(src.body).not.toContain('#');
    expect(src.baseHash).toHaveLength(64);

    const out = await svc.saveNoteContent('rid0001', {
      title: '新标题',
      body: '\n新正文A。\n\n新正文B。',
      baseHash: src.baseHash,
    });
    expect(out.note.title).toBe('新标题');

    const raw = readVault(root, 'RedNote/Bookmarks/原笔记-rid0001.md');
    expect(raw).toContain('# 新标题');
    expect(raw).toContain('新正文A。');
    expect(raw).not.toContain('原标题');
    expect(raw).not.toContain('原正文第一段');
    expect(raw).toContain('resourceId: "rid0001"'); // frontmatter 原样
    expect(raw).toContain('author: "作者甲"');

    expect(svc.detail('rid0001').title).toBe('新标题');
    expect(svc.query({ ...Q, collection: 'rednote', q: '新正文A' }).items.map((i) => i.id)).toContain('rid0001');
    expect(svc.query({ ...Q, collection: 'rednote', q: '原正文第一段' }).total).toBe(0);
    expect(out.revision).toBeGreaterThan(0);
  });

  it('网页：只改 fm title 行，其余逐字保留；未改动保存 = 字节级还原', async () => {
    const { svc, root } = await boot();
    const id = 'Clippings/网页一篇.md';
    const before = readVault(root, id);
    const src = await svc.noteSource(id);
    expect(src.titleMode).toBe('fm');
    expect(src.fmKey).toBe('title');
    expect(src.title).toBe('网页原题');
    expect(src.body).toContain('网页正文。');

    // 未改动保存：round-trip 必须字节一致（手术式重组的硬要求）
    await svc.saveNoteContent(id, { title: src.title, body: src.body, baseHash: src.baseHash });
    expect(readVault(root, id)).toBe(before);

    // 真改标题：只动 title 行
    await svc.saveNoteContent(id, { title: '网页新题', body: src.body, baseHash: src.baseHash });
    const raw = readVault(root, id);
    expect(raw).toContain('title: "网页新题"');
    expect(raw).toContain('source: "https://example.com/a"');
    expect(raw).toContain('网页正文。');
    expect(raw).not.toContain('网页原题');
    expect(svc.detail(id).title).toBe('网页新题');
  });

  it('网页无 fm title：GET 给回落标题（H1），保存后把 title 键插入 frontmatter', async () => {
    const { svc, root } = await boot();
    const id = 'Clippings/手写网页.md';
    const src = await svc.noteSource(id);
    expect(src.title).toBe('手写标题'); // fm 无 title → 回落 H1
    await svc.saveNoteContent(id, { title: '手写新题', body: src.body, baseHash: src.baseHash });
    const raw = readVault(root, id);
    expect(raw).toMatch(/^title: "手写新题"$/m);
    expect(raw).toContain('# 手写标题'); // 正文不动
    expect(svc.detail(id).title).toBe('手写新题'); // fm 键优先于 H1
  });

  it('宝贝：CSV标题 行替换，正文与其它 frontmatter 不动', async () => {
    const { svc, root } = await boot();
    const id = '我的收藏品/茶壶一只.md';
    const src = await svc.noteSource(id);
    expect(src.titleMode).toBe('fm');
    expect(src.fmKey).toBe('CSV标题');
    expect(src.title).toBe('茶壶原题');
    await svc.saveNoteContent(id, { title: '茶壶新题', body: src.body, baseHash: src.baseHash });
    const raw = readVault(root, id);
    expect(raw).toContain('CSV标题: "茶壶新题"');
    expect(raw).toContain('收藏分类: 茶器');
    expect(raw).toContain('价格: 100');
    expect(raw).toContain('茶壶正文。');
    expect(svc.detail(id).title).toBe('茶壶新题');
  });

  it('冲突：baseHash 过期 → 拒绝且盘上文件一个字都不动', async () => {
    const { svc, root } = await boot();
    const id = 'Clippings/网页一篇.md';
    const p = path.join(root, 'Clippings', '网页一篇.md');
    const src = await svc.noteSource(id);
    // 模拟 Obsidian/同步工具在拾藏之外改了文件
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n外部追加。\n', 'utf8');
    await expect(
      svc.saveNoteContent(id, { title: 'X', body: 'Y', baseHash: src.baseHash })
    ).rejects.toThrow(/之外被修改/);
    const raw = fs.readFileSync(p, 'utf8');
    expect(raw).toContain('外部追加。'); // 外部改动未被覆盖
    expect(raw).toContain('title: "网页原题"'); // 原内容完好
    expect(svc.detail(id).title).toBe('网页原题'); // 索引也未变
  });

  it('日记不可编辑；开关关闭明确报错；未知 id 报未找到', async () => {
    const { svc } = await boot();
    const dId = 'flomo/2026-09-29_随笔_测试.md';
    expect(() => svc.noteSource(dId)).toThrow(/不支持/);
    await expect(
      svc.saveNoteContent(dId, { title: 'x', body: 'y', baseHash: 'z' })
    ).rejects.toThrow(/不支持/);
    expect(() => svc.noteSource('没有这篇')).toThrow(/未找到/);

    const { svc: off } = await boot({ vaultWriteEnabled: false });
    await expect(
      off.saveNoteContent('rid0001', { title: 'x', body: 'y', baseHash: 'z' })
    ).rejects.toThrow(/写回/);
  });

  it('写前备份落在数据目录（vault 外）、内容是写之前的原文；vault 内无 tmp 残留；二刷快路径不重复入库', async () => {
    const { svc, root, cfg } = await boot();
    const totalBefore = svc.libraryInfo().total;
    const src = await svc.noteSource('rid0001');
    await svc.saveNoteContent('rid0001', { title: '备份测试', body: '\n新内容。', baseHash: src.baseHash });

    const bakDir = path.join(cfg.dataDir, 'edit-backups');
    const baks = fs.readdirSync(bakDir);
    expect(baks).toHaveLength(1);
    expect(baks[0]).toContain('原笔记-rid0001.md');
    expect(fs.readFileSync(path.join(bakDir, baks[0]!), 'utf8')).toContain('# 原标题');

    // vault 内不允许留下临时文件
    const vaultFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else vaultFiles.push(e.name);
      }
    };
    walk(root);
    expect(vaultFiles.some((f) => f.includes('.tmp'))).toBe(false);

    // 记录已带新 mtime/size → 二刷走快路径，不重复解析、不重复入库
    const job = await refresh(svc);
    expect(job.state).toBe('completed');
    expect(job.updated).toBe(0);
    expect(job.added).toBe(0);
    expect(svc.libraryInfo().total).toBe(totalBefore);
  });

  it('路由层：GET source 形状、PUT 缺字段 400、过期 baseHash 409 SOURCE_CHANGED', async () => {
    const { svc } = await boot();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', apiRouter({ library: () => svc, allowedOrigins: () => [], isReady: () => true }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const src = (await (await fetch(`${base}/api/notes/${encodeURIComponent('rid0001')}/source`)).json()) as {
        editable: boolean;
        titleMode: string;
        baseHash: string;
      };
      expect(src.editable).toBe(true);
      expect(src.titleMode).toBe('h1');
      expect(src.baseHash).toHaveLength(64);

      const bad = await fetch(`${base}/api/notes/rid0001/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      });
      expect(bad.status).toBe(400);

      const conflict = await fetch(`${base}/api/notes/rid0001/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x', body: 'y', baseHash: 'deadbeef' }),
      });
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('SOURCE_CHANGED');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
