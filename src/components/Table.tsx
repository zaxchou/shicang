import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionInfo, NoteSummary } from '../../shared/types';
import { shanghaiDate } from '../../shared/time';
import { IconArchive, IconChevronDown, IconStar } from './Icons';

interface Props {
  notes: NoteSummary[];
  /** 当前收藏库信息（含表格字段 extraFields）；组视图传聚合体 */
  info: CollectionInfo;
  /** 组视图：多一条"收藏库"列、没有分类列 */
  isGroupScope?: boolean;
  /** 组视图下列"收藏库"的名字映射 */
  collectionName?(id: string | null): string | null;
  /** 当前筛选条件下的总条数：大于 notes.length 时说明只加载了前一段（要提示，否则像丢数据） */
  resultTotal?: number | null;
  categoryName(id: string | null): string | null;
  onOpen(note: NoteSummary, el: HTMLElement): void;
  onToggleStar(note: NoteSummary): void;
  /** 归档 / 取回单条 */
  onToggleArchive(note: NoteSummary): void;
  /** 勾选（批量操作用） */
  selected: Set<string>;
  onToggleSelect(id: string, on: boolean): void;
  onToggleSelectAll(on: boolean): void;
  registerEl(id: string, el: HTMLElement | null): void;
}

type ColKind = 'title' | 'author' | 'category' | 'collection' | 'date' | 'tags' | 'extra' | 'remark';

interface Col {
  key: string;
  label: string;
  kind: ColKind;
  extraKey?: string;
  minW?: number;
}

/** treasures 表格列的优先顺序（存在才显示；说明列太长留给详情） */
const EXTRA_ORDER = [
  '价格', '购买时间', '作者品牌', '作者', '器型', '制作年份', '拓年份', '朝代', '时代',
  '书风', '画风', '撰写', '装裱', '尺寸', '工艺', '泥料', '艺术家', '价格区间',
];

function buildColumns(info: CollectionInfo, opts: { group: boolean }): Col[] {
  // 组视图（如剪藏）：混着多个子库的笔记，列是各库的公约数 + "收藏库"列标明归属
  if (opts.group) {
    return [
      { key: 'title', label: '标题', kind: 'title', minW: 320 },
      { key: 'author', label: '作者', kind: 'author', minW: 130 },
      { key: 'collection', label: '收藏库', kind: 'collection', minW: 90 },
      { key: 'publishedAt', label: '发布时间', kind: 'date', minW: 110 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 200 },
      { key: 'remark', label: '备注', kind: 'remark', minW: 200 },
    ];
  }
  if (info.id === 'rednote') {
    return [
      { key: 'title', label: '标题', kind: 'title', minW: 300 },
      { key: 'author', label: '作者', kind: 'author', minW: 140 },
      { key: 'category', label: '分类', kind: 'category', minW: 110 },
      { key: 'publishedAt', label: '发布时间', kind: 'date', minW: 110 },
      { key: 'syncedAt', label: '同步时间', kind: 'date', minW: 110 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 220 },
      { key: 'remark', label: '备注', kind: 'remark', minW: 200 },
    ];
  }
  if (info.type === 'web') {
    // 网页/微信公众号剪藏：来源分类 + 原文发布时间 + 剪藏时间（按类型判定，不认 id）
    return [
      { key: 'title', label: '标题', kind: 'title', minW: 320 },
      { key: 'author', label: '作者', kind: 'author', minW: 130 },
      { key: 'category', label: '来源', kind: 'category', minW: 100 },
      { key: 'publishedAt', label: '发布时间', kind: 'date', minW: 110 },
      { key: 'syncedAt', label: '剪藏时间', kind: 'date', minW: 110 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 180 },
      { key: 'remark', label: '备注', kind: 'remark', minW: 200 },
    ];
  }
  if (info.id === 'diary') {
    return [
      { key: 'publishedAt', label: '日期', kind: 'date', minW: 100 },
      { key: 'category', label: '主题', kind: 'category', minW: 110 },
      { key: 'title', label: '标题', kind: 'title', minW: 360 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 160 },
      { key: 'remark', label: '备注', kind: 'remark', minW: 200 },
    ];
  }
  // treasures：标题 + 分类 + 按出现率/顺序的附加字段 + 标签
  const present = info.extraFields.map((f) => f.key);
  const extras = EXTRA_ORDER.filter((k) => present.includes(k)).map<Col>((k) => ({
    key: `x:${k}`,
    label: k,
    kind: 'extra',
    extraKey: k,
    minW: k === '购买时间' || k.startsWith('制作') || k.startsWith('拓年') ? 110 : 96,
  }));
  return [
    { key: 'title', label: '标题', kind: 'title', minW: 280 },
    { key: 'category', label: '分类', kind: 'category', minW: 90 },
    ...extras,
    { key: 'tags', label: '标签', kind: 'tags', minW: 180 },
    { key: 'remark', label: '备注', kind: 'remark', minW: 200 },
  ];
}

function cellValue(note: NoteSummary, col: Col): string | number | null {
  switch (col.kind) {
    case 'title':
      return note.title;
    case 'author':
      return note.author;
    case 'category':
      return note.categoryId ? (note.categoryId as string) : '未分类';
    case 'collection':
      return note.collection;
    case 'date': {
      const iso = col.key === 'publishedAt' ? note.publishedAt : note.syncedAt;
      return iso ? (shanghaiDate(iso) ?? '') : null;
    }
    case 'tags':
      return note.tags.join('、');
    case 'remark':
      return note.annotation.remark;
    case 'extra': {
      const v = note.extra?.[col.extraKey!];
      return v === undefined || v === null || v === '' ? null : v;
    }
    default:
      return null;
  }
}

export function DataTable({
  notes,
  info,
  isGroupScope = false,
  collectionName,
  resultTotal = null,
  categoryName,
  onOpen,
  onToggleStar,
  onToggleArchive,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  registerEl,
}: Props) {
  const cols = useMemo(() => buildColumns(info, { group: isGroupScope }), [info, isGroupScope]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  // 全选框的"部分选中"：受控 checkbox 只有 checked，不设 indeterminate 的话
  // 部分选中显示为未勾选，视觉语义是错的（深审发现）。indeterminate 只能 imperative 设置。
  const allChecked = notes.length > 0 && notes.every((n) => selected.has(n.id));
  const someChecked = notes.some((n) => selected.has(n.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = selectAllRef.current;
    if (el) el.indeterminate = someChecked && !allChecked;
  }, [someChecked, allChecked]);

  const rows = useMemo(() => {
    if (!sort) return notes;
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return notes;
    const enriched = notes.map((n) => ({ n, v: cellValue(n, col) }));
    enriched.sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // null 恒排末尾
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv), 'zh-Hans-CN') * sort.dir;
    });
    return enriched.map((x) => x.n);
  }, [notes, sort, cols]);

  const toggleSort = (col: Col) => {
    setSort((prev) => (prev?.key === col.key ? { key: col.key, dir: prev.dir === 1 ? -1 : 1 } : { key: col.key, dir: 1 }));
  };

  const renderCell = (note: NoteSummary, col: Col) => {
    const v = cellValue(note, col);
    if (v === null) return <span className="cell-null">—</span>;
    if (col.kind === 'title') {
      return (
        <span className="cell-title" title={note.title}>
          {note.title}
        </span>
      );
    }
    if (col.kind === 'tags') {
      const tags = note.tags.slice(0, 4);
      return (
        <span className="cell-tags" title={note.tags.join('、')}>
          {tags.map((t) => (
            <span key={t} className="cell-tag">
              #{t}
            </span>
          ))}
          {note.tags.length > 4 && <span className="cell-tag-more">+{note.tags.length - 4}</span>}
        </span>
      );
    }
    if (col.kind === 'category') {
      const name = note.categoryId ? (categoryName(note.categoryId) ?? note.categoryId) : null;
      return name ? <span className="cell-cat">{name}</span> : <span className="cell-null">未分类</span>;
    }
    if (col.kind === 'collection') {
      const name = collectionName?.(note.collection) ?? note.collection;
      return <span className="cell-cat">{name}</span>;
    }
    if (col.kind === 'remark') {
      return (
        <span className="cell-remark" title={String(v)}>
          {String(v)}
        </span>
      );
    }
    if (col.kind === 'extra' && typeof v === 'number') {
      return <span className="cell-num">{v.toLocaleString('zh-CN')}</span>;
    }
    return <span className="cell-text">{String(v)}</span>;
  };

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th className="th-sel">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label="全选当前加载的行"
                checked={allChecked}
                onChange={(e) => onToggleSelectAll(e.target.checked)}
              />
            </th>
            <th className="th-act" title="标星 / 归档（点一下即可，不用进详情）">
              <span>标注</span>
            </th>
            {cols.map((c) => (
              <th
                key={c.key}
                style={{ minWidth: c.minW ?? 90 }}
                className={sort?.key === c.key ? `sorted dir-${sort.dir}` : ''}
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                tabIndex={0}
                onClick={() => toggleSort(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSort(c);
                  }
                }}
                title="点击或回车排序，再按一次反向"
              >
                <span>{c.label}</span>
                <IconChevronDown size={11} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((note) => (
            <tr
              key={note.id}
              tabIndex={0}
              ref={(el) => registerEl(note.id, el)}
              onClick={(e) => {
                // 行内控件（勾选框 / 星标 / 归档）自己会 stopPropagation 掉点击，
                // 但键盘事件没被拦住 —— 见下面的 onKeyDown
                onOpen(note, e.currentTarget);
              }}
              onKeyDown={(e) => {
                // 只处理"焦点就在行本身"的情况：否则空格/回车会从行内控件冒泡上来，
                // 变成"勾一下选/按一下星标，顺手把详情也打开了"——键盘用户根本没法用空格勾选（深审发现）
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(note, e.currentTarget);
                }
              }}
            >
              <td className="td-sel" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`选择「${note.title}」`}
                  checked={selected.has(note.id)}
                  onChange={(e) => onToggleSelect(note.id, e.target.checked)}
                />
              </td>
              <td className="td-act" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`row-star${note.annotation.starred ? ' starred' : ''}`}
                  aria-pressed={note.annotation.starred}
                  title={note.annotation.starred ? '取消标星' : '标星'}
                  aria-label={note.annotation.starred ? '取消标星' : '标星'}
                  onClick={() => onToggleStar(note)}
                >
                  <IconStar size={13} filled={note.annotation.starred} />
                </button>
                <button
                  type="button"
                  className={`row-archive${note.annotation.status === 'archived' ? ' archived' : ''}`}
                  aria-pressed={note.annotation.status === 'archived'}
                  title={note.annotation.status === 'archived' ? '取回（放回默认列表）' : '归档'}
                  aria-label={note.annotation.status === 'archived' ? '取回' : '归档'}
                  onClick={() => onToggleArchive(note)}
                >
                  <IconArchive size={13} />
                </button>
              </td>
              {cols.map((c) => (
                <td key={c.key}>{renderCell(note, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-foot">
        共 {rows.length} 行
        {resultTotal !== null && resultTotal > notes.length && (
          <span className="table-foot-warn">
            （当前筛选共 {resultTotal} 条，只加载了前 {notes.length} 条；列排序仅作用于已加载部分）
          </span>
        )}
      </div>
    </div>
  );
}
