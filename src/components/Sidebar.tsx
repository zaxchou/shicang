import { useState } from 'react';
import type { CollectionInfo, LibraryInfo } from '../../shared/types';
import {
  IconArchive,
  IconBook,
  IconChevronDown,
  IconGlobe,
  IconInbox,
  IconLayers,
  IconLibrary,
  IconPen,
  IconStar,
  IconTag,
  categoryIcon,
  IconGem,
} from './Icons';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  library: LibraryInfo | null;
  /** 当前作用域：收藏库 id 或分组 id（如 clippings=剪藏） */
  collection: string;
  activeCategoryId: string | null; // null=该库全部
  tagsView: boolean; // 当前是否处于标签视图
  starredOnly: boolean; // 当前是否只看标星
  archiveView: boolean; // 当前是否处于归档视图
  onSelectCollection(id: string): void;
  onSelectCategory(id: string | null): void;
  onSelectTags(): void;
  onSelectStarred(): void;
  onSelectArchive(): void;
}

const COLLECTION_ICONS: Record<string, typeof IconLibrary> = {
  rednote: IconLibrary,
  treasures: IconGem,
  diary: IconPen,
  web: IconGlobe,
  wechat: IconBook,
};
const GROUP_ICON = IconLayers;

export function Sidebar({
  library,
  collection,
  activeCategoryId,
  tagsView,
  starredOnly,
  archiveView,
  onSelectCollection,
  onSelectCategory,
  onSelectTags,
  onSelectStarred,
  onSelectArchive,
}: Props) {
  const infos = library?.collections ?? [];
  const groups = library?.groups ?? [];
  const curGroup = groups.find((g) => g.id === collection) ?? null;
  const cur: CollectionInfo | null = infos.find((c) => c.id === collection) ?? null;
  // 标星/归档的计数口径 = 当前作用域（组 = 成员聚合，点进去看到的条数必须和这里一致）
  const scopeStarred = curGroup ? curGroup.starred : (cur?.starred ?? 0);
  const scopeArchived = curGroup ? curGroup.archived : (cur?.archived ?? 0);
  // 分类区只对"单个库"显示：分类是各子库自己的概念（小红书的六类、网页的来源站点），
  // 组视图下混着展示只会困惑——子分类靠点子库进去看
  const showCategories = curGroup === null && (cur?.categories.length ?? 0) > 0;

  // 分组的展开/收起：默认全展开（子库要一眼能看见）；收起状态记到 localStorage
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('mb-groups-collapsed') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem('mb-groups-collapsed', JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const groupedIds = new Set(groups.flatMap((g) => g.collectionIds));
  const standalone = infos.filter((c) => !groupedIds.has(c.id));

  const collectionButton = (c: CollectionInfo, sub = false) => {
    const Icon = COLLECTION_ICONS[c.id] ?? IconLibrary;
    const active = !tagsView && c.id === collection;
    return (
      <button
        key={c.id}
        className={`nav-item${sub ? ' nav-sub' : ''}${active ? ' active' : ''}`}
        onClick={() => onSelectCollection(c.id)}
        aria-current={active ? 'page' : undefined}
      >
        <Icon size={sub ? 14 : 15} />
        <span className="nav-label">{c.name}</span>
        {/* 计数用"工作集"（在用）：点进去看到的条数必须和这里一致 */}
        <span className="nav-count">{c.active}</span>
      </button>
    );
  };

  return (
    <aside className="sidebar glass-surface">
      <div className="sidebar-brand">
        <img src="/icon-96.png" alt="" className="brand-icon" aria-hidden />
        <span>拾藏</span>
      </div>
      <nav className="sidebar-nav" aria-label="收藏库与分类">
        <div className="nav-section">收藏库</div>
        {groups.map((g) => {
          const groupActive = !tagsView && g.id === collection;
          const expanded = !collapsed.has(g.id);
          return (
            <div key={g.id} className="nav-group">
              <div className="nav-group-row">
                {/* 点组名 = 看组内全部子库的笔记（搜索也跨子库）；右边的小箭头只负责展开/收起 */}
                <button
                  className={`nav-item nav-group-main${groupActive ? ' active' : ''}`}
                  onClick={() => onSelectCollection(g.id)}
                  aria-current={groupActive ? 'page' : undefined}
                >
                  <GROUP_ICON size={15} />
                  <span className="nav-label">{g.name}</span>
                  <span className="nav-count">{g.active}</span>
                </button>
                <button
                  type="button"
                  className="nav-caret"
                  aria-label={expanded ? `收起${g.name}的子收藏库` : `展开${g.name}的子收藏库`}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(g.id)}
                >
                  <IconChevronDown size={12} className={expanded ? 'caret open' : 'caret'} />
                </button>
              </div>
              {expanded &&
                g.collectionIds.map((cid) => {
                  const child = infos.find((x) => x.id === cid);
                  return child ? collectionButton(child, true) : null;
                })}
            </div>
          );
        })}
        {standalone.map((c) => collectionButton(c))}

        {showCategories && (
          <>
            <div className="nav-section">分类</div>
            {cur!.categories.map((c) => {
              // 派生分类（收藏分类/日记主题/网页来源）统一用标签图标；rednote 用类目图标
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
            {/* 未分类固定排在分类列表末尾，不参与上面的类目排序；
                计数为 0 时整条隐藏（用户要求：没有未分类就别显示这一项） */}
            {cur!.uncategorized > 0 && (
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
        {/* 标星是当前作用域（库或组）内的一层筛选（计数与这里一致），选中它会清掉分类筛选 */}
        <button
          className={`nav-item${starredOnly ? ' active' : ''}`}
          onClick={onSelectStarred}
          aria-current={starredOnly ? 'page' : undefined}
          title="只看已标星的笔记"
        >
          <IconStar size={15} filled={starredOnly} />
          <span className="nav-label">标星</span>
          <span className="nav-count">{scopeStarred}</span>
        </button>
        {/* 归档：只表示"现在对我来说没用了"。点进去会带上源文件已消失的记录（标注不随文件消失） */}
        <button
          className={`nav-item${archiveView ? ' active' : ''}`}
          onClick={onSelectArchive}
          aria-current={archiveView ? 'page' : undefined}
          title="已归档的笔记（随时可以取回）"
        >
          <IconArchive size={15} />
          <span className="nav-label">归档</span>
          <span className="nav-count">{scopeArchived}</span>
        </button>
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
