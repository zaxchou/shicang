import { useCallback, useEffect, useRef, useState } from 'react';
import type { Category, NoteDetail, NoteSummary } from '../../shared/types';
import { formatShanghai } from '../../shared/time';
import { api, ApiError } from '../api/client';
import { IconChevronDown, IconCheck, IconClose, IconExternal } from './Icons';

interface Props {
  summary: NoteSummary;
  categories: Category[];
  categoryRevision: number;
  onCategoryChanged(noteId: string, categoryId: string | null, revision: number): void;
  onCategoryError(message: string): void;
  onClose(): void;
}

export function DetailDialog({ summary, categories, categoryRevision, onCategoryChanged, onCategoryError, onClose }: Props) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  /** 先播退出动画，动画结束再真正卸载 */
  const beginClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    // 立即暂停所有媒体，避免退出动画期间仍有声音
    bodyRef.current?.querySelectorAll('video').forEach((v) => v.pause());
    setClosing(true);
  }, []);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api
      .note(summary.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e: ApiError) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [summary.id]);

  // 打开时聚焦关闭按钮；Esc 关闭
  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') beginClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [beginClose]);

  // 远程视频播放失败时给出可理解的反馈（含监听前已失败的情况）
  useEffect(() => {
    if (!detail) return;
    const root = bodyRef.current;
    if (!root) return;
    const videos = Array.from(root.querySelectorAll('video'));
    for (const v of videos) {
      v.addEventListener('error', () => setVideoFailed(true));
      if (v.error) setVideoFailed(true); // error 事件只触发一次，补查已发生的失败
    }
    // 正文图片加载失败 → 替换为占位提示
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('.detail-article img'));
    const cleanups: Array<() => void> = [];
    for (const img of imgs) {
      const onError = () => {
        img.style.display = 'none';
        if (!img.nextElementSibling?.classList.contains('img-fallback')) {
          img.insertAdjacentHTML(
            'afterend',
            '<div class="img-fallback">图片加载失败，可尝试查看原文</div>'
          );
        }
      };
      img.addEventListener('error', onError);
      if (img.complete && img.naturalWidth === 0) onError(); // 已失败的缓存图片不再触发 error
      cleanups.push(() => img.removeEventListener('error', onError));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [detail]);

  // 点击菜单外部关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const setCategory = useCallback(
    async (categoryId: string | null) => {
      setMenuOpen(false);
      setSaving(true);
      try {
        const out = await api.setCategory(summary.id, categoryId, categoryRevision);
        onCategoryChanged(summary.id, out.categoryId, out.revision);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : '保存失败';
        onCategoryError(msg);
      } finally {
        setSaving(false);
      }
    },
    [summary.id, categoryRevision, onCategoryChanged, onCategoryError]
  );

  const currentCat = categories.find((c) => c.id === summary.categoryId) ?? null;

  return (
    <div
      className={`detail-overlay${closing ? ' closing' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) beginClose();
      }}
      role="presentation"
    >
      <div
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-label={summary.title}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget && e.animationName === 'detailOut') onClose();
        }}
      >
        <div className="detail-header">
          <div className="detail-author">
            <span className="detail-avatar" aria-hidden>
              {summary.author.slice(0, 1)}
            </span>
            <span className="detail-author-name">{summary.author}</span>
          </div>
          <div className="detail-header-actions">
            {detail?.originalUrl && (
              <a className="btn-link" href={detail.originalUrl} target="_blank" rel="noopener noreferrer">
                <IconExternal size={13} />
                查看原文
              </a>
            )}
            <button ref={closeBtnRef} className="btn-icon" onClick={beginClose} aria-label="关闭详情">
              <IconClose size={16} />
            </button>
          </div>
        </div>

        <div className="detail-body" ref={bodyRef}>
          {error && (
            <div className="detail-state">
              <div className="state-title" style={{ color: 'var(--text-secondary)' }}>详情加载失败</div>
              <div>{error}</div>
            </div>
          )}
          {!error && !detail && <div className="detail-state">加载中…</div>}
          {detail && (
            <div className="detail-inner">
              <h2 className="detail-title">{detail.title}</h2>
              <div className="detail-meta">
                <div className="cat-picker" ref={menuRef}>
                  <button
                    className={`cat-picker-btn${saving ? ' saving' : ''}`}
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={saving}
                  >
                    {currentCat ? currentCat.name : '未分类'}
                    <IconChevronDown size={12} />
                  </button>
                  {menuOpen && (
                    <div className="cat-menu" role="menu">
                      {categories.map((c) => (
                        <button
                          key={c.id}
                          role="menuitemradio"
                          aria-checked={summary.categoryId === c.id}
                          className={`cat-menu-item${summary.categoryId === c.id ? ' current' : ''}`}
                          onClick={() => setCategory(c.id)}
                        >
                          <span>{c.name}</span>
                          {summary.categoryId === c.id && (
                            <span className="check">
                              <IconCheck />
                            </span>
                          )}
                        </button>
                      ))}
                      <button
                        role="menuitemradio"
                        aria-checked={summary.categoryId === null}
                        className={`cat-menu-item${summary.categoryId === null ? ' current' : ''}`}
                        onClick={() => setCategory(null)}
                      >
                        <span>未分类</span>
                        {summary.categoryId === null && (
                          <span className="check">
                            <IconCheck />
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
                <span>发布：{formatShanghai(detail.publishedAt) ?? '未知'}</span>
                <span>同步：{formatShanghai(detail.syncedAt) ?? '未知'}</span>
                {detail.sourceStatus === 'missing' && <span style={{ color: 'var(--accent)' }}>源文件暂不可用</span>}
              </div>

              {videoFailed && (
                <div className="detail-video-fallback">
                  视频暂时无法播放（远程视频源不可用或受网络限制）。可尝试
                  {detail.originalUrl ? (
                    <a href={detail.originalUrl} target="_blank" rel="noopener noreferrer">
                      查看原文
                    </a>
                  ) : (
                    '稍后重试'
                  )}
                  。图文内容仍可正常阅读。
                </div>
              )}

              <div className="detail-article" dangerouslySetInnerHTML={{ __html: detail.bodyHtml }} />

              {detail.tags.length > 0 && (
                <div className="detail-tags">
                  {detail.tags.map((t) => (
                    <span key={t} className="detail-tag">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
