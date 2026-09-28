/**
 * 收藏库解析审计：对真实 vault 全量跑 parseNote，找出「渲染不出来」的内容。
 *
 * 背景（v0.5.1）：`![[Pasted image xxx.png]]` 的媒体 id 带空格，markdown 链接被截断，
 * 图片静默消失——媒体登记了、缩略图也正常，单看测试抓不到。这个脚本把三类问题量化：
 *   1. 正文残留 markdown（`![..](..)` 没被改写成 <img>）
 *   2. 登记了图片媒体但正文 0 图（链接断了）
 *   3. 标题/分类异常（MOC、未命名页面等）与索引页混入
 *
 * 用法：npx tsx scripts/parse-audit.ts [vaultRoot]
 * 改 server/reader/parse.ts 的解析逻辑后、发布前跑一遍；同时记得 PARSE_VERSION +1。
 */
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
      if (/^attachments$/i.test(e.name)) continue; // 纯媒体目录
      walk(p, out);
    } else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

const NON_DISPLAYABLE = /\.(heic|heif|tiff?)$/i;
let total = 0;
const problems: string[] = [];

for (const col of cfg.collections as CollectionDef[]) {
  const rootDir = path.join(vaultRoot, col.root);
  if (!fs.existsSync(rootDir)) {
    problems.push(`[${col.id}] 收藏库根不存在: ${col.root}`);
    continue;
  }
  for (const abs of walk(rootDir)) {
    const rel = path.relative(vaultRoot, abs).split(path.sep).join('/');
    if ((col.exclude ?? []).some((re) => new RegExp(re).test(rel))) continue;
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
      console.log(`跳过  [${col.id}] ${rel} —— ${out.skippedReason}`);
      continue;
    }
    const rec = out.record;
    if (!rec) {
      problems.push(`[${col.id}] ${rel} 解析失败: ${out.error}`);
      continue;
    }
    total++;
    const tag = `[${col.id}] ${rel}`;
    const leftover = /!\[[^\]]*\]\(/.test(rec.bodyHtml);
    if (leftover) problems.push(`${tag} 正文残留 markdown（图片没渲染）`);
    // 逐个媒体核对：除封面外，每个图片媒体都应真的出现在正文里
    // （只比总数会把「只有封面、正文为空」的条目误报）
    for (const m of rec.media) {
      if (m.kind !== 'image') continue;
      if (m.id === rec.coverMediaId && !rec.bodyHtml.includes(`/api/media/`)) continue;
      const token = encodeURIComponent(m.id).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      const url = `/api/media/${encodeURIComponent(rec.id)}/${token}`;
      if (!rec.bodyHtml.includes(token)) {
        problems.push(`${tag} 图片媒体未出现在正文: ${m.id}${NON_DISPLAYABLE.test(m.localRelativePath ?? '') ? '（浏览器不支持的格式，仅提示）' : ''}`);
      }
      void url;
    }
    if (rec.bodyHtml.includes('media://')) problems.push(`${tag} 正文残留 media:// 占位`);
    if (/^(MOC|未命名页面|未命名)\.md$/i.test(path.basename(rel)) && rec.title === path.basename(rel, '.md')) {
      problems.push(`${tag} 标题回退到文件名（应优先 CSV标题/H1）`);
    }
    if (rec.coverMediaId && !rec.media.some((m) => m.id === rec.coverMediaId)) {
      problems.push(`${tag} coverMediaId 指向不存在的媒体`);
    }
    const cover = rec.media.find((m) => m.id === rec.coverMediaId);
    if (cover && NON_DISPLAYABLE.test(cover.localRelativePath ?? '')) {
      problems.push(`${tag} 封面是浏览器无法显示的格式: ${cover.localRelativePath}`);
    }
    for (const w of out.warnings) {
      // 已按设计回退的情况只作提示，不算问题（如封面是 HEIC 改用正文首图）
      if (/浏览器不支持/.test(w)) console.log(`提示  ${tag} —— ${w}`);
      else problems.push(`${tag} 警告: ${w}`);
    }
  }
}

console.log(`\n解析 ${total} 篇`);
if (problems.length === 0) {
  console.log('未发现问题');
} else {
  console.log(`发现 ${problems.length} 处问题：`);
  problems.forEach((p) => console.log('  ' + p));
  process.exitCode = 1;
}
