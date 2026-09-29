// 库就绪轮询的节奏决策（纯函数，便于回归——评审 2026-09-30 R2）。
// 原实现 150 次（约 5 分钟）一刀切停表：启动自刷 + 40 次 AI 兜底完全可能超过 5 分钟，
// 到点后前端再也没有下一次 /api/library 能观察到 ready——页面永久停在"刷新中"、刷新入口被禁用。
export function bootPollDelayMs(indexStatus: string | null | undefined, polls: number): number | null {
  if (indexStatus === 'ready') return null;
  if (indexStatus === 'scanning') {
    // 服务端明确还在扫描：陪到底，150 次后退避到 5s——转圈显示的是真实状态，不存在"永远解除不了"
    return polls < 150 ? 2000 : 5000;
  }
  // 真空库（empty）/未知状态（如持续请求失败）：保留原 150 次兜底，不给"永远每 2s 打一次"留口子
  return polls < 150 ? 2000 : null;
}
