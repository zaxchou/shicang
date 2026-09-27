// 只读边界验证：对内容源（Markdown + 媒体）生成哈希清单，开发前后对比。
// 用法：node scripts/source-hash.mjs [--check .local/source-hash.json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = 'Z:/BaiduNetdiskWorkspace/mynote/mynote/RedNote';
const OUT = '.local/source-hash.json';

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, rel, out);
    else if (ent.isFile()) {
      const buf = fs.readFileSync(abs);
      out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
    }
  }
}

const manifest = {};
walk(path.join(SRC, 'Bookmarks'), 'Bookmarks', manifest);
walk(path.join(SRC, 'Media'), 'Media', manifest);

if (process.argv.includes('--check')) {
  const prev = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--check') + 1] ?? OUT, 'utf8'));
  const added = Object.keys(manifest).filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in manifest));
  const changed = Object.keys(manifest).filter((k) => k in prev && prev[k] !== manifest[k]);
  console.log(JSON.stringify({ total: Object.keys(manifest).length, added: added.length, removed: removed.length, changed: changed.length, addedSample: added.slice(0, 5), changedSample: changed.slice(0, 5) }, null, 2));
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1), 'utf8');
  console.log(`清单已写入 ${OUT}，共 ${Object.keys(manifest).length} 个文件`);
}
