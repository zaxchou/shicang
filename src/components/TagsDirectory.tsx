import { useMemo, useState } from 'react';
import type { TagCount } from '../../shared/types';
import { IconSearch } from './Icons';

interface Props {
  tags: TagCount[] | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onSelect(tag: string): void;
}

/** 标签目录：搜索并点选标签，快速定位对应内容 */
export function TagsDirectory({ tags, loading, error, onRetry, onSelect }: Props) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!tags) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return tags;
    return tags.filter((t) => t.tag.toLowerCase().includes(f));
  }, [tags, filter]);

  return (
    <div className="tags-directory">
      <div className="search-box" style={{ marginTop: 14 }}>
        <IconSearch size={15} />
        <input
          type="text"
          value={filter}
          placeholder="搜索标签…"
          onChange={(e) => setFilter(e.target.value)}
          aria-label="搜索标签"
        />
      </div>

      {loading && !tags && <div className="results-state">加载中…</div>}
      {error && !tags && (
        <div className="results-state">
          <div className="state-title">标签加载失败</div>
          <div>{error}</div>
          <button className="btn-refresh" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {tags && filtered.length === 0 && (
        <div className="results-state">
          <div className="state-title">没有匹配的标签</div>
          <div>{filter ? `不含“${filter.trim()}”的标签` : '收藏笔记暂无标签'}</div>
        </div>
      )}
      {tags && filtered.length > 0 && (
        <div className="tag-chips">
          {filtered.map((t) => (
            <button key={t.tag} className="tag-chip" onClick={() => onSelect(t.tag)} title={`${t.tag}（${t.count} 篇）`}>
              <span className="tag-name">#{t.tag}</span>
              <span className="tag-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
