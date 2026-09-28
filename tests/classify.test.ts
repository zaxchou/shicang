// 自动分类管道测试：规则本体 + AI 回复解析 + 刷新时的批量补分类
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRednote, REDNOTE_CATEGORIES } from '../server/services/classify.js';
import { parseAiCategory } from '../server/services/ai-classify.js';
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
