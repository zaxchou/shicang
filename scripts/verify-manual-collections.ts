// 核验「我的宝贝 / 日记」导入：数量对得上、手工分类（frontmatter/标签）原样带进索引。
// 用法：npx tsx scripts/verify-manual-collections.ts [vaultRoot]
import fs from 'node:fs';
import path from 'node:path';
import { parseNote } from '../server/reader/parse.js';
import { loadConfig } from '../server/config.js';
import type { CollectionDef } from '../shared/types.js';

const cfg = loadConfig(process.env);
const vaultRoot = process.argv[2] ?? cfg.vaultRoot;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^attachments$/i.test(e.name)) continue;
      walk(p, out);
    } else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

const problems: string[] = [];

for (const col of cfg.collections as CollectionDef[]) {
  if (col.type === 'rednote') continue; // 小红书走规则/AI，另一条线已测
  const rootDir = path.join(vaultRoot, col.root);
  let total = 0;
  let skipped = 0;
  let uncategorized = 0;
  const uncList: string[] = [];

  for (const abs of walk(rootDir)) {
    const rel = path.relative(vaultRoot, abs).split(path.sep).join('/');
    // exclude 正则是对「相对收藏库根」的路径评估的（与 scan.ts 一致）
    const relInCollection = path.relative(rootDir, abs).split(path.sep).join('/');
    if ((col.exclude ?? []).some((re) => new RegExp(re).test(relInCollection))) continue;
    const st = fs.statSync(abs);
    const out = parseNote({
      absolutePath: abs,
      relativePath: rel,
      sourceRelativePath: rel,
      mtimeMs: st.mtimeMs,
      size: st.size,
      vaultRoot,
      collection: col,
    });
    if (out.skippedReason) {
      skipped++;
      continue;
    }
    const rec = out.record;
    if (!rec) {
      problems.push(`[${col.id}] ${rel} 解析失败: ${out.error}`);
      continue;
    }
    total++;

    if (col.type === 'treasures') {
      // 手工分类应来自 frontmatter「收藏分类」；没有时回退分类文件夹段
      const raw = fs.readFileSync(abs, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
      const m = /^收藏分类:\s*"?([^"\n]*)"?/m.exec(fm);
      const manual = (m?.[1] ?? '').trim();
      if (manual && rec.derivedCategory !== manual) {
        problems.push(`[treasures] ${rel} frontmatter 收藏分类=「${manual}」但导入为「${rec.derivedCategory}」`);
      }
      if (!rec.derivedCategory) {
        uncategorized++;
        uncList.push(rel);
      }
    } else {
      // 日记：tags[0] > 文件名第二段
      const raw = fs.readFileSync(abs, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
      const tagList = [...fm.matchAll(/^\s+-\s+"?([^"\n]*)"?\s*$/gm)]
        .map((x) => (x[1] ?? '').trim())
        .filter(Boolean);
      const seg = path.basename(rel, '.md').split('_')[1] ?? '';
      if (tagList.length > 0 && rec.derivedCategory !== tagList[0]) {
        problems.push(`[diary] ${rel} tags[0]=「${tagList[0]}」但导入为「${rec.derivedCategory}」`);
      }
      if (tagList.length === 0 && !seg) {
        uncategorized++;
        uncList.push(rel);
      }
    }
  }

  console.log(`\n[${col.name}] 条目 ${total}（跳过索引/空笔记 ${skipped}），未分类 ${uncategorized}`);
  uncList.forEach((u) => console.log('   未分类:', u));
}

console.log('\n=== 结论 ===');
if (problems.length === 0) console.log('手工分类与导入结果完全一致，无问题');
else {
  console.log(`${problems.length} 处不一致：`);
  problems.forEach((p) => console.log('  ' + p));
  process.exitCode = 1;
}
