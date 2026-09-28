import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_REMARK, type NoteDetail, type NoteStatus, type NoteSummary } from '../../shared/types';

interface CategoryOption {
  id: string;
  name: string;
}
import { formatShanghai } from '../../shared/time';
import { api, ApiError } from '../api/client';
import { IconArchive, IconChevronDown, IconCheck, IconClose, IconExternal, IconPen, IconStar } from './Icons';

/** 详情中附加字段展示顺序（与表格一致） */
const EXTRA_DISPLAY_ORDER = [
  '价格', '购买时间', '作者品牌', '作者', '器型', '制作年份', '拓年份', '朝代', '时代',
  '书风', '画风', '撰写', '装裱', '尺寸', '工艺', '泥料', '艺术家', '价格区间', '说明',
];

interface Props {
  summary: NoteSummary;
  categories: CategoryOption[];
  categoryRevision: number;
  /** 仅 rednote 显示可编辑的分类选择；其它库显示只读派生分类 */
  showCategoryPicker?: boolean;
  onCategoryChanged(noteId: string, categoryId: string | null, revision: number): void;
  onCategoryError(message: string): void;
  /** 标星开关（三个库都可标） */
  onToggleStar(): void;
  /** 标注 revision，改状态时作为 expectedRevision */
  annotationRevision: number;
  onStatusChanged(noteId: string, status: NoteStatus, revision: number): void;
  /** 备注保存成功（App 更新列表卡片与详情） */
  onRemarkChanged(noteId: string, remark: string | null, revision: number): void;
  /** 标注类操作（归档 / 备注）出错时的统一提示 */
  onAnnotationError(message: string): void;
  onClose(): void;
}

/** 归档只有一个含义（现在没用了），所以就是一个开关按钮，不做多种状态 */
export function DetailDialog({
  summary,
  categories,
  categoryRevision,
  showCategoryPicker = true,
  onCategoryChanged,
  onCategoryError,
  onToggleStar,
  annotationRevision,
  onStatusChanged,
  onRemarkChanged,
  onAnnotationError,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(summary.annotation.remark ?? '');
  const [remarkSaving, setRemarkSaving] = useState(false);
  /** 备注面板默认收起：常驻一个输入框太占地方（用户反馈「有点显眼」） */
  const [remarkOpen, setRemarkOpen] = useState(false);
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

  const currentStatus = summary.annotation.status;
  const setStatus = useCallback(
    async (next: 'archived' | null) => {
      if ((next === null) === (currentStatus === 'active')) return; // 点当前状态不做无谓的写盘
      setStatusSaving(true);
      try {
        const out = await api.setStatus(summary.id, next, annotationRevision);
        onStatusChanged(summary.id, out.status, out.revision);
      } catch (e) {
        onAnnotationError(e instanceof ApiError ? e.message : '归档操作失败');
      } finally {
        setStatusSaving(false);
      }
    },
    [summary.id, currentStatus, annotationRevision, onStatusChanged, onAnnotationError]
  );

  // 换一条笔记（或备注被别处改过）时把草稿同步回来
  useEffect(() => {
    setRemarkDraft(summary.annotation.remark ?? '');
  }, [summary.id, summary.annotation.remark]);

  const savedRemark = summary.annotation.remark ?? '';
  const remarkDirty = remarkDraft.trim() !== savedRemark;
  const saveRemark = useCallback(async () => {
    const next = remarkDraft.trim();
    if (next === savedRemark) return;
    setRemarkSaving(true);
    try {
      const out = await api.setRemark(summary.id, next === '' ? null : next, annotationRevision);
      onRemarkChanged(summary.id, out.remark, out.revision);
      setRemarkOpen(false); // 保存即收起，想再改再点一次「备注」
    } catch (e) {
      onAnnotationError(e instanceof ApiError ? e.message : '备注保存失败');
    } finally {
      setRemarkSaving(false);
    }
  }, [remarkDraft, savedRemark, summary.id, annotationRevision, onRemarkChanged, onAnnotationError]);

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
            {/* 备注改成按需展开：平时不占地方，需要时点这里（有内容时按钮上有个小点） */}
            <button
              type="button"
              className={`btn-icon btn-remark-toggle${savedRemark ? ' has-remark' : ''}`}
              aria-expanded={remarkOpen}
              aria-label={remarkOpen ? '收起备注' : '备注'}
              title={savedRemark ? '备注（已有内容）' : '添加备注'}
              onClick={() => setRemarkOpen((v) => !v)}
            >
              <IconPen size={15} />
            </button>
            <button
              type="button"
              className={`btn-star detail-star${summary.annotation.starred ? ' starred' : ''}`}
              onClick={onToggleStar}
              aria-pressed={summary.annotation.starred}
              aria-label={summary.annotation.starred ? '取消标星' : '标星'}
              title={summary.annotation.starred ? '取消标星' : '标星'}
            >
              <IconStar size={15} filled={summary.annotation.starred} />
            </button>
            {/* 归档紧挨着标星：两个都是"这条怎么处理"的开关，没必要各占一行 */}
            <button
              type="button"
              className={`btn-icon btn-archive-icon${currentStatus === 'archived' ? ' archived' : ''}`}
              aria-pressed={currentStatus === 'archived'}
              disabled={statusSaving}
              aria-label={currentStatus === 'archived' ? '取回' : '归档'}
              title={
                currentStatus === 'archived'
                  ? '已归档 · 点一下取回（放回默认列表）'
                  : '归档：现在没用了，收进侧栏「归档」（只影响拾藏，不删源文件，随时可取回）'
              }
              onClick={() => void setStatus(currentStatus === 'archived' ? null : 'archived')}
            >
              <IconArchive size={15} />
            </button>
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

        {remarkOpen && (
          <div className="detail-remark-panel">
            <div className="remark-head">
              <span className="remark-label">备注</span>
              {remarkDirty && <span className="remark-dirty">未保存</span>}
            </div>
            <textarea
              className="remark-input"
              autoFocus
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void saveRemark();
                }
                if (e.key === 'Escape') {
                  // 就地收起，不要顺带把整个详情关掉（详情也在监听 Esc）
                  e.stopPropagation();
                  setRemarkOpen(false);
                }
              }}
              placeholder="给自己记点什么：为什么留下它、下次怎么用…"
              maxLength={MAX_REMARK}
              rows={4}
              disabled={remarkSaving}
              aria-label="备注"
            />
            <div className="remark-actions">
              <button
                type="button"
                className="btn-remark-save"
                onClick={() => void saveRemark()}
                disabled={!remarkDirty || remarkSaving}
              >
                {remarkSaving ? '保存中…' : '保存备注'}
              </button>
              <button type="button" className="btn-remark-close" onClick={() => setRemarkOpen(false)}>
                收起
              </button>
              <span className="ann-hint">⌘/Ctrl + Enter 保存 · 只存在拾藏里，不写回 Obsidian</span>
            </div>
          </div>
        )}

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
              {detail.extra && Object.keys(detail.extra).length > 0 && (
                <div className="detail-extras">
                  {EXTRA_DISPLAY_ORDER.filter((k) => k in detail.extra!).map((k) => (
                    <div key={k} className="extra-item">
                      <span className="extra-label">{k}</span>
                      <span className="extra-value">{String(detail.extra![k])}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="detail-meta">
                {showCategoryPicker ? (
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
                ) : (
                  <span className="cat-static">{summary.categoryId ?? '未分类'}</span>
                )}
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
