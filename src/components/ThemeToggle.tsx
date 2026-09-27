import { useEffect, useState } from 'react';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '../theme';
import { IconMonitor, IconMoon, IconSun } from './Icons';

const OPTIONS: Array<{ mode: ThemeMode; label: string; Icon: typeof IconSun }> = [
  { mode: 'light', label: '亮色', Icon: IconSun },
  { mode: 'dark', label: '深色', Icon: IconMoon },
  { mode: 'system', label: '跟随系统', Icon: IconMonitor },
];

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  useEffect(() => subscribeTheme(setMode), []);
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="界面主题">
      {OPTIONS.map(({ mode: m, label, Icon }) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          aria-label={label}
          title={label}
          className={mode === m ? 'active' : ''}
          onClick={() => setThemeMode(m)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
