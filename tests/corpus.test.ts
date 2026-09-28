// 语料导出测试：纯函数（HTML→文本、内容 hash、目录排版）+ 落盘行为 + 与 LibraryService 的接线。
//
// 重点覆盖三类容易"看起来对但其实不对"的地方：
//   1. 归档 / 源文件消失的记录**必须留在语料里**（过滤掉就悄悄丢数据）；
//   2. contentHash 只跟文本内容走——归档一篇不该让外部 embedding 重算（口说无凭，用例钉住）；
//   3. 导出目录落在 vault 里必须**拒绝写入**，而不是照着配置污染 Obsidian。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryService } from '../server/services/library';
import type { AppConfig } from '../server/config';
import type { NoteRecord } from '../server/reader/parse';
import type { NoteAnnotation, RecognizedText } from '../shared/types';
import {
  CATALOG_FILE,
  CORPUS_FILE,
  MANIFEST_FILE,
  assertOutsideVault,
  buildCatalog,
  buildCorpusRecords,
  computeContentHash,
  exportCorpus,
  htmlToText,
  readCorpusManifest,
  type CorpusBuildContext,
} from '../server/services/corpus';
import { createFixture, type Fixture } from './helpers/fixture';

function mkRecord(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'n1',
    collection: 'rednote',
    sourceRelativePath: 'RedNote/Bookmarks/a.md',
    sourceMtimeMs: 1,
    sourceSize: 1,
    sourceHash: 'sh-1',
    title: '标题',
    author: '作者',
    tags: ['标签'],
    excerpt: '摘录',
    searchText: '标题 作者 标签',
    publishedAt: '2026-01-02T00:00:00.000Z',
    syncedAt: null,
    originalUrl: 'https://example.com/x',
    bodyHtml: '<p>正文</p>',
    media: [{ id: 'image-1.webp', kind: 'image', localRelativePath: 'RedNote/Media/n1/image-1.webp', available: true }],
    coverMediaId: 'image-1.webp',
    sourceStatus: 'available',
    warnings: [],
    ...over,
  };
}

const ANN: NoteAnnotation = { starred: false, starredAt: null, status: 'active', remark: null };

function mkCtx(over: Partial<CorpusBuildContext> = {}): CorpusBuildContext {
  return {
    collections: [
      { id: 'rednote', name: '小红书收藏', categories: [{ id: 'c1', name: '甲类' }, { id: 'c2', name: '乙类' }] },
    ],
    categoryIdOf: () => ({ id: 'c1', source: 'initial' as const }),
    annotationOf: () => ANN,
    ...over,
  };
}

function tmpExportDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myinfobase-corpus-'));
}

describe('htmlToText：正文 HTML → 纯文本', () => {
  it('段落与换行变成换行，列表变成 - 前缀', () => {
    expect(htmlToText('<p>甲</p><p>乙</p>')).toBe('甲\n乙');
    expect(htmlToText('<ul><li>一</li><li>二</li></ul>')).toBe('- 一\n- 二');
    expect(htmlToText('上<br>下')).toBe('上\n下');
  });

  it('标题保留层级（# 前缀），行内标签只剥壳', () => {
    expect(htmlToText('<h2>小标题</h2><p><strong>粗</strong>与<em>斜</em></p>')).toBe('## 小标题\n粗与斜');
  });

  it('命名实体与数字实体都解码（含十六进制）', () => {
    expect(htmlToText('<p>&amp;&lt;&gt;&quot;&#39;&mdash;&#x4e2d;</p>')).toBe('&<>"\'—中');
    expect(htmlToText('<p>a&nbsp;b</p>')).toBe('a b');
  });

  it('先剥标签再解实体：正文里写成 &lt;p&gt; 的字面量不会被当标签吃掉', () => {
    expect(htmlToText('<p>&lt;p&gt;是标签写法</p>')).toBe('<p>是标签写法');
  });

  it('script / style 整块丢弃，不只是去标签', () => {
    expect(htmlToText('<p>保留</p><script>var secret=1;</script><style>.a{color:red}</style>')).toBe('保留');
  });

  it('空白归一：连续空格与三连换行都压掉；空输入返回空串', () => {
    expect(htmlToText('<p>a   b</p><p></p><p></p><p>c</p>')).toBe('a b\n\nc');
    expect(htmlToText('')).toBe('');
  });
});

describe('computeContentHash：语义内容 hash', () => {
  const base = {
    collection: 'rednote',
    title: '标题',
    author: '作者',
    tags: ['标签'],
    categoryId: 'c1',
    categoryName: '甲类',
    remark: null,
    text: '正文',
    extra: null,
    recognized: [] as RecognizedText[],
  };

  it('同一内容永远得到同一 hash；改备注 / 正文 / 分类都会变', () => {
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
    expect(computeContentHash({ ...base, remark: '改过' })).not.toBe(computeContentHash(base));
    expect(computeContentHash({ ...base, text: '正文2' })).not.toBe(computeContentHash(base));
    expect(computeContentHash({ ...base, categoryId: 'c2' })).not.toBe(computeContentHash(base));
  });

  it('识别文本参与 hash（OCR/转录接进来后，外部管道才会感知到内容变了）', () => {
    const withOcr: RecognizedText[] = [
      { kind: 'ocr', mediaId: 'image-1.webp', mediaHash: 'h-ocr', text: '图里的字', model: 'm', at: '2026-01-01T00:00:00.000Z' },
    ];
    expect(computeContentHash({ ...base, recognized: withOcr })).not.toBe(computeContentHash(base));
  });
});

describe('buildCorpusRecords：记录构造', () => {
  it('归档与源文件已消失的记录都保留（语料不是"工作集"，不该悄悄少篇）', () => {
    const recs = buildCorpusRecords(
      [
        mkRecord({ id: 'a' }),
        mkRecord({ id: 'b', sourceStatus: 'missing' }),
        mkRecord({ id: 'c' }),
      ],
      mkCtx({
        annotationOf: (id) => (id === 'c' ? { ...ANN, status: 'archived' } : ANN),
      })
    );
    expect(recs.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(recs.find((r) => r.id === 'b')!.sourceStatus).toBe('missing');
    expect(recs.find((r) => r.id === 'c')!.status).toBe('archived');
  });

  it('分类名从 collections 映射解析；映射里没有的分类回落到 id；未分类为 null', () => {
    const recs = buildCorpusRecords(
      [mkRecord({ id: 'a' }), mkRecord({ id: 'b' }), mkRecord({ id: 'c' })],
      mkCtx({
        categoryIdOf: (r) =>
          r.id === 'a'
            ? { id: 'c1', source: 'initial' }
            : r.id === 'b'
              ? { id: 'unknown', source: 'override' }
              : { id: null, source: 'none' },
      })
    );
    const by = new Map(recs.map((r) => [r.id, r]));
    expect(by.get('a')!.categoryName).toBe('甲类');
    expect(by.get('b')!.categoryName).toBe('unknown');
    expect(by.get('c')!.categoryId).toBeNull();
    expect(by.get('c')!.categoryName).toBeNull();
  });

  it('recognized 默认空数组；提供 recognizedOf 时填进去', () => {
    const noProvider = buildCorpusRecords([mkRecord()], mkCtx());
    expect(noProvider[0].recognized).toEqual([]);

    const ocr: RecognizedText[] = [
      { kind: 'ocr', mediaId: 'image-1.webp', mediaHash: 'h-1', text: '识别出的字', model: 'mimo-v2.6-flash', at: '2026-01-01T00:00:00.000Z' },
    ];
    const withProvider = buildCorpusRecords([mkRecord()], mkCtx({ recognizedOf: () => ocr }));
    expect(withProvider[0].recognized).toEqual(ocr);
  });

  it('排序是决定论的：收藏库顺序 → 发布时间倒序 → id', () => {
    const ctx = mkCtx({
      collections: [
        { id: 'rednote', name: '小红书收藏', categories: [{ id: 'c1', name: '甲类' }] },
        { id: 'treasures', name: '我的宝贝', categories: [] },
      ],
      categoryIdOf: () => ({ id: null, source: 'none' as const }),
    });
    const recs = buildCorpusRecords(
      [
        mkRecord({ id: 'z', collection: 'rednote', publishedAt: '2026-01-01T00:00:00.000Z' }),
        mkRecord({ id: 'a', collection: 'rednote', publishedAt: '2026-03-01T00:00:00.000Z' }),
        mkRecord({ id: 'm', collection: 'treasures' }),
        mkRecord({ id: 'b', collection: 'rednote', publishedAt: '2026-03-01T00:00:00.000Z' }),
      ],
      ctx
    );
    expect(recs.map((r) => r.id)).toEqual(['a', 'b', 'z', 'm']);
  });

  it('extra 的空对象归成 null，避免导出一堆空字段干扰下游', () => {
    const recs = buildCorpusRecords([mkRecord({ extra: {} }), mkRecord({ id: 'n2', extra: { 价格: 100 } })], mkCtx());
    const by = new Map(recs.map((r) => [r.id, r]));
    expect(by.get('n1')!.extra).toBeNull();
    expect(by.get('n2')!.extra).toEqual({ 价格: 100 });
  });

  it('starred / status 变化不改变 contentHash（归档不该触发外部重算），但字段本身要跟着变', () => {
    const active = buildCorpusRecords([mkRecord()], mkCtx({ annotationOf: () => ANN }))[0];
    const archived = buildCorpusRecords(
      [mkRecord()],
      mkCtx({ annotationOf: () => ({ ...ANN, status: 'archived', starred: true, starredAt: '2026-02-02T00:00:00.000Z' }) })
    )[0];
    expect(archived.contentHash).toBe(active.contentHash);
    expect(archived.status).toBe('archived');
    expect(archived.starred).toBe(true);
  });
});

describe('buildCatalog：人读目录', () => {
  const manifestBase = {
    schemaVersion: 1,
    app: 'myinfobase',
    appVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    contentSource: '/vault',
    indexRevision: 3,
    annotationRevision: 4,
    categoryRevision: 5,
    parseVersion: 4,
    counts: {
      total: 3,
      active: 2,
      archived: 1,
      starred: 1,
      missing: 0,
      byCollection: [{ id: 'rednote', name: '小红书收藏', count: 3 }],
    },
    contentDigest: 'd',
    digest: 'd',
    metaDigest: 'm',
  };

  it('分类小节顺序跟 collections 走，不跟记录出现顺序走；归档单独一节', () => {
    const ctx = mkCtx();
    const recs = buildCorpusRecords(
      [
        mkRecord({ id: 'u', publishedAt: '2026-05-01T00:00:00.000Z' }), // 先出现，属于未分类
        mkRecord({ id: 'y', publishedAt: '2026-04-01T00:00:00.000Z' }), // 乙类
        mkRecord({ id: 'j', publishedAt: '2026-03-01T00:00:00.000Z' }), // 甲类
      ],
      mkCtx({
        categoryIdOf: (r) =>
          r.id === 'u'
            ? { id: null, source: 'none' }
            : r.id === 'y'
              ? { id: 'c2', source: 'initial' }
              : { id: 'c1', source: 'initial' },
      })
    );
    const md = buildCatalog(recs, { ...manifestBase, counts: { ...manifestBase.counts, active: 3, archived: 0 } }, ctx.collections);
    const order = ['### 甲类', '### 乙类', '### 未分类'].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('星标、备注摘要、源文件已移除都体现在条目里；归档另起一节；标签按次数列在末尾', () => {
    const ctx = mkCtx();
    const recs = buildCorpusRecords(
      [
        mkRecord({ id: 'a', tags: ['甲', '乙'], sourceStatus: 'missing' }),
        mkRecord({ id: 'b', tags: ['甲'] }),
        mkRecord({ id: 'c', title: '已经不用了的那条', sourceRelativePath: 'RedNote/Bookmarks/c.md', tags: ['甲'] }),
      ],
      mkCtx({
        annotationOf: (id) =>
          id === 'a'
            ? { ...ANN, starred: true, remark: '这是我自己写的备注' }
            : id === 'c'
              ? { ...ANN, status: 'archived' }
              : ANN,
      })
    );
    const md = buildCatalog(recs, { ...manifestBase, counts: { ...manifestBase.counts, total: 3, active: 2, archived: 1 } }, ctx.collections);
    expect(md).toContain('★');
    expect(md).toContain('「这是我自己写的备注」');
    expect(md).toContain('（源文件已移除）');
    expect(md).toContain('- #甲（3）');
    expect(md).toContain('- #乙（1）');
    expect(md).toContain('### 已归档（1）');
    // 归档的那篇只出现在归档节里，不再混在分类节
    const archAt = md.indexOf('### 已归档');
    expect(archAt).toBeGreaterThan(0);
    const afterArch = md.slice(archAt);
    expect(afterArch).toContain('已经不用了的那条');
    expect(afterArch.match(/- 2026-/g)?.length).toBe(1);
    expect(md.slice(0, archAt)).not.toContain('已经不用了的那条');
  });
});

describe('exportCorpus：落盘', () => {
  const meta = {
    app: 'myinfobase',
    appVersion: '9.9.9',
    contentSource: '/vault',
    indexRevision: 1,
    annotationRevision: 2,
    categoryRevision: 3,
    parseVersion: 4,
  };

  it('写出 corpus.jsonl / catalog.md / manifest.json，行数与计数正确', async () => {
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const records = buildCorpusRecords(
      [
        mkRecord({ id: 'a' }),
        mkRecord({ id: 'b' }),
        mkRecord({ id: 'c', sourceStatus: 'missing' }),
        mkRecord({ id: 'd' }),
      ],
      mkCtx({
        annotationOf: (id) =>
          id === 'd' ? { ...ANN, status: 'archived' } : id === 'b' ? { ...ANN, starred: true } : ANN,
      })
    );
    const res = await exportCorpus({ dir, vaultRoot: '/vault', records, collections: ctx.collections, meta });

    expect(res.written).toBe(true);
    const lines = fs.readFileSync(path.join(dir, CORPUS_FILE), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l).id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(fs.existsSync(path.join(dir, CATALOG_FILE))).toBe(true);

    expect(res.manifest.counts).toMatchObject({ total: 4, active: 3, archived: 1, starred: 1, missing: 1 });
    expect(res.manifest.counts.byCollection).toEqual([{ id: 'rednote', name: '小红书收藏', count: 4 }]);
    expect(res.manifest.files.corpus.lines).toBe(4);
    expect(res.manifest.files.corpus.bytes).toBeGreaterThan(0);
    // manifest 落盘内容与返回值一致
    expect(readCorpusManifest(dir)).toEqual(res.manifest);
  });

  it('内容没变时跳过写入：不写盘、不换 generatedAt', async () => {
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const records = buildCorpusRecords([mkRecord()], ctx);
    const first = await exportCorpus({ dir, vaultRoot: '/vault', records, collections: ctx.collections, meta });
    expect(first.written).toBe(true);

    const jsonl = path.join(dir, CORPUS_FILE);
    const mtimeBefore = fs.statSync(jsonl).mtimeMs;
    const second = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records,
      collections: ctx.collections,
      meta,
      now: new Date(Date.now() + 60_000),
    });
    expect(second.written).toBe(false);
    expect(second.files).toEqual([]);
    expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
    expect(fs.statSync(jsonl).mtimeMs).toBe(mtimeBefore);
  });

  it('改了备注就重新写，contentDigest 也变（外部管道据此判定增量）', async () => {
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const before = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records: buildCorpusRecords([mkRecord()], ctx),
      collections: ctx.collections,
      meta,
    });
    const after = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records: buildCorpusRecords([mkRecord()], mkCtx({ annotationOf: () => ({ ...ANN, remark: '新备注' }) })),
      collections: ctx.collections,
      meta,
    });
    expect(after.written).toBe(true);
    expect(after.manifest.contentDigest).not.toBe(before.manifest.contentDigest);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, CORPUS_FILE), 'utf8').trim());
    expect(rec.remark).toBe('新备注');
  });

  it('提交阶段失败（目标被占成目录）：抛错、tmp 清干净、manifest 不被破坏', async () => {
    // 原子写的回退分支此前零覆盖（json-store 同款手法有测试，corpus 这份独立实现没有）
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const first = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records: buildCorpusRecords([mkRecord()], ctx),
      collections: ctx.collections,
      meta,
    });
    expect(first.written).toBe(true);
    const oldManifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

    fs.rmSync(path.join(dir, CORPUS_FILE));
    fs.mkdirSync(path.join(dir, CORPUS_FILE)); // rename / copyFile 都会失败
    const changed = mkCtx({ annotationOf: () => ({ ...ANN, remark: '改过了' }) });
    await expect(
      exportCorpus({
        dir,
        vaultRoot: '/vault',
        records: buildCorpusRecords([mkRecord()], changed),
        collections: ctx.collections,
        meta,
      })
    ).rejects.toThrow();

    // 失败一次攒一个 .tmp 的泄漏必须没有；manifest（最后写的）还是旧的，下次导出能自愈
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(oldManifest);
    fs.rmdirSync(path.join(dir, CORPUS_FILE));
  });

  it('导出目录落在内容源里 → 抛错拒绝写入（不能靠"配置应该是对的"来保护 vault）', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'myinfobase-vault-'));
    expect(() => assertOutsideVault(path.join(vault, 'export'), vault)).toThrow(/落在内容源里/);
    expect(() => assertOutsideVault(vault, vault)).toThrow(/落在内容源里/);
    expect(() => assertOutsideVault(path.join(vault, '..', 'export'), vault)).not.toThrow();

    const ctx = mkCtx();
    await expect(
      exportCorpus({
        dir: path.join(vault, 'RedNote', 'export'),
        vaultRoot: vault,
        records: buildCorpusRecords([mkRecord()], ctx),
        collections: ctx.collections,
        meta,
      })
    ).rejects.toThrow(/落在内容源里/);
    // 拒绝之后确实什么都没写
    expect(fs.existsSync(path.join(vault, 'RedNote', 'export'))).toBe(false);
  });

  it('只改标星/归档也必须重写文件（contentHash 不含状态，不能拿它当"要不要写"的判据）', async () => {
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const first = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records: buildCorpusRecords([mkRecord()], ctx),
      collections: ctx.collections,
      meta,
    });
    expect(first.written).toBe(true);

    // 唯一变化：这条被标星并归档了。语义文本一个字没动。
    const second = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records: buildCorpusRecords(
        [mkRecord()],
        mkCtx({ annotationOf: () => ({ ...ANN, status: 'archived', starred: true, starredAt: '2026-02-02T00:00:00.000Z' }) })
      ),
      collections: ctx.collections,
      meta,
    });
    expect(second.written).toBe(true);
    // 文件里的状态确实更新了（这才是这条用例存在的理由）
    const rec = JSON.parse(fs.readFileSync(path.join(dir, CORPUS_FILE), 'utf8').trim());
    expect(rec).toMatchObject({ status: 'archived', starred: true });
    expect(second.manifest.counts).toMatchObject({ active: 0, archived: 1, starred: 1 });
    // 但内容 hash 与 contentDigest 都不变——外部 embedding 不该因为一次归档重算
    expect(second.manifest.contentDigest).toBe(first.manifest.contentDigest);
    // 用来判断"要不要重写"的是另一个 digest
    expect(second.manifest.digest).not.toBe(first.manifest.digest);
  });

  it('应用版本变了也重写 manifest（否则导出物会一直写着旧版本号）', async () => {
    const dir = tmpExportDir();
    const ctx = mkCtx();
    const records = buildCorpusRecords([mkRecord()], ctx);
    await exportCorpus({ dir, vaultRoot: '/vault', records, collections: ctx.collections, meta });
    const bumped = await exportCorpus({
      dir,
      vaultRoot: '/vault',
      records,
      collections: ctx.collections,
      meta: { ...meta, appVersion: '9.9.10' },
    });
    expect(bumped.written).toBe(true);
    expect(bumped.manifest.appVersion).toBe('9.9.10');
    expect(readCorpusManifest(dir)!.appVersion).toBe('9.9.10');
  });

  it('manifest 坏了或不存在时返回 null，不抛错（路由要能安全展示"还没导出过"）', () => {
    const dir = tmpExportDir();
    expect(readCorpusManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), '{ 这不是 JSON', 'utf8');
    expect(readCorpusManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ hello: 1 }), 'utf8');
    expect(readCorpusManifest(dir)).toBeNull();
  });

  it('空库也能导出（0 篇而不是崩）', async () => {
    const dir = tmpExportDir();
    const res = await exportCorpus({ dir, vaultRoot: '/vault', records: [], collections: [], meta });
    expect(res.manifest.counts.total).toBe(0);
    expect(fs.readFileSync(path.join(dir, CORPUS_FILE), 'utf8')).toBe('');
  });
});

describe('与 LibraryService 的接线', () => {
  function makeCfg(fx: Fixture, exportAfterRefresh: boolean): AppConfig {
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
      exportAfterRefresh,
      logDir: path.join(fx.root, 'logs'),
      isProduction: false,
      version: 'test',
    };
  }

  async function boot(fx: Fixture, exportAfterRefresh: boolean): Promise<LibraryService> {
    const svc = new LibraryService(makeCfg(fx, exportAfterRefresh));
    await svc.init();
    return svc;
  }

  async function waitForJob(svc: LibraryService, jobId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const job = svc.getRefreshJob(jobId);
      if (job && job.state !== 'running') {
        if (job.state !== 'completed') throw new Error(`刷新异常(${job.state}): ${job.diagnostics.join(' | ')}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('刷新任务超时');
  }

  it('刷新后自动导出，且把人工标注带进语料（标星 / 归档 / 备注）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一', postCreatedAt: '2026-06-01T10:00:00.000Z' });
    fx.writeNote({ id: 'id-0002', title: '笔记二', postCreatedAt: '2026-06-02T10:00:00.000Z' });
    const svc = await boot(fx, true);
    await waitForJob(svc, svc.startRefresh().jobId);

    // 标注一层：标星 + 备注 + 归档
    await svc.setStar('id-0001', true);
    // 备注与状态是"看一眼再改"的写：必须带当前 revision（此前少传了参数，类型检查这次才抓到）
    await svc.setRemark('id-0001', '这条以后做参考', svc.libraryInfo().annotationRevision);
    await svc.setStatus('id-0002', 'archived', svc.libraryInfo().annotationRevision);
    await svc.exportCorpus();

    const recs = fs
      .readFileSync(path.join(fx.exportDir, CORPUS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: string; starred: boolean; remark: string | null; status: string; text: string });
    const by = new Map(recs.map((r) => [r.id, r]));
    expect(by.get('id-0001')).toMatchObject({ starred: true, remark: '这条以后做参考', status: 'active' });
    expect(by.get('id-0002')).toMatchObject({ status: 'archived' });
    expect(by.get('id-0001')!.text).toContain('正文');

    const m = svc.corpusManifest();
    expect(m).not.toBeNull();
    expect(m!.counts).toMatchObject({ total: 2, active: 1, archived: 1, starred: 1 });
    expect(svc.corpusDir).toBe(fx.exportDir);
  });

  it('关掉 exportAfterRefresh 就不导出（开关真的起作用）', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const svc = await boot(fx, false);
    await waitForJob(svc, svc.startRefresh().jobId);
    expect(fs.existsSync(path.join(fx.exportDir, CORPUS_FILE))).toBe(false);
    expect(svc.corpusManifest()).toBeNull();
  });

  it('导出目录非法（落在内容源里）时刷新照样成功，只在诊断里记一笔', async () => {
    const fx = createFixture();
    fx.writeNote({ id: 'id-0001', title: '笔记一' });
    const cfg = makeCfg(fx, true);
    const svc = new LibraryService({ ...cfg, exportDir: path.join(fx.sourceRoot, 'export') });
    await svc.init();
    const job = svc.startRefresh();
    await waitForJob(svc, job.jobId);
    expect(svc.libraryInfo().total).toBe(1); // 索引没被拖垮
    const done = svc.getRefreshJob(job.jobId)!;
    expect(done.diagnostics.join('|')).toMatch(/语料导出失败/);
    expect(fs.existsSync(path.join(fx.sourceRoot, 'export'))).toBe(false);
  });
});
