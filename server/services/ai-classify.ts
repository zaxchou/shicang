// AI 分类兜底：规则（classify.ts）未命中时，用 OpenAI 兼容的 Chat Completions 接口分类。
// 接口形态照搬 molin-wiki 项目（backend/app/llm/client.py + providers.py）：
//   POST {baseUrl}/chat/completions，Authorization: Bearer <key>，
//   MiMo 是推理模型，body 必须带 thinking:{type:'disabled'}，否则 max_tokens 会被思考过程吃光。
// 配置走环境变量（key 绝不进 git）：AI_CLASSIFY_API_KEY / AI_CLASSIFY_BASE_URL / AI_CLASSIFY_MODEL。
// 未配置 key 时整个模块静默跳过，行为与 v0.5.1 相同（新笔记进未分类）。

export interface AiClassifyConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * 单次刷新的 AI 调用上限。分类表被重置（删除 categories.json）或一次导入几百篇时，
   * 没有上限就会串行打几百次接口，把配额和刷新时长一起打爆。
   */
  maxPerRefresh: number;
}

export function aiClassifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiClassifyConfig | null {
  const apiKey = (env.AI_CLASSIFY_API_KEY ?? env.MIMO_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.AI_CLASSIFY_BASE_URL ?? env.MIMO_API_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    model: (env.AI_CLASSIFY_MODEL ?? env.MIMO_MODEL ?? 'mimo-v2.5').trim(),
    timeoutMs: positiveInt(env.AI_CLASSIFY_TIMEOUT_MS, 30000, 1000),
    maxPerRefresh: positiveInt(env.AI_CLASSIFY_MAX_PER_REFRESH, 40, 1),
  };
}

/** 环境变量里的正整数：缺失或写错（NaN）时用默认值，避免静默失效 */
function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** 从模型回复里宽松地取出 JSON（有的模型会包 ```json 围栏或夹带说明文字） */
export function parseAiCategory(
  text: string,
  validIds: ReadonlySet<string>
): { categoryId: string; reason: string } | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { categoryId?: unknown; reason?: unknown };
    const id = typeof obj.categoryId === 'string' ? obj.categoryId.trim() : '';
    if (!validIds.has(id)) return null;
    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 40) : '';
    return { categoryId: id, reason };
  } catch {
    return null;
  }
}

const PROMPT_HEADER = `你是收藏内容的分类器。把这篇小红书笔记分入唯一类别，只输出 JSON：{"categoryId":"…","reason":"不超过20字"}。
类别说明：
- shuhua: 书画——国画/书法/篆刻的作品欣赏、技法教程、临摹创作、文房装裱；兼收水彩速写
- maker-digital: 数码硬件——3D打印与拓竹、开源硬件(ESP32等)、数码评测开箱、桌搭家电
- language-learning: 学习语言——英语日语、考试考研、留学申请、学术论文
- design-aigc: 设计与创作——UI/视觉/平面设计、字体壁纸、摄影剪辑、AI 生图/AI 视频等创作玩法（含把名画古画做成 AI 视频）
- ai-programming: AI 工具——AI/大模型工具、编程开发、Agent、知识管理(Obsidian/Notion)、效率软件与开源项目
- life: 生活——茶器文玩、宠物、旅行、穿搭、健康心理、认知成长、日常杂谈`;

export async function classifyByAi(
  cfg: AiClassifyConfig,
  input: { title: string; tags: string[]; excerpt: string },
  validIds: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch
): Promise<{ categoryId: string; rationale: string } | null> {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: PROMPT_HEADER },
      {
        role: 'user',
        content: `标题：${input.title}\n标签：${input.tags.join('、') || '（无）'}\n内容摘要：${(input.excerpt || '').slice(0, 400)}`,
      },
    ],
    max_tokens: 300,
    temperature: 0,
    thinking: { type: 'disabled' }, // MiMo 系推理模型必须关思考，见文件头说明
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // 网络/鉴权问题都不阻塞刷新，保持未分类
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    const hit = parseAiCategory(content, validIds);
    return hit ? { categoryId: hit.categoryId, rationale: `AI：${hit.reason || '模型判断'}` } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
