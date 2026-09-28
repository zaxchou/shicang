import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 全局前置：清掉 AI 环境变量 + 拦住对 AI 网关的真实请求，保证测试不花用户的钱
    setupFiles: ['./tests/setup.ts'],
    // 各文件 waitForJob 的轮询上限 5–10s，默认 5s 的 testTimeout 会先杀掉它们，
    // 报出来的还是"test timed out"而不是"刷新任务超时"——排障被误导（深审发现）
    testTimeout: 30000,
    hookTimeout: 30000,
    // stub 过的全局/环境变量每个用例后自动还原：漏写一处 afterEach 不再静默泄漏
    // （setup.ts 的守卫是直接赋值不是 stubGlobal，不受影响，深审发现）
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
