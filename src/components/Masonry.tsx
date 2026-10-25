import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteSummary } from '../../shared/types';
import { NoteCard } from './NoteCard';

interface Props {
  items: NoteSummary[];
  categoryName(id: string): string | null;
  collectionType(id: string): string | null;
  onOpen(note: NoteSummary, el: HTMLElement): void;
  onToggleStar(note: NoteSummary): void;
  registerEl(id: string, el: HTMLElement | null): void;
}

interface Position {
  x: number;
  y: number;
}

const COL_GAP = 18;
const ROW_GAP = 28;
/** 目标列宽：决定列数（1600px 视口下为 5 列）；调大会掉到 4 列，密度变化很明显 */
const TARGET_CARD_W = 230;

/**
 * 瀑布流：单一 DOM 列表保持发布时间顺序，视觉上放入当前最短列；
 * 同高从左到右；ResizeObserver + rAF 批量重排；首次布局后位移带过渡。
 *
 * 卡高只用 ResizeObserver 实测值，**不做估算落位**：先按估算值摆好、实测回来再校正，
 * 会让一大批已落位卡片在加载窗口内改列搬移（带 .settled 过渡就是肉眼可见的乱跳，
 * 实测一批 120 张产生 974 次位移事件）。未测量的卡片保持隐藏，测到真实高度才落位；
 * 已落位卡片的高度此后不再变化，位置因此永久稳定（切库/筛选/改列数的重排仍走过渡动画）。
 */
export function Masonry({ items, categoryName, collectionType, onOpen, onToggleStar, registerEl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperEls = useRef<Map<string, HTMLElement>>(new Map());
  /** 实测卡高，连同测量时的宽度一起记：首次布局前 wrapper 还是 width:100%，
   *  那时的测量值是错的（实测 60 张全部量到同一个暂态高度 593px），按它落位
   *  整屏先摆错、再带过渡搬到位——正是加载窗口里肉眼可见的乱跳。 */
  const heights = useRef<Map<string, { h: number; w: number }>>(new Map());
  /** 上一轮布局的列宽：窗口改宽高时，wrapper 还没被渲染成新宽度，
   *  此时收到的是"旧宽度的正确测量"，要用；而首屏前的 width:100% 测量两种都对不上，弃用。 */
  const prevCardWRef = useRef<number | null>(null);
  const delays = useRef<Map<string, number>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef(0);
  const [layout, setLayout] = useState<{
    positions: Map<string, Position>;
    cardW: number;
    height: number;
  } | null>(null);
  /** 上一次已定位过的条目 id：只有它们才带位移过渡。
   *  新条目（首屏、切库、追加）第一次落位时不得有过渡——过渡起点是 none 的话，
   *  卡片会从容器左上角"飞"到各自位置。
   *  不用"首帧之后再打开过渡"的写法：resize observer 触发的重排会不断取消并重排 rAF，
   *  低帧率环境下那个状态可能永远轮不到（实测 1.8s 内类名始终没加上）。 */
  const settledIds = useRef<Set<string>>(new Set());

  const itemIds = items.map((i) => i.id).join('|');
  // 条目集合变化时清理失效的高度与延迟记录
  useEffect(() => {
    const live = new Set(itemIds.split('|'));
    for (const id of heights.current.keys()) if (!live.has(id)) heights.current.delete(id);
    for (const id of delays.current.keys()) if (!live.has(id)) delays.current.delete(id);
    scheduleLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds]);

  // 入场延迟：本批新出现的条目按出现次序 stagger，已有条目不重播
  const enterDelays: number[] = [];
  {
    let newIdx = 0;
    for (const item of items) {
      let d = delays.current.get(item.id);
      if (d === undefined) {
        d = layout === null ? 0 : Math.min(newIdx * 26, 420);
        delays.current.set(item.id, d);
        newIdx++;
      }
      enterDelays.push(d);
    }
  }

  const computeLayout = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const cols = Math.max(1, Math.floor((w + COL_GAP) / (TARGET_CARD_W + COL_GAP)));
    const cardW = (w - (cols - 1) * COL_GAP) / cols;
    const prevCardW = prevCardWRef.current;
    const colHeights = new Array<number>(cols).fill(0);
    const positions = new Map<string, Position>();
    for (const item of items) {
      const m = heights.current.get(item.id);
      // 只认"当前列宽或上一轮列宽下量到的高度"；首屏前 width:100% 的暂态测量两者都不匹配，弃用
      const usable =
        m !== undefined &&
        (Math.abs(m.w - cardW) <= 0.5 ||
          (prevCardW !== null && Math.abs(m.w - prevCardW) <= 0.5));
      if (!usable) continue; // 未实测的卡片不落位（保持隐藏），见组件头注释
      const h = m.h;
      let col = 0;
      for (let i = 1; i < cols; i++) {
        if ((colHeights[i] ?? 0) < (colHeights[col] ?? 0) - 0.5) col = i; // 同高从左到右
      }
      positions.set(item.id, { x: col * (cardW + COL_GAP), y: colHeights[col] ?? 0 });
      colHeights[col] = (colHeights[col] ?? 0) + h + ROW_GAP;
    }
    prevCardWRef.current = cardW;
    const height = Math.max(0, ...colHeights);
    // 位置没变就不更新 state：ref 回调是稳定的，任何多余的 re-render 都会重启
    // "渲染→observer 通知→重排"循环（实测曾因此每帧空转 240 次 observe/unobserve）
    setLayout((prev) => {
      if (
        prev &&
        prev.cardW === cardW &&
        prev.height === height &&
        prev.positions.size === positions.size
      ) {
        let same = true;
        for (const [id, p] of positions) {
          const q = prev.positions.get(id);
          if (!q || q.x !== p.x || q.y !== p.y) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return { positions, cardW, height };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds]);

  // 布局提交后记录"这次已定位过的条目"，供下一轮渲染判断谁可以带过渡
  useEffect(() => {
    if (layout) settledIds.current = new Set(layout.positions.keys());
  }, [layout]);

  const scheduleLayout = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(computeLayout);
  }, [computeLayout]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.noteId;
        if (id) heights.current.set(id, { h: e.contentRect.height, w: e.contentRect.width });
      }
      scheduleLayout();
    });
    roRef.current = ro;
    ro.observe(el);
    // 已挂载的条目（含"加载更多"追加的）必须补挂，否则拿不到真实高度
    for (const wrapper of wrapperEls.current.values()) ro.observe(wrapper);
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, [scheduleLayout]);

  /** 必须是稳定引用且从 dataset 取 id：内联箭头每轮渲染都是新函数，
   *  React 会反复 detach/attach，ResizeObserver 每次重新 observe 都重发首轮通知，
   *  240 张卡片时实测 40 秒内投递 61 万次测量、每帧空转一轮重排。 */
  const registerWrapper = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const id = el.dataset.noteId;
    if (!id) return;
    wrapperEls.current.set(id, el);
    roRef.current?.observe(el);
    return () => {
      if (wrapperEls.current.get(id) === el) {
        wrapperEls.current.delete(id);
        roRef.current?.unobserve(el);
      }
    };
  }, []);

  return (
    <div
      className="masonry"
      ref={containerRef}
      style={{ height: layout?.height ?? undefined }}
    >
      {items.map((note, i) => {
        const pos = layout?.positions.get(note.id);
        return (
          <div
            key={note.id}
            data-note-id={note.id}
            ref={registerWrapper}
            className={`masonry-item${settledIds.current.has(note.id) ? ' settled' : ''}`}
            style={{
              width: layout?.cardW ?? '100%',
              transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
              visibility: pos ? 'visible' : 'hidden',
              position: 'absolute',
            }}
          >
            <NoteCard
              note={note}
              categoryName={categoryName(note.categoryId ?? '')}
              sourceName={note.sourceCategory}
              collectionType={collectionType(note.collection)}
              enterDelay={layout ? enterDelays[i] ?? 0 : 0}
              onOpen={onOpen}
              onToggleStar={onToggleStar}
              registerEl={registerEl}
            />
          </div>
        );
      })}
    </div>
  );
}
