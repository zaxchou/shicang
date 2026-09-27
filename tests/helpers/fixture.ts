// 测试夹具：在临时目录构造迷你 RedNote 源（Markdown + WebP），绝不触碰真实源。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 构造最小合法 WebP（VP8L），返回字节 */
export function tinyWebp(width = 3, height = 2): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f; // VP8L signature
  const bits = (width - 1) | ((height - 1) << 14);
  payload.writeUInt32LE(bits, 1);
  const chunk = Buffer.concat([Buffer.from('VP8L'), Buffer.from([payload.length, 0, 0, 0]), payload]);
  const riffSize = 4 + chunk.length;
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([riffSize & 0xff, 0, 0, 0]), Buffer.from('WEBP'), chunk]);
}

export interface FixtureNoteOptions {
  id: string;
  title?: string;
  author?: string;
  tags?: string[];
  postCreatedAt?: string | null;
  syncedAt?: string | null;
  body?: string;
  bom?: boolean;
  crlf?: boolean;
  images?: number; // 生成 image-N.webp
  videoUrl?: string;
  extraFm?: string;
  fileName?: string;
  badYaml?: boolean;
}

export function noteMarkdown(o: FixtureNoteOptions): string {
  if (o.badYaml) {
    return `---\nresourceId: "${o.id}"\nauthor: [未闭合\n  bad: ::\n`;
  }
  const fm: string[] = [];
  fm.push(`resourceId: "${o.id}"`);
  fm.push(`type: "收藏"`);
  fm.push(`author: "${o.author ?? '测试作者'}"`);
  fm.push(`url: "https://www.xiaohongshu.com/explore/${o.id}"`);
  if (o.postCreatedAt !== null) fm.push(`postCreatedAt: ${o.postCreatedAt ?? '2026-06-01T10:00:00.000Z'}`);
  if (o.syncedAt !== null) fm.push(`syncedAt: ${o.syncedAt ?? '2026-09-01T08:00:00.000Z'}`);
  if (o.extraFm) fm.push(o.extraFm);
  if (o.tags && o.tags.length) {
    fm.push('tags:');
    for (const t of o.tags) fm.push(`  - "${t}"`);
  }
  let body = o.body ?? `# ${o.title ?? '默认标题'}\n\n正文内容 测试${o.id.slice(0, 4)}\n`;
  for (let i = 1; i <= (o.images ?? 1); i++) {
    body += `\n![[RedNote/Media/${o.id}/image-${i}.webp]]\n`;
  }
  if (o.videoUrl) body += `\n<video controls src="${o.videoUrl}"></video>\n`;
  let raw = `---\n${fm.join('\n')}\n---\n\n${body}`;
  if (o.crlf) raw = raw.replace(/\n/g, '\r\n');
  if (o.bom) raw = '\uFEFF' + raw;
  return raw;
}

export interface Fixture {
  root: string;
  sourceRoot: string;
  dataDir: string;
  backupDir: string;
  writeNote(o: FixtureNoteOptions): void;
  writeMedia(id: string, name: string, bytes: Buffer): void;
  removeNote(id: string): void;
}

export function createFixture(prefix = 'myinfobase-test'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const sourceRoot = path.join(root, 'RedNote');
  fs.mkdirSync(path.join(sourceRoot, 'Bookmarks'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'Media'), { recursive: true });
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  return {
    root,
    sourceRoot,
    dataDir,
    backupDir,
    writeNote(o) {
      const name = o.fileName ?? `${o.title ?? 'note'}-${o.id}.md`;
      fs.writeFileSync(path.join(sourceRoot, 'Bookmarks', name), noteMarkdown(o), 'utf8');
      for (let i = 1; i <= (o.images ?? 1); i++) {
        this.writeMedia(o.id, `image-${i}.webp`, tinyWebp(3 + i, 2 + i));
      }
    },
    writeMedia(id, name, bytes) {
      const dir = path.join(sourceRoot, 'Media', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), bytes);
    },
    removeNote(id) {
      const dir = path.join(sourceRoot, 'Bookmarks');
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(`-${id}.md`)) fs.rmSync(path.join(dir, f));
      }
    },
  };
}
