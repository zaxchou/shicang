// 把 PNG 降采样成字符视图：用于在无法可靠"看图"的环境里做客观视觉检查。
// 用法：node scripts/pngview.cjs <png> [cols] [rows]
const fs = require('fs');
const zlib = require('zlib');

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels * (depth / 8), stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, stride, out };
}

const ramp = ' .:-=+*#%@';
const file = process.argv[2];
const cols = Number(process.argv[3] || 96);
const rows = Number(process.argv[4] || 34);
const img = decode(file);
const cw = img.w / cols, ch = img.h / rows;
let lum = [];
let colorGrid = [];
for (let ry = 0; ry < rows; ry++) {
  let lrow = '', crow = [];
  for (let rx = 0; rx < cols; rx++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor(rx * cw), x1 = Math.min(img.w, Math.floor((rx + 1) * cw));
    const y0 = Math.floor(ry * ch), y1 = Math.min(img.h, Math.floor((ry + 1) * ch));
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 6));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = y * img.stride + x * img.bpp;
      r += img.out[i]; g += img.out[i + 1]; b += img.out[i + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lrow += ramp[Math.min(9, Math.floor(L * 10))];
    crow.push([r, g, b]);
  }
  lum.push(lrow); colorGrid.push(crow);
}
console.log(`# ${file}  ${img.w}x${img.h}  → ${cols}x${rows} 字符视图（亮度：' '暗 → '@' 亮）`);
lum.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l + '|'));
console.log('\n# 关键格平均色（行,列 → 十六进制）');
const probe = process.argv.slice(5).map((s) => s.split(',').map(Number));
for (const [ry, rx] of probe) {
  const [r, g, b] = colorGrid[ry][rx];
  const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  console.log(`  r${ry} c${rx}  ${hex}  rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`);
}
