// 只读边界验证：对内容源（Markdown + 媒体）生成哈希清单，开发前后对比。
// 用法：node scripts/source-hash.mjs [--check .local/source-hash.json]
//
// 范围来自 config/app.json 的 collections（v0.4.0 起是三个库：RedNote / 我的收藏品 / flomo）——
// 只盯 RedNote 会漏掉另外两个库的误写。vault 根取环境变量 SOURCE_ROOT，缺省用配置里的值。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = '.local/source-hash.json';

const cfg = JSON.parse(fs.readFileSync('config/app.json', 'utf8'));
const vaultRoot = (process.env.SOURCE_ROOT ?? cfg.vaultRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
if (!vaultRoot) {
  console.error('未配置内容源：设置 SOURCE_ROOT 或 config/app.json 的 vaultRoot');
  process.exit(2);
}
const roots = (cfg.collections ?? []).map((c) => c.root);
if (roots.length === 0) {
  console.error('config/app.json 里没有 collections，无法确定只读范围');
  process.exit(2);
}

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
for (const root of roots) {
  const abs = path.join(vaultRoot, root);
  if (!fs.existsSync(abs)) {
    console.error(`内容目录不存在: ${abs}`);
    process.exit(2);
  }
  walk(abs, root, manifest);
}

if (process.argv.includes('--check')) {
  const file = process.argv[process.argv.indexOf('--check') + 1] ?? OUT;
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  const added = Object.keys(manifest).filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in manifest));
  const changed = Object.keys(manifest).filter((k) => k in prev && prev[k] !== manifest[k]);
  console.log(
    JSON.stringify(
      {
        roots,
        total: Object.keys(manifest).length,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        addedSample: added.slice(0, 5),
        changedSample: changed.slice(0, 5),
      },
      null,
      2
    )
  );
  // 变更就是"来源被改过"的信号：非零退出让调用方（人/脚本）注意到
  if (added.length + removed.length + changed.length > 0) process.exit(3);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1), 'utf8');
  console.log(`清单已写入 ${OUT}，共 ${Object.keys(manifest).length} 个文件（范围：${roots.join(' / ')}）`);
}
