import { useState, type RefObject } from 'react';
import { shanghaiDateDaysAgo } from '../../shared/time';
import { IconArrowLeft, IconChevronDown, IconClose, IconGrid, IconList, IconMenu, IconSearch, IconSettings, IconStar } from './Icons';

export interface QueryState {
  q: string;
  categoryId: string | null;
  /** 来源维（web/微信）：与 categoryId 正交组合（AND） */
  source: string | null;
  timeField: 'published' | 'synced';
  range: 'all' | '7d' | '30d' | 'custom';
  from: string;
  to: string;
  order: 'desc' | 'asc';
  /** 只看已标星 */
  starred: boolean;
  /** 状态视图：active=在用（默认），archived=归档 */
  status: 'active' | 'archived';
}

interface Props {
  headerRef?: RefObject<HTMLDivElement | null>;
  headerHidden?: boolean;
  onOpenNavigation(): void;
  navigationOpen: boolean;
  query: QueryState;
  onChange(patch: Partial<QueryState>): void;
  /** 标题与范围计数由 App 计算传入（库视图 / 标签结果视图） */
  title: string;
  scopeCount: number | null;
  countUnit?: string;
  showFilters: boolean;
  searchPlaceholder?: string;
  showBack?: boolean;
  onBack?(): void;
  resultCount: number | null;
  listError: string | null;
  onRetry(): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  /** 展示模式（仅在显示内容时展示切换器） */
  showViewToggle?: boolean;
  viewMode?: 'masonry' | 'table';
  onViewMode?(v: 'masonry' | 'table'): void;
}

const isFiltered = (q: QueryState) =>
  q.q.trim() !== '' ||
  q.range !== 'all' ||
  q.order !== 'desc' ||
  q.timeField !== 'published' ||
  q.starred ||
  q.source !== null;

export function Toolbar({
  headerRef,
  headerHidden,
  onOpenNavigation,
  navigationOpen,
  query,
  onChange,
  title,
  scopeCount,
  countUnit = '篇',
  showFilters,
  searchPlaceholder,
  showBack,
  onBack,
  resultCount,
  listError,
  onRetry,
  onCompositionStart,
  onCompositionEnd,
  showViewToggle,
  viewMode,
  onViewMode,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = Number(query.starred) + Number(query.range !== 'all') +
    Number(query.timeField !== 'published') + Number(query.order !== 'desc') + Number(query.source !== null);
  const onRangeChange = (range: QueryState['range']) => {
    if (range !== 'custom') {
      onChange({ range, from: '', to: '' });
      return;
    }
    // 预填最近 7 天（按上海日历日，与服务端筛选口径一致）
    onChange({ range, from: shanghaiDateDaysAgo(6), to: shanghaiDateDaysAgo(0) });
  };

  return (
    <div ref={headerRef} className={`main-header${headerHidden ? ' header-hidden' : ''}`}>
      <div className="header-row">
        <button
          className="mobile-nav-toggle btn-icon"
          onClick={onOpenNavigation}
          aria-label="打开收藏库导航"
          aria-controls="library-navigation"
          aria-expanded={navigationOpen}
        >
          <IconMenu size={20} />
        </button>
        <h1 className="main-title">
          {showBack && onBack && (
            <button className="btn-back" onClick={onBack} aria-label="返回标签目录">
              <IconArrowLeft size={16} />
            </button>
          )}
          <span className="title-text">{title}</span>
          <span className="title-count">{scopeCount != null ? `${scopeCount} ${countUnit}` : ''}</span>
        </h1>
        {/* 刷新收藏库/导出语料已收进侧栏「设置」（v0.16.1）：低频操作不占工具栏常驻位，
            刷新进度改由设置按钮与侧栏底部「刷新中…」承载 */}
      </div>

      {showViewToggle && (
        <div className="view-toggle" role="group" aria-label="展示模式">
          <button
            aria-pressed={viewMode === 'masonry'}
            aria-label="瀑布流"
            className={viewMode === 'masonry' ? 'active' : ''}
            onClick={() => onViewMode?.('masonry')}
            title="瀑布流"
          >
            <IconGrid size={14} />
            <span className="view-toggle-label">瀑布流</span>
          </button>
          <button
            aria-pressed={viewMode === 'table'}
            aria-label="列表"
            className={viewMode === 'table' ? 'active' : ''}
            onClick={() => onViewMode?.('table')}
            title="列表（表格）"
          >
            <IconList size={14} />
            <span className="view-toggle-label">列表</span>
          </button>
        </div>
      )}

      {showFilters && (
        <>
          <div className="search-filter-row">
            <div className="search-row">
              <div className="search-box">
                <IconSearch size={15} />
                <input
                  type="text"
                  value={query.q}
                  placeholder={searchPlaceholder ?? '搜索标题、正文、作者、标签或备注…'}
                  onChange={(e) => onChange({ q: e.target.value })}
                  onCompositionStart={onCompositionStart}
                  onCompositionEnd={onCompositionEnd}
                  aria-label="搜索收藏"
                />
                {query.q !== '' && (
                  <button className="search-clear" onClick={() => onChange({ q: '' })} aria-label="清空搜索">
                    <IconClose size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* 手机把结果数与筛选并到搜索同一行（v0.18.1）：原先标题/视图/搜索/筛选各占一行，
                光顶部就吃掉约 1/3 屏。这里只在手机显示，桌面仍是 .filter-row 里的完整统计 */}
            <div className="mobile-filter-summary">
              {listError ? (
                <button className="link-clear" onClick={onRetry}>失败，重试</button>
              ) : (
                <span className="mobile-result-count">
                  <span className="mobile-result-prefix">结果 </span>
                  {resultCount ?? '…'}
                </span>
              )}
              <button
                className={`filter-toggle${filterCount ? ' on' : ''}`}
                aria-label={filterCount ? `筛选，已启用 ${filterCount} 项` : '筛选'}
                aria-expanded={filtersOpen}
                aria-controls="collection-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <IconSettings size={15} />
                {filterCount > 0 && <span className="filter-badge">{filterCount}</span>}
              </button>
            </div>
          </div>
          <div id="collection-filters" className={`filter-row${filtersOpen ? ' filters-open' : ''}`}>
            {/* 标星开关放在筛选行：它是一层筛选，必须和「当前结果 N 篇」在一起，
                否则列表变短的唯一线索就只剩侧栏那个入口 */}
            <button
              type="button"
              className={`pill-toggle${query.starred ? ' on' : ''}`}
              onClick={() =>
                // 打开标星时顺手清掉分类：标星是"我在意的那些"，与分类交叉会让侧栏计数
                // 和实际条数对不上（计数是全库口径）
                onChange(query.starred ? { starred: false } : { starred: true, categoryId: null })
              }
              aria-pressed={query.starred}
              title={query.starred ? '显示全部（含未标星）' : '只看已标星'}
            >
              <IconStar size={12} filled={query.starred} />
              标星
            </button>
            <label className="pill-select">
              <select
                value={query.range}
                onChange={(e) => onRangeChange(e.target.value as QueryState['range'])}
                aria-label="时间范围"
              >
                <option value="all">全部时间</option>
                <option value="7d">最近 7 天</option>
                <option value="30d">最近 30 天</option>
                <option value="custom">自定义</option>
              </select>
              <IconChevronDown />
            </label>
            {query.range === 'custom' && (
              <>
                <div className="filter-custom-dates">
                  <input
                    type="date"
                    value={query.from}
                    onChange={(e) => {
                      onChange({ from: e.target.value });
                    }}
                    aria-label="开始日期"
                  />
                  <span style={{ color: 'var(--text-weak)' }}>至</span>
                  <input
                    type="date"
                    value={query.to}
                    onChange={(e) => {
                      onChange({ to: e.target.value });
                    }}
                    aria-label="结束日期"
                  />
                </div>
                {!query.from && <span className="filter-dates-error">请选择开始日期</span>}
              </>
            )}
            <label className="pill-select">
              <select
                value={query.timeField}
                onChange={(e) => onChange({ timeField: e.target.value as QueryState['timeField'] })}
                aria-label="时间类型"
              >
                <option value="published">发布时间</option>
                <option value="synced">同步时间</option>
              </select>
              <IconChevronDown />
            </label>
            <label className="pill-select">
              <select
                value={query.order}
                onChange={(e) => onChange({ order: e.target.value as QueryState['order'] })}
                aria-label="排序"
              >
                <option value="desc">最新发布</option>
                <option value="asc">最早发布</option>
              </select>
              <IconChevronDown />
            </label>
            <div className="filter-result-count">
              {listError ? (
                <button className="link-clear" onClick={onRetry}>
                  加载失败，点击重试
                </button>
              ) : (
                <span>当前结果 {resultCount ?? '…'} 篇</span>
              )}
              {isFiltered(query) && (
                <button
                  className="link-clear"
                  onClick={() => {
                    // 只清筛选（搜索/时间/标星/**来源**），不动分类——分类是导航，不是筛选（保持原有行为）
                    onChange({
                      q: '',
                      range: 'all',
                      from: '',
                      to: '',
                      order: 'desc',
                      timeField: 'published',
                      starred: false,
                      source: null,
                    });
                  }}
                >
                  清除筛选
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 保留类型引用，避免未使用告警
