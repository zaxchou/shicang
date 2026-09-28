// API client：统一错误封装、请求序号防过期覆盖。
import type {
  Category,
  CorpusManifest,
  LibraryInfo,
  NoteDetail,
  NoteListResult,
  NoteStatus,
  OcrRunResult,
  RecognizedText,
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
  /** 只看已标星 */
  starred?: boolean;
  /** 状态视图：active=在用（默认）；archived=归档 */
  status?: 'active' | 'archived';
  /** 归档视图带上源文件已消失的记录 */
  includeMissing?: boolean;
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
  if (p.starred) sp.set('starred', 'true');
  sp.set('status', p.status ?? 'active');
  if (p.includeMissing) sp.set('includeMissing', 'true');
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
  /** 标星 / 取消标星（单字段幂等动作，不需要 expectedRevision） */
  setStar: (id: string, star: boolean) =>
    request<{ revision: number; starred: boolean }>(`/api/notes/${encodeURIComponent(id)}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ star }),
    }),
  /** 归档 / 取回（null）。带 revision：这是"看一眼再改"的编辑 */
  setStatus: (id: string, status: 'archived' | null, expectedRevision: number) =>
    request<{ revision: number; status: NoteStatus }>(`/api/notes/${encodeURIComponent(id)}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedRevision }),
    }),
  /** 写备注（纯文本，传 null/空串清空）。与状态一样带 revision */
  setRemark: (id: string, remark: string | null, expectedRevision: number) =>
    request<{ revision: number; remark: string | null }>(
      `/api/notes/${encodeURIComponent(id)}/annotation`,
      { method: 'PATCH', body: JSON.stringify({ remark, expectedRevision }) }
    ),
  /** 批量归档/取回（表格里勾选多条后用）；返回实际改动条数 */
  setAnnotationMany: (ids: string[], patch: { star?: boolean; status?: 'archived' | null }) =>
    request<{ revision: number; updated: number }>('/api/annotations', {
      method: 'PATCH',
      body: JSON.stringify({ ids, ...patch }),
    }),
  startRefresh: () => request<{ job: RefreshJobInfo }>('/api/refresh', { method: 'POST' }),
  refreshJob: (jobId: string) => request<{ job: RefreshJobInfo }>(`/api/refresh/${encodeURIComponent(jobId)}`),
  /** 上次导出的 manifest（没导过为 null） */
  corpusManifest: () => request<{ manifest: CorpusManifest | null; dir: string }>('/api/export/corpus'),
  /** 立刻重导语料；内容没变时 written=false（服务端跳过写入） */
  exportCorpus: () =>
    request<{ manifest: CorpusManifest; written: boolean; dir: string }>('/api/export/corpus', { method: 'POST' }),
  /** 某笔记已有的识别文本（OCR/转录） */
  noteMediaText: (id: string) =>
    request<{ items: RecognizedText[] }>(`/api/notes/${encodeURIComponent(id)}/media-text`),
  /**
   * 按需识别图片文字。**只发 id**——图片由服务端自己读盘，浏览器不上传文件。
   * 不带 mediaId = 识别这篇里还没识别过的图（服务端有单次上限）。
   */
  ocrNote: (id: string, mediaId?: string) =>
    request<OcrRunResult>(`/api/notes/${encodeURIComponent(id)}/ocr`, {
      method: 'POST',
      body: JSON.stringify(mediaId ? { mediaId } : {}),
    }),
  /**
   * 按需转录语音。与 ocrNote 同形态：**只发 id**——音频由服务端读盘、（必要时）ffmpeg 转码后送出，
   * 浏览器不上传文件；按音频秒数计费，所以也是逐段请求、带进度。
   */
  transcribeNote: (id: string, mediaId?: string) =>
    request<OcrRunResult>(`/api/notes/${encodeURIComponent(id)}/transcribe`, {
      method: 'POST',
      body: JSON.stringify(mediaId ? { mediaId } : {}),
    }),
  /** 删掉一条识别结果（识别错了想重来） */
  clearMediaText: (id: string, mediaId: string) =>
    request<{ removed: boolean }>(
      `/api/notes/${encodeURIComponent(id)}/media-text/${encodeURIComponent(mediaId)}`,
      { method: 'DELETE' }
    ),
};
