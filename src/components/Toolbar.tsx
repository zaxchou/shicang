
import { IconArrowLeft, IconChevronDown, IconClose, IconGrid, IconList, IconRefresh, IconSearch } from './Icons';
import LiquidGlass from 'liquid-glass-react';
import { useEffectiveTheme } from '../theme';

export interface QueryState {
  q: string;
  categoryId: string | null;
  timeField: 'published' | 'synced';
  range: 'all' | '7d' | '30d' | 'custom';
  from: string;
  to: string;
  order: 'desc' | 'asc';
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
  q.q.trim() !== '' || q.range !== 'all' || q.order !== 'desc' || q.timeField !== 'published';

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
  const effectiveTheme = useEffectiveTheme();
  const onRangeChange = (range: QueryState['range']) => {
    if (range !== 'custom') {
      onChange({ range, from: '', to: '' });
      return;
    }
    // 预填最近 7 天
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 86400_000);
    onChange({ range, from: fmt(from), to: fmt(to) });
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
        {/* 暗色主题用 LiquidGlass 液态折射按钮；亮色下该库折射层偏暗，退回手写玻璃胶囊 */}
        {effectiveTheme === 'dark' ? (
          <div className="liquid-slot">
            <LiquidGlass
              displacementScale={64}
              blurAmount={0.12}
              saturation={130}
              aberrationIntensity={2}
              elasticity={0.32}
              cornerRadius={999}
              padding="0 17px"
              onClick={onRefresh}
            >
              <span className={`btn-refresh-liquid${refreshing ? ' spinning' : ''}`}>
                <IconRefresh size={14} />
                {refreshing ? '刷新中…' : '刷新收藏库'}
              </span>
            </LiquidGlass>
          </div>
        ) : (
          <button
            className={`btn-refresh${refreshing ? ' spinning' : ''}`}
            onClick={onRefresh}
            disabled={refreshing}
            title={refreshing ? '刷新中…' : '读取 Obsidian 中新增的收藏'}
          >
            <IconRefresh size={14} />
            {refreshing ? '刷新中…' : '刷新收藏库'}
          </button>
        )}
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
                    onChange({ q: '', range: 'all', from: '', to: '', order: 'desc', timeField: 'published' });
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
