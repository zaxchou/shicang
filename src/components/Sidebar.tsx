import type { LibraryInfo } from '../../shared/types';
import { IconInbox, IconLibrary, IconTag, categoryIcon } from './Icons';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  library: LibraryInfo | null;
  activeCategoryId: string | null; // null=全部
  tagsView: boolean; // 当前是否处于标签视图
  onSelectCategory(id: string | null): void;
  onSelectTags(): void;
}

export function Sidebar({ library, activeCategoryId, tagsView, onSelectCategory, onSelectTags }: Props) {
  const categories = library?.categories ?? [];
  return (
    <aside className="sidebar glass-surface">
      <div className="sidebar-brand">
        <img src="/icon.svg" alt="" className="brand-icon" aria-hidden />
        <span>拾藏</span>
      </div>
      <nav className="sidebar-nav" aria-label="收藏分类">
        <button
          className={`nav-item${!tagsView && activeCategoryId === null ? ' active' : ''}`}
          onClick={() => onSelectCategory(null)}
          aria-current={!tagsView && activeCategoryId === null ? 'page' : undefined}
        >
          <IconLibrary size={15} />
          <span className="nav-label">全部收藏</span>
          <span className="nav-count">{library?.total ?? '—'}</span>
        </button>
        <button
          className={`nav-item${!tagsView && activeCategoryId === 'uncategorized' ? ' active' : ''}`}
          onClick={() => onSelectCategory('uncategorized')}
          aria-current={!tagsView && activeCategoryId === 'uncategorized' ? 'page' : undefined}
        >
          <IconInbox size={15} />
          <span className="nav-label">未分类</span>
          <span className="nav-count">{library?.uncategorized ?? '—'}</span>
        </button>
        <div className="nav-section">分类</div>
        {categories.map((c) => {
          const Icon = categoryIcon(c.id);
          const active = !tagsView && activeCategoryId === c.id;
          return (
            <button
              key={c.id}
              className={`nav-item${active ? ' active' : ''}`}
              onClick={() => onSelectCategory(c.id)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={15} />
              <span className="nav-label">{c.name}</span>
              <span className="nav-count">{c.count}</span>
            </button>
          );
        })}
        <div className="nav-section">发现</div>
        <button
          className={`nav-item${tagsView ? ' active' : ''}`}
          onClick={onSelectTags}
          aria-current={tagsView ? 'page' : undefined}
        >
          <IconTag size={15} />
          <span className="nav-label">标签</span>
          <span className="nav-count">{library ? '›' : ''}</span>
        </button>
      </nav>
      <div className="sidebar-foot">
        <ThemeToggle />
        {library?.lastScan?.finishedAt
          ? `最近刷新：${new Date(library.lastScan.finishedAt).toLocaleString('zh-CN', { hour12: false })}，新增 ${library.lastScan.added} 篇`
          : '尚未刷新过收藏库'}
      </div>
    </aside>
  );
}
