// 启动轮询节奏（评审 2026-09-30 R2）：长扫描不再把页面卡死在"刷新中"。
// 原实现 150 次一刀切停表后，前端再无下一次 /api/library 能观察到 ready——
// 服务端扫完页面也不知道，刷新入口永久禁用。scanning 必须陪到底（退避），empty/失败才走兜底。
import { describe, expect, it } from 'vitest';
import { bootPollDelayMs } from '../src/lib/boot-poll';

describe('启动轮询节奏（bootPollDelayMs，评审 R2）', () => {
  it('ready 即停', () => {
    expect(bootPollDelayMs('ready', 0)).toBeNull();
    expect(bootPollDelayMs('ready', 999)).toBeNull();
  });

  it('scanning 超过 150 次仍继续（退避 5s）：长扫描不再冻结页面', () => {
    expect(bootPollDelayMs('scanning', 0)).toBe(2000);
    expect(bootPollDelayMs('scanning', 149)).toBe(2000);
    expect(bootPollDelayMs('scanning', 150)).toBe(5000);
    expect(bootPollDelayMs('scanning', 10_000)).toBe(5000); // 没有"第二次到点卡死"的边界
  });

  it('empty / 未知状态（含持续失败）保留 150 次兜底，不永远打接口', () => {
    expect(bootPollDelayMs('empty', 149)).toBe(2000);
    expect(bootPollDelayMs('empty', 150)).toBeNull();
    expect(bootPollDelayMs(null, 150)).toBeNull();
    expect(bootPollDelayMs(undefined, 150)).toBeNull();
  });
});
