// 测试环境自身的防护（守卫也要被验证，否则它悄悄失效时没人知道）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiClassifyConfigFromEnv } from '../server/services/ai-classify.js';
import { aiVisionConfigFromEnv } from '../server/services/ai-vision.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('测试环境不得花用户的钱', () => {
  it('进程里没有 AI key：分类与视觉都不会被配置（刷新里的 AI 兜底静默跳过）', () => {
    expect(aiClassifyConfigFromEnv()).toBeNull();
    expect(aiVisionConfigFromEnv()).toBeNull();
  });

  it('即使人为设了 key，对 AI 网关的真实请求也会被 setup 拦住（而不是真发出去）', async () => {
    vi.stubEnv('AI_CLASSIFY_API_KEY', 'sk-test-not-real');
    expect(aiClassifyConfigFromEnv()).not.toBeNull(); // 配置层确实认了这个 key
    await expect(fetch('https://api.xiaomimimo.com/v1/chat/completions')).rejects.toThrow(
      /真实请求|不许花用户的钱|测试里出现/
    );
  });

  it('非 AI 地址照常放行（本地服务/媒体请求不受影响）', async () => {
    // 只断言"没有被守卫拦下"：这里故意指向一个必然连不上的地址，得到网络错误而非守卫错误
    await expect(fetch('http://127.0.0.1:1/nope')).rejects.not.toThrow(/不许花|测试里出现/);
  });
});
