// 自动分类管道测试：规则本体 + AI 回复解析 + 刷新时的批量补分类
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRednote, REDNOTE_CATEGORIES } from '../server/services/classify.js';
import { classifyByAi, parseAiCategory, type AiClassifyConfig } from '../server/services/ai-classify.js';
import { CategoriesService } from '../server/services/categories.js';

const VALID = new Set(REDNOTE_CATEGORIES.map((c) => c.id));

describe('规则分类（classifyRednote）', () => {
  it('2026-09-28 新增 8 篇：7 篇命中规则/人工表，1 篇留给 AI 兜底', () => {
    const cases: Array<[string, string, string[], string | null]> = [
      ['6ab49468', '中年男人下班后，深夜独自喝茶的快乐。', ['玩茶人', '茶生活', '夜茶时光'], 'life'],
      ['6aac2496', '分享我最近手搓的两个内容管理的小工具💪', ['效率神器', '内容管理', 'howto用好AI'], 'ai-programming'],
      ['6ab12838', '《心经》居然可以这样被看见！', ['心经', '佛学美学', '东方美学'], null], // 正文讲信息可视化/书籍设计 → AI 兜底
      ['6aab22db', '笔墨迭代与重构（4）', ['艺术创作过程', '张修安大写意', '传统文化艺术'], 'shuhua'],
      ['6aafb4be', '最近又开始流行的清透质感 UI', ['UI设计', '卡片设计', '液态设计'], 'design-aigc'],
      ['6ab3a7b8', '数据一目了然｜高颜值Dashboard界面灵感', ['数据可视化', 'B端UI设计', '后台管理系统'], 'design-aigc'],
      ['6843aee3', '🌲【干货｜松树核心结构画法全解析】', ['山水画', '国画教程', '松树画法'], 'shuhua'],
      ['6aacad1a', 'AI驯化｜古画活起来教程', ['仇英', '琵琶行'], 'design-aigc'], // 人工表：同「名画变电影」先例
    ];
    for (const [id, title, tags, expected] of cases) {
      const r = classifyRednote(id, title, tags);
      expect(r?.categoryId ?? null).toBe(expected);
    }
  });

  it(' rationale 记录命中依据，人工表条目使用人工说明', () => {
    const byTag = classifyRednote('6aab22db', '笔墨迭代与重构（4）', ['张修安大写意']);
    expect(byTag?.rationale).toContain('标签含');
    const manual = classifyRednote('6aacad1a', 'AI驯化｜古画活起来教程', []);
    expect(manual?.rationale).toContain('人工');
  });

  it('大小写敏感词不误伤（UI 只认大写）', () => {
    expect(classifyRednote('aaaaaaaa', 'tailwind 主题配置', [])?.categoryId).not.toBe('design-aigc');
    expect(classifyRednote('aaaaaaaa', '最近流行的 UI 风格', [])?.categoryId).toBe('design-aigc');
  });
});

describe('AI 回复解析（parseAiCategory）', () => {
  it('裸 JSON / 围栏 JSON / 夹带说明文字都能取出', () => {
    expect(parseAiCategory('{"categoryId":"life","reason":"茶"}', VALID)?.categoryId).toBe('life');
    expect(parseAiCategory('```json\n{"categoryId":"shuhua","reason":"国画"}\n```', VALID)?.categoryId).toBe('shuhua');
    expect(parseAiCategory('好的，结果是 {"categoryId":"ai-programming","reason":"效率工具"}', VALID)?.categoryId).toBe('ai-programming');
  });

  it('非法类别 / 无 JSON / 空串返回 null', () => {
    expect(parseAiCategory('{"categoryId":"不存在","reason":"x"}', VALID)).toBeNull();
    expect(parseAiCategory('我觉得是书画', VALID)).toBeNull();
    expect(parseAiCategory('', VALID)).toBeNull();
  });
});

/** 最小分类定义夹具（生产里这 6 类来自 seed） */
function writeCategoryDefs(dataDir: string): void {
  const doc = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    categories: REDNOTE_CATEGORIES.map((c, i) => ({
      id: c.id,
      name: c.name,
      description: '',
      order: i + 1,
    })),
    initialAssignments: {},
  };
  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify(doc), 'utf8');
}

describe('刷新时的批量补分类（ensureClassified）', () => {
  function makeService(): CategoriesService {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cat-'));
    writeCategoryDefs(dir);
    return new CategoriesService(dir, path.join(dir, 'bak'));
  }

  it('只补没有分类依据的笔记；已有覆盖的不动；重复调用幂等', async () => {
    const svc = makeService();
    const diags = await svc.init(null);
    void diags;
    // 人工覆盖优先
    await svc.setOverride('ovr-1', 'life', 0);

    const { assigned, unclassified } = await svc.ensureClassified(
      [
        { id: 'rule-1', title: '中年男人下班后，深夜独自喝茶的快乐。', tags: ['茶生活'], excerpt: '' },
        { id: 'ovr-1', title: '应该是设计与创作才对', tags: ['UI设计'], excerpt: '' }, // 有覆盖 → 跳过
        { id: 'ai-1', title: '完全猜不出来的笔记', tags: [], excerpt: '' }, // 分类器返回 null
        { id: 'bad-1', title: '随意', tags: [], excerpt: '' }, // 分类器返回非法类别 → 不采用
      ],
      async (item) => {
        if (item.id === 'ai-1') return null;
        if (item.id === 'bad-1') return { categoryId: '不存在的类', rationale: 'x' };
        return classifyRednote(item.id, item.title, item.tags);
      }
    );
    expect(assigned).toBe(1);
    expect(unclassified.sort()).toEqual(['ai-1', 'bad-1']);
    expect(svc.effective('rule-1')).toEqual({ categoryId: 'life', source: 'initial' });
    expect(svc.effective('ovr-1')).toEqual({ categoryId: 'life', source: 'override' });
    expect(svc.effective('ai-1').categoryId).toBeNull();

    // 幂等：再跑一遍不再产生新分配
    const again = await svc.ensureClassified(
      [{ id: 'rule-1', title: '中年男人下班后，深夜独自喝茶的快乐。', tags: ['茶生活'], excerpt: '' }],
      async () => null
    );
    expect(again.assigned).toBe(0);
  });

  it('分配持久化：新实例加载后依然有效', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cat-'));
    writeCategoryDefs(dir);
    const svc = new CategoriesService(dir, path.join(dir, 'bak'));
    await svc.init(null);
    await svc.ensureClassified(
      [{ id: 'n-1', title: 'ESP32 做了一个桌面摆件', tags: ['乐鑫'], excerpt: '' }],
      async (it) => classifyRednote(it.id, it.title, it.tags)
    );
    const reloaded = new CategoriesService(dir, path.join(dir, 'bak'));
    await reloaded.init(null);
    expect(reloaded.effective('n-1').categoryId).toBe('maker-digital');
  });
});

// ---------- classifyByAi 的请求形态与失败路径 ----------
// 此前 classifyByAi 零直接测试：mock 只数调用次数，把 thinking:{type:'disabled'} 删掉
// 测试照样全绿，而生产上 AI 兜底会静默退化成"永远返回 null"（深审发现）。
describe('classifyByAi：请求形态与失败翻译', () => {
  const cfg: AiClassifyConfig = {
    apiKey: 'k',
    baseUrl: 'https://classify.example/v1',
    model: 'm',
    timeoutMs: 5000,
    maxPerRefresh: 40,
  };
  const input = { title: '深夜喝茶', tags: ['茶生活'], excerpt: '摘要' };

  it('打 /chat/completions、带 Bearer、关思考、限制输出长度', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"categoryId":"life","reason":"茶"}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const hit = await classifyByAi(cfg, input, new Set(['life']), stub);
    expect(hit?.categoryId).toBe('life');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://classify.example/v1/chat/completions');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('m');
    // 不关思考的话 max_tokens 会被推理过程吃光（ai-classify.ts 注释里记着的实测教训）
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(300);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer k');
  });

  it('HTTP 401 / 网络抛错 / 响应非 JSON 都返回 null（刷新不被 AI 卡死）', async () => {
    const bad401 = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    expect(await classifyByAi(cfg, input, new Set(), bad401)).toBeNull();
    const netErr = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await classifyByAi(cfg, input, new Set(), netErr)).toBeNull();
    const notJson = (async () => new Response('oops', { status: 200 })) as typeof fetch;
    expect(await classifyByAi(cfg, input, new Set(), notJson)).toBeNull();
  });
});
