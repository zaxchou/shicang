// 测试夹具：在临时目录构造迷你 RedNote 源（Markdown + WebP），绝不触碰真实源。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 构造最小合法 PNG（8 位 RGBA，1x1 像素，含正确 CRC） */
export function tinyPng(width = 4, height = 3): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** 构造最小合法 GIF89a（尺寸写在逻辑屏幕描述符里） */
export function tinyGif(width = 7, height = 5): Buffer {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0; // 无全局色表
  return Buffer.concat([head, Buffer.from([0x3b])]); // trailer
}

/**
 * 构造最小 JPEG 标记序列：SOI + APP0(JFIF) + SOF0 + EOI。
 * 尺寸解析只走段链表，不需要可解码的压缩数据——注意它不能当真实图片渲染。
 * exifExtra > 0 时在 SOF 之前插入一个超长 APP1 段，验证解析器真的在按段长跳段
 * （而不是"一次多读几百字节"）。
 */
export function tinyJpeg(width = 640, height = 480, exifExtra = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.alloc(16);
  app0.writeUInt16BE(16, 0);
  app0.write('JFIF\0', 2, 'ascii');
  parts.push(Buffer.from([0xff, 0xe0]), app0);
  if (exifExtra > 0) {
    const app1 = Buffer.alloc(4 + exifExtra);
    app1.writeUInt16BE(4 + exifExtra, 0);
    app1.write('Exif\0\0', 2, 'latin1');
    parts.push(Buffer.from([0xff, 0xe1]), app1);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(11, 0); // 段长
  sof[2] = 8; // 精度
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3; // 分量数
  parts.push(Buffer.from([0xff, 0xc0]), sof);
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** 构造"扩展名像图片、内容其实是错误响应"的文件（实测藏品库里出现过 3 个） */
export function fakeImageBody(): Buffer {
  return Buffer.from('{"code":500,"msg":"服务器异常，请稍后重试"}', 'utf8');
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
