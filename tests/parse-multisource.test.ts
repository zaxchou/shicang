import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNote } from '../server/reader/parse';
import { LibraryService, ValidationError } from '../server/services/library';
import type { AppConfig } from '../server/config';
import type { CollectionDef } from '../shared/types';
import { formatShanghai } from '../shared/time';
import { tinyWebp } from './helpers/fixture';

const COLLECTIONS: CollectionDef[] = [
  { id: 'rednote', name: '小红书', root: 'RedNote/Bookmarks', type: 'rednote' },
  {
    id: 'treasures',
    name: '我的宝贝',
    root: '我的收藏品',
    type: 'treasures',
    exclude: ['-索引\\.md$', '^MOC\\.md$', '^未命名页面\\.md$'],
  },
  {
    id: 'diary',
    name: '日记',
    root: 'flomo',
    type: 'diary',
    exclude: ['^闪念笔记概览\\.md$', '^flomo-首页\\.md$', '^flomo-.+-首页\\.md$'],
  },
  { id: 'web', name: '网页', root: 'Clippings', type: 'web' },
  { id: 'wechat', name: '微信公众号', root: '笔记同步助手', type: 'web' },
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
  // treasures：文件名/路径带空格、封面相对收藏库根、wiki 裸文件名嵌入（v0.5.1 回归）
  const shuDir = path.join(root, '我的收藏品', '我的收藏-书法');
  fs.mkdirSync(path.join(shuDir, 'Attachments'), { recursive: true });
  fs.writeFileSync(path.join(shuDir, 'Attachments', 'Pasted image 20260426145213.png'), tinyWebp(7, 5));
  fs.writeFileSync(path.join(shuDir, 'Attachments', 'image 1.png'), tinyWebp(6, 6));
  fs.mkdirSync(path.join(shuDir, 'Attachments', '某帖'), { recursive: true });
  fs.writeFileSync(path.join(shuDir, 'Attachments', '某帖', 'mm 1.jpg'), tinyWebp(3, 4));
  fs.writeFileSync(
    path.join(shuDir, '无辨色.md'),
    '---\n收藏分类: 书法\n封面图: 我的收藏-书法/Attachments/某帖/mm 1.jpg\n价格: 2800\n---\n\n' +
      '## 图片\n![[Pasted image 20260426145213.png]]\n\n![带空格](Attachments/image 1.png)\n',
    'utf8'
  );
  // treasures：子目录里的 MOC.md（无 frontmatter，靠 H1 当标题、靠路径段归分类）
  fs.mkdirSync(path.join(shuDir, '豪翰斋'), { recursive: true });
  fs.writeFileSync(
    path.join(shuDir, '豪翰斋', 'MOC.md'),
    '# 豪翰斋\n\n张羽翔 999\n\n![图](Attachments/image 1.png)\n',
    'utf8'
  );
  // 收藏总索引（vault 自带「笔记类型」标注）与空笔记：应被有意跳过
  fs.writeFileSync(
    path.join(root, '我的收藏品', '我的收藏品-首页.md'),
    '---\n笔记类型: "收藏总索引"\n收藏库: "我的收藏品"\n---\n\n# 我的收藏品\n',
    'utf8'
  );
  fs.mkdirSync(path.join(root, '我的收藏品', '我的收藏-篆刻'), { recursive: true });
  fs.writeFileSync(path.join(root, '我的收藏品', '我的收藏-篆刻', '未命名页面.md'), '', 'utf8');
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
  // flomo 导出工具生成的首页/导航页：应被 exclude 排除（v0.5.3）
  fs.writeFileSync(path.join(root, 'flomo', 'flomo-首页.md'), '# flomo-首页\n', 'utf8');
  fs.writeFileSync(path.join(root, 'flomo', 'flomo-书法-首页.md'), '# flomo-书法-首页\n', 'utf8');
  // web：Obsidian Web Clipper 剪藏（frontmatter 模板 + wiki 作者 + 样板标签）
  fs.mkdirSync(path.join(root, 'Clippings'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Clippings', '陈天奇播客.md'),
    '---\ntitle: "陈天奇：机器学习系统｜WhynotTV Podcast #3"\nsource: "https://www.bilibili.com/video/BV1xx"\nauthor:\n  - "[[WhynotTV]]"\npublished: 2025-09-12\ncreated: 2026-05-02\ndescription: "对谈陈天奇：长期主义与机器学习系统。"\ntags:\n  - "clippings"\n---\n\n## 简介\n\n正文里还有独有词"量子纠缠的茶壶"。字幕很长……\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'Clippings', '公众号文章.md'),
    '---\ntitle: "一篇公众号文章"\nsource: "https://mp.weixin.qq.com/s/abc"\nauthor:\n  - "[[某公众号]]"\npublished:\ncreated: 2026-05-10\ndescription: ""\ntags:\n  - "clippings"\n---\n\n公众号正文\n',
    'utf8'
  );
  // web：无 frontmatter 的手写笔记（用户确认也要收进来）
  fs.writeFileSync(
    path.join(root, 'Clippings', '宿命论部分总结.md'),
    '手写总结正文，含独有词"西西弗斯"。没有 frontmatter。\n',
    'utf8'
  );
  // wechat：笔记同步助手导出（微信公众号）——另一套 frontmatter（url/saved）、
  // 文章在日期子目录里、图片是 vault 绝对路径的 wiki 嵌入
  fs.mkdirSync(path.join(root, '笔记同步助手', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, '笔记同步助手', 'images', 'cover1.png'), tinyWebp(8, 6));
  fs.mkdirSync(path.join(root, '笔记同步助手', '2026-09-29'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '笔记同步助手', '2026-09-29', '测试公众号文章.md'),
    '---\nauthor: 缩小信息差的\nsource: 微信公众号\nurl: https://mp.weixin.qq.com/s?__biz=MjM5&s=abc\nsaved: 2026-09-29 11:23:46\ntags:\n  - 笔记同步助手\nid: 757a3e2c-7c72-45cc-8c9f-07364dff0ebe\n---\n\n' +
      '公众号名称：一只梨\n\n作者名称：缩小信息差的\n\n发布时间：2026-09-14 19:18\n\n' +
      '原文链接：[https://mp.weixin.qq.com/s/xxx#rd](https://mp.weixin.qq.com/s/xxx#rd)\n\n' +
      '![[笔记同步助手/images/cover1.png]]\n\n正文第一段，含独有词"量子纠缠的茶壶"。\n\n第二段正文。\n',
    'utf8'
  );
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

const [RN, TR, DIA, WEB, WECHAT] = COLLECTIONS;

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

  it('treasures：路径含空格的正文图片必须真正渲染（v0.5.1 回归）', () => {
    const root = makeVault();
    const out = parseAt(root, TR, '我的收藏-书法/无辨色.md');
    expect(out.error).toBeNull();
    const r = out.record!;

    // 封面图字段相对「收藏库根」（我的收藏-书法/...），不在 vault 根也不在笔记目录下
    const cover = r.media.find((m) => m.id === r.coverMediaId);
    expect(cover?.localRelativePath).toBe('我的收藏品/我的收藏-书法/Attachments/某帖/mm 1.jpg');

    // wiki 裸文件名嵌入：按 <笔记目录>/Attachments/<文件名> 解析
    expect(r.media.some((m) => m.id === 'Pasted image 20260426145213.png')).toBe(true);
    // md 图片：目标含空格，也必须解析成功
    expect(r.media.some((m) => m.id === 'image 1.png')).toBe(true);

    // 三张图都要出现在正文里，且不残留未解析的 markdown / media:// 占位
    const imgs = r.bodyHtml.split('<img ').length - 1;
    expect(imgs).toBe(2); // 正文两张（封面是第 3 张，不进正文）
    expect(r.bodyHtml).not.toContain('media://');
    expect(r.bodyHtml).not.toMatch(/!\[[^\]]*\]\(/);
    expect(r.bodyHtml).not.toContain('Pasted image'); // 文件名只应出现在 URL 里（已百分号编码）
  });

  it('treasures：子目录 MOC 归所属分类且标题取 H1；索引页与空笔记被有意跳过', () => {
    const root = makeVault();
    const moc = parseAt(root, TR, '我的收藏-书法/豪翰斋/MOC.md');
    expect(moc.error).toBeNull();
    expect(moc.skippedReason).toBeFalsy();
    expect(moc.record!.derivedCategory).toBe('书法'); // 路径段「我的收藏-书法」，尽管 MOC 在子目录里
    expect(moc.record!.title).toBe('豪翰斋'); // 无 CSV标题/文件名叫 MOC → 用正文 H1
    expect(moc.record!.bodyHtml).toContain('<img'); // 正文图片要真的渲染

    const home = parseAt(root, TR, '我的收藏品-首页.md');
    expect(home.record).toBeNull();
    expect(home.error).toBeNull();
    expect(home.skippedReason).toContain('收藏索引页');

    const blank = parseAt(root, TR, '我的收藏-篆刻/未命名页面.md');
    expect(blank.record).toBeNull();
    expect(blank.error).toBeNull();
    expect(blank.skippedReason).toBe('空笔记');
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
      groups: [{ id: 'clippings', name: '剪藏', collections: ['rednote', 'web'] }],
      host: '127.0.0.1',
      port: 0,
      timezone: 'Asia/Shanghai',
      publicOrigin: '',
      extraAllowedOrigins: [],
      dataDir: path.join(root, 'data'),
      backupDir: path.join(root, 'backups'),
      exportDir: path.join(root, '..', path.basename(root) + '-export'),
      exportAfterRefresh: false,
      logDir: path.join(root, 'logs'),
      isProduction: false,
      version: 'test',
    };
    const svc = new LibraryService(cfg);
    await svc.init();
    return svc;
  }

  const base = { q: '', timeField: 'published', range: 'all', order: 'desc', offset: 0, limit: 100 };

  it('五库分别入库；exclude 规则排除索引/MOC/概览', async () => {
    const svc = await boot();
    const info = svc.libraryInfo();
    const byId = Object.fromEntries(info.collections.map((c) => [c.id, c]));
    expect(byId['rednote'].total).toBe(1);
    expect(byId['treasures'].total).toBe(3); // 茶器1 + 书法2（无辨色/豪翰斋MOC）；索引页与空笔记被跳过
    expect(byId['diary'].total).toBe(1); // 概览被排除
    expect(byId['web'].total).toBe(3); // 两篇剪藏 + 一篇无 frontmatter 的手写（用户要求也收）
    expect(byId['wechat'].total).toBe(1); // 笔记同步助手：日期子目录里的一篇
    expect(info.total).toBe(9);
    expect(byId['wechat'].type).toBe('web'); // 前端按 type 走网页列与卡片底片
  });

  it('按库查询：分类过滤用派生值；treasures 表格字段有计数', async () => {
    const svc = await boot();
    const tr = svc.query({ ...base, collection: 'treasures' } as never);
    expect(tr.total).toBe(3);
    expect(tr.items.every((i) => i.categorySource === 'derived')).toBe(true);
    expect(tr.items.find((i) => i.title.includes('测试茶壶7800'))!.extra!['价格']).toBe(7800);

    const byCat = svc.query({ ...base, collection: 'treasures', categoryId: '茶器' } as never);
    expect(byCat.total).toBe(1);
    const wrongCat = svc.query({ ...base, collection: 'treasures', categoryId: '书画' } as never);
    expect(wrongCat.total).toBe(0);

    const info = svc.collectionInfo('treasures')!;
    expect(info.categories.find((c) => c.name === '茶器')?.count).toBe(1);
    expect(info.categories.find((c) => c.name === '书法')?.count).toBe(2); // 无辨色 + 豪翰斋 MOC
    expect(info.extraFields.find((f) => f.key === '价格')?.count).toBe(2);

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
describe('剪藏分组（CollectionGroup）', () => {
  it('组查询 = 成员合集：小红书 + 网页一起返回，单库查询不受影响', async () => {
    const svc = await boot();
    const group = svc.query({ ...base, collection: 'clippings' } as never);
    expect(group.total).toBe(4); // rednote 1 + web 3
    expect(new Set(group.items.map((i) => i.collection))).toEqual(new Set(['rednote', 'web']));
    expect(svc.query({ ...base, collection: 'rednote' } as never).total).toBe(1);
    expect(svc.query({ ...base, collection: 'web' } as never).total).toBe(3);
  });

  it('libraryInfo.groups 聚合成员计数；组内标星跨成员', async () => {
    const svc = await boot();
    const g = svc.libraryInfo().groups.find((x) => x.id === 'clippings')!;
    expect(g.name).toBe('剪藏');
    expect(g.collectionIds).toEqual(['rednote', 'web']);
    expect(g.total).toBe(4);
    expect(g.active).toBe(4);

    // 各标一篇（web + rednote）→ 组内标星 = 2；组内标星查询也跨成员
    const webItems = svc.query({ ...base, collection: 'web' } as never);
    const first = await svc.setAnnotation(webItems.items[0]!.id, { star: true }, 0);
    const rn = svc.query({ ...base, collection: 'rednote' } as never);
    await svc.setAnnotation(rn.items[0]!.id, { star: true }, first.revision);
    const starred = svc.query({ ...base, collection: 'clippings', starred: true } as never);
    expect(starred.total).toBe(2);
    expect(svc.libraryInfo().groups[0]!.starred).toBe(2);
  });

  it('组标签目录跨成员聚合；单库口径不变', async () => {
    const svc = await boot();
    // web 的样板标签已滤掉 → 组标签 = rednote 的'测试'
    expect(svc.tagCounts('clippings').map((t) => t.tag)).toContain('测试');
    expect(svc.tagCounts('web')).toEqual([]);
    expect(svc.tagCounts('rednote').map((t) => t.tag)).toContain('测试');
  });

  it('setCategory 仍只允许 rednote（组不改变这条纪律）', async () => {
    const svc = await boot();
    const group = svc.query({ ...base, collection: 'clippings' } as never);
    const webNote = group.items.find((i) => i.collection === 'web')!;
    await expect(svc.setCategory(webNote.id, '随便', 0)).rejects.toBeInstanceOf(ValidationError);
  });
});
});

describe('web：网页剪藏解析', () => {
  it('Web Clipper 模板：frontmatter 映射、作者剥 [[]]、样板标签滤掉、来源派生分类', () => {
    const root = makeVault();
    const out = parseAt(root, WEB, '陈天奇播客.md');
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.collection).toBe('web');
    expect(r.title).toBe('陈天奇：机器学习系统｜WhynotTV Podcast #3'); // title 以 frontmatter 为准（含 # 与全角）
    expect(r.author).toBe('WhynotTV'); // [[wiki-link]] 剥壳
    expect(r.originalUrl).toBe('https://www.bilibili.com/video/BV1xx');
    expect(r.publishedAt).toContain('2025-09-12'); // 来源发布时间
    expect(r.syncedAt).toContain('2026-05-02'); // 剪藏时间
    expect(r.tags).toEqual([]); // 每篇都有的样板标签 clippings 被滤掉
    expect(r.derivedCategory).toBe('哔哩哔哩'); // source 域名派生
    expect(r.excerpt).toContain('长期主义'); // 摘要优先 description（正文一半是字幕）
    // description 与正文都进搜索文本；作者频道名也要能搜到
    expect(r.searchText).toContain('量子纠缠的茶壶');
    expect(r.searchText).toContain('whynottv');
  });

  it('来源域名→分类：微信公众号 / 手写笔记（无 frontmatter）也收且归未分类', () => {
    const root = makeVault();
    const wx = parseAt(root, WEB, '公众号文章.md');
    expect(wx.record!.derivedCategory).toBe('微信公众号');
    expect(wx.record!.publishedAt).toBeNull(); // published 可为空
    expect(wx.record!.author).toBe('某公众号');

    const hand = parseAt(root, WEB, '宿命论部分总结.md');
    expect(hand.error).toBeNull();
    const r = hand.record!;
    expect(r.title).toBe('宿命论部分总结'); // 无 frontmatter：标题用文件名
    expect(r.author).toBe('我'); // 手写 = 用户自己的
    expect(r.originalUrl).toBe('');
    expect(r.derivedCategory).toBeNull(); // 无来源 → 未分类
    expect(r.searchText).toContain('西西弗斯');
  });
});

describe('wechat：笔记同步助手方言（微信公众号剪藏）', () => {
  it('frontmatter 映射：url 当原文链接、saved 当剪藏时间、发布时间从正文取、样板标签滤掉', () => {
    const root = makeVault();
    const out = parseAt(root, WECHAT, '2026-09-29/测试公众号文章.md');
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.collection).toBe('wechat');
    expect(r.title).toBe('测试公众号文章'); // 没有 fm.title → 文件名（文章在日期子目录里）
    expect(r.author).toBe('缩小信息差的');
    expect(r.originalUrl).toContain('mp.weixin.qq.com/s?'); // url 才是链接；source 是展示名
    expect(r.publishedAt).toMatch(/^2026-09-14T/); // 工具不写 published → 正文「发布时间：」
    expect(r.syncedAt).toMatch(/^2026-09-29T/); // saved = 剪藏时间
    // 展示口径（用户看到的）：文件里写 11:26/19:18，显示就必须是这两个钟点。
    // js-yaml 会把 `2026-09-29 11:26:17` 当 UTC 解析，直接用 fm 值会晚 8 小时——这条断言在旧代码上是红的
    expect(formatShanghai(r.publishedAt)).toBe('2026-09-14 19:18');
    expect(formatShanghai(r.syncedAt)).toBe('2026-09-29 11:23');
    expect(r.tags).toEqual([]); // 样板标签「笔记同步助手」被滤掉（同 clippings）
    expect(r.derivedCategory).toBe('微信公众号'); // 按 url 域名派生，不能拿 source 当链接解析
  });

  it('图片嵌入与摘录：vault 绝对路径嵌入登记成媒体并当封面；摘录跳过开头元信息块', () => {
    const root = makeVault();
    const out = parseAt(root, WECHAT, '2026-09-29/测试公众号文章.md');
    const r = out.record!;
    expect(r.media).toHaveLength(1);
    expect(r.media[0]?.available).not.toBe(false);
    expect(r.coverMediaId).not.toBeNull(); // 首图就是封面——本地图，不需要出网抓封面
    expect(r.bodyHtml).toContain('/api/media/'); // ![[…]] 改写成媒体路由
    expect(r.bodyHtml).not.toContain('[[');
    expect(r.excerpt.startsWith('公众号名称')).toBe(false); // 开头元信息块不进摘录
    expect(r.excerpt).toContain('量子纠缠的茶壶'); // 摘录从正文开始
    expect(r.searchText).toContain('一只梨'); // 公众号名称只在正文里，但仍可搜到
    expect(out.warnings).toEqual([]);
  });
});
