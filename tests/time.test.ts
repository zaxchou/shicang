import { describe, expect, it } from 'vitest';
import {
  customRangeMs,
  formatShanghai,
  lastNDaysRangeMs,
  shanghaiDate,
  shanghaiDayStartMs,
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

  it('最近 7 天含今天共 7 个自然日', () => {
    const [s, e] = lastNDaysRangeMs(7);
    expect(e - s).toBe(7 * 24 * 3600 * 1000);
  });

  it('自定义区间为 [起始00:00, 结束次日00:00)', () => {
    const [s, e] = customRangeMs('2026-06-01', '2026-06-03')!;
    expect(e - s).toBe(3 * 24 * 3600 * 1000);
    expect(customRangeMs('2026-06-31', '2026-06-03')).toBeNull();
  });

  it('格式化输出上海本地时间', () => {
    expect(formatShanghai('2026-06-01T16:30:05.000Z')).toBe('2026-06-02 00:30');
    expect(formatShanghai(null)).toBeNull();
    expect(formatShanghai('not-a-date')).toBeNull();
  });
});
