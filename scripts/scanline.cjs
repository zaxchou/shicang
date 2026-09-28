/**
 * 明度扫描线：验证"柔和光影"是否真的做出来了（阴影是渐变的，只能沿一条线看）。
 *
 * 用法：node scripts/scanline.cjs <png> <y> <x0> <x1> [step] [探针x...]
 *
 * 合格的面板间隙应该看到「面板内部 → 更暗的阴影带 → 1px 玻璃亮边 → 面板内部」；
 * 浮起元素是「面板 → 投影微暗 → 元素面更亮」，凹陷元素是「面板 → 框内明显更暗」。
 */
const fs = require('fs'); const zlib = require('zlib');
function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  // 只解 8 位、非隔行的灰度/RGB/RGBA：解不出来的必须报错，否则亮度数字是假的
  if (depth !== 8) throw new Error(`不支持的位深 depth=${depth}（仅 8 位）`);
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  if (color === 3) throw new Error('不支持调色板 PNG（color type 3）');
  // 通道数按 color type 定：写死 4/3 会把灰度 PNG 解成乱码（每像素多读 2 字节）
  const bpp = color === 6 ? 4 : color === 2 ? 3 : color === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++]; const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, stride, out };
}
const img = decode(process.argv[2]);
const y = Number(process.argv[3]);
const x0 = Number(process.argv[4] || 0), x1 = Number(process.argv[5] || img.w), step = Number(process.argv[6] || 1);
const L = (x) => { const i = y * img.stride + x * img.bpp; return Math.round(0.2126 * img.out[i] + 0.7152 * img.out[i + 1] + 0.0722 * img.out[i + 2]); };
let line = '';
const vals = [];
for (let x = x0; x < x1; x++) { const v = L(x); vals.push(v); }
const max = Math.max(...vals), min = Math.min(...vals);
console.log(`y=${y} x=${x0}..${x1}  min=${min} max=${max}`);
const ramp = ' .:-=+*#%@';
for (let x = x0; x < x1; x += step) {
  const v = L(x);
  const t = max === min ? 0.5 : (v - min) / (max - min);
  line += ramp[Math.min(9, Math.floor(t * 10))];
}
console.log('x' + x0 + ' |' + line + '|');
const at = (x) => console.log(`  x=${x} L=${L(x)}`);
process.argv.slice(7).map(Number).forEach(at);
