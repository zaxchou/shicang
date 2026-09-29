// 生成 data-seed/categories-seed.json（全量重刷 seed 用；日常新增走服务端自动分类，无需跑这个）。
// 规则本体在 server/services/classify.ts（单一事实来源），本脚本只负责读取索引、套规则、写 seed。
// 用法：npx tsx scripts/classify.ts
import fs from 'node:fs';
import { classifyByRules, REDNOTE_CATEGORIES } from '../server/services/classify.js';

const CAT_META: Record<string, { name: string; description: string }> = {
  shuhua: { name: '书画', description: '国画、书法与篆刻：作品欣赏、技法教程、临摹创作、文房装裱；兼收水彩、速写等绘画内容' },
  'maker-digital': { name: '数码硬件', description: '3D 打印与拓竹、开源硬件（ESP32 等）、数码好物评测、桌搭理线与家电' },
  'language-learning': { name: '学习语言', description: '英语日语、考研考试、数学科普、学术论文、留学教育' },
  'design-aigc': { name: '设计与创作', description: 'UI/UX 与视觉设计、字体壁纸、摄影剪辑；AI 生图、AI 视频、数字 3D 等创作玩法' },
  'ai-programming': { name: 'AI 工具', description: 'AI 工具与大模型、编程与 Agent、知识管理（Obsidian/Notion）、效率软件与开源项目' },
  life: { name: '生活', description: '茶器文玩、养宠园艺、旅行见闻、穿搭健康、认知成长、音乐与日常好物' },
};

interface IndexedNote {
  id: string;
  title: string;
  tags?: string[];
  collection?: string;
  sourceStatus?: string;
}

// 只处理小红书收藏：宝贝/日记的分类来自笔记本身（收藏分类 / tags[0]），
// 而且它们的 id 是源文件路径——混进 seed 会写入几百条无效条目
const raw = JSON.parse(fs.readFileSync('.local/data/library-index.json', 'utf8')) as { notes: IndexedNote[] };
const idx = {
  notes: raw.notes.filter((n) => (n.collection ?? 'rednote') === 'rednote' && (n.sourceStatus ?? 'available') === 'available'),
};

const results: Array<{ id: string; title: string; cat: string; rule: string }> = [];
const fallback: Array<{ id: string; title: string; tags: string }> = [];
for (const n of idx.notes) {
  const hit = classifyByRules(n.id, String(n.title ?? ''), n.tags ?? []);
  if (hit) results.push({ id: n.id, title: n.title, cat: hit.categoryId, rule: hit.rationale });
  else fallback.push({ id: n.id, title: n.title, tags: (n.tags ?? []).join(',') });
}

// ---- 输出 ----
const counts: Record<string, number> = {};
for (const c of REDNOTE_CATEGORIES) counts[c.id] = 0;
for (const r of results) counts[r.cat] = (counts[r.cat] ?? 0) + 1;
let out = '';
for (const c of REDNOTE_CATEGORIES) {
  out += `\n===== ${c.name} (${c.id}) — ${counts[c.id] ?? 0} =====\n`;
  for (const r of results.filter((x) => x.cat === c.id)) {
    out += `${r.id.slice(0, 8)} | ${r.title.slice(0, 40)} | ${r.rule}\n`;
  }
}
fs.mkdirSync('.local', { recursive: true });
fs.writeFileSync('.local/classify-review.txt', out, 'utf8');
console.log('分布:', JSON.stringify(Object.fromEntries(REDNOTE_CATEGORIES.map((c) => [c.name, counts[c.id] ?? 0]))));
console.log('已分类:', results.length, '/', idx.notes.length);
console.log('未命中:', fallback.length);
for (const f of fallback) console.log(`  ${f.id.slice(0, 8)} | ${f.title.slice(0, 42)} | ${f.tags.slice(0, 50)}`);

// ---- 生成 data-seed/categories-seed.json ----
// 覆盖不全不报错：规则命中不了的（AI 兜底过的、体裁判断不了的）留给运行时的自动分类/AI，
// 由页面「未分类」兜底。以前这里 throw，导致只要有一篇没命中就再也刷不动 seed。
const known = new Set(REDNOTE_CATEGORIES.map((c) => c.id));
for (const r of results) if (!known.has(r.cat)) throw new Error(`非法分类 ${r.cat}`);
const seen = new Set<string>();
for (const r of results) {
  if (seen.has(r.id)) throw new Error(`重复分配 ${r.id}`);
  seen.add(r.id);
}

const classifiedAt = new Date().toISOString();
const seed = {
  schemaVersion: 1,
  generatedAt: classifiedAt,
  categories: REDNOTE_CATEGORIES.map((c, i) => ({
    id: c.id,
    name: CAT_META[c.id]?.name ?? c.name,
    description: CAT_META[c.id]?.description ?? '',
    order: i + 1,
  })),
  initialAssignments: Object.fromEntries(
    results.map((r) => [r.id, { categoryId: r.cat, rationale: r.rule, classifiedAt }])
  ),
};
fs.mkdirSync('data-seed', { recursive: true });
fs.writeFileSync('data-seed/categories-seed.json', JSON.stringify(seed, null, 2), 'utf8');
console.log('seed 已生成:', results.length, '条');
if (fallback.length > 0) {
  console.log(`注意：${fallback.length} 篇未写入 seed（规则未命中），首次导入后由自动分类/AI 或人工处理`);
}
