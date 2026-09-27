// 首批分类：规则优先级匹配（标题 > 标签），输出逐条结果供人工审查。
// 分类体系与边界见 docs/category-taxonomy.md。
import fs from 'node:fs';

const idx = JSON.parse(fs.readFileSync('.local/data/library-index.json', 'utf8'));

// ---- 分类定义（稳定 ID，与 data-seed/categories-seed.json 一致） ----
const CATS = [
  { id: 'shuhua', name: '书画', order: 1 },
  { id: 'ai-programming', name: 'AI 与编程', order: 2 },
  { id: 'design-aigc', name: '设计与 AIGC', order: 3 },
  { id: 'maker-digital', name: '3D 打印与数码', order: 4 },
  { id: 'language-learning', name: '语言与学习', order: 5 },
  { id: 'life', name: '生活', order: 6 },
];

// ---- 规则（按序评估，先命中先得）----
// titleKw: 标题子串（latin 短词区分大小写另列）；tagKw: 任一标签包含即命中
const RULES = [
  {
    cat: 'shuhua', desc: '书画（标题）',
    titleKw: ['国画', '书法', '书画', '中国画', '水墨', '山水', '花鸟', '写意', '工笔', '没骨', '白描', '皴', '临摹', '宋画', '泼墨', '界画', '留白',
      '笔法', '用笔', '笔锋', '笔顺', '蘸墨', '调墨', '控笔', '画法', '画家', '画作', '画展', '画虎', '画鱼', '画竹', '读画', '写生',
      '楷书', '行书', '草书', '隶书', '汉隶', '小楷', '欧体', '榜书', '匾额', '手札', '墨迹', '书谱', '碑帖', '字帖', '帖', '字库',
      '春联', '对联', '福字', '砚', '毛笔', '宣纸', '熟宣', '生宣', '绢本', '泥银纸', '金粟笺', '笺', '篆刻', '印章', '印谱', '金石', '文玩', '折扇', '扇面',
      '挂画', '画框', '装裱', '古画', '名画', '寒食帖', '兰亭', '洛神赋', '赵孟頫', '米芾', '王羲之',
      '梅花', '兰花', '菊花', '荷花', '荷叶', '牡丹', '紫藤', '松针', '松树', '墨竹', '禽鸟', '八哥', '鳜鱼',
      '画画', '绘画', '水彩', '油画', '速写', '漫画', '书法'],
  },
  {
    cat: 'shuhua', desc: '书画（标签）',
    tagKw: ['国画', '书法', '书画', '中国画', '水墨', '山水画', '花鸟', '写意', '工笔', '没骨', '白描', '临摹', '宋画', '篆刻', '春联', '对联',
      '楷书', '行书', '草书', '隶书', '小楷', '字帖', '印章', '印谱', '砚台', '毛笔', '我的书法分享', '书法学习', '书法教学', '国画教程', '国画技法',
      '水彩', '油画', '速写', '漫画', '画画', '绘画', '字画', '美术', '工笔画', '写意国画', '国画花鸟', '观真艺术', '古画', '名画', '泼墨', '福字'],
  },
  {
    cat: 'life', desc: '生活·个人成长与日常（核心）',
    titleKw: ['人生', '认知', '心理', '焦虑', '拖延', '开悟', '修行', '觉醒', '孩子', '亲子', '自驱力', '青春期', '母乳', '涨奶',
      '丸子头', '发圈', '发型', '穿搭', '卫衣', '汉服', '丹宁', '哑铃', '塑形', '减脂', '头像'],
    tagKw: ['人生', '认知', '心理', '焦虑', '拖延', '开悟', '修行', '觉醒', '孩子', '亲子', '自驱力', '青春期', '母乳', '涨奶',
      '穿搭', '汉服', '发型', '健身', '塑形', '减脂', '饮食', '摄影', '拍照', '头像'],
  },
  {
    cat: 'maker-digital', desc: '3D 打印与数码',
    titleKw: ['3D打印', '3D 打印', '拓竹', 'TPU', '打印机', '切片软件', 'PCB', '单片机', 'ESP32', 'esp32', '乐鑫', '机器狗', '桌搭', '理线', '桌面改造',
      '拓展坞', '氮化镓', '充电宝', '耳机', 'U盘', '鼠标', '键盘', '麦克风', '风扇', '吹风机', '显示屏', '显示器', '平板', '折叠屏', 'iPhone', 'iphone',
      '小米', '澎湃', '玩机', '手机技巧', '数码', '开箱', '群晖', 'NAS', 'Jellyfin', 'jellyfin', '外设', '电子DIY', '评测', '机器狗', '首饰盒', '书签'],
    tagKw: ['3D打印', '拓竹', 'TPU', '单片机', 'ESP32', 'esp32', '乐鑫', '机器狗', '桌搭', '理线', '桌面改造', '拓展坞', '氮化镓', '充电宝', '耳机',
      '鼠标', '键盘', '麦克风', '风扇', '数码科技', '小米', '雷军', '玩机攻略', '手机技巧', '群晖nas', '电子DIY', '显示', '显示屏'],
  },
  {
    cat: 'design-aigc', desc: '数字 3D 创作',
    titleKw: ['3D模型', '3D建模', '3D场景', '3D 世界', '3D宇宙', '自动建模', 'Blender', 'blender'],
    tagKw: ['3D建模', '3D模型', 'AI3D', '建模'],
  },
  {
    cat: 'ai-programming', desc: 'AI 编程与工具（Vibe/Codex/Claude）',
    titleKw: ['vibe coding', 'vibecoding', 'Vibe', 'vibe', 'codex', 'Codex', 'claude', 'Claude', 'clau. code', 'openclaw', 'OpenClaw', 'deepseek', 'DeepSeek',
      'karpathy', 'Karpathy', 'notebooklm', 'NotebookLM', 'notebook', 'Notebook', 'obsidian', 'Obsidian', 'notion', 'Notion', 'meshy', 'Meshy', 'kimi', 'Kimi',
      'n8n', '1Panel', 'MaxKB', 'Ollama', 'ollama', 'LLM', '知识库', '知识管理', '第二大脑', '本地部署', '无代码', '低代码', '智能体', 'skill', 'Skill', 'MCP', 'Astra'],
    tagKw: ['vibecoding', 'vibe coding', 'codex', 'claudecode', 'claude', 'openclaw', 'deepseek', 'kimi', 'MCP', 'agent', 'Agent', 'skills', 'skill',
      '扣子', 'coze', 'obsidian', '知识管理', '知识库', '第二大脑', '大模型', 'LLM', 'GLM', '智谱', 'trae', 'TRAE', 'cursor', 'Cursor', '开源项目',
      '智能体', '千问大模型', 'qwen', '魔搭社区', 'notebooklm', '工作流'],
  },
  {
    cat: 'language-learning', desc: '语言与学习',
    titleKw: ['英语', '英文', '口语', '听力', '发音', '单词', '语法', '作文', '日语', '日本語', '雅思', '考研', '高考', '中考', '政治', '马原', '真题',
      '翻译', '诗词', '学诗', '数学', '三角函数', '留学', '申请', 'MIT', 'mit', '麻省理工', '寄宿', '藤校', '科研', '论文', '文献', 'YouTube'],
    tagKw: ['英语', '英文', '口语', '听力', '发音', '单词', '语法', '作文', '日语', '雅思', '考研', '考研政治', '高考', '中考', '美术高考', '美术中考',
      '翻译', '诗词', '数学', '留学', '美本申请', 'MIT', 'mit', '麻省理工', '藤校', '科研', '论文', '文献', '考研', '艺术考研', '音乐留学', 'ai留学'],
  },
  {
    cat: 'design-aigc', desc: '设计与 AIGC（主）',
    titleKw: ['设计', 'UI', 'PPT', 'ppt', 'Figma', 'figma', '字体', '宋体', '壁纸', '动效', 'p5', 'three.js', 'XR', '创意编程', '数字艺术', 'AIGC',
      '生图', 'AI绘画', 'ai绘画', 'AI视频', 'AI修图', '修图', '变装', '海报', '封面', '图标', '广告', '短视频', '视频剪辑', '剪辑', '剪映', '字幕', '配音',
      'AI音频', '压缩', 'ffmpeg', '线稿', '自媒体', '图表', '原型', 'slides', 'Slides', 'deck'],
    tagKw: ['设计教程', '设计工具', '设计网站', '设计干货', '平面设计', '字体设计', '视觉设计', '网站设计', '网页设计', '前端设计', 'UI设计', 'ui设计',
      'UIUX', 'ux', 'UX', '产品设计', '产品经理', '设计师', '字体', '壁纸', '高清壁纸', '手机壁纸', 'PPT', 'ppt模板', 'ppt设计', 'figma', '动效设计',
      'AIGC', 'AI设计', 'AI绘画', 'ai绘画', 'AI视频', 'AI教程', 'AI生图', '生图', 'AI修图', '变装', '海报', '封面', '广告拍摄', '短视频', '视频剪辑',
      '剪映', '字幕', '配音', 'AI音频', 'ffmpeg', '线稿', '自媒体', '视觉', 'p5', 'XD', 'oc', '手办', '新中式', '审美积累', '超现实主义'],
  },
  {
    cat: 'ai-programming', desc: 'AI 与编程（主）',
    titleKw: ['AI', 'ai', '人工智能', '机器学习', '深度学习', '提示词', '工作流', '自动化', '编程', '代码', '开发者', '独立开发', '小程序', '浏览器',
      '插件', '微软', 'WPS', 'edge', 'Edge', '电脑', '文件管理', '文件命名', '效率', 'GitHub', 'github', '开源', '部署', 'CLI', '命令行', 'Markdown',
      'GPT', 'gpt', 'Gemini', 'gemini', 'GLM', '智谱', '飞书', 'app', 'App', '工具', '网站', '软件', 'RAG', '智能', '桌宠', '语音', '翻译'],
    tagKw: ['ai', 'AI', '人工智能', '机器学习', '深度学习', '提示词', 'AI工具', 'ai工具', 'AI编程', 'AI教程', 'AI开发', 'AI应用', 'AI学习', 'AI视频',
      '效率工具', '效率神器', '效率提升', '效率', '自动化', '办公', '开源', '浏览器插件', '软件开发', 'App开发', '独立开发', '开发者', '小程序',
      '微软', 'WPS', 'edge', '电脑知识', '文件管理', '文件命名', 'GitHub', '开源项目', '部署', 'MCP', 'CLI', '命令行', 'Markdown', 'GPT', 'gpt',
      'Gemini', 'GLM', '智谱', '飞书', 'Kimi', 'kimi', '豆包ai', '驯服AI', 'AI0x0', 'ai硬件', '龙珠', '转码', '深度学习', '机器学习', '知识库',
      'PKM', '数字游民', '一人公司', 'OPC', 'HOWTO'],
  },
  {
    cat: 'life', desc: '生活（其余）',
    titleKw: ['茶', '龟', '鱼缸', '养鱼', '斗鱼', '水草', '猫', '宠物', '旅行', '旅游', '景点', '西藏', '古建', '密室', '剧本杀', '游戏', '春晚',
      '舞蹈', '健身', '锻炼', '好物', '居家', '清洁', '文具', '手账', '礼物', '科幻', '脑洞', '庄子', '哲学', '量子', '科普', '梦境', '音乐', '钢琴',
      '简谱', '瑜伽', '冥想', 'NSDR'],
    tagKw: ['茶器', '茶具', '紫砂壶', '茶', '蛋龟', '乌龟', '养龟', '龟缸', '龟宠', '鱼缸', '水草缸', '养鱼', '泰国斗鱼', '灯鱼', '原生缸', '生态缸',
      '养猫', '猫咪', '猫星人', '萌宠', '旅行', '旅游', '西藏', '古建', '密室', '剧本杀', '游戏', '春晚', '舞蹈', '卡点舞', '魔性舞蹈', '好物推荐',
      '好物分享', '居家好物', '清洁膏', '文具', '手账', '礼物', '科幻', '脑洞', '庄子', '量子力学', '科普', '梦境', '钢琴', '简谱', '成人钢琴',
      '音乐', '冥想', '午休', '双胞胎', '游戏推荐', '主机游戏', '游戏日常', '双语者', '认知科学'],
  },
];

// 短 latin 词在原始标题上区分大小写匹配
const CASE_SENSITIVE = ['UI', 'PPT', 'XR', 'NAS', 'LLM', 'GLM', 'MCP', 'GPT', 'MIT', 'TPU', 'PCB', 'NSDR', 'WPS', 'IDE', 'CLI', 'RAG', 'XD', 'OC'];

function matchTitle(title, kws) {
  for (const kw of kws) {
    if (CASE_SENSITIVE.includes(kw)) {
      if (kw === 'p5') {
        // p5 需要词边界，避免误匹配 TOP5 之类
        if (/\bp5\b/.test(title)) return kw;
        continue;
      }
      if (title.includes(kw)) return kw;
    } else if (title.toLowerCase().includes(kw.toLowerCase())) return kw;
  }
  return null;
}
function matchTags(tags, kws) {
  for (const t of tags) {
    for (const kw of kws) {
      if (t.toLowerCase().includes(kw.toLowerCase())) return kw;
    }
  }
  return null;
}

// 人工复核覆盖（规则未能可靠判定的少量条目）
const MANUAL = {
  '67dc281c': { cat: 'shuhua', why: '人工复核：罗寒蕾工笔画步骤图' },
  '6a1a1e5e': { cat: 'shuhua', why: '人工复核：释明纲行草书墨迹' },
  '669b9b92': { cat: 'shuhua', why: '人工复核：破凤眼为兰花画法术语' },
  '666192aa': { cat: 'shuhua', why: '人工复核：宋代书画审美' },
  '67450df1': { cat: 'language-learning', why: '人工复核：古诗人文内容' },
  '64899cbe': { cat: 'life', why: '人工复核：西藏森林摄影游记' },
  '66ef887e': { cat: 'ai-programming', why: '人工复核：Notion Life OS 效率系统' },
  '6a5ddc8e': { cat: 'maker-digital', why: '人工复核：音箱新品数码' },
  '69aecda6': { cat: 'language-learning', why: '人工复核：美院艺考教育话题' },
  '66fbaf50': { cat: 'ai-programming', why: '人工复核：AI 工具盘点（正文含 AI 黑科技）' },
  '66c02146': { cat: 'shuhua', why: '人工复核：泼墨菊花国画' },
  '696793d1': { cat: 'shuhua', why: '人工复核：福字书法' },
  '67e28aff': { cat: 'shuhua', why: '人工复核：正仓院唐笔文房' },
  '6746cb62': { cat: 'life', why: '人工复核：日常随拍' },
  '6a8adec9': { cat: 'life', why: '人工复核：哲学科普视频' },
  '68dfb8a5': { cat: 'life', why: '人工复核：家庭日常' },
  '68231c62': { cat: 'life', why: '人工复核：观鸟自然观察' },
  '6743e175': { cat: 'shuhua', why: '人工复核：日本画家伊藤若冲绘画' },
  '68875fae': { cat: 'shuhua', why: '人工复核：菊花写意画作' },
  '667c2279': { cat: 'ai-programming', why: '人工复核：Coze 搭建助手' },
  '6952342c': { cat: 'shuhua', why: '人工复核：丝网版画艺术展览' },
  '6974456a': { cat: 'life', why: '人工复核：铜工艺品联名好物' },
  '6795a80f': { cat: 'shuhua', why: '人工复核：书画装裱' },
  '68561fb4': { cat: 'life', why: '人工复核：内容无法判断，暂归生活，可人工调整' },
  '6a5c9faf': { cat: 'life', why: '人工复核：美容养生' },
  '69cb8955': { cat: 'shuhua', why: '人工复核：书法用纸（赵孟頫洛神赋）' },
  '6629d977': { cat: 'shuhua', why: '人工复核：书法创作（大鱼堂）' },
  '67fe4729': { cat: 'life', why: '人工复核：中文说唱音乐' },
  '67bab9a4': { cat: 'shuhua', why: '人工复核：篆刻学习（汉印法度）' },
  '67a1b46d': { cat: 'design-aigc', why: '人工复核：TouchDesigner 视觉教程' },
  '6a9fd5db': { cat: 'shuhua', why: '人工复核：AI 复现《千里江山图》，主题为国画' },
  '6a38ec04': { cat: 'design-aigc', why: '人工复核：AI 纯代码生成视频' },
  '6aa5062d': { cat: 'design-aigc', why: '人工复核：AI 把名画变成电影的创作教程' },
  '6a3e5611': { cat: 'ai-programming', why: '人工复核：Claude Code 开发 APP' },
  '6613dd67': { cat: 'language-learning', why: '人工复核：国美考研信息' },
  '6aa8fcd1': { cat: 'design-aigc', why: '人工复核：AI 生图运镜教程' },
  '69cef878': { cat: 'design-aigc', why: '人工复核：AI 视频剪辑工具' },
  '69ba1a81': { cat: 'design-aigc', why: '人工复核：AI+D2C 的 UI 设计出图' },
  '69eadc8e': { cat: 'ai-programming', why: '人工复核：GitHub AI 项目盘点' },
  '687900cf': { cat: 'life', why: '人工复核：思维认知随笔' },
  '6698b405': { cat: 'ai-programming', why: '人工复核：安卓 AI 语音笔记应用' },
  '69ce2f94': { cat: 'ai-programming', why: '人工复核：飞书 CLI 直播分享' },
  '6841945a': { cat: 'design-aigc', why: '人工复核：AI 配音音频创作工具' },
  '655dabaf': { cat: 'design-aigc', why: '人工复核：iPad 高清壁纸套图' },
  '69467dad': { cat: 'language-learning', why: '人工复核：MIT 留学作品集' },
  '6a86afa1': { cat: 'maker-digital', why: '人工复核：数码通信新品' },
  '6a816c43': { cat: 'design-aigc', why: '人工复核：AI 旅行照片创意生成' },
  '689b01ee': { cat: 'shuhua', why: '人工复核：艺术家画猫作品欣赏' },
};

const results = [];
const fallback = [];
for (const n of idx.notes) {
  const shortId = n.id.slice(0, 8);
  const manual = MANUAL[shortId];
  if (manual) {
    results.push({ id: n.id, title: n.title, cat: manual.cat, rule: manual.why });
    continue;
  }
  let hit = null;
  for (const r of RULES) {
    if (r.titleKw) {
      const kw = matchTitle(n.title, r.titleKw);
      if (kw) { hit = { cat: r.cat, rule: `${r.desc}：标题含「${kw}」` }; break; }
    }
    if (r.tagKw) {
      const kw = matchTags(n.tags, r.tagKw);
      if (kw) { hit = { cat: r.cat, rule: `${r.desc}：标签含「${kw}」` }; break; }
    }
  }
  if (hit) results.push({ id: n.id, title: n.title, cat: hit.cat, rule: hit.rule });
  else fallback.push({ id: n.id, title: n.title, tags: n.tags.join(',') });
}

// ---- 输出审查文件 ----
const byCat = {};
for (const c of CATS) byCat[c.id] = [];
for (const r of results) byCat[r.cat].push(r);
let out = '';
for (const c of CATS) {
  out += `\n===== ${c.name} (${c.id}) — ${byCat[c.id].length} 篇 =====\n`;
  for (const r of byCat[c.id]) out += `${r.id.slice(0, 8)} | ${r.title.slice(0, 42)} | ${r.rule}\n`;
}
fs.writeFileSync('.local/classify-output.txt', out, 'utf8');
console.log('各分类数量:', Object.fromEntries(CATS.map((c) => [c.name, byCat[c.id].length])));
console.log('已分类:', results.length, '/ 598');
console.log('\n未命中规则（需人工判定）:', fallback.length);
for (const f of fallback) console.log(`  ${f.id.slice(0, 8)} | ${f.title.slice(0, 40)} | ${f.tags.slice(0, 40)}`);

// ---- 生成 seed（分类定义 + 首批分配）----
const CAT_META = {
  shuhua: { name: '书画', description: '国画与书法：作品欣赏、技法教程、临摹创作、篆刻文房、装裱展览；兼收水彩、速写等绘画内容' },
  'ai-programming': { name: 'AI 与编程', description: 'AI 工具与大模型、编程与 Agent、知识管理（Obsidian/Notion）、效率软件与开源项目' },
  'design-aigc': { name: '设计与 AIGC', description: 'UI/UX 与产品设计、字体、壁纸、PPT；AI 生图、AI 视频、数字 3D 等创作玩法与工具' },
  'maker-digital': { name: '3D 打印与数码', description: '3D 打印与拓竹、开源硬件（ESP32 等）、数码好物、桌搭理线与硬件玩法' },
  'language-learning': { name: '语言与学习', description: '英语、日语、考研考试、数学科普、留学教育与学术工具' },
  life: { name: '生活', description: '茶器、养宠园艺、旅行见闻、穿搭健康、认知成长、音乐与日常好物等生活内容' },
};
const knownCats = new Set(CATS.map((c) => c.id));
for (const r of results) {
  if (!knownCats.has(r.cat)) throw new Error(`非法分类 ID: ${r.cat} (${r.id})`);
}
const seen = new Set();
for (const r of results) {
  if (seen.has(r.id)) throw new Error(`重复分配: ${r.id}`);
  seen.add(r.id);
}
if (seen.size !== idx.notes.length) {
  const missing = idx.notes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  throw new Error(`覆盖不全，缺 ${missing.length}: ${missing.slice(0, 5).join(',')}`);
}

const classifiedAt = new Date().toISOString();
const seed = {
  schemaVersion: 1,
  generatedAt: classifiedAt,
  categories: CATS.map((c) => ({
    id: c.id,
    name: CAT_META[c.id].name,
    description: CAT_META[c.id].description,
    order: c.order,
  })),
  initialAssignments: Object.fromEntries(
    results.map((r) => [r.id, { categoryId: r.cat, rationale: r.rule, classifiedAt }])
  ),
};
fs.mkdirSync('data-seed', { recursive: true });
fs.writeFileSync('data-seed/categories-seed.json', JSON.stringify(seed, null, 2), 'utf8');
console.log(`\nseed 已生成: data-seed/categories-seed.json（${results.length} 条分配）`);
