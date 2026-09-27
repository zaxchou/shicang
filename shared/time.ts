// 时间边界与格式化：全部按 Asia/Shanghai 日历日计算（UTC+8，无夏令时）。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取 ISO 时间的上海日历日，返回 YYYY-MM-DD；非法返回 null */
export function shanghaiDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + SHANGHAI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD（上海日历日）→ 该日 00:00 的 UTC 毫秒；非法（含 6 月 31 日这类不存在日期）返回 null */
export function shanghaiDayStartMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d) - SHANGHAI_OFFSET_MS;
  if (Number.isNaN(ms)) return null;
  // 校验日期真实存在（防止 6/31 滚动到 7/1）
  const check = new Date(ms + SHANGHAI_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

/** 今天的上海日历日 */
export function todayShanghai(): string {
  return shanghaiDate(new Date().toISOString()) as string;
}

/** 含今天的最近 n 个自然日 [起始日00:00, 明日00:00) 的毫秒区间 */
export function lastNDaysRangeMs(n: number): [number, number] {
  const today = todayShanghai();
  const todayStart = shanghaiDayStartMs(today) as number;
  return [todayStart - (n - 1) * 24 * 3600 * 1000, todayStart + 24 * 3600 * 1000];
}

/** custom 起止日 → [起始00:00, 结束次日00:00)；to 缺省取 from */
export function customRangeMs(from: string, to?: string): [number, number] | null {
  const s = shanghaiDayStartMs(from);
  if (s === null) return null;
  const e = to ? shanghaiDayStartMs(to) : s;
  if (e === null) return null;
  return [s, e + 24 * 3600 * 1000];
}

/** 详情展示用：ISO → 上海本地 "YYYY-MM-DD HH:mm" */
export function formatShanghai(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = shanghaiDate(iso);
  if (!d) return null;
  const t = Date.parse(iso);
  const dt = new Date(t + SHANGHAI_OFFSET_MS);
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mm = String(dt.getUTCMinutes()).padStart(2, '0');
  return `${d} ${hh}:${mm}`;
}
