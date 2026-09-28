import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseNote } from '../server/reader/parse';
import type { CollectionDef } from '../shared/types';
import { createFixture, tinyWebp, type FixtureNoteOptions } from './helpers/fixture';

const RN: CollectionDef = { id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' };

function parse(o: FixtureNoteOptions) {
  const fx = createFixture();
  fx.writeNote(o);
  const file = fs.readdirSync(path.join(fx.sourceRoot, 'Bookmarks'))[0];
  const abs = path.join(fx.sourceRoot, 'Bookmarks', file);
  return parseNote({
    vaultRoot: fx.sourceRoot,
    collection: RN,
    absolutePath: abs,
    relativePath: file,
    sourceRelativePath: `RedNote/Bookmarks/${file}`,
    mtimeMs: 1,
    size: 1,
  });
}

describe('parseNote 基础解析', () => {
  it('解析标题、作者、tags、日期与媒体', () => {
    const out = parse({ id: 'aaaa0001', title: '测试标题', author: '作者甲', tags: ['tag1', 'tag2'], images: 2 });
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.id).toBe('aaaa0001');
    expect(r.title).toBe('测试标题');
    expect(r.author).toBe('作者甲');
    expect(r.tags).toEqual(['tag1', 'tag2']);
    expect(r.publishedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(r.media).toHaveLength(2);
    expect(r.media[0]!.kind).toBe('image');
    expect(r.coverMediaId).toBe('image-1.webp');
    expect(r.media[0]!.width).toBe(4); // tinyWebp(3+1, 2+1)
    expect(r.media[0]!.height).toBe(3);
    // HTML 中的媒体指向媒体 API
    expect(r.bodyHtml).toContain('/api/media/aaaa0001/image-1.webp');
    // 正文首个 H1 不重复渲染
    expect(r.bodyHtml).not.toContain('<h1>测试标题</h1>');
  });

  it('BOM 与 CRLF 正常处理', () => {
    const out = parse({ id: 'aaaa0002', bom: true, crlf: true, title: 'BOM标题' });
    expect(out.error).toBeNull();
    expect(out.record!.title).toBe('BOM标题');
  });

  it('缺少日期字段记录 null 且不影响入库', () => {
    const out = parse({ id: 'aaaa0003', postCreatedAt: null, syncedAt: null });
    expect(out.record!.publishedAt).toBeNull();
    expect(out.record!.syncedAt).toBeNull();
  });

  it('缺少 resourceId 报错跳过，不用文件名充当 ID', () => {
    const fx = createFixture();
    fs.writeFileSync(
      path.join(fx.sourceRoot, 'Bookmarks', 'no-id-note.md'),
      '---\nauthor: "x"\n---\n# 无ID\n正文',
      'utf8'
    );
    const out = parseNote({
      absolutePath: path.join(fx.sourceRoot, 'Bookmarks', 'no-id-note.md'),
      relativePath: 'no-id-note.md',
      vaultRoot: fx.sourceRoot,
      collection: RN,
      sourceRelativePath: 'RedNote/Bookmarks/no-id-note.md',
      mtimeMs: 0,
      size: 0,
    });
    expect(out.record).toBeNull();
    expect(out.error).toContain('resourceId');
  });

  it('坏 YAML 报错不抛异常', () => {
    const out = parse({ id: 'aaaa0004', badYaml: true });
    expect(out.record).toBeNull();
    expect(out.error).toBeTruthy();
  });

  it('H1 缺失时回退文件名（去除资源 ID 尾巴）', () => {
    const out = parse({ id: 'aaaa0005', body: '没有H1的正文\n' });
    expect(out.record!.title).toBe('note'); // fileName = note-<id>.md
    expect(out.record!.warnings.some((w) => w.includes('H1'))).toBe(true);
  });
});

describe('媒体路径安全', () => {
  it('vault 前缀映射到源内 Media 目录', () => {
    const out = parse({ id: 'bbbb0001', images: 1 });
    expect(out.record!.media[0]!.localRelativePath).toBe('Media/bbbb0001/image-1.webp');
    expect(out.record!.media[0]!.available).toBe(true);
  });

  it('媒体文件缺失 → available=false 且警告，不崩溃', () => {
    const fx = createFixture();
    // 不写 image-1.webp，只写笔记
    fs.writeFileSync(
      path.join(fx.sourceRoot, 'Bookmarks', `missing-media-${'bbbb0002'}.md`),
      '---\nresourceId: "bbbb0002"\nauthor: "x"\npostCreatedAt: 2026-06-01T10:00:00.000Z\n---\n\n![[RedNote/Media/bbbb0002/image-1.webp]]\n',
      'utf8'
    );
    const out = parseNote({
      absolutePath: path.join(fx.sourceRoot, 'Bookmarks', `missing-media-${'bbbb0002'}.md`),
      relativePath: `missing-media-bbbb0002.md`,
      vaultRoot: fx.sourceRoot,
      collection: RN,
      sourceRelativePath: 'RedNote/Bookmarks/missing-media-bbbb0002.md',
      mtimeMs: 0,
      size: 0,
    });
    expect(out.record!.media[0]!.available).toBe(false);
    expect(out.warnings.join()).toContain('缺失');
  });

  it('源外嵌入与目录穿越被拒绝', () => {
    const fx = createFixture();
    const dir = path.join(fx.sourceRoot, 'Bookmarks');
    fs.writeFileSync(
      path.join(dir, 'trav-1.md'),
      '---\nresourceId: "cccc0001"\nauthor: "x"\npostCreatedAt: 2026-06-01T10:00:00.000Z\n---\n\n![[../../../outside/secret.webp]]\n',
      'utf8'
    );
    const out = parseNote({
      absolutePath: path.join(dir, 'trav-1.md'),
      relativePath: 'trav-1.md',
      vaultRoot: fx.sourceRoot,
      collection: RN,
      sourceRelativePath: 'RedNote/Bookmarks/trav-1.md',
      mtimeMs: 0,
      size: 0,
    });
    expect(out.record!.media).toHaveLength(0);
    expect(out.warnings.join()).toContain('缺失或不支持');
  });

  it('中文与空格文件名的嵌入可解析', () => {
    const fx = createFixture();
    fx.writeMedia('dddd0001', '中文 图.webp', tinyWebp(5, 5));
    const dir = path.join(fx.sourceRoot, 'Bookmarks');
    fs.writeFileSync(
      path.join(dir, 'cn-1.md'),
      '---\nresourceId: "dddd0001"\nauthor: "x"\npostCreatedAt: 2026-06-01T10:00:00.000Z\n---\n\n![[RedNote/Media/dddd0001/中文 图.webp]]\n',
      'utf8'
    );
    const out = parseNote({
      absolutePath: path.join(dir, 'cn-1.md'),
      relativePath: 'cn-1.md',
      vaultRoot: fx.sourceRoot,
      collection: RN,
      sourceRelativePath: 'RedNote/Bookmarks/cn-1.md',
      mtimeMs: 0,
      size: 0,
    });
    expect(out.record!.media).toHaveLength(1);
    expect(out.record!.media[0]!.width).toBe(5);
    // 关键：必须真的渲染出 <img>；此前只断言「登记成功」，
    // 漏掉了链接在空格处被截断、图片其实没显示的问题
    expect(out.record!.bodyHtml).toContain('<img');
    expect(out.record!.bodyHtml).not.toContain('media://');
    expect(out.record!.bodyHtml).not.toContain('中文 图');
  });

  it('远程视频进入媒体清单并保留在 HTML 中', () => {
    const out = parse({ id: 'eeee0001', videoUrl: 'http://sns-bak-v1.xhscdn.com/v.mp4' });
    const v = out.record!.media.find((m) => m.kind === 'video');
    expect(v?.remoteUrl).toBe('http://sns-bak-v1.xhscdn.com/v.mp4');
    expect(out.record!.bodyHtml).toContain('<video');
    expect(out.record!.bodyHtml).toContain('controls');
  });

  it('javascript: 与 script 标签被消毒', () => {
    const fx = createFixture();
    const dir = path.join(fx.sourceRoot, 'Bookmarks');
    fs.writeFileSync(
      path.join(dir, 'xss-1.md'),
      '---\nresourceId: "ffff0001"\nauthor: "x"\npostCreatedAt: 2026-06-01T10:00:00.000Z\n---\n\n# XSS测试\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(2))\n',
      'utf8'
    );
    const out = parseNote({
      absolutePath: path.join(dir, 'xss-1.md'),
      relativePath: 'xss-1.md',
      vaultRoot: fx.sourceRoot,
      collection: RN,
      sourceRelativePath: 'RedNote/Bookmarks/xss-1.md',
      mtimeMs: 0,
      size: 0,
    });
    expect(out.record!.bodyHtml).not.toContain('<script');
    expect(out.record!.bodyHtml).not.toContain('javascript:');
  });
});

describe('flomo 式 vault 相对附件链接（flomo/attachments/…）', () => {
  it('普通链接也会登记媒体并改写成媒体路由（114 处语音就是这个形态）', () => {
    // 真实 flomo 导出写的是 `[音频: x](flomo/attachments/<日期>/<hash>.m4a)`——
    // 旧正则只认裸 `attachments/`，语音从未被登记，ASR 没有目标（做转录时发现）。
    // 走 diary 分支（parseDiary），与生产里 flomo 笔记同一条路径。
    const fx = createFixture();
    const DIA: CollectionDef = { id: 'diary', name: '日记', root: 'flomo', type: 'diary' };
    const dir = path.join(fx.sourceRoot, 'flomo', 'attachments', '2026', '05', '31');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'voice.m4a'), Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50]));
    const noteName = '2026-05-31_但是刷完之后_MjM5NjAwODMw.md';
    fs.writeFileSync(
      path.join(fx.sourceRoot, 'flomo', noteName),
      '---\ncreated_at: "2026-05-31 23:55:52"\nupdated_at: "2026-05-31 23:56:37"\ntags: []\n---\n\n但是刷完之后，它会自动地把我刷掉。\n\n**附件:**\n[音频: 17802429536800161E9D8D549F3E0](flomo/attachments/2026/05/31/voice.m4a)\n',
      'utf8'
    );
    const abs = path.join(fx.sourceRoot, 'flomo', noteName);
    const out = parseNote({
      absolutePath: abs,
      relativePath: `flomo/${noteName}`,
      vaultRoot: fx.sourceRoot,
      collection: DIA,
      sourceRelativePath: `flomo/${noteName}`,
      mtimeMs: 1,
      size: 1,
    });
    expect(out.error).toBeNull();
    const r = out.record!;
    expect(r.collection).toBe('diary');
    expect(r.media).toHaveLength(1);
    expect(r.media[0]).toMatchObject({
      kind: 'audio',
      id: 'voice.m4a',
      available: true,
      localRelativePath: 'flomo/attachments/2026/05/31/voice.m4a',
    });
    // 链接被改写成媒体路由（详情里能直接打开播放，而不是指向一个网页相对路径）
    expect(r.bodyHtml).toContain('/api/media/');
    expect(r.bodyHtml).toContain('voice.m4a');
  });
});
