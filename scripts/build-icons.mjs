// 从一张源图生成全套应用图标（public/icon-1024.png、apple-touch-icon.png、icon-32.png、icon-96.png）。
//
// 支持两种源图：
//   A. 白底 RGB（旧稿，颜色类型 2）：靠"彩度/暗度"猜形状，边界带按离白多远换算 alpha；
//   B. **带真透明的 RGBA（现用，颜色类型 6）**：alpha 通道就是形状，直接透传（含边缘抗锯齿），
//      不再猜颜色——淡奶油底色这类"低彩度形状"在 A 的判据下会被误判成背景。
//
// 用法：node scripts/build-icons.mjs <源图.png>
//
// 为什么要这个脚本：图标源是"白底 + 圆角方块"的位图（RGB，无 alpha）。
//   - iOS / apple-touch-icon 需要**不透明、满幅**的图（系统自己套圆角遮罩），
//     所以裁剪到形状包围盒即可，不能留白边、也不能自己挖透明角；
//   - favicon 与侧栏品牌位（深色玻璃面板上，28px）需要**角部透明**，否则会糊一块白/绿方块；
//     所以按每行的非白区间反推形状，把形状外的像素设为透明，边界用"离白多远"换算 alpha 做抗锯齿。
// 缩放用面积平均（盒式滤波）并在预乘 alpha 空间里做，避免透明边缘出现白边/暗边。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
/** 判定"这是背景白"的阈值（源图背景实测 #fdfdff~#fefefe） */
const WHITE_MIN = 248;
/** 各目标尺寸：不透明版给系统图标用，透明圆角版给 favicon 与侧栏用 */
const TARGETS = [
  { name: 'icon-1024.png', size: 1024, alpha: false },
  { name: 'apple-touch-icon.png', size: 180, alpha: false },
  { name: 'icon-96.png', size: 96, alpha: true },
  { name: 'icon-32.png', size: 32, alpha: true },
];

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`只支持 8 位 PNG（当前 ${depth}）`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  if (color !== 2 && color !== 6) {
    throw new Error(`源图需为 RGB(2) 或 RGBA(6)，当前 ${color}（调色板/灰阶请先另存为 PNG-24/32）`);
  }
  const bpp = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, stride, ch: bpp, data: out };
}

/**
 * 逐行找形状的非白区间（圆角方块每行都是一个连续区间）
 * 用"彩度/暗度"判形状，而不是"非白"：源图带一层很淡的中性投影，
 * 按非白判会把阴影视作形状（左侧就会取到阴影的浅灰像素，补角补出一圈白）。
 */
function shapeBounds(img) {
  const rows = [];
  const mask = new Uint8Array(img.w * img.h);
  let minX = img.w;
  let maxX = -1;
  let minY = img.h;
  let maxY = -1;
  let shadowMinX = img.w;
  let shadowMinY = img.h;
  let shadowMaxX = -1;
  let shadowMaxY = -1;
  for (let y = 0; y < img.h; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < img.w; x++) {
      const i = y * img.stride + x * img.ch;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      // 带 alpha 的源图：alpha >= 16 即形状（淡色形状也能认出来）；否则用彩度/暗度猜
      const inside = img.ch === 4 ? img.data[i + 3] >= 16 : chroma > 30 || Math.min(r, g, b) < 200;
      if (inside) mask[y * img.w + x] = 1;
      if (chroma > 6 || Math.min(r, g, b) < WHITE_MIN) {
        // 阴影/内容（比形状宽一圈）
        shadowMinX = Math.min(shadowMinX, x);
        shadowMaxX = Math.max(shadowMaxX, x);
        shadowMinY = Math.min(shadowMinY, y);
        shadowMaxY = Math.max(shadowMaxY, y);
      }
      if (inside) {
        if (left < 0) left = x;
        right = x;
      }
    }
    rows.push({ left, right });
    if (left >= 0) {
      minX = Math.min(minX, left);
      maxX = Math.max(maxX, right);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { rows, mask, minX, maxX, minY, maxY, shadow: { minX: shadowMinX, maxX: shadowMaxX, minY: shadowMinY, maxY: shadowMaxY } };
}

/**
 * 裁剪到形状包围盒。
 * - 透明版：形状外 alpha=0，边界带按"离白多远"换算覆盖度做抗锯齿（给 favicon / 侧栏用）
 * - 不透明版：形状外补满颜色（给 iOS / apple-touch-icon 用，系统自己套圆角遮罩，
 *   留白边或白角都会露出来）。补色取**竖直方向最近的形状内颜色**并内缩 3px：
 *   同行边界色在顶部/底部是抗锯齿的浅色细边，直接用会补出一圈白。
 * 注意：行边界是源图坐标，必须先转到裁剪坐标系再比较（否则左右各错切一大条）。
 */
function extract(img, bounds, { alpha }) {
  const { rows, mask, minX, maxX, minY, maxY } = bounds;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const lefts = new Int32Array(h);
  const rights = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    lefts[y] = rows[minY + y].left - minX;
    rights[y] = rows[minY + y].right - minX;
  }
  const topRow = new Int32Array(w).fill(-1);
  const botRow = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = lefts[y]; x <= rights[y]; x++) {
      if (x < 0 || x >= w) continue;
      if (topRow[x] < 0) topRow[x] = y;
      botRow[x] = y;
    }
  }
  // 四个角的圆弧半径估计：第一行/最后一行的形状起止位置就是弧的水平半径
  const rTL = lefts[0];
  const rTR = w - 1 - rights[0];
  const rBL = lefts[h - 1];
  const rBR = w - 1 - rights[h - 1];
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (minY + y) * img.stride + (minX + x) * img.ch;
      const di = (y * w + x) * 4;
      if (img.ch === 4) {
        const a4 = img.data[si + 3];
        if (alpha) {
          // 透明版（favicon / 侧栏）：源稿自带抗锯齿，RGB + alpha 原样透传。
          // 唯一例外：AI 出图的源稿内部 alpha 常见 252/253 而不是 255（实测 99% 像素如此），
          // 原样透传会让图标在深色玻璃面板上整体蒙一层约 1% 的灰——>=250 一律拉满，
          // 真正的边缘过渡（<250）保持不动
          out[di] = img.data[si];
          out[di + 1] = img.data[si + 1];
          out[di + 2] = img.data[si + 2];
          out[di + 3] = a4 >= 250 ? 255 : a4;
          continue;
        }
        if (a4 >= 128) {
          // 不透明版（iOS）：实心像素拷贝，alpha 拉满
          out[di] = img.data[si];
          out[di + 1] = img.data[si + 1];
          out[di + 2] = img.data[si + 2];
          out[di + 3] = 255;
          continue;
        }
        // 半透明/透明（边缘过渡与外侧微光）：落到下面的补色逻辑——iOS 的圆角遮罩下不能露透明
      }
      // 白底源图："是否属于图标内容"用行区间判定（中间的白色书签同样是内容）；
      // 补色射线的参考像素才要求彩色（见下），两个判据不能混
      const inside = x >= lefts[y] && x <= rights[y];
      if (inside && img.ch === 3) {
        out[di] = img.data[si];
        out[di + 1] = img.data[si + 1];
        out[di + 2] = img.data[si + 2];
        out[di + 3] = 255;
        continue;
      }
      if (!alpha) {
        // 形状外补色：沿"指向该角圆心的方向"找到第一个形状内像素，用它上色。
        // 等价于把边缘颜色沿径向外推：角弧上每个角度的渐变都被自然延续，
        // 不会像"同行取色"那样把顶边的浅色高光带铺满整个角。
        const cx = x < w >> 1 ? rTL : w - 1 - rTR;
        const cy = y < h >> 1 ? rTL : h - 1 - rBL;
        const dx = cx - x;
        const dy = cy - y;
        const len = Math.max(1, Math.hypot(dx, dy));
        let refX = x;
        let refY = y;
        for (let d = 1; d <= 420; d++) {
          const sx = Math.round(x + (dx / len) * d);
          const sy = Math.round(y + (dy / len) * d);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) break;
          // 必须命中**彩色**像素（绿色边框）：只按"落在该行的形状区间"判定会打到
          // 中间那块白色书签上，补角就补成白的
          if (mask[(minY + sy) * img.w + (minX + sx)] === 1) {
            refX = sx;
            refY = sy;
            break;
          }
        }
        const ri = (minY + refY) * img.stride + (minX + refX) * img.ch;
        out[di] = img.data[ri];
        out[di + 1] = img.data[ri + 1];
        out[di + 2] = img.data[ri + 2];
        out[di + 3] = 255;
        continue;
      }
      // 透明版：只保留边界带 ±1px，用"离白多远"换算覆盖度
      if (x < lefts[y] - 1 || x > rights[y] + 1) {
        out[di + 3] = 0;
        continue;
      }
      const refX = x <= lefts[y] ? Math.min(w - 1, lefts[y] + 3) : Math.max(0, rights[y] - 3);
      const refI = (minY + y) * img.stride + (minX + refX) * img.ch;
      const refMin = Math.min(img.data[refI], img.data[refI + 1], img.data[refI + 2]);
      const selfMin = Math.min(img.data[si], img.data[si + 1], img.data[si + 2]);
      const denom = 255 - Math.min(refMin, 254);
      const cov = denom <= 0 ? 1 : Math.max(0, Math.min(1, (255 - selfMin) / denom));
      out[di] = img.data[refI];
      out[di + 1] = img.data[refI + 1];
      out[di + 2] = img.data[refI + 2];
      out[di + 3] = Math.round(cov * 255);
    }
  }
  return { w, h, data: out };
}

/** 盒式（面积平均）缩放，在预乘 alpha 空间累加，避免透明边缘发白/发黑 */
function resize(src, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = src.w / dw;
  const sy = src.h / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * sy;
    const y1 = Math.min(src.h, (dy + 1) * sy);
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * sx;
      const x1 = Math.min(src.w, (dx + 1) * sx);
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          const wgt = wx * wy;
          if (wgt <= 0) continue;
          const i = (y * src.w + x) * 4;
          const a = src.data[i + 3] / 255;
          ar += src.data[i] * a * wgt;
          ag += src.data[i + 1] * a * wgt;
          ab += src.data[i + 2] * a * wgt;
          aa += a * wgt;
          area += wgt;
        }
      }
      const di = (dy * dw + dx) * 4;
      const a = area > 0 ? aa / area : 0;
      out[di] = aa > 0 ? Math.round(ar / aa) : 0;
      out[di + 1] = aa > 0 ? Math.round(ag / aa) : 0;
      out[di + 2] = aa > 0 ? Math.round(ab / aa) : 0;
      out[di + 3] = Math.round(a * 255);
    }
  }
  return { w: dw, h: dh, data: out };
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

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ w, h, data }, withAlpha) {
  const channels = withAlpha ? 4 : 3;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // 过滤类型 0
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = y * (stride + 1) + 1 + x * channels;
      raw[di] = data[si];
      raw[di + 1] = data[si + 1];
      raw[di + 2] = data[si + 2];
      if (withAlpha) raw[di + 3] = data[si + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = withAlpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sample(png, x, y) {
  const i = (y * png.w + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

const srcFile = process.argv[2];
if (!srcFile) {
  console.error('用法：node scripts/build-icons.mjs <源图.png>');
  process.exit(2);
}
const img = decodePng(srcFile);
const bounds = shapeBounds(img);
if (bounds.maxX < 0) throw new Error('源图里没找到非白内容');
const shapeW = bounds.maxX - bounds.minX + 1;
const shapeH = bounds.maxY - bounds.minY + 1;
const sd = bounds.shadow;
console.log(
  `源图 ${img.w}x${img.h}｜形状 ${shapeW}x${shapeH} @ (${bounds.minX},${bounds.minY})｜` +
    `含投影范围 x ${sd.minX}..${sd.maxX} y ${sd.minY}..${sd.maxY}（裁剪只取形状，不含投影）`
);

for (const target of TARGETS) {
  const cropped = extract(img, bounds, { alpha: target.alpha });
  const scaled = resize(cropped, target.size, target.size);
  const png = encodePng(scaled, target.alpha);
  fs.writeFileSync(path.join(OUT_DIR, target.name), png);
  const c = sample(scaled, 1, 1);
  const mid = sample(scaled, target.size >> 1, Math.round(target.size * 0.18));
  const center = sample(scaled, target.size >> 1, target.size >> 1);
  const hx = (p) => '#' + p.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  console.log(
    `  ${target.name.padEnd(22)} ${target.size}x${target.size} ` +
      `${target.alpha ? 'RGBA' : 'RGB '} ${(png.length / 1024).toFixed(1)}KB` +
      `｜角 ${hx(c)} alpha=${c[3]}` +
      `｜上部 ${hx(mid)}｜中心 ${hx(center)}`
  );
}
console.log(`已写入 ${OUT_DIR}`);
