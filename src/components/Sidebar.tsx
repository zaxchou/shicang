import { useEffect, useRef, useState } from 'react';
import type { CollectionInfo, LibraryInfo } from '../../shared/types';
import {
  IconArchive,
  IconBook,
  IconChevronDown,
  IconExport,
  IconGlobe,
  IconInbox,
  IconLayers,
  IconLibrary,
  IconPen,
  IconRefresh,
  IconSettings,
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
  activeCategoryId: string | null; // null=该库全部（分类维=主题）
  /** 来源维的激活项（web/微信：哔哩哔哩…；null=不按来源筛） */
  activeSource: string | null;
  tagsView: boolean; // 当前是否处于标签视图
  starredOnly: boolean; // 当前是否只看标星
  archiveView: boolean; // 当前是否处于归档视图
  /** 刷新中（手动刷新或启动自刷）：设置菜单项转圈 + 底部「刷新中…」 */
  refreshing: boolean;
  exporting: boolean;
  onRefresh(): void;
  onExportCorpus(): void;
  onSelectCollection(id: string): void;
  onSelectCategory(id: string | null): void;
  onSelectSource(id: string | null): void;
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
/** 走人工分类层的库类型（与服务端 setCategory / 详情分类选择器同一口径）：rednote 与 web 型 */
const managedCategoryTypes = new Set(['rednote', 'web']);

export function Sidebar({
  library,
  collection,
  activeCategoryId,
  activeSource,
  tagsView,
  starredOnly,
  archiveView,
  refreshing,
  exporting,
  onRefresh,
  onExportCorpus,
  onSelectCollection,
  onSelectCategory,
  onSelectSource,
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
  // 分类/来源两段按作用域取数：单库取 collectionInfo，组取 v0.16 起聚合的 groupInfo
  //（v0.12 的"组视图不显示分类/来源"决策已撤销——三个成员库共用类目表后组级主题成立，用户批准）
  const scopeInfo = curGroup ?? cur;
  const cats = scopeInfo?.categories ?? [];
  const srcs = scopeInfo?.sources ?? [];
  const uncat = scopeInfo?.uncategorized ?? 0;
  const showCategories = cats.length > 0;
  /** 来源段只有 web 型（网页/微信公众号）有值，且没有"无来源"行——手写笔记本来就没有来源 */
  const showSources = srcs.length > 0;

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

  // ---- 设置菜单（v0.16.1）：低频操作（刷新/导出/主题）的收纳容器，未来新选项也加在这里 ----
  // 点击外部/Esc 关闭——照抄详情里分类选择器（cat-picker）的成熟模式
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

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
            {cats.map((c) => {
              // 类目图标按 id 映射（rednote/web 共用同一份类目表）；组作用域没有单一 type，
              // 但组的成员全是托管型（否则聚合口径早就混了）→ 直接走类目图标；其余回落标签图标
              const managed = curGroup !== null || managedCategoryTypes.has(cur?.type ?? '');
              const Icon = managed ? categoryIcon(c.id) : IconTag;
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
            {uncat > 0 && (
              <button
                className={`nav-item nav-item-last${!tagsView && activeCategoryId === 'uncategorized' ? ' active' : ''}`}
                onClick={() => onSelectCategory('uncategorized')}
                aria-current={!tagsView && activeCategoryId === 'uncategorized' ? 'page' : undefined}
              >
                <IconInbox size={15} />
                <span className="nav-label">未分类</span>
                <span className="nav-count">{uncat}</span>
              </button>
            )}

            {/* 来源段（仅网页/微信）：与分类维正交，两个可以同时激活（AND） */}
            {showSources && (
              <>
                <div className="nav-section">来源</div>
                {srcs.map((c) => {
                  const active = !tagsView && activeSource === c.id;
                  return (
                    <button
                      key={c.id}
                      className={`nav-item${active ? ' active' : ''}`}
                      onClick={() => onSelectSource(c.id)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <IconGlobe size={15} />
                      <span className="nav-label">{c.name}</span>
                      <span className="nav-count">{c.count}</span>
                    </button>
                  );
                })}
              </>
            )}
          </>
        )}

        <div className="nav-section">发现</div>
        {/* 标星是当前作用域（库或组）内的一层筛选（计数与这里一致），选中它会清掉分类与来源筛选 */}
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
        <div className="settings-wrap" ref={settingsRef}>
          {settingsOpen && (
            <div className="settings-menu" role="menu" aria-label="设置">
              <div className="settings-theme-row">
                <span className="settings-label">界面主题</span>
                <ThemeToggle />
              </div>
              <button
                role="menuitem"
                className={`settings-menu-item${refreshing ? ' spinning' : ''}`}
                onClick={() => {
                  setSettingsOpen(false);
                  onRefresh();
                }}
                disabled={refreshing}
                title={refreshing ? '刷新中…' : '读取 Obsidian 中新增的收藏'}
              >
                <IconRefresh size={14} />
                {refreshing ? '刷新中…' : '刷新收藏库'}
              </button>
              <button
                role="menuitem"
                className={`settings-menu-item${exporting ? ' pulsing' : ''}`}
                onClick={() => {
                  setSettingsOpen(false);
                  onExportCorpus();
                }}
                disabled={exporting}
                title={
                  exporting
                    ? '正在导出…'
                    : '把全部笔记导成可检索的语料（corpus.jsonl / catalog.md / manifest.json）；刷新收藏库后会自动更新'
                }
              >
                <IconExport size={14} />
                {exporting ? '导出中…' : '导出语料'}
              </button>
            </div>
          )}
          <button
            className="settings-btn"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <IconSettings size={15} />
            <span className="nav-label">设置</span>
          </button>
        </div>
        {/* 版本与最近刷新留在菜单外面（用户要求）：一眼判断数据是不是最新的 */}
        <div className="foot-meta">
          {library?.version && <span className="foot-version">v{library.version}</span>}
          <span className="foot-scan">
            {refreshing
              ? '刷新中…'
              : library?.lastScan?.finishedAt
                ? `最近刷新：${new Date(library.lastScan.finishedAt).toLocaleString('zh-CN', { hour12: false })}，新增 ${library.lastScan.added} 篇`
                : '尚未刷新过收藏库'}
          </span>
        </div>
      </div>
    </aside>
  );
}
