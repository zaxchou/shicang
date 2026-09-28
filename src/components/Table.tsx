import { useMemo, useState } from 'react';
import type { CollectionInfo, NoteSummary } from '../../shared/types';
import { shanghaiDate } from '../../shared/time';
import { IconChevronDown } from './Icons';

interface Props {
  notes: NoteSummary[];
  /** 当前收藏库信息（含表格字段 extraFields） */
  info: CollectionInfo;
  /** 当前筛选条件下的总条数：大于 notes.length 时说明只加载了前一段（要提示，否则像丢数据） */
  resultTotal?: number | null;
  categoryName(id: string | null): string | null;
  onOpen(note: NoteSummary, el: HTMLElement): void;
  registerEl(id: string, el: HTMLElement | null): void;
}

type ColKind = 'title' | 'author' | 'category' | 'date' | 'tags' | 'extra';

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

function buildColumns(info: CollectionInfo): Col[] {
  if (info.id === 'rednote') {
    return [
      { key: 'title', label: '标题', kind: 'title', minW: 300 },
      { key: 'author', label: '作者', kind: 'author', minW: 140 },
      { key: 'category', label: '分类', kind: 'category', minW: 110 },
      { key: 'publishedAt', label: '发布时间', kind: 'date', minW: 110 },
      { key: 'syncedAt', label: '同步时间', kind: 'date', minW: 110 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 220 },
    ];
  }
  if (info.id === 'diary') {
    return [
      { key: 'publishedAt', label: '日期', kind: 'date', minW: 100 },
      { key: 'category', label: '主题', kind: 'category', minW: 110 },
      { key: 'title', label: '标题', kind: 'title', minW: 360 },
      { key: 'tags', label: '标签', kind: 'tags', minW: 160 },
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
    case 'date': {
      const iso = col.key === 'publishedAt' ? note.publishedAt : note.syncedAt;
      return iso ? (shanghaiDate(iso) ?? '') : null;
    }
    case 'tags':
      return note.tags.join('、');
    case 'extra': {
      const v = note.extra?.[col.extraKey!];
      return v === undefined || v === null || v === '' ? null : v;
    }
    default:
      return null;
  }
}

export function DataTable({ notes, info, resultTotal = null, categoryName, onOpen, registerEl }: Props) {
  const cols = useMemo(() => buildColumns(info), [info]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

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
              onClick={(e) => onOpen(note, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(note, e.currentTarget);
                }
              }}
            >
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
