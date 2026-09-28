import { describe, expect, it } from 'vitest';
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
    const [s, e] = lastNDaysRangeMs(7);
    expect(e - s).toBe(7 * 24 * 3600 * 1000);
    // 整体偏移一天的实现也能满足"跨度 = 7 天"，所以必须锚定到今天
    const todayStart = shanghaiDayStartMs(todayShanghai())!;
    expect(e).toBe(todayStart + 24 * 3600 * 1000);
    expect(s).toBe(todayStart - 6 * 24 * 3600 * 1000);
  });

  it('往前推 N 天的上海日历日（前端预填自定义范围用）', () => {
    const today = todayShanghai();
    expect(shanghaiDateDaysAgo(0)).toBe(today);
    const back = shanghaiDateDaysAgo(6);
    expect(shanghaiDayStartMs(today)! - shanghaiDayStartMs(back)!).toBe(6 * 24 * 3600 * 1000);
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
