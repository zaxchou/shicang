import { describe, expect, it, vi } from 'vitest';
import {
  customRangeMs,
  formatShanghai,
  lastNDaysRangeMs,
  shanghaiDate,
  shanghaiDateDaysAgo,
  shanghaiDayStartMs,
  todayShanghai,
} from '../shared/time';

describe('上海时区边界', () => {
  it('UTC 时间映射到正确的上海日历日（跨午夜）', () => {
    // 2026-06-01 16:00Z = 上海 6/2 00:00
    expect(shanghaiDate('2026-06-01T16:00:00.000Z')).toBe('2026-06-02');
    // 2026-06-01 15:59:59Z = 上海 6/1 23:59:59
    expect(shanghaiDate('2026-06-01T15:59:59.000Z')).toBe('2026-06-01');
  });

  it('日界毫秒值正确', () => {
    expect(shanghaiDayStartMs('2026-06-02')).toBe(Date.UTC(2026, 5, 2) - 8 * 3600 * 1000);
    expect(shanghaiDayStartMs('2026-13-01')).toBeNull();
    expect(shanghaiDayStartMs('bad')).toBeNull();
  });

  it('最近 7 天：起点是今天往前 6 天的 00:00，终点是明日 00:00（不只是跨度对）', () => {
    // 钉死时钟：断言锚定"今天"，两处各取一次 todayShanghai 会在上海午夜跨天时必红（深审发现）
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00+08:00'));
    try {
      const [s, e] = lastNDaysRangeMs(7);
      expect(e - s).toBe(7 * 24 * 3600 * 1000);
      // 2026-06-04 00:00 +08 → 06-03T16:00Z；2026-06-11 00:00 +08 → 06-10T16:00Z
      expect(s).toBe(Date.UTC(2026, 5, 3, 16));
      expect(e).toBe(Date.UTC(2026, 5, 10, 16));
    } finally {
      vi.useRealTimers();
    }
  });

  it('往前推 N 天的上海日历日（前端预填自定义范围用）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00+08:00'));
    try {
      expect(todayShanghai()).toBe('2026-06-10');
      expect(shanghaiDateDaysAgo(0)).toBe('2026-06-10');
      expect(shanghaiDateDaysAgo(6)).toBe('2026-06-04');
      expect(
        shanghaiDayStartMs('2026-06-10')! - shanghaiDayStartMs('2026-06-04')!
      ).toBe(6 * 24 * 3600 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('自定义区间为 [起始00:00, 结束次日00:00)', () => {
    const [s, e] = customRangeMs('2026-06-01', '2026-06-03')!;
    expect(e - s).toBe(3 * 24 * 3600 * 1000);
    expect(customRangeMs('2026-06-31', '2026-06-03')).toBeNull();
    // to 缺省 = 单日；跨月边界要按 31 天/30 天算
    expect(customRangeMs('2026-06-15')).toEqual([
      shanghaiDayStartMs('2026-06-15')!,
      shanghaiDayStartMs('2026-06-16')!,
    ]);
    const [ms, me] = customRangeMs('2026-01-31', '2026-02-01')!;
    expect(me - ms).toBe(2 * 24 * 3600 * 1000);
    // 反向区间当前返回空区间（start > end），筛选结果为空而非报错——记录现状
    const [rs, re] = customRangeMs('2026-06-05', '2026-06-01')!;
    expect(rs).toBeGreaterThan(re);
  });

  it('格式化输出上海本地时间', () => {
    expect(formatShanghai('2026-06-01T16:30:05.000Z')).toBe('2026-06-02 00:30');
    expect(formatShanghai(null)).toBeNull();
    expect(formatShanghai('not-a-date')).toBeNull();
  });
});
