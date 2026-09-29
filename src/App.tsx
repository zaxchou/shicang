import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollectionInfo, LibraryInfo, NoteStatus, NoteSummary, RefreshJobInfo, TagCount } from '../shared/types';
import { api, ApiError, type QueryParams } from './api/client';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type QueryState } from './components/Toolbar';
import { Masonry } from './components/Masonry';
import { DetailDialog } from './components/DetailDialog';
import { TagsDirectory } from './components/TagsDirectory';
import { DataTable } from './components/Table';
import { IconArchive, IconRefresh } from './components/Icons';
import { bootPollDelayMs } from './lib/boot-poll';

const PAGE_SIZE = 60;
const TABLE_LIMIT = 1000;

const INITIAL_QUERY: QueryState = {
  q: '',
  categoryId: null,
  source: null,
  timeField: 'published',
  range: 'all',
  from: '',
  to: '',
  order: 'desc',
  starred: false,
  status: 'active',
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
  const [exporting, setExporting] = useState(false);
  /** 表格里勾选的条目（批量归档用）；换筛选/视图/库就清空 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailSummary, setDetailSummary] = useState<NoteSummary | null>(null);
  const [toast, setToast] = useState<{
    id: number;
    msg: string;
    kind: 'info' | 'error';
    action?: { label: string; run(): void };
  } | null>(null);

  const seqRef = useRef(0);
  const librarySeqRef = useRef(0);
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
  const libraryRef = useRef<LibraryInfo | null>(library);
  libraryRef.current = library;
  const revisionRef = useRef(indexRevision);
  revisionRef.current = indexRevision;

  const infos = library?.collections ?? [];
  const curInfo = infos.find((c) => c.id === collection) ?? null;
  const curCategories = curInfo?.categories ?? [];

  const showToast = useCallback(
    (msg: string, kind: 'info' | 'error' = 'info', action?: { label: string; run(): void }) => {
      // 用自增 id 而不是消息文本判归属：相同文案的两条 toast 会在第一条的定时器上被提前清掉
      const id = ++toastIdRef.current;
      setToast({ id, msg, kind, action });
      // 带「撤销」的多留一会儿，否则手还没移到按钮上就消失了
      window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), action ? 6500 : 4200);
    },
    []
  );

  const loadLibrary = useCallback(async () => {
    // 库信息也按序号防过期：轮询与"写后刷新"并发时，晚到的旧快照会把
    // annotationRevision/categoryRevision 顶回旧值，下一次带 expectedRevision 的写就莫名 409（深审发现）
    const seq = ++librarySeqRef.current;
    try {
      const lib = await api.library();
      if (seq !== librarySeqRef.current) return;
      setLibrary(lib);
      setLibraryError(null);
    } catch (e) {
      if (seq !== librarySeqRef.current) return;
      setLibraryError(e instanceof ApiError ? e.message : '加载收藏库信息失败');
    }
  }, []);

  /**
   * 标签也按请求序号防过期：快速切库时两次请求可能乱序返回，
   * 后到的旧响应会把新库的标签目录盖掉（此前只清空了一次，挡不住晚到的响应）。
   */
  const tagsSeqRef = useRef(0);
  const loadTags = useCallback(async () => {
    const seq = ++tagsSeqRef.current;
    const cid = collectionRef.current;
    try {
      const r = await api.tags(cid);
      if (seq !== tagsSeqRef.current) return; // 已有更新的请求：丢弃这次响应
      setTags(r.tags);
      setTagsError(null);
    } catch (e) {
      if (seq !== tagsSeqRef.current) return;
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
        source: viewRef.current === 'library' ? q.source : null,
        tag: viewRef.current === 'tags' ? activeTagRef.current : null,
        starred: q.starred,
        status: q.status,
        includeMissing: q.status !== 'active',
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
    // 与 fetchPage 同款短路：标签目录里不拉列表（否则目录页白拉一次 1000 条）
    if (viewRef.current === 'tags' && !activeTagRef.current) {
      setListLoading(false);
      return;
    }
    const q = queryRef.current;
    const seq = ++seqRef.current;
    setListLoading(true);
    setLoadingMore(false); // 表格加载会作废进行中的"加载更多"，否则那个按钮会一直卡在"加载中…"
    try {
      const res = await api.notes({
        collection: collectionRef.current,
        q: q.q,
        categoryId: viewRef.current === 'library' ? q.categoryId : null,
        source: viewRef.current === 'library' ? q.source : null,
        tag: viewRef.current === 'tags' ? activeTagRef.current : null,
        starred: q.starred,
        status: q.status,
        includeMissing: q.status !== 'active',
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

  // 勾选只在当前这一屏有意义：换了筛选/视图/库/标签就清掉，避免"选了看不见的东西"再批量执行
  useEffect(() => {
    setSelectedIds(new Set());
  }, [query, view, activeTag, collection, viewMode]);

  // 列表被替换后按当前列表求交集兜底：刷新重建、行内归档移出、跨标签切换等路径不会走上面的
  // 清空 effect，勾选里会留着已不在列表上的 id——批量条显示"已选 N 条"却打在看不见的行上（深审发现）
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((n) => n.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

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

  // 库就绪轮询：首扫/重建期间（indexStatus 为 scanning 或 empty）每 2s 拉一次。
  // 节奏决策抽成纯函数 bootPollDelayMs（评审 2026-09-30 R2）：scanning 期间陪到底（150 次后退避 5s），
  // 真空库/持续失败保留 150 次兜底——否则长扫描把页面永久卡死在"刷新中"且刷新入口禁用。
  const bootPollsRef = useRef(0);
  const prevIndexStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const delay = bootPollDelayMs(library?.indexStatus, bootPollsRef.current);
    if (delay === null) return;
    const t = window.setInterval(() => {
      bootPollsRef.current += 1;
      void loadLibrary();
    }, delay);
    return () => window.clearInterval(t);
  }, [library, libraryError, loadLibrary]);

  // 扫描/首扫完成（非 ready → ready）：**必须重拉列表与标签**。
  // 此前启动扫描全程不报 scanning、前端也不轮询，扫完没有任何东西会重取——
  // 开机全量重建后界面停在"这个收藏库是空的"直到用户手动操作（深审发现）。
  useEffect(() => {
    const prev = prevIndexStatusRef.current;
    const cur = library?.indexStatus ?? null;
    if (cur !== prev) bootPollsRef.current = 0;
    prevIndexStatusRef.current = cur;
    if (prev !== null && prev !== 'ready' && cur === 'ready') {
      void reload();
      void loadTags();
    }
  }, [library, reload, loadTags]);

  /**
   * **切换作用域前先把列表清空并进入加载态**。
   * 不清的话：标题与侧栏计数立刻变成新口径（"标星 12 篇"），而网格里还挂着上一批卡片，
   * 直到防抖请求回来——用户看到的就是"数字和列表互相矛盾"（深审发现）。
   */
  const beginScopeChange = useCallback(() => {
    // 作废在途列表请求：切了作用域还让旧响应回灌，旧口径的卡片会挂在新标题下（深审发现）
    seqRef.current++;
    setLoadingMore(false);
    setItems([]);
    setTotal(null);
    setListLoading(true);
  }, []);

  /**
   * 改查询条件。
   * **会改变"结果集口径"的字段**（分类 / 标星 / 归档 / 时间范围 / 时间口径）在变化的同一次提交里
   * 就把列表清空并进入加载态——否则标题与侧栏计数已经换成新口径（"标星 1 篇"），
   * 网格里还挂着上一批卡片（605 篇的 120 张），正好是用户最反感的"数字与列表打架"。
   * 搜索词与排序不清空：它们是"同一批结果里再筛/再排"，保留现有卡片更稳。
   */
  const SCOPE_FIELDS: Array<keyof QueryState> = [
    'categoryId',
    'source',
    'starred',
    'status',
    'range',
    'from',
    'to',
    'timeField',
  ];
  const patchQuery = useCallback(
    (patch: Partial<QueryState>) => {
      const prev = queryRef.current;
      const scopeChanged = SCOPE_FIELDS.some(
        (k) => k in patch && (patch[k] ?? null) !== (prev[k] ?? null)
      );
      if (scopeChanged) beginScopeChange();
      setQuery((p) => ({ ...p, ...patch }));
    },
    [beginScopeChange]
  );

  const selectCollection = useCallback(
    (cid: string) => {
      setCollection((prev) => (prev === cid ? prev : cid));
      // 视图模式的读取与写入放在更新函数外面：setState 的 updater 必须是纯函数
      // （StrictMode/并发下可能被执行多次），在里面写别的 state/ref 是隐患
      if (collectionRef.current !== cid) {
        const mode = readViewMode(cid);
        setViewModeState(mode);
        viewModeRef.current = mode;
      }
      setView('library');
      setActiveTag(null);
      setQuery((q) => ({ ...q, categoryId: null, source: null, q: '', starred: false, status: 'active' }));
      beginScopeChange();
      setTags(null); // 标签目录属于上一个库，先清空（否则会显示别的库的标签）
      setTagsError(null);
    },
    [beginScopeChange]
  );

  const selectCategory = useCallback(
    (id: string | null) => {
      // 从标签结果跳到分类：同一个提交里就会切回库视图，旧标签结果必须清掉，
      // 否则新标题下面挂着上一批结果（等到防抖请求回来才换）
      if (viewRef.current === 'tags' || queryRef.current.categoryId !== id) {
        beginScopeChange();
      }
      setView('library');
      setActiveTag(null);
      // 选分类 = 想"看这个分类"，顺手关掉标星筛选与归档视图，避免在分类里再被悄悄过滤一层
      patchQuery({ categoryId: id, starred: false, status: 'active' });
    },
    [beginScopeChange, patchQuery]
  );

  /** 侧栏「来源」段：与分类维正交（同时生效 = AND），切法与 selectCategory 一致 */
  const selectSource = useCallback(
    (src: string | null) => {
      if (viewRef.current === 'tags' || queryRef.current.source !== src) {
        beginScopeChange();
      }
      setView('library');
      setActiveTag(null);
      patchQuery({ source: src, starred: false, status: 'active' });
    },
    [beginScopeChange, patchQuery]
  );

  const selectTagsView = useCallback(() => {
    setView('tags');
    setActiveTag(null);
  }, []);

  /**
   * 侧栏「归档」：现在没用了的笔记都收在这里。打开时清掉分类与标星筛选（计数是全库口径），
   * 并且会把源文件已消失的记录一并列出——"取消收藏已完成"这条链路要看得见。
   */
  const selectArchive = useCallback(() => {
    setView('library');
    setActiveTag(null);
    const next =
      queryRef.current.status !== 'active'
        ? { ...queryRef.current, status: 'active' as const }
        : { ...queryRef.current, status: 'archived' as const, categoryId: null, source: null, starred: false };
    beginScopeChange(); // 作用域变了：先清列表，别让旧卡片挂在新标题下面
    setQuery(next);
  }, [beginScopeChange]);

  /** 侧栏「标星」：当前库内的一层筛选，打开时清掉分类、来源与归档视图（全库口径） */
  const selectStarred = useCallback(() => {
    setView('library');
    setActiveTag(null);
    const next = queryRef.current.starred
      ? { ...queryRef.current, starred: false }
      : { ...queryRef.current, starred: true, categoryId: null, source: null, status: 'active' as const };
    beginScopeChange();
    setQuery(next);
  }, [beginScopeChange]);

  const selectTag = useCallback(
    (tag: string) => {
      setActiveTag(tag);
      beginScopeChange(); // 同样要作废在途请求：切标签前一页的响应晚到会把旧标签的结果灌进来
    },
    [beginScopeChange]
  );

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
      let failStreak = 0;
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
            failStreak = 0;
            await poll(cur);
          } catch {
            // 单次查询失败不放弃：服务端 job 还在跑，放弃后跑完也没人重拉列表（深审发现）。
            // 连续 3 次才停（大概率服务真挂了）；中途恢复就继续正常轮询。
            failStreak += 1;
            if (failStreak >= 3) {
              pollingRef.current = null;
              setRefreshing(false);
              showToast('刷新状态查询失败', 'error');
              return;
            }
            await poll(j);
          }
        }, 1500);
      };
      await poll(job);
    } catch (e) {
      setRefreshing(false);
      showToast(e instanceof ApiError ? e.message : '触发刷新失败', 'error');
    }
  }, [refreshing, loadLibrary, loadTags, reload, showToast]);

  // ---- 导出语料（plan §18.3）：刷新后会自动更新，这里是手动补一次 ----
  const startExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { manifest, written } = await api.exportCorpus();
      const mb = (manifest.files.corpus.bytes / 1048576).toFixed(2);
      // 「内容没变」是正常结果而不是失败：跳过写入是设计（省掉 NAS 上几 MB 的无谓写入）
      showToast(
        written
          ? `语料已导出：${manifest.counts.total} 篇 · ${manifest.files.corpus.lines} 行 · ${mb} MB`
          : `语料已是最新，无需重写（${manifest.counts.total} 篇）`
      );
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '导出语料失败', 'error');
    } finally {
      setExporting(false);
    }
  }, [exporting, showToast]);

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
      setDetailSummary((prev) =>
        prev && prev.id === noteId ? { ...prev, categoryId, categorySource: 'override' as const } : prev
      );
      setLibrary((prev) => (prev ? { ...prev, categoryRevision: revision } : prev));
      void loadLibrary();
      if (filteredOut) {
        setItems((prev) => prev.filter((n) => n.id !== noteId));
        setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
        showToast('分类已保存，已移出当前筛选');
        return;
      }
      setItems((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, categoryId, categorySource: 'override' as const } : n))
      );
      // 反向操作：这条刚才是被当前筛选移出去的（改回来时它已不在 items 里），
      // 只 map 补不回来 → 重新取数，否则计数涨了而列表里没有它（深审发现）
      if (viewRef.current === 'library' && q.categoryId !== null) void reload();
      showToast('分类已保存');
    },
    [loadLibrary, reload, showToast]
  );

  const onCategoryError = useCallback(
    (msg: string) => {
      showToast(msg, 'error');
      void loadLibrary();
    },
    [loadLibrary, showToast]
  );

  const statusLabel = (s: NoteStatus): string => (s === 'archived' ? '已归档' : '已取回，回到在用');

  /**
   * 改状态后的本地同步：不再符合当前视图的立刻移出（否则列表与筛选条件自相矛盾），
   * 之后再拉一次列表与库信息，保证与服务端一致——恢复一条归档笔记时它得重新出现。
   */
  const syncStatusLocally = useCallback(
    (noteId: string, status: NoteStatus, revision: number) => {
      const view = queryRef.current.status;
      const matches =
        view === 'active' ? status === 'active' : view === 'archived' ? status !== 'active' : status === view;
      const patchNote = (n: NoteSummary): NoteSummary =>
        n.id === noteId ? { ...n, annotation: { ...n.annotation, status } } : n;
      if (matches) {
        setItems((prev) => prev.map(patchNote));
      } else {
        setItems((prev) => prev.filter((n) => n.id !== noteId));
        setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
      }
      setDetailSummary((prev) => (prev && prev.id === noteId ? patchNote(prev) : prev));
      setLibrary((prev) => (prev ? { ...prev, annotationRevision: revision } : prev));
      void loadLibrary();
      void reload();
    },
    [loadLibrary, reload]
  );

  /** 自引用（撤销要能再调一次）只能走 ref，否则 useCallback 里拿不到自己 */
  const applyStatusRef = useRef<
    ((noteId: string, status: NoteStatus, expectedRevision: number, prev?: NoteStatus) => Promise<void>) | null
  >(null);

  /**
   * 状态**已写入成功之后**的本地同步 + 撤销 toast。
   * 详情面板自己发 PATCH，成功后只调这个——此前这里会再发一次（幂等空转），但网络一抖
   * 就报"保存失败"假错误，两次写之间若插入别的标注写入还会撞 409（明明已成功却说冲突，深审发现）。
   */
  const onStatusChanged = useCallback(
    (noteId: string, status: NoteStatus, revision: number, prev?: NoteStatus) => {
      syncStatusLocally(noteId, status, revision);
      if (prev !== undefined && prev !== status) {
        showToast(statusLabel(status), 'info', {
          label: '撤销',
          run: () => void applyStatusRef.current?.(noteId, prev, revision),
        });
      }
    },
    [syncStatusLocally, showToast]
  );

  /**
   * 写入状态。带 expectedRevision（冲突说明别处动过这条标注），
   * 成功后复用 onStatusChanged（本地同步 + 撤销 toast）。
   */
  const applyStatus = useCallback(
    async (noteId: string, status: NoteStatus, expectedRevision: number, prev?: NoteStatus) => {
      try {
        const out = await api.setStatus(noteId, status === 'active' ? null : status, expectedRevision);
        onStatusChanged(noteId, out.status, out.revision, prev);
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : '状态保存失败', 'error');
        void loadLibrary();
      }
    },
    [onStatusChanged, showToast, loadLibrary]
  );
  applyStatusRef.current = applyStatus;

  /** 标注类操作（归档 / 备注）出错：统一提示 + 拉一次库信息，避免本地状态与服务端不一致 */
  const onAnnotationError = useCallback(
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
        } else if (next && queryRef.current.starred) {
          // 反向操作：刚才被移出「只看标星」的那条又被标回来了——它已经不在 items 里，
          // 光 map 是补不回来的，必须重新取数，否则计数涨了而列表里没有它（深审发现）
          void reload();
        }
      } catch (e) {
        setItems((prev) => prev.map(mark(!next)));
        setDetailSummary((prev) => (prev && prev.id === note.id ? mark(!next)(prev) : prev));
        showToast(e instanceof ApiError ? e.message : '标星失败', 'error');
      }
    },
    [loadLibrary, reload, showToast]
  );

  /** 备注保存成功：更新列表卡片与详情；若当前有搜索词就重查一次（备注本身参与搜索） */
  /** 自引用（撤销要能再调一次） */
  const applyBatchRef = useRef<((ids: string[], status: NoteStatus, prev?: NoteStatus) => Promise<void>) | null>(
    null
  );

  /** 批量归档 / 取回：一次请求写盘，撤销就是把同一批改回去 */
  const applyBatch = useCallback(
    async (ids: string[], status: NoteStatus, prev?: NoteStatus) => {
      try {
        const out = await api.setAnnotationMany(ids, { status: status === 'active' ? null : status });
        setSelectedIds(new Set());
        setLibrary((prevLib) => (prevLib ? { ...prevLib, annotationRevision: out.revision } : prevLib));
        void loadLibrary();
        void reload();
        if (prev !== undefined) {
          const label = out.updated === 0 ? '这些已经是该状态了' : status === 'archived' ? `已归档 ${out.updated} 条` : `已取回 ${out.updated} 条`;
          showToast(label, 'info', { label: '撤销', run: () => void applyBatchRef.current?.(ids, prev) });
        }
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : '批量操作失败', 'error');
      }
    },
    [loadLibrary, reload, showToast]
  );
  applyBatchRef.current = applyBatch;

  const toggleSelect = useCallback((id: string, on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((on: boolean) => {
    setSelectedIds(on ? new Set(items.map((n) => n.id)) : new Set());
  }, [items]);

  /** 表格里的单条归档 / 取回（与详情里的按钮同一套逻辑） */
  const toggleArchive = useCallback(
    (note: NoteSummary) => {
      const next: NoteStatus = note.annotation.status === 'archived' ? 'active' : 'archived';
      void applyStatus(note.id, next, libraryRef.current?.annotationRevision ?? 0, note.annotation.status);
    },
    [applyStatus]
  );

  const onRemarkChanged = useCallback(
    (noteId: string, remark: string | null, revision: number) => {
      const patch = (n: NoteSummary): NoteSummary =>
        n.id === noteId ? { ...n, annotation: { ...n.annotation, remark } } : n;
      setItems((prev) => prev.map(patch));
      setDetailSummary((prev) => (prev && prev.id === noteId ? patch(prev) : prev));
      setLibrary((prev) => (prev ? { ...prev, annotationRevision: revision } : prev));
      showToast('备注已保存');
      if (queryRef.current.q.trim()) void reload();
    },
    [showToast, reload]
  );

  /** 编辑写回成功（v0.17）：标题/摘要/正文都可能变，整条替换 + 列表重取（卡片显示的是标题与摘要） */
  const onContentChanged = useCallback(
    (note: NoteSummary) => {
      setItems((prev) => prev.map((n) => (n.id === note.id ? note : n)));
      setDetailSummary((prev) => (prev && prev.id === note.id ? note : prev));
      showToast('已写回 Obsidian');
      void reload();
    },
    [showToast, reload]
  );

  const categoryName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const hit = curCategories.find((c) => c.id === id);
      if (hit) return hit.name;
      // 组视图下卡片可能是别的子库的笔记：分类名要在**全部库**里找（派生分类 id 即名称，兜底直接显示 id）
      for (const info of infos) {
        const hit2 = info.categories.find((c) => c.id === id);
        if (hit2) return hit2.name;
      }
      return id;
    },
    [curCategories, infos]
  );

  /** 组视图下表格"收藏库"列的名字映射 */
  const collectionName = useCallback(
    (id: string | null) => infos.find((c) => c.id === id)?.name ?? id,
    [infos]
  );

  /** 笔记所属库的**类型**（web=网页/微信公众号剪藏）：卡片按类型决定底片与封面探测，
   *  按 id 硬编码会让新加入的同类型库整块失效（微信公众号 v0.14 就踩在这条线上） */
  const collectionType = useCallback((id: string) => infos.find((c) => c.id === id)?.type ?? null, [infos]);

  // ---- 标题与视图状态 ----
  const inTagResult = view === 'tags' && activeTag !== null;
  const inDirectory = view === 'tags' && activeTag === null;
  const curGroup = library?.groups.find((g) => g.id === collection) ?? null;
  /** 分类+来源同时激活时的标题：拼成「来源 · 分类」——只显示一个会让人以为另一个没生效 */
  const filterTitle = (() => {
    const parts: string[] = [];
    if (query.source) parts.push(query.source);
    if (query.categoryId === 'uncategorized') parts.push('未分类');
    else if (query.categoryId) parts.push(categoryName(query.categoryId) ?? '收藏');
    return parts.length > 0 ? parts.join(' · ') : null;
  })();
  // 组视图的标题/计数走组聚合；v0.16 起组作用域同样支持两维筛选，激活维度时标题与单库一致显示「来源 · 分类」
  const headerTitle = inDirectory
    ? '标签'
    : inTagResult
      ? `#${activeTag}`
      : query.status !== 'active'
        ? '归档'
        : query.starred
          ? '标星'
          : (filterTitle ?? (curGroup?.name ?? curInfo?.name ?? '收藏'));
  // 计数口径 = 当前作用域（单库 curInfo、组 curGroup——两者字段同形），维度规则两处共用：
  // 分叉写两套正是"标题与列表数字打架"的温床；组分支顺带补上了此前缺失的标星计数
  const scopeStats = curGroup ?? curInfo;
  const scopeCount = inDirectory
    ? (tags?.length ?? null)
    : inTagResult
      ? (tags?.find((t) => t.tag === activeTag)?.count ?? null)
      : query.status !== 'active'
        ? (scopeStats?.archived ?? null)
        : query.starred
          ? (scopeStats?.starred ?? null)
          : // 两维同时激活时，任一维的计数都不等于它们的交集——改用查询返回的 total（数字不许和列表打架）
            query.source && query.categoryId
            ? total
            : query.source
              ? (scopeStats?.sources.find((c) => c.id === query.source)?.count ?? null)
              : query.categoryId === 'uncategorized'
                ? (scopeStats?.uncategorized ?? null)
                : query.categoryId
                  ? (scopeStats?.categories.find((c) => c.id === query.categoryId)?.count ?? null)
                  : (scopeStats?.active ?? null);

  const bootLoading = !library && !libraryError;
  const emptyLibrary =
    (curGroup ? curGroup.total : (curInfo?.total ?? 0)) === 0 && view === 'library' && !libraryError && library !== null;
  /** 组视图的表格表头信息：Table 需要 CollectionInfo 形状（分组的聚合体——v0.16 起带上两维聚合计数） */
  const tableInfo: CollectionInfo | null = curGroup
    ? {
        id: curGroup.id,
        name: curGroup.name,
        total: curGroup.total,
        active: curGroup.active,
        archived: curGroup.archived,
        uncategorized: curGroup.uncategorized,
        starred: curGroup.starred,
        categories: curGroup.categories,
        sources: curGroup.sources,
        extraFields: [],
      }
    : curInfo;
  const noResult = !listLoading && !listError && total === 0 && !inDirectory;
  /** 「只看标星」且一条都没有：这不是"筛没了"，而是还没标过任何一条，提示要不一样 */
  const emptyStarred =
    query.starred && !inTagResult && !query.q.trim() && query.range === 'all' && total === 0;
  /** 工作集空了但归档里有东西：提示去归档，而不是说"没有匹配的收藏" */
  const allArchived =
    query.status === 'active' &&
    !inTagResult &&
    !query.starred &&
    query.categoryId === null &&
    !query.q.trim() &&
    query.range === 'all' &&
    total === 0 &&
    (curInfo?.archived ?? 0) > 0;
  /** 归档视图本身是空的 */
  const emptyArchive =
    query.status !== 'active' && !inTagResult && !query.q.trim() && query.range === 'all' && total === 0;
  const listSwitching = listLoading && items.length === 0;
  const showNotes = !inDirectory && !libraryError && !emptyLibrary && items.length > 0;
  const showTableView = showNotes && viewMode === 'table';

  return (
    <div className="app">
      <Sidebar
        library={library}
        collection={collection}
        activeCategoryId={query.categoryId}
        activeSource={query.source}
        tagsView={view === 'tags'}
        starredOnly={query.starred}
        archiveView={query.status !== 'active'}
        refreshing={refreshing || library?.indexStatus === 'scanning'}
        exporting={exporting}
        onRefresh={() => void startRefresh()}
        onExportCorpus={() => void startExport()}
        onSelectCollection={selectCollection}
        onSelectCategory={selectCategory}
        onSelectSource={selectSource}
        onSelectTags={selectTagsView}
        onSelectStarred={selectStarred}
        onSelectArchive={selectArchive}
      />

      <main className="main glass-surface">
        <Toolbar
          query={query}
          onChange={patchQuery}
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
                    {allArchived
                      ? '在用的笔记都在归档里'
                      : emptyArchive
                        ? '归档里还没有笔记'
                        : emptyStarred
                          ? '还没有标星的笔记'
                          : '没有匹配的收藏'}
                  </div>
                  <div>
                    {allArchived ? (
                      <>归档里有 {curInfo?.archived} 篇。在详情面板里点「取回」就能放回默认列表。</>
                    ) : emptyArchive ? (
                      <>
                        在详情面板里点「归档」，笔记就会收进这里。
                        <br />
                        归档只影响拾藏，不删源文件，随时可以取回。
                      </>
                    ) : emptyStarred ? (
                      <>在卡片左上角（没有封面的卡片在作者行右端）点一下星标，就会出现在这里。</>
                    ) : (
                      <>
                        当前条件：
                        {inTagResult
                          ? `标签 #${activeTag}`
                          : query.status !== 'active'
                            ? '归档'
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
                  {allArchived ? (
                    <button className="btn-refresh" onClick={selectArchive}>
                      <IconArchive size={14} /> 打开归档
                    </button>
                  ) : (
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
                          status: 'active',
                        });
                        setActiveTag(null);
                      }}
                    >
                      返回并清除筛选
                    </button>
                  )}
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

              {showNotes && showTableView && tableInfo && (
                <>
                  {selectedIds.size > 0 && (
                    <div className="bulk-bar" role="region" aria-label="批量操作">
                      <span className="bulk-count">已选 {selectedIds.size} 条</span>
                      <button
                        className="btn-refresh"
                        onClick={() =>
                          void applyBatch(
                            [...selectedIds],
                            query.status === 'archived' ? 'active' : 'archived',
                            query.status === 'archived' ? 'archived' : 'active'
                          )
                        }
                      >
                        <IconArchive size={14} />
                        {query.status === 'archived' ? '取回' : '归档'}
                      </button>
                      <button className="link-clear" onClick={() => setSelectedIds(new Set())}>
                        取消选择
                      </button>
                    </div>
                  )}
                  <DataTable
                    notes={items}
                    info={tableInfo}
                    isGroupScope={curGroup !== null}
                    collectionName={collectionName}
                    resultTotal={total}
                    categoryName={categoryName}
                    onOpen={openDetail}
                    onToggleStar={toggleStar}
                    onToggleArchive={toggleArchive}
                    selected={selectedIds}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAll}
                    registerEl={registerEl}
                  />
                </>
              )}
              {showNotes && !showTableView && (
                <>
                  <Masonry
                    items={items}
                    categoryName={categoryName}
                    collectionType={collectionType}
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
          // key 绑到笔记 id：详情里的"展开哪些图/备注面板是否打开/识别到第几张"都是**单篇状态**，
          // 没有 key 时切换笔记会复用同一个组件实例，上一篇的状态会带进下一篇（深审发现）
          key={detailSummary.id}
          summary={detailSummary}
          categories={categoriesOf(infos, detailSummary.collection)}
          categoryRevision={library.categoryRevision}
          sourceCategory={detailSummary.sourceCategory}
          // 分类可编辑的范围与服务端 setCategory 一致：rednote 与 web 型（网页/微信公众号）
          showCategoryPicker={(() => {
            const t = collectionType(detailSummary.collection);
            return t === 'rednote' || t === 'web';
          })()}
          onCategoryChanged={onCategoryChanged}
          onCategoryError={onCategoryError}
          onToggleStar={() => void toggleStar(detailSummary)}
          annotationRevision={library.annotationRevision}
          onStatusChanged={(id, status, revision) =>
            onStatusChanged(id, status, revision, detailSummary.annotation.status)
          }
    onRemarkChanged={onRemarkChanged}
    onContentChanged={onContentChanged}
    onAnnotationError={onAnnotationError}
          onNotice={(msg) => showToast(msg)}
          onClose={closeDetail}
        />
      )}

      {toast && (
        <div key={toast.id} className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toast.action?.run;
                setToast(null);
                run?.();
              }}
            >
              {toast.action.label}
            </button>
          )}
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
