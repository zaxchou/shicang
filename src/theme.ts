// 主题模式：light / dark / system（跟随系统），持久化在 localStorage（仅 UI 偏好）。
export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'mb-theme';
const MODES: ThemeMode[] = ['light', 'dark', 'system'];

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'system';
  } catch {
    return 'system';
  }
}

export function effectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = effectiveTheme(getThemeMode());
}

const listeners = new Set<(mode: ThemeMode) => void>();

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 隐私模式下忽略 */
  }
  applyTheme();
  for (const fn of listeners) fn(mode);
}

export function subscribeTheme(fn: (mode: ThemeMode) => void): () => void {
  listeners.add(fn);
  // 系统主题变化时同步应用
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystem = () => {
    if (getThemeMode() === 'system') applyTheme();
  };
  mq.addEventListener('change', onSystem);
  return () => {
    listeners.delete(fn);
    mq.removeEventListener('change', onSystem);
  };
}
