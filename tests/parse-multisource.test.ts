import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNote } from '../server/reader/parse';
import { LibraryService, ValidationError } from '../server/services/library';
import type { AppConfig } from '../server/config';
import type { CollectionDef } from '../shared/types';
import { tinyWebp } from './helpers/fixture';

const COLLECTIONS: CollectionDef[] = [
  { id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' },
  {
    id: 'treasures',
    name: '我的宝贝',
    root: '我的收藏品',
    type: 'treasures',
    exclude: ['-索引\\.md$', '^MOC\\.md$', '^未命名页面\\.md$'],
  },
  { id: 'diary', name: '日记', root: 'flomo', type: 'diary', exclude: ['^闪念笔记概览\\.md$'] },
];

/** 构造迷你 vault：三个 collection 的真实布局（含图片与附件） */
function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-vault-'));
  // rednote
  fs.mkdirSync(path.join(root, 'RedNote', 'Bookmarks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'RedNote', 'Media', 'rid0001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'RedNote', 'Media', 'rid0001', 'image-1.webp'), tinyWebp(10, 6));
  fs.writeFileSync(
    path.join(root, 'RedNote', 'Bookmarks', '红书笔记-rid0001.md'),
    '---\nresourceId: "rid0001"\nauthor: "作者甲"\npostCreatedAt: 2026-06-01T10:00:00.000Z\nsyncedAt: 2026-09-01T08:00:00.000Z\ntags:\n  - 测试\n---\n\n# 红书标题\n\n正文内容\n\n![[RedNote/Media/rid0001/image-1.webp]]\n',
    'utf8'
  );
  // treasures：分类内笔记 + 封面 + 本地/远程图 + 表格字段
  const teaDir = path.join(root, '我的收藏品', '我的收藏-茶器');
  fs.mkdirSync(path.join(teaDir, 'Attachments', '测试茶壶'), { recursive: true });
  fs.mkdirSync(path.join(root, '我的收藏品', 'Attachments'), { recursive: true });
  fs.writeFileSync(path.join(teaDir, 'Attachments', '测试茶壶', 'a.jpg'), tinyWebp(8, 8));
  fs.writeFileSync(path.join(root, '我的收藏品', 'Attachments', 'cover.jpg'), tinyWebp(4, 3));
  fs.writeFileSync(
    path.join(teaDir, '测试茶壶7800.md'),
    '---\n收藏分类: 茶器\n封面图: 我的收藏品/Attachments/cover.jpg\n价格: 7800\n购买时间: 2026-09-04\n器型: 紫砂壶\n作者品牌: 陈俊\ntags:\n  - 收藏\n---\n\n测试茶壶\n\n![主图](Attachments/测试茶壶/a.jpg)\n\n![远程图](https://example.com/x.jpg)\n',
    'utf8'
  );
  // treasures：索引与 MOC（应被排除）
  fs.writeFileSync(path.join(root, '我的收藏品', '我的收藏-茶器-索引.md'), '# 索引\n', 'utf8');
  fs.writeFileSync(path.join(root, '我的收藏品', 'MOC.md'), '# MOC\n', 'utf8');
  // diary：附件链接（图片转内联）+ 主题
  fs.mkdirSync(path.join(root, 'flomo', 'attachments', '2024', '07', '31'), { recursive: true });
  fs.writeFileSync(path.join(root, 'flomo', 'attachments', '2024', '07', '31', 'img1.jpg'), tinyWebp(5, 5));
  fs.writeFileSync(
    path.join(root, 'flomo', '2024-07-31_画画_测试摘要内容.md'),
    '---\ncreated_at: "2024-07-31 17:01:40"\nupdated_at: "2024-08-01 10:00:00"\ntags: ["画画"]\n---\n\n# 测试摘要内容\n\n这是日记正文\n\n[img1](attachments/2024/07/31/img1.jpg)\n',
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'flomo', '闪念笔记概览.md'), '# 概览\n', 'utf8');
  return root;
}

function parseAt(vaultRoot: string, col: CollectionDef, relInCollection: string) {
  const abs = path.join(vaultRoot, ...`${col.root}/${relInCollection}`.split('/'));
  return parseNote({
    vaultRoot,
    collection: col,
    absolutePath: abs,
    relativePath: relInCollection,
    sourceRelativePath: `${col.root}/${relInCollection}`,
    mtimeMs: fs.statSync(abs).mtimeMs,
    size: fs.statSync(abs).size,
  });
}

const [RN, TR, DIA] = COLLECTIONS;

describe('多源解析', () => {
  it('treasures：派生分类、表格字段、封面与本地/远程图片', () => {
    const root = makeVault();
    const out = parseAt(root, TR, '我的收藏-茶器/测试茶壶7800.md');
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.collection).toBe('treasures');
    expect(r.id).toBe('我的收藏品/我的收藏-茶器/测试茶壶7800.md');
    expect(r.derivedCategory).toBe('茶器');
    expect(r.title).toContain('测试茶壶7800');
    expect(r.author).toBe('陈俊');
    expect(r.extra!['价格']).toBe(7800); // 数字可排序
    expect(r.extra!['器型']).toBe('紫砂壶');
    expect(r.publishedAt).toContain('2026-09-04');
    // 封面来自 frontmatter（vault 相对路径）
    const cover = r.media.find((m) => m.id === r.coverMediaId);
    expect(cover?.localRelativePath).toBe('我的收藏品/Attachments/cover.jpg');
    // 正文本地图 → 媒体路由；远程图保留
    expect(r.bodyHtml).toContain('/api/media/');
    expect(r.bodyHtml).toContain('https://example.com/x.jpg');
    // 索引与 MOC 被排除由 scan 负责；此处确认解析独立于它们
    expect(r.sourceStatus).toBe('available');
  });

  it('diary：日期标题、主题分类、附件图片转内联、时间字段', () => {
    const root = makeVault();
    const out = parseAt(root, DIA, '2024-07-31_画画_测试摘要内容.md');
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.collection).toBe('diary');
    expect(r.title).toBe('2024-07-31 测试摘要内容');
    expect(r.derivedCategory).toBe('画画');
    expect(r.author).toBe('我');
    expect(r.publishedAt?.slice(0, 10)).toBe('2024-07-31');
    expect(r.syncedAt?.slice(0, 10)).toBe('2024-08-01');
    // 附件图片转为 <img> 指向媒体路由
    expect(r.bodyHtml).toContain('<img');
    expect(r.bodyHtml).toContain('/api/media/');
    expect(r.coverMediaId).toBeTruthy();
  });

  it('rednote：旧逻辑回归（resourceId、wiki 媒体、封面）', () => {
    const root = makeVault();
    const out = parseAt(root, RN, '红书笔记-rid0001.md');
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.id).toBe('rid0001');
    expect(r.collection).toBe('rednote');
    expect(r.title).toBe('红书标题');
    expect(r.derivedCategory).toBeUndefined();
    expect(r.coverMediaId).toBeTruthy();
    expect(r.bodyHtml).toContain('/api/media/rid0001/');
  });
});

describe('多库集成（LibraryService）', () => {
  async function boot() {
    const root = makeVault();
    const cfg: AppConfig = {
      app: 'test',
      vaultRoot: root.replace(/\\/g, '/'),
      collections: COLLECTIONS,
      host: '127.0.0.1',
      port: 0,
      timezone: 'Asia/Shanghai',
      publicOrigin: '',
      extraAllowedOrigins: [],
      dataDir: path.join(root, 'data'),
      backupDir: path.join(root, 'backups'),
      logDir: path.join(root, 'logs'),
      isProduction: false,
      version: 'test',
    };
    const svc = new LibraryService(cfg);
    await svc.init();
    return svc;
  }

  const base = { q: '', timeField: 'published', range: 'all', order: 'desc', offset: 0, limit: 100 };

  it('三库分别入库；exclude 规则排除索引/MOC/概览', async () => {
    const svc = await boot();
    const info = svc.libraryInfo();
    const byId = Object.fromEntries(info.collections.map((c) => [c.id, c]));
    expect(byId['rednote'].total).toBe(1);
    expect(byId['treasures'].total).toBe(1); // 索引与 MOC 被排除
    expect(byId['diary'].total).toBe(1); // 概览被排除
    expect(info.total).toBe(3);
  });

  it('按库查询：分类过滤用派生值；treasures 表格字段有计数', async () => {
    const svc = await boot();
    const tr = svc.query({ ...base, collection: 'treasures' } as never);
    expect(tr.total).toBe(1);
    expect(tr.items[0]!.categorySource).toBe('derived');
    expect(tr.items[0]!.extra!['价格']).toBe(7800);

    const byCat = svc.query({ ...base, collection: 'treasures', categoryId: '茶器' } as never);
    expect(byCat.total).toBe(1);
    const wrongCat = svc.query({ ...base, collection: 'treasures', categoryId: '书画' } as never);
    expect(wrongCat.total).toBe(0);

    const info = svc.collectionInfo('treasures')!;
    expect(info.categories.find((c) => c.name === '茶器')?.count).toBe(1);
    expect(info.extraFields.find((f) => f.key === '价格')?.count).toBe(1);

    // 跨库隔离：rednote 库里查不到 diary 内容
    const rn = svc.query({ ...base } as never);
    expect(rn.total).toBe(1);
    expect(rn.items[0]!.collection).toBe('rednote');
  });

  it('标签按库作用域', async () => {
    const svc = await boot();
    expect(svc.tagCounts('diary').map((t) => t.tag)).toContain('画画');
    expect(svc.tagCounts('rednote').map((t) => t.tag)).toContain('测试');
    expect(svc.tagCounts('rednote').find((t) => t.tag === '画画')).toBeUndefined();
  });

  it('非 rednote 库拒绝修改分类', async () => {
    const svc = await boot();
    const tr = svc.query({ ...base, collection: 'treasures' } as never);
    await expect(svc.setCategory(tr.items[0]!.id, '茶器', 0)).rejects.toBeInstanceOf(ValidationError);
  });
});
