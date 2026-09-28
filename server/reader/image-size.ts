// 文件头识别（不依赖扩展名）：位图尺寸 + 图片 MIME。
// 为什么看文件头而不是扩展名：藏品库里有名为 `640` 的无扩展名图片（共 37 个），
// 按扩展名判断会把它们当成未知类型；而 .jpg/.png 封面曾因只解析 WebP 拿不到尺寸，
// 被强行按 4:3 裁切（2026-09-28 统计：938 张封面里 285 张没有尺寸）。
import fs from 'node:fs';

export interface ImageSize {
  width: number;
  height: number;
}

/** 一次读取的文件头字节数：足以覆盖 WebP / PNG / GIF 的尺寸字段 */
const HEADER_BYTES = 64;

/**
 * 从文件头读取位图尺寸；不支持的格式（SVG、AVIF 等）返回 null，调用方按 4:3 占位。
 * 已支持：WebP（VP8 / VP8L / VP8X）、PNG、GIF、JPEG。
 */
export function imageSize(filePath: string): ImageSize | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (n < 10) return null;
    return webpSize(head, n) ?? pngSize(head, n) ?? gifSize(head, n) ?? jpegSize(fd, head, n);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 按文件头判断图片 MIME；不是图片返回 null。
 * 媒体路由用它给「无扩展名 / 未知扩展名」的文件定 Content-Type，
 * 解析器用它判断未知类型的文件能不能当封面。
 */
export function sniffImageMime(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    return sniffHead(head, n);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function sniffHead(buf: Buffer, n: number): string | null {
  if (n < 12) return null;
  const ascii = buf.toString('latin1', 0, Math.min(n, 16));
  if (ascii.startsWith('\u0089PNG\r\n\u001a\n')) return 'image/png';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('RIFF')) {
    const four = buf.toString('ascii', 8, 12);
    if (four === 'WEBP') return 'image/webp';
    if (four === 'WAVE') return 'audio/wav';
  }
  if (ascii.startsWith('BM')) return 'image/bmp';
  // ISO-BMFF（HEIC/AVIF）：第 4..8 字节固定为 'ftyp'
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) {
      return 'image/heic';
    }
  }
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('ID3')) return 'audio/mpeg';
  // 文本型（SVG 通常是 <svg / <?xml）：只在文件头就是纯文本标记时判定
  const text = buf.toString('utf8', 0, Math.min(n, 64)).trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('svg'))) return 'image/svg+xml';
  return null;
}

// ---------------- 各格式解析（只读文件头，不做整文件读取） ----------------

function webpSize(buf: Buffer, n: number): ImageSize | null {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // 'VP8 ' + size(4) + frame tag(3) + sync(3: 0x9d 0x01 0x2a) + w(2) + h(2)
    if (n < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    if (n < 25) return null;
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    const width = (b & 0x3fff) + 1;
    const height = ((b >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === 'VP8X') {
    if (n < 30) return null;
    const width = buf.readUIntLE(24, 3) + 1;
    const height = buf.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  return null;
}

function pngSize(buf: Buffer, n: number): ImageSize | null {
  if (n < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifSize(buf: Buffer, n: number): ImageSize | null {
  if (n < 10) return null;
  const magic = buf.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG：按段链表逐段跳过（EXIF 段动辄几十 KB，不能靠"多读一点"解决），
 * 命中 SOF0/1/2… 后取高宽。只做几次小读，不读整图。
 */
function jpegSize(fd: number, head: Buffer, n: number): ImageSize | null {
  if (n < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  const marker = Buffer.alloc(4);
  let pos = 2;
  for (let guard = 0; guard < 64; guard++) {
    if (fs.readSync(fd, marker, 0, 4, pos) < 4) return null;
    if (marker[0] !== 0xff) return null;
    const code = marker[1] as number;
    if (code === 0xff) {
      pos += 1; // 填充字节
      continue;
    }
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      pos += 2; // 无载荷的独立标记
      continue;
    }
    const len = marker.readUInt16BE(2);
    if (len < 2) return null;
    const isSof = code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
    if (isSof) {
      const sof = Buffer.alloc(5);
      if (fs.readSync(fd, sof, 0, 5, pos + 4) < 5) return null;
      const height = sof.readUInt16BE(1);
      const width = sof.readUInt16BE(3);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (code === 0xda || code === 0xd9) return null; // 进入压缩数据，后面不会再有 SOF
    pos += 2 + len;
  }
  return null;
}
