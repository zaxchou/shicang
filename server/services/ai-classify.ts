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
  // 用 || 而不是 ??：env 里设成空串应视为"没配"，否则空的 AI_CLASSIFY_API_KEY 会把 MIMO_API_KEY 别名挡死
  const apiKey = (env.AI_CLASSIFY_API_KEY || env.MIMO_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.AI_CLASSIFY_BASE_URL || env.MIMO_API_BASE || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    // 默认与 compose / vision 侧一致（此前这里停在 mimo-v2.5，三处默认值互相打架）
    model: (env.AI_CLASSIFY_MODEL || env.MIMO_MODEL || 'mimo-v2.6-flash').trim(),
    timeoutMs: positiveInt(env.AI_CLASSIFY_TIMEOUT_MS, 30000, 1000),
    maxPerRefresh: positiveInt(env.AI_CLASSIFY_MAX_PER_REFRESH, 40, 1),
  };
}

/** 环境变量里的正整数：缺失或写错（NaN）时用默认值，避免静默失效；上限钳到 2^31-1（setTimeout 会溢出） */
function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), 2_147_483_647);
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

/** 系统提示按**类目表动态生成**（类目说明的单一事实来源是 categories.json 的 description），
 *  描述对象由调用方传入（小红书笔记 / 网页剪藏）——写死"这篇小红书笔记"会让网页文章按错的语境被分类，
 *  写死类目清单则会在增删类目后与界面各说各话。 */
export function buildSystemPrompt(
  subject: string,
  categories: ReadonlyArray<{ id: string; name: string; description?: string }>
): string {
  const lines = categories.map((c) => `- ${c.id}: ${c.name}——${c.description || c.name}`);
  return [
    `你是收藏内容的分类器。把${subject}分入唯一类别，只输出 JSON：{"categoryId":"…","reason":"不超过20字"}。`,
    '类别说明：',
    ...lines,
  ].join('\n');
}

export async function classifyByAi(
  cfg: AiClassifyConfig,
  input: { title: string; tags: string[]; excerpt: string },
  validIds: ReadonlySet<string>,
  ctx: {
    /** 要分类的对象（如「这条小红书笔记」/「这条网页剪藏（文章）」） */
    subject: string;
    /** 全类目表（按 order 排好），说明取 categories.json 的 description */
    categories: ReadonlyArray<{ id: string; name: string; description?: string }>;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{ categoryId: string; rationale: string } | null> {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(ctx.subject, ctx.categories) },
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
