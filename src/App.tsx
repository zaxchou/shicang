import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryInfo, NoteSummary, RefreshJobInfo, TagCount } from '../shared/types';
import { api, ApiError, type QueryParams } from './api/client';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type QueryState } from './components/Toolbar';
import { Masonry } from './components/Masonry';
import { DetailDialog } from './components/DetailDialog';
import { TagsDirectory } from './components/TagsDirectory';
import { DataTable } from './components/Table';
import { IconRefresh } from './components/Icons';

const PAGE_SIZE = 60;
const TABLE_LIMIT = 1000;

const INITIAL_QUERY: QueryState = {
  q: '',
  categoryId: null,
  timeField: 'published',
  range: 'all',
  from: '',
  to: '',
  order: 'desc',
  starred: false,
};

type View = 'library' | 'tags';
type ViewMode = 'masonry' | 'table';

function readViewMode(cid: string): ViewMode {
  try {
    return localStorage.getItem(`mb-view-${cid}`) === 'table' ? 'table' : 'masonry';
  } catch {
    return 'masonry';
  }
}
function writeViewMode(cid: string, v: ViewMode): void {
  try {
    localStorage.setItem(`mb-view-${cid}`, v);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [library, setLibrary] = useState<LibraryInfo | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  // 收藏库与视图
  const [collection, setCollection] = useState<string>('rednote');
  // 首屏也要用本库上次选的模式（此前只有切换收藏库时才读，刷新页面后偏好被忽略）
  const [viewMode, setViewModeState] = useState<ViewMode>(() => readViewMode('rednote'));
  const [view, setView] = useState<View>('library'); // library | tags
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
  const [toast, setToast] = useState<{ id: number; msg: string; kind: 'info' | 'error' } | null>(null);

  const seqRef = useRef(0);
  const composingRef = useRef(false);
  const toastIdRef = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const focusedElRef = useRef<HTMLElement | null>(null);
  const cardElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pollingRef = useRef<number | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const viewRef = useRef(view);
  viewRef.current = view;
  const activeTagRef = useRef(activeTag);
  activeTagRef.current = activeTag;
  const collectionRef = useRef(collection);
  collectionRef.current = collection;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const revisionRef = useRef(indexRevision);
  revisionRef.current = indexRevision;

  const infos = library?.collections ?? [];
  const curInfo = infos.find((c) => c.id === collection) ?? null;
  const curCategories = curInfo?.categories ?? [];

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    // 用自增 id 而不是消息文本判归属：相同文案的两条 toast 会在第一条的定时器上被提前清掉
    const id = ++toastIdRef.current;
    setToast({ id, msg, kind });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4200);
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const lib = await api.library();
      setLibrary(lib);
      setLibraryError(null);
    } catch (e) {
      setLibraryError(e instanceof ApiError ? e.message : '加载收藏库信息失败');
    }
  }, []);

  const loadTags = useCallback(async () => {
    try {
      const r = await api.tags(collectionRef.current);
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
        collection: collectionRef.current,
        q: q.q,
        categoryId: viewRef.current === 'library' ? q.categoryId : null,
        tag: viewRef.current === 'tags' ? activeTagRef.current : null,
        starred: q.starred,
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
      if (append && revisionRef.current !== res.indexRevision) {
        // 追加期间索引被重建（别处点了刷新 / 跑过扫描）：这一份是"从 offset 开始的页"，
        // 直接采用会把中间页当成首页，而且之后每次都重取同一段（看起来点了没反应）
        void fetchPage(0);
        return;
      }
      if (append) {
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

  /** 表格模式：一次取全量（≤1000，列排序在前端做） */
  const loadAll = useCallback(async () => {
    const q = queryRef.current;
    const seq = ++seqRef.current;
    setListLoading(true);
    setLoadingMore(false); // 表格加载会作废进行中的"加载更多"，否则那个按钮会一直卡在"加载中…"
    try {
      const res = await api.notes({
        collection: collectionRef.current,
        q: q.q,
        categoryId: viewRef.current === 'library' ? q.categoryId : null,
        tag: viewRef.current === 'tags' ? activeTagRef.current : null,
        starred: q.starred,
        timeField: q.timeField,
        range: q.range,
        from: q.range === 'custom' && q.from ? q.from : undefined,
        to: q.range === 'custom' && q.to ? q.to : undefined,
        order: q.order,
        offset: 0,
        limit: TABLE_LIMIT,
      });
      if (seq !== seqRef.current) return;
      setItems(res.items);
      setTotal(res.total);
      setIndexRevision(res.indexRevision);
      setListError(null);
    } catch (e) {
      if (seq === seqRef.current) setListError(e instanceof ApiError ? e.message : '加载列表失败');
    } finally {
      setLoadingMore(false);
      if (seq === seqRef.current) setListLoading(false);
    }
  }, []);

  /** 按当前展示模式重新加载（表格要一次取全量，瀑布流取第一页） */
  const reload = useCallback(
    () => (viewModeRef.current === 'table' ? loadAll() : fetchPage(0)),
    [loadAll, fetchPage]
  );

  // 首次加载
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // 查询/视图/标签/收藏库/展示模式变化 → 重新加载（搜索防抖 200ms）
  // viewMode 必须在依赖里：瀑布流首屏只取 60 条，切到表格必须改用一次取全量，
  // 否则表格会拿瀑布流已加载的那几十条当全部（实测：切到列表 0 个请求、显示 120/606 行）
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (composingRef.current) return;
      if (viewMode === 'table') void loadAll();
      else void fetchPage(0);
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view, activeTag, collection, viewMode]);

  // 输入法组合期间不重查；若 compositionend 丢事件（切窗口等）状态会永久卡住，失焦兜底
  useEffect(() => {
    const reset = () => {
      composingRef.current = false;
    };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, []);

  // 进入标签视图时按收藏库加载标签；先清空，避免把上一个库的标签当成当前库的
  useEffect(() => {
    if (view !== 'tags') return;
    setTags(null);
    setTagsError(null);
    void loadTags();
  }, [view, collection, indexRevision, loadTags]);

  // 筛选/视图/库/搜索词变化滚动回顶部
  useEffect(() => {
    resultsRef.current?.scrollTo({ top: 0 });
  }, [
    query.q,
    query.categoryId,
    query.range,
    query.timeField,
    query.order,
    query.from,
    query.to,
    query.starred,
    view,
    activeTag,
    collection,
  ]);

  // 库就绪轮询（首次启动自动扫描可能延迟）
  useEffect(() => {
    if (library && library.indexStatus !== 'scanning' && libraryError === null) return;
    const t = window.setInterval(() => void loadLibrary(), 2000);
    return () => window.clearInterval(t);
  }, [library, libraryError, loadLibrary]);

  const patchQuery = useCallback((patch: Partial<QueryState>) => {
    setQuery((prev) => ({ ...prev, ...patch }));
  }, []);

  const selectCollection = useCallback((cid: string) => {
    setCollection((prev) => {
      if (prev === cid) return prev;
      setViewModeState(readViewMode(cid));
      viewModeRef.current = readViewMode(cid);
      return cid;
    });
    setView('library');
    setActiveTag(null);
    setQuery((q) => ({ ...q, categoryId: null, q: '', starred: false }));
    setItems([]);
    setTotal(null);
    setListLoading(true);
    setTags(null); // 标签目录属于上一个库，先清空（否则会显示别的库的标签）
    setTagsError(null);
  }, []);

  const selectCategory = useCallback(
    (id: string | null) => {
      // 从标签结果跳到分类：同一个提交里就会切回库视图，旧标签结果必须清掉，
      // 否则新标题下面挂着上一批结果（等到防抖请求回来才换）
      if (viewRef.current === 'tags') {
        setItems([]);
        setTotal(null);
        setListLoading(true);
      }
      setView('library');
      setActiveTag(null);
      // 选分类 = 想"看这个分类"，顺手关掉标星筛选，避免在分类里再被标星悄悄过滤一层
      patchQuery({ categoryId: id, starred: false });
    },
    [patchQuery]
  );

  const selectTagsView = useCallback(() => {
    setView('tags');
    setActiveTag(null);
  }, []);

  /** 侧栏「标星」：当前库内的一层筛选，打开时清掉分类（否则计数与条数对不上） */
  const selectStarred = useCallback(() => {
    setView('library');
    setActiveTag(null);
    setQuery((q) => (q.starred ? { ...q, starred: false } : { ...q, starred: true, categoryId: null }));
  }, []);

  const selectTag = useCallback((tag: string) => {
    setActiveTag(tag);
    setItems([]);
    setTotal(null);
    setListLoading(true); // 否则首次加载期间是一片空白（既没有骨架也没有内容）
  }, []);

  const setViewMode = useCallback((v: ViewMode) => {
    setViewModeState(v);
    viewModeRef.current = v;
    writeViewMode(collectionRef.current, v);
  }, []);

  const hasMore = total !== null && items.length < total;
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || listLoading) return;
    void fetchPage(items.length, true);
  }, [hasMore, loadingMore, listLoading, fetchPage, items.length]);

  // 触底自动加载（仅瀑布流）
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewMode === 'table') return;
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
  }, [loadMore, viewMode]);

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
          await reload();
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
  }, [refreshing, loadLibrary, loadTags, reload, showToast]);

  useEffect(
    () => () => {
      if (pollingRef.current) window.clearTimeout(pollingRef.current);
    },
    []
  );

  // ---- 详情与分类 ----
  const openDetail = useCallback((note: NoteSummary, el: HTMLElement) => {
    focusedElRef.current = el;
    setDetailSummary(note);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailSummary(null);
    const el = focusedElRef.current;
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
      // 改完分类后，这条可能已经不符合当前筛选（比如在「未分类」里把它归了类）：
      // 留着会让列表和自己声称的筛选条件矛盾
      const q = queryRef.current;
      const filteredOut =
        viewRef.current === 'library' &&
        q.categoryId !== null &&
        (q.categoryId === 'uncategorized' ? categoryId !== null : categoryId !== q.categoryId);
      if (filteredOut) {
        setItems((prev) => prev.filter((n) => n.id !== noteId));
        setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
      } else {
        setItems((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, categoryId, categorySource: 'override' as const } : n))
        );
      }
      setDetailSummary((prev) =>
        prev && prev.id === noteId ? { ...prev, categoryId, categorySource: 'override' as const } : prev
      );
      setLibrary((prev) => (prev ? { ...prev, categoryRevision: revision } : prev));
      void loadLibrary();
      showToast(filteredOut ? '分类已保存，已移出当前筛选' : '分类已保存');
    },
    [loadLibrary, showToast]
  );

  const onCategoryError = useCallback(
    (msg: string) => {
      showToast(msg, 'error');
      void loadLibrary();
    },
    [loadLibrary, showToast]
  );

  /**
   * 标星 / 取消标星。先乐观更新（点一下要立刻有反馈，等一个来回会显得卡），失败再回滚。
   * 服务端那边是单字段幂等写入，不需要 expectedRevision，所以连点不会互相冲突。
   */
  const toggleStar = useCallback(
    async (note: NoteSummary) => {
      const next = !note.annotation.starred;
      const mark = (b: boolean) => (n: NoteSummary): NoteSummary =>
        n.id === note.id
          ? { ...n, annotation: { ...n.annotation, starred: b, starredAt: b ? new Date().toISOString() : null } }
          : n;
      setItems((prev) => prev.map(mark(next)));
      setDetailSummary((prev) => (prev && prev.id === note.id ? mark(next)(prev) : prev));
      try {
        await api.setStar(note.id, next);
        void loadLibrary(); // 刷新侧栏的标星计数
        if (!next && queryRef.current.starred) {
          // 在「只看标星」里取消标星：这条已经不符合当前筛选，留在列表里自相矛盾
          setItems((prev) => prev.filter((n) => n.id !== note.id));
          setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
        }
      } catch (e) {
        setItems((prev) => prev.map(mark(!next)));
        setDetailSummary((prev) => (prev && prev.id === note.id ? mark(!next)(prev) : prev));
        showToast(e instanceof ApiError ? e.message : '标星失败', 'error');
      }
    },
    [loadLibrary, showToast]
  );

  const categoryName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const hit = curCategories.find((c) => c.id === id);
      return hit ? hit.name : id; // 派生分类 id 即名称
    },
    [curCategories]
  );

  // ---- 标题与视图状态 ----
  const inTagResult = view === 'tags' && activeTag !== null;
  const inDirectory = view === 'tags' && activeTag === null;
  const headerTitle = inDirectory
    ? '标签'
    : inTagResult
      ? `#${activeTag}`
      : query.starred
        ? '标星'
        : query.categoryId === 'uncategorized'
          ? '未分类'
          : query.categoryId
            ? (categoryName(query.categoryId) ?? '收藏')
            : (curInfo?.name ?? '收藏');
  const scopeCount = inDirectory
    ? (tags?.length ?? null)
    : inTagResult
      ? (tags?.find((t) => t.tag === activeTag)?.count ?? null)
      : query.starred
        ? (curInfo?.starred ?? null)
        : query.categoryId === 'uncategorized'
          ? (curInfo?.uncategorized ?? null)
          : query.categoryId
            ? (curInfo?.categories.find((c) => c.id === query.categoryId)?.count ?? null)
            : (curInfo?.total ?? null);

  const bootLoading = !library && !libraryError;
  const emptyLibrary = (curInfo?.total ?? 0) === 0 && view === 'library' && !libraryError && library !== null;
  const noResult = !listLoading && !listError && total === 0 && !inDirectory;
  /** 「只看标星」且一条都没有：这不是"筛没了"，而是还没标过任何一条，提示要不一样 */
  const emptyStarred =
    query.starred && !inTagResult && !query.q.trim() && query.range === 'all' && total === 0;
  const listSwitching = listLoading && items.length === 0;
  const showNotes = !inDirectory && !libraryError && !emptyLibrary && items.length > 0;
  const showTableView = showNotes && viewMode === 'table';

  return (
    <div className="app">
      <Sidebar
        library={library}
        collection={collection}
        activeCategoryId={query.categoryId}
        tagsView={view === 'tags'}
        starredOnly={query.starred}
        onSelectCollection={selectCollection}
        onSelectCategory={selectCategory}
        onSelectTags={selectTagsView}
        onSelectStarred={selectStarred}
      />

      <main className="main glass-surface">
        <Toolbar
          query={query}
          onChange={patchQuery}
          onRefresh={() => void startRefresh()}
          refreshing={refreshing || library?.indexStatus === 'scanning'}
          title={headerTitle}
          scopeCount={scopeCount}
          countUnit="篇"
          showFilters={!inDirectory}
          showViewToggle={!inDirectory}
          viewMode={viewMode}
          onViewMode={setViewMode}
          showBack={inTagResult}
          onBack={selectTagsView}
          resultCount={total}
          listError={listError}
          onRetry={() => void reload()}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            void reload();
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
              {emptyLibrary && (
                <div className="results-state">
                  <div className="state-title">这个收藏库是空的</div>
                  <div>点击「刷新收藏库」读取 Obsidian 中的笔记；若持续为空，请检查内容源路径配置。</div>
                  <button className="btn-refresh" onClick={() => void startRefresh()}>
                    <IconRefresh size={14} /> 刷新收藏库
                  </button>
                </div>
              )}
              {noResult && !libraryError && !bootLoading && (
                <div className="results-state">
                  <div className="state-title">
                    {emptyStarred ? '还没有标星的笔记' : '没有匹配的收藏'}
                  </div>
                  <div>
                    {emptyStarred ? (
                      <>在卡片左上角（没有封面的卡片在作者行右端）点一下星标，就会出现在这里。</>
                    ) : (
                      <>
                        当前条件：
                        {inTagResult
                          ? `标签 #${activeTag}`
                          : query.starred
                            ? '标星'
                            : query.categoryId === 'uncategorized'
                              ? '未分类'
                              : (categoryName(query.categoryId ?? null) ?? curInfo?.name ?? '全部')}
                        {query.q.trim() ? `，搜索“${query.q.trim()}”` : ''}
                        {query.range !== 'all'
                          ? `，时间范围 ${query.range === 'custom' ? `${query.from} 至 ${query.to}` : query.range === '7d' ? '最近 7 天' : '最近 30 天'}`
                          : ''}
                      </>
                    )}
                  </div>
                  <button
                    className="btn-refresh"
                    onClick={() => {
                      patchQuery({
                        q: '',
                        range: 'all',
                        from: '',
                        to: '',
                        order: 'desc',
                        timeField: 'published',
                        categoryId: null,
                        starred: false,
                      });
                      setActiveTag(null);
                    }}
                  >
                    返回并清除筛选
                  </button>
                </div>
              )}
              {listError && items.length === 0 && !libraryError && !bootLoading && (
                <div className="results-state">
                  <div className="state-title">列表加载失败</div>
                  <div>{listError}</div>
                  <button className="btn-refresh" onClick={() => void reload()}>
                    <IconRefresh size={14} /> 重试
                  </button>
                </div>
              )}

              {showNotes && showTableView && curInfo && (
                <DataTable
                  notes={items}
                  info={curInfo}
                  resultTotal={total}
                  categoryName={categoryName}
                  onOpen={openDetail}
                  registerEl={registerEl}
                />
              )}
              {showNotes && !showTableView && (
                <>
                  <Masonry
                    items={items}
                    categoryName={categoryName}
                    onOpen={openDetail}
                    onToggleStar={toggleStar}
                    registerEl={registerEl}
                  />
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
          categories={categoriesOf(infos, detailSummary.collection)}
          categoryRevision={library.categoryRevision}
          showCategoryPicker={detailSummary.collection === 'rednote'}
          onCategoryChanged={onCategoryChanged}
          onCategoryError={onCategoryError}
          onToggleStar={() => void toggleStar(detailSummary)}
          onClose={closeDetail}
        />
      )}

      {toast && (
        <div key={toast.id} className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/** 详情里的分类选择器选项：rednote 用 seed 类目，其它库用派生分类（仅展示） */
function categoriesOf(infos: LibraryInfo['collections'], cid: string): { id: string; name: string }[] {
  return infos.find((c) => c.id === cid)?.categories ?? [];
}

function SkeletonGrid() {
  const heights = [300, 240, 340, 220, 280, 320, 250, 300, 230, 310, 260, 290];
  return (
    <div className="skeleton-wrap" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }} aria-hidden>
      {heights.map((h, i) => (
        <div key={i} className="skeleton-card" style={{ width: 236, maxWidth: '100%' }}>
          <div className="skeleton-block" style={{ height: h - 90, margin: 0 }} />
          <div className="skeleton-line" style={{ width: '85%', marginTop: 10 }} />
          <div className="skeleton-line" style={{ width: '45%' }} />
        </div>
      ))}
    </div>
  );
}
