// 测试全局前置：**确保测试永远不会真的调用 AI 供应商**（那要花钱、还会把用户笔记发出去）。
//
// 背景：`aiClassifyConfigFromEnv()` 直接读 `process.env.AI_CLASSIFY_API_KEY` / `MIMO_API_KEY`。
// 按文档做法在本地导出过 `deploy/production/.env` 的开发者，跑 `npm test` 时刷新流程会**真的**
// 走到 `fetch(.../chat/completions)`——集成测试（corpus/annotations/library/http）全都会命中。
// 所以这里做两件事：
//   ① 把 AI 相关环境变量从测试进程里清掉（需要它的用例自己用 `vi.stubEnv` 显式打开）；
//   ② 兜底：任何指向 AI 网关的真实请求直接抛错，而不是静默花钱——忘记 mock 的用例会当场失败。
const AI_HOSTS = ['api.xiaomimimo.com', 'api.deepseek.com', 'api.openai.com'];

for (const key of Object.keys(process.env)) {
  if (/^(AI_|MIMO_)/.test(key)) delete process.env[key];
}

const realFetch = globalThis.fetch;
type FetchInput = string | URL | { url: string };
globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (AI_HOSTS.some((h) => url.includes(h))) {
    // 用 rejected promise 而不是同步 throw：与真实 fetch 的失败方式一致，
    // 调用方无论用 try/catch 还是 .catch 都能接住
    return Promise.reject(
      new Error(
        `测试里出现对 AI 网关的真实请求（${url}）：要么用 vi.stubGlobal('fetch', ...) 打桩，` +
          `要么这个用例不该联网。测试不许花用户的钱。`
      )
    );
  }
  return realFetch(input as never, init);
}) as typeof fetch;
