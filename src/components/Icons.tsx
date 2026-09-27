// SF Symbols 风格线性图标：圆润端点、均匀笔画、紧凑比例（对齐 Apple HIG 视觉语言）。
import type { ReactElement } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number | undefined, className: string | undefined) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export const IconSearch = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="10.8" cy="10.8" r="6.8" />
    <path d="M19.6 19.6 15.8 15.8" />
  </svg>
);

export const IconRefresh = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 12.5A8 8 0 1 1 17.4 6" />
    <path d="M20 3.5V9h-5.5" />
  </svg>
);

export const IconClose = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M17.5 6.5l-11 11M6.5 6.5l11 11" />
  </svg>
);

export const IconExternal = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5 11 13" />
    <path d="M17 13.5V18A1.5 1.5 0 0 1 15.5 19.5H6A1.5 1.5 0 0 1 4.5 18V8.5A1.5 1.5 0 0 1 6 7H10.5" />
  </svg>
);

export const IconChevronDown = ({ size, className }: IconProps) => (
  <svg {...base(size ?? 14, className)}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </svg>
);

export const IconChevronLeft = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M14.5 6 9 11.5 14.5 17" />
  </svg>
);

export const IconPlay = ({ size, className }: IconProps) => (
  <svg {...base(size ?? 11, className)} fill="currentColor" stroke="none">
    <path d="M8.2 5.2v13.6a1 1 0 0 0 1.52.86l10.4-6.8a1 1 0 0 0 0-1.72L9.72 4.34a1 1 0 0 0-1.52.86Z" />
  </svg>
);

export const IconLayers = ({ size, className }: IconProps) => (
  <svg {...base(size ?? 11, className)}>
    <path d="m12 3.5 8.5 4.7L12 12.9 3.5 8.2 12 3.5Z" />
    <path d="m3.5 12.6 8.5 4.7 8.5-4.7" />
  </svg>
);

export const IconLibrary = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20V4.5Z" />
    <path d="M5 19.2A1.8 1.8 0 0 1 6.8 17.4H19v3.1H6.8A1.8 1.8 0 0 1 5 20.4v-1.2Z" fill="currentColor" stroke="none" opacity="0.35" />
  </svg>
);

export const IconInbox = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20.8 12.6h-5.2l-1.6 2.6h-4l-1.6-2.6H3.2" />
    <path d="M6.1 5.2 3.2 11v6A1.9 1.9 0 0 0 5.1 19h13.8a1.9 1.9 0 0 0 1.9-1.9V11l-2.9-5.8A1.9 1.9 0 0 0 16.1 4H7.9a1.9 1.9 0 0 0-1.8 1.2Z" />
  </svg>
);

export const IconBrush = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M14.8 3.7 20.3 9.2 10 19.5a2.2 2.2 0 0 1-1.2.62l-5.2.78.78-5.2A2.2 2.2 0 0 1 5 14.5L14.8 3.7Z" />
    <path d="m13.1 5.6 5.3 5.3" opacity="0.6" />
  </svg>
);

export const IconCpu = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="3" />
    <rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1.2" />
    <path d="M9.2 2.8v2.4M14.8 2.8v2.4M9.2 18.8v2.4M14.8 18.8v2.4M2.8 9.2h2.4M2.8 14.8h2.4M18.8 9.2h2.4M18.8 14.8h2.4" />
  </svg>
);

export const IconPalette = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 3a9 9 0 1 0 .2 18c1.6 0 2.3-1 1.8-2.2-.6-1.5.2-2.8 1.9-2.8h1.9A4.2 4.2 0 0 0 21 11.8C20.8 6.9 16.9 3 12 3Z" />
    <circle cx="7.8" cy="11.2" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10.4" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.9" cy="7.2" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconBox = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20.5 8.4v7.2a2 2 0 0 1-1 1.73l-6.5 3.75a2 2 0 0 1-2 0l-6.5-3.75a2 2 0 0 1-1-1.73V8.4a2 2 0 0 1 1-1.73l6.5-3.75a2 2 0 0 1 2 0l6.5 3.75a2 2 0 0 1 1 1.73Z" />
    <path d="m3.7 7.2 8.3 4.8 8.3-4.8M12 21v-9" />
  </svg>
);

export const IconGlobe = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M3.4 12h17.2M12 3.4a14.5 14.5 0 0 1 0 17.2M12 3.4a14.5 14.5 0 0 0 0 17.2" />
  </svg>
);

export const IconLeaf = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M11.2 20.2A7.4 7.4 0 0 1 4 12.8C4 7.6 8.2 3.7 13.4 2.8c3-.5 6-.3 7 .1.3 1 .6 4.1 0 7.2-1 5.4-5.2 9.4-10 9.4h-.2Z" />
    <path d="M4.4 21c3-5.2 7.2-9.4 12.4-12.4" />
  </svg>
);

export const IconTag = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12.4 3.8 20.2 11.6a2 2 0 0 1 0 2.83l-5.77 5.77a2 2 0 0 1-2.83 0L3.8 12.4V5.8a2 2 0 0 1 2-2h6.6Z" />
    <circle cx="8.3" cy="8.3" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCheck = ({ size, className }: IconProps) => (
  <svg {...base(size ?? 14, className)}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const IconSun = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
  </svg>
);

export const IconMoon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20.6 14.2A8.8 8.8 0 0 1 9.8 3.4a8.8 8.8 0 1 0 10.8 10.8Z" />
  </svg>
);

export const IconMonitor = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect x="3" y="4.2" width="18" height="12.4" rx="2.4" />
    <path d="M8.6 20.4h6.8M12 16.6v3.8" />
  </svg>
);

export const IconArrowLeft = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M19 12H5M11.5 5.5 5 12l6.5 6.5" />
  </svg>
);

export const CATEGORY_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  shuhua: IconBrush,
  'ai-programming': IconCpu,
  'design-aigc': IconPalette,
  'maker-digital': IconBox,
  'language-learning': IconGlobe,
  life: IconLeaf,
};

export function categoryIcon(id: string) {
  return CATEGORY_ICONS[id] ?? IconBrush;
}
