// 从图片文件头读取宽高（当前数据全部为 WebP；其他格式返回 null 用 4:3 占位）。
import fs from 'node:fs';

export function imageSize(path: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.alloc(42);
    const f = fs.openSync(path, 'r');
    try {
      const n = fs.readSync(f, buf, 0, 42, 0);
      return parseHeader(buf, n);
    } finally {
      fs.closeSync(f);
    }
  } catch {
    return null;
  }
}

function parseHeader(buf: Buffer, n: number): { width: number; height: number } | null {
  if (n < 21) return null;
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
