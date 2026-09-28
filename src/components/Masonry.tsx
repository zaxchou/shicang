import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteSummary } from '../../shared/types';
import { NoteCard } from './NoteCard';

interface Props {
  items: NoteSummary[];
  categoryName(id: string): string | null;
  onOpen(note: NoteSummary, el: HTMLElement): void;
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

/** 估算卡高（渲染后由 ResizeObserver 校正） */
function estimateHeight(item: NoteSummary, cardW: number): number {
  let h = 0;
  if (item.cover) {
    const c = item.cover;
    const mediaH =
      c.width && c.height ? Math.min(520, cardW * (c.height / c.width)) : cardW * 0.75;
    h += mediaH;
  }
  h += Math.min(2, Math.ceil(item.title.length / Math.max(8, Math.floor(cardW / 14)))) * 20 + 53;
  return h;
}

/**
 * 瀑布流：单一 DOM 列表保持发布时间顺序，视觉上放入当前最短列；
 * 同高从左到右；ResizeObserver + rAF 批量重排；首次布局后位移带过渡。
 */
export function Masonry({ items, categoryName, onOpen, registerEl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperEls = useRef<Map<string, HTMLElement>>(new Map());
  const heights = useRef<Map<string, number>>(new Map());
  const delays = useRef<Map<string, number>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef(0);
  const [layout, setLayout] = useState<{
    positions: Map<string, Position>;
    cardW: number;
    height: number;
  } | null>(null);

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
    const colHeights = new Array<number>(cols).fill(0);
    const positions = new Map<string, Position>();
    for (const item of items) {
      const h = heights.current.get(item.id) ?? estimateHeight(item, cardW);
      let col = 0;
      for (let i = 1; i < cols; i++) {
        if ((colHeights[i] ?? 0) < (colHeights[col] ?? 0) - 0.5) col = i; // 同高从左到右
      }
      positions.set(item.id, { x: col * (cardW + COL_GAP), y: colHeights[col] ?? 0 });
      colHeights[col] = (colHeights[col] ?? 0) + h + ROW_GAP;
    }
    setLayout({ positions, cardW, height: Math.max(0, ...colHeights) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds]);

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
        if (id) heights.current.set(id, e.contentRect.height);
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

  const registerWrapper = useCallback((id: string, el: HTMLElement | null) => {
    const prev = wrapperEls.current.get(id);
    if (prev && prev !== el) roRef.current?.unobserve(prev);
    if (el) {
      wrapperEls.current.set(id, el);
      roRef.current?.observe(el);
    } else {
      wrapperEls.current.delete(id);
    }
  }, []);

  return (
    <div
      className={`masonry${layout ? ' ready' : ''}`}
      ref={containerRef}
      style={{ height: layout?.height ?? undefined }}
    >
      {items.map((note, i) => {
        const pos = layout?.positions.get(note.id);
        return (
          <div
            key={note.id}
            data-note-id={note.id}
            ref={(el) => registerWrapper(note.id, el)}
            className="masonry-item"
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
              enterDelay={layout ? enterDelays[i] ?? 0 : 0}
              onOpen={onOpen}
              registerEl={registerEl}
            />
          </div>
        );
      })}
    </div>
  );
}
