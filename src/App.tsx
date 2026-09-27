import { useCallback, useEffect, useRef, useState } from 'react';
import type { Category, LibraryInfo, NoteSummary, RefreshJobInfo, TagCount } from '../shared/types';
import { api, ApiError, type QueryParams } from './api/client';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type QueryState } from './components/Toolbar';
import { Masonry } from './components/Masonry';
import { DetailDialog } from './components/DetailDialog';
import { TagsDirectory } from './components/TagsDirectory';
import { IconRefresh } from './components/Icons';

const PAGE_SIZE = 60;

const INITIAL_QUERY: QueryState = {
  q: '',
  categoryId: null,
  timeField: 'published',
  range: 'all',
  from: '',
  to: '',
  order: 'desc',
};

type View = 'library' | 'tags';

export default function App() {
  const [library, setLibrary] = useState<LibraryInfo | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const [view, setView] = useState<View>('library');
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const [query, setQuery] = useState<QueryState>(INITIAL_QUERY);
  const [items, setItems] = useState<NoteSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [indexRevision, setIndexRevision] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [detailSummary, setDetailSummary] = useState<NoteSummary | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null);

  const seqRef = useRef(0);
  const composingRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const focusedCardRef = useRef<HTMLElement | null>(null);
  const cardElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pollingRef = useRef<number | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const viewRef = useRef(view);
  viewRef.current = view;
  const activeTagRef = useRef(activeTag);
  activeTagRef.current = activeTag;
  const revisionRef = useRef(indexRevision);
  revisionRef.current = indexRevision;

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4200);
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const [lib, cats] = await Promise.all([api.library(), api.categories()]);
      setLibrary(lib);
      setCategories(cats.categories);
      setLibraryError(null);
    } catch (e) {
      setLibraryError(e instanceof ApiError ? e.message : '加载收藏库信息失败');
    }
  }, []);

  const loadTags = useCallback(async () => {
    try {
      const r = await api.tags();
      setTags(r.tags);
      setTagsError(null);
    } catch (e) {
      setTagsError(e instanceof ApiError ? e.message : '加载标签失败');
    }
  }, []);

  // 查询列表；请求序号防止过期响应覆盖。标签目录模式不拉列表。
  const fetchPage = useCallback(async (offset: number, append = false) => {
    if (viewRef.current === 'tags' && !activeTagRef.current) {
      setListLoading(false);
      return;
    }
    const q = queryRef.current;
    const seq = ++seqRef.current;
    if (append) setLoadingMore(true);
    else setListLoading(true);
    try {
      const params: QueryParams = {
        q: q.q,
        categoryId: viewRef.current === 'library' ? q.categoryId : null,
        tag: viewRef.current === 'tags' ? activeTagRef.current : null,
        timeField: q.timeField,
        range: q.range,
        from: q.range === 'custom' && q.from ? q.from : undefined,
        to: q.range === 'custom' && q.to ? q.to : undefined,
        order: q.order,
        offset,
        limit: PAGE_SIZE,
      };
      const res = await api.notes(params);
      if (seq !== seqRef.current) return; // 过期响应丢弃
      setTotal(res.total);
      setListError(null);
      if (append && revisionRef.current === res.indexRevision) {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...res.items.filter((i) => !seen.has(i.id))];
        });
      } else {
        setItems(res.items);
      }
      setIndexRevision(res.indexRevision);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setListError(e instanceof ApiError ? e.message : '加载收藏列表失败');
    } finally {
      if (seq === seqRef.current) {
        setListLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // 首次加载
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // 玻璃表面的鼠标跟随高光（rAF 节流，更新根级 CSS 变量）
  useEffect(() => {
    let raf = 0;
    let px = -999;
    let py = -999;
    const flush = () => {
      raf = 0;
      const root = document.documentElement;
      root.style.setProperty('--gx', `${px}px`);
      root.style.setProperty('--gy', `${py}px`);
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // 查询/视图/标签变化 → 重新加载第一页（搜索防抖 200ms；输入法组合中延迟提交）
  useEffect(() => {
    const t = window.setTimeout(
      () => {
        if (!composingRef.current) void fetchPage(0);
      },
      200
    );
    return () => window.clearTimeout(t);
  }, [query, view, activeTag, fetchPage]);

  // 进入标签视图时加载标签目录
  useEffect(() => {
    if (view === 'tags') void loadTags();
  }, [view, indexRevision, loadTags]);

  // 筛选/视图变化滚动回顶部
  useEffect(() => {
    resultsRef.current?.scrollTo({ top: 0 });
  }, [query.categoryId, query.range, query.timeField, query.order, query.from, query.to, view, activeTag]);

  // 库就绪后（首次启动服务端自动扫描可能延迟）轮询刷新 library
  useEffect(() => {
    if (library && library.indexStatus !== 'scanning' && libraryError === null) return;
    const t = window.setInterval(() => void loadLibrary(), 2000);
    return () => window.clearInterval(t);
  }, [library, libraryError, loadLibrary]);

  const patchQuery = useCallback((patch: Partial<QueryState>) => {
    setQuery((prev) => ({ ...prev, ...patch }));
  }, []);

  const selectCategory = useCallback(
    (id: string | null) => {
      setView('library');
      setActiveTag(null);
      patchQuery({ categoryId: id });
    },
    [patchQuery]
  );

  const selectTagsView = useCallback(() => {
    setView('tags');
    setActiveTag(null);
  }, []);

  const selectTag = useCallback((tag: string) => {
    setActiveTag(tag);
    setItems([]);
    setTotal(null);
  }, []);

  const hasMore = total !== null && items.length < total;
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || listLoading) return;
    void fetchPage(items.length, true);
  }, [hasMore, loadingMore, listLoading, fetchPage, items.length]);

  // 触底自动加载
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const root = resultsRef.current;
    if (!el || !root) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: '600px' }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [loadMore]);

  // ---- 刷新收藏库 ----
  const startRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { job } = await api.startRefresh();
      const poll = async (j: RefreshJobInfo) => {
        if (j.state !== 'running') {
          pollingRef.current = null;
          setRefreshing(false);
          await loadLibrary();
          await loadTags();
          await fetchPage(0);
          if (j.state === 'completed') showToast(`刷新完成：新增 ${j.added} 篇`);
          else if (j.state === 'partial') showToast(`刷新部分完成：新增 ${j.added} 篇，${j.errors} 个问题`, 'error');
          else showToast(`刷新失败：${j.diagnostics[j.diagnostics.length - 1] ?? '未知错误'}`, 'error');
          return;
        }
        pollingRef.current = window.setTimeout(async () => {
          try {
            const { job: cur } = await api.refreshJob(j.jobId);
            await poll(cur);
          } catch {
            pollingRef.current = null;
            setRefreshing(false);
            showToast('刷新状态查询失败', 'error');
          }
        }, 1500);
      };
      await poll(job);
    } catch (e) {
      setRefreshing(false);
      showToast(e instanceof ApiError ? e.message : '触发刷新失败', 'error');
    }
  }, [refreshing, loadLibrary, loadTags, fetchPage, showToast]);

  useEffect(
    () => () => {
      if (pollingRef.current) window.clearTimeout(pollingRef.current);
    },
    []
  );

  // ---- 详情与分类 ----
  const openDetail = useCallback((note: NoteSummary, el: HTMLElement) => {
    focusedCardRef.current = el;
    setDetailSummary(note);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailSummary(null);
    const el = focusedCardRef.current;
    window.setTimeout(() => {
      if (el && el.isConnected) el.focus();
    }, 0);
  }, []);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardElsRef.current.set(id, el);
    else cardElsRef.current.delete(id);
  }, []);

  const onCategoryChanged = useCallback(
    (noteId: string, categoryId: string | null, revision: number) => {
      setItems((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, categoryId, categorySource: 'override' as const } : n
        )
      );
      setDetailSummary((prev) =>
        prev && prev.id === noteId ? { ...prev, categoryId, categorySource: 'override' as const } : prev
      );
      setLibrary((prev) => (prev ? { ...prev, categoryRevision: revision } : prev));
      void loadLibrary(); // 刷新计数
      showToast('分类已保存');
    },
    [loadLibrary, showToast]
  );

  const onCategoryError = useCallback(
    (msg: string) => {
      showToast(msg, 'error');
      void loadLibrary(); // 拿到最新 revision 便于重试
    },
    [loadLibrary, showToast]
  );

  const categoryName = useCallback(
    (id: string) => categories.find((c) => c.id === id)?.name ?? null,
    [categories]
  );

  // ---- 标题与视图状态 ----
  const inTagResult = view === 'tags' && activeTag !== null;
  const inDirectory = view === 'tags' && activeTag === null;
  const headerTitle = inDirectory
    ? '标签'
    : inTagResult
      ? `#${activeTag}`
      : query.categoryId === null
        ? '全部收藏'
        : query.categoryId === 'uncategorized'
          ? '未分类'
          : (categories.find((c) => c.id === query.categoryId)?.name ?? '收藏');
  const scopeCount = inDirectory
    ? (tags?.length ?? null)
    : inTagResult
      ? (tags?.find((t) => t.tag === activeTag)?.count ?? null)
      : query.categoryId === null
        ? (library?.total ?? null)
        : query.categoryId === 'uncategorized'
          ? (library?.uncategorized ?? null)
          : (library?.categories.find((c) => c.id === query.categoryId)?.count ?? null);

  const bootLoading = !library && !libraryError;
  const emptyLibrary = library !== null && library.total === 0 && library.indexStatus !== 'scanning';
  const noResult = !listLoading && !listError && total === 0 && !inDirectory;
  const listSwitching = listLoading && items.length === 0; // 筛选/标签切换时的加载骨架
  const showList = !inDirectory && !libraryError && !emptyLibrary && items.length > 0;

  return (
    <div className="app">
      <Sidebar
        library={library}
        activeCategoryId={query.categoryId}
        tagsView={view === 'tags'}
        onSelectCategory={selectCategory}
        onSelectTags={selectTagsView}
      />

      <main className="main glass-surface">
        <Toolbar
          query={query}
          onChange={patchQuery}
          onRefresh={() => void startRefresh()}
          refreshing={refreshing || library?.indexStatus === 'scanning'}
          title={headerTitle}
          scopeCount={scopeCount}
          countUnit={inDirectory ? '个' : '篇'}
          showFilters={!inDirectory}
          showBack={inTagResult}
          onBack={selectTagsView}
          resultCount={total}
          listError={listError}
          onRetry={() => void fetchPage(0)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            void fetchPage(0);
          }}
        />

        <div className="results" ref={resultsRef}>
          {inDirectory ? (
            <TagsDirectory
              tags={tags}
              loading={!tags && !tagsError}
              error={tagsError}
              onRetry={() => void loadTags()}
              onSelect={selectTag}
            />
          ) : (
            <>
              {bootLoading && <SkeletonGrid />}
              {listSwitching && !bootLoading && !libraryError && <SkeletonGrid />}
              {libraryError && (
                <div className="results-state">
                  <div className="state-title">无法连接收藏库服务</div>
                  <div>{libraryError}</div>
                  <button className="btn-refresh" onClick={() => void loadLibrary()}>
                    <IconRefresh size={14} /> 重试
                  </button>
                </div>
              )}
              {emptyLibrary && !libraryError && (
                <div className="results-state">
                  <div className="state-title">收藏库是空的</div>
                  <div>点击「刷新收藏库」读取 Obsidian 收藏内容；若持续为空，请检查内容源路径配置。</div>
                  <button className="btn-refresh" onClick={() => void startRefresh()}>
                    <IconRefresh size={14} /> 刷新收藏库
                  </button>
                </div>
              )}
              {noResult && !libraryError && (
                <div className="results-state">
                  <div className="state-title">没有匹配的收藏</div>
                  <div>
                    当前条件：
                    {inTagResult
                      ? `标签 #${activeTag}`
                      : query.categoryId === 'uncategorized'
                        ? '未分类'
                        : (categoryName(query.categoryId ?? '') ?? '全部分类')}
                    {query.q.trim() ? `，搜索“${query.q.trim()}”` : ''}
                    {query.range !== 'all'
                      ? `，时间范围 ${query.range === 'custom' ? `${query.from} 至 ${query.to}` : query.range === '7d' ? '最近 7 天' : '最近 30 天'}`
                      : ''}
                  </div>
                  <button
                    className="btn-refresh"
                    onClick={() => {
                      patchQuery({ q: '', range: 'all', from: '', to: '', order: 'desc', timeField: 'published', categoryId: null });
                      setActiveTag(null);
                    }}
                  >
                    返回并清除筛选
                  </button>
                </div>
              )}
              {listError && items.length === 0 && !libraryError && (
                <div className="results-state">
                  <div className="state-title">列表加载失败</div>
                  <div>{listError}</div>
                  <button className="btn-refresh" onClick={() => void fetchPage(0)}>
                    <IconRefresh size={14} /> 重试
                  </button>
                </div>
              )}

              {showList && (
                <>
                  <Masonry items={items} categoryName={categoryName} onOpen={openDetail} registerEl={registerEl} />
                  <div ref={sentinelRef} style={{ height: 1 }} />
                  {hasMore && (
                    <div className="load-more">
                      <button onClick={loadMore} disabled={loadingMore}>
                        {loadingMore ? '加载中…' : `加载更多（已显示 ${items.length}/${total}）`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>

      {detailSummary && library && (
        <DetailDialog
          summary={detailSummary}
          categories={categories}
          categoryRevision={library.categoryRevision}
          onCategoryChanged={onCategoryChanged}
          onCategoryError={onCategoryError}
          onClose={closeDetail}
        />
      )}

      {toast && (
        <div className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function SkeletonGrid() {
  const heights = [300, 240, 340, 220, 280, 320, 250, 300, 230, 310, 260, 290];
  return (
    <div className="skeleton-wrap" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }} aria-hidden>
      {heights.map((h, i) => (
        <div key={i} className="skeleton-card" style={{ width: 236 }}>
          <div className="skeleton-block" style={{ height: h - 90, margin: 0 }} />
          <div className="skeleton-line" style={{ width: '85%', marginTop: 10 }} />
          <div className="skeleton-line" style={{ width: '45%' }} />
        </div>
      ))}
    </div>
  );
}
