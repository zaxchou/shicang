import type { CollectionInfo, LibraryInfo } from '../../shared/types';
import { IconInbox, IconLibrary, IconPen, IconTag, categoryIcon, IconGem } from './Icons';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  library: LibraryInfo | null;
  /** 当前收藏库 id */
  collection: string;
  activeCategoryId: string | null; // null=该库全部
  tagsView: boolean; // 当前是否处于标签视图
  onSelectCollection(id: string): void;
  onSelectCategory(id: string | null): void;
  onSelectTags(): void;
}

const COLLECTION_ICONS: Record<string, typeof IconLibrary> = {
  rednote: IconLibrary,
  treasures: IconGem,
  diary: IconPen,
};

export function Sidebar({
  library,
  collection,
  activeCategoryId,
  tagsView,
  onSelectCollection,
  onSelectCategory,
  onSelectTags,
}: Props) {
  const infos = library?.collections ?? [];
  const cur: CollectionInfo | null = infos.find((c) => c.id === collection) ?? null;
  const hasCategories = (cur?.categories.length ?? 0) > 0;

  return (
    <aside className="sidebar glass-surface">
      <div className="sidebar-brand">
        <img src="/icon-96.png" alt="" className="brand-icon" aria-hidden />
        <span>拾藏</span>
      </div>
      <nav className="sidebar-nav" aria-label="收藏库与分类">
        <div className="nav-section">收藏库</div>
        {infos.map((c) => {
          const Icon = COLLECTION_ICONS[c.id] ?? IconLibrary;
          return (
            <button
              key={c.id}
              className={`nav-item${!tagsView && c.id === collection ? ' active' : ''}`}
              onClick={() => onSelectCollection(c.id)}
              aria-current={!tagsView && c.id === collection ? 'page' : undefined}
            >
              <Icon size={15} />
              <span className="nav-label">{c.name}</span>
              <span className="nav-count">{c.total}</span>
            </button>
          );
        })}

        {hasCategories && (
          <>
            <div className="nav-section">分类</div>
            {cur!.categories.map((c) => {
              // 派生分类（收藏分类/日记主题）统一用标签图标；rednote 用类目图标
              const Icon = collection === 'rednote' ? categoryIcon(c.id) : IconTag;
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
            {/* 未分类固定排在分类列表末尾，不参与上面的类目排序 */}
            {(cur!.uncategorized > 0 || collection === 'rednote') && (
              <button
                className={`nav-item nav-item-last${!tagsView && activeCategoryId === 'uncategorized' ? ' active' : ''}`}
                onClick={() => onSelectCategory('uncategorized')}
                aria-current={!tagsView && activeCategoryId === 'uncategorized' ? 'page' : undefined}
              >
                <IconInbox size={15} />
                <span className="nav-label">未分类</span>
                <span className="nav-count">{cur!.uncategorized}</span>
              </button>
            )}
          </>
        )}

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
