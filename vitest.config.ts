import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 全局前置：清掉 AI 环境变量 + 拦住对 AI 网关的真实请求，保证测试不花用户的钱
    setupFiles: ['./tests/setup.ts'],
  },
});
