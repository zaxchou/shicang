// API client：统一错误封装、请求序号防过期覆盖。
import type {
  Category,
  LibraryInfo,
  NoteDetail,
  NoteListResult,
  RefreshJobInfo,
  TagCount,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络请求失败，请检查与服务器的连接');
  }
  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface QueryParams {
  collection?: string;
  q: string;
  categoryId: string | null; // null=全部, 'uncategorized', 或分类 id
  tag?: string | null; // 精确标签过滤
  timeField: 'published' | 'synced';
  range: 'all' | '7d' | '30d' | 'custom';
  from?: string;
  to?: string;
  order: 'desc' | 'asc';
  offset: number;
  limit: number;
}

export function buildQuery(p: QueryParams): string {
  const sp = new URLSearchParams();
  if (p.collection) sp.set('collection', p.collection);
  if (p.q.trim()) sp.set('q', p.q.trim());
  if (p.categoryId) sp.set('category', p.categoryId);
  if (p.tag) sp.set('tag', p.tag);
  sp.set('timeField', p.timeField);
  sp.set('range', p.range);
  if (p.range === 'custom') {
    if (p.from) sp.set('from', p.from);
    if (p.to) sp.set('to', p.to);
  }
  sp.set('order', p.order);
  sp.set('offset', String(p.offset));
  sp.set('limit', String(p.limit));
  return sp.toString();
}

export const api = {
  library: () => request<LibraryInfo>('/api/library'),
  categories: () => request<{ categories: Category[] }>('/api/categories'),
  tags: (collection?: string) =>
    request<{ tags: TagCount[] }>(`/api/tags${collection ? `?collection=${encodeURIComponent(collection)}` : ''}`),
  notes: (p: QueryParams) => request<NoteListResult>(`/api/notes?${buildQuery(p)}`),
  note: (id: string) => request<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`),
  setCategory: (id: string, categoryId: string | null, expectedRevision: number) =>
    request<{ revision: number; categoryId: string | null }>(
      `/api/notes/${encodeURIComponent(id)}/category`,
      { method: 'PATCH', body: JSON.stringify({ categoryId, expectedRevision }) }
    ),
  startRefresh: () => request<{ job: RefreshJobInfo }>('/api/refresh', { method: 'POST' }),
  refreshJob: (jobId: string) => request<{ job: RefreshJobInfo }>(`/api/refresh/${encodeURIComponent(jobId)}`),
};
