import { shanghaiDateDaysAgo } from '../../shared/time';
import { IconArrowLeft, IconChevronDown, IconClose, IconGrid, IconList, IconRefresh, IconSearch, IconStar } from './Icons';

export interface QueryState {
  q: string;
  categoryId: string | null;
  timeField: 'published' | 'synced';
  range: 'all' | '7d' | '30d' | 'custom';
  from: string;
  to: string;
  order: 'desc' | 'asc';
  /** 只看已标星 */
  starred: boolean;
  /** 状态视图：active=工作集（默认），archived=过期+已取消，expired/uncollected 是细分 */
  status: 'active' | 'archived' | 'expired' | 'uncollected';
}

interface Props {
  query: QueryState;
  onChange(patch: Partial<QueryState>): void;
  onRefresh(): void;
  refreshing: boolean;
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
  q.starred;

export function Toolbar({
  query,
  onChange,
  onRefresh,
  refreshing,
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
  const onRangeChange = (range: QueryState['range']) => {
    if (range !== 'custom') {
      onChange({ range, from: '', to: '' });
      return;
    }
    // 预填最近 7 天（按上海日历日，与服务端筛选口径一致）
    onChange({ range, from: shanghaiDateDaysAgo(6), to: shanghaiDateDaysAgo(0) });
  };

  return (
    <div className="main-header">
      <div className="header-row">
        <h1 className="main-title">
          {showBack && onBack && (
            <button className="btn-back" onClick={onBack} aria-label="返回标签目录">
              <IconArrowLeft size={16} />
            </button>
          )}
          <span className="title-text">{title}</span>
          <span className="title-count">{scopeCount != null ? `${scopeCount} ${countUnit}` : ''}</span>
        </h1>
        {/* 刷新：统一使用 CSS 柔和玻璃胶囊（LiquidGlass 的 SVG 位移滤镜每次指针移动都要重建，帧耗过高） */}
        <button
          className={`btn-refresh${refreshing ? ' spinning' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          title={refreshing ? '刷新中…' : '读取 Obsidian 中新增的收藏'}
        >
          <IconRefresh size={14} />
          {refreshing ? '刷新中…' : '刷新收藏库'}
        </button>
      </div>

      {showViewToggle && (
        <div className="view-toggle" role="tablist" aria-label="展示模式">
          <button
            role="tab"
            aria-selected={viewMode === 'masonry'}
            className={viewMode === 'masonry' ? 'active' : ''}
            onClick={() => onViewMode?.('masonry')}
            title="瀑布流"
          >
            <IconGrid size={14} />
            瀑布流
          </button>
          <button
            role="tab"
            aria-selected={viewMode === 'table'}
            className={viewMode === 'table' ? 'active' : ''}
            onClick={() => onViewMode?.('table')}
            title="列表（表格）"
          >
            <IconList size={14} />
            列表
          </button>
        </div>
      )}

      {showFilters && (
        <>
          <div className="search-row">
            <div className="search-box">
              <IconSearch size={15} />
              <input
                type="text"
                value={query.q}
                placeholder={searchPlaceholder ?? '搜索标题、正文、作者或标签…'}
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

          <div className="filter-row">
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
            {/* 归档视图下的细分：只在这个视图里出现，默认视图不占地方 */}
            {query.status !== 'active' && (
              <label className="pill-select">
                <select
                  value={query.status}
                  onChange={(e) => onChange({ status: e.target.value as QueryState['status'] })}
                  aria-label="归档范围"
                >
                  <option value="archived">全部归档</option>
                  <option value="expired">已过期</option>
                  <option value="uncollected">已取消收藏</option>
                </select>
                <IconChevronDown />
              </label>
            )}
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
                    // 只清筛选，不动分类（分类是导航，不是筛选——保持原有行为）
                    onChange({
                      q: '',
                      range: 'all',
                      from: '',
                      to: '',
                      order: 'desc',
                      timeField: 'published',
                      starred: false,
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
