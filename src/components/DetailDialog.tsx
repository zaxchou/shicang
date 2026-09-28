import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MAX_REMARK,
  type NoteDetail,
  type NoteStatus,
  type NoteSummary,
  type RecognizedText,
} from '../../shared/types';

interface CategoryOption {
  id: string;
  name: string;
}
import { formatShanghai } from '../../shared/time';
import { api, ApiError } from '../api/client';
import {
  IconArchive,
  IconChevronDown,
  IconCheck,
  IconClose,
  IconExternal,
  IconPen,
  IconScanText,
  IconStar,
} from './Icons';

/**
 * 一次点击最多识别几张：与后端 `AI_OCR_MAX_PER_NOTE` 的默认值一致。
 * 前端按这个数分批，剩下的用「识别其余 N 张」显式再点一次——不替用户一次烧掉几十张的额度。
 */
const OCR_BATCH = 8;

/** 识别文本的折叠阈值（em）：超过这个高度才裁切。约 5 行。 */
const OCR_CLAMP_EM = 9;

/**
 * 一条识别文本。
 * **必须测量真实溢出，不能数 `\n`**——上一版按"换行数 > 4"决定要不要给「展开全部」，
 * 而裁切是 CSS 无条件施加的，于是"4 行的短文本"既没有展开按钮、又被渐隐吞掉最后一行
 * （用户截图里 `12 Jun 2005` 就是这么消失的）。而且遮罩加在整个块上时，短文本也会被渐隐。
 * 现在：先按未裁切状态量出内容高度，只有真的超过阈值才加裁切与渐隐，并同时给出展开入口。
 */
function OcrText({
  text,
  noText,
  expanded,
  onToggle,
}: {
  text: string;
  noText: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight 不受 max-height 影响（裁切时也返回完整内容高度），所以这个判断在
    // 裁切前后都成立：换宽度、换主题重排后重新量一次即可。
    const check = () => {
      const limit = OCR_CLAMP_EM * parseFloat(getComputedStyle(el).fontSize);
      setOverflow(el.scrollHeight > limit + 1);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [text]);

  const clamped = overflow && !expanded;
  return (
    <>
      <p ref={ref} className={`ocr-text${noText ? ' empty' : ''}${clamped ? ' clamped' : ''}`}>
        {text}
      </p>
      {overflow && (
        <button type="button" className="link-clear ocr-more" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '收起' : `展开全部（${text.split('\n').length} 行）`}
        </button>
      )}
    </>
  );
}

/** 复制到剪贴板。
 * 局域网 http 访问时 `navigator.clipboard` 不存在（非安全上下文），所以必须留 execCommand 一路，
 * 两路都不行时返回 false，由界面提示"手动选中复制"——不能假装复制成功了。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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
  /** 普通提示（识别开始/完成这类"过程通知"）——详情里跑长任务时必须让用户看见 */
  onNotice?(message: string): void;
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
  onNotice,
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
  /** 识别文本（OCR）：进详情就拉一次已有的，不必再点 */
  const [mediaText, setMediaText] = useState<RecognizedText[]>([]);
  const [expandedOcr, setExpandedOcr] = useState<Set<string>>(new Set());
  const [ocrRunning, setOcrRunning] = useState(false);
  /** 图片文字默认**折叠**：它是附加内容，不该一进来就把正文顶下去（用户明确反馈过） */
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
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

  // 已有的识别文本（OCR）：进详情就拉一次——用户要"能看见"，不该还要再点一次才看得到
  useEffect(() => {
    let alive = true;
    setMediaText([]);
    setOcrMsg(null);
    api
      .noteMediaText(summary.id)
      .then((r) => {
        if (alive) setMediaText(r.items);
      })
      .catch(() => {
        /* 识别文本拉不到不影响阅读正文，静默即可 */
      });
    return () => {
      alive = false;
    };
  }, [summary.id]);

  /** 这篇能识别的本地图片（按笔记内顺序）；没有图就不显示按钮 */
  const ocrTargets = (detail?.media ?? []).filter(
    (m) => m.kind === 'image' && m.localRelativePath && m.available !== false
  );

  const runOcr = useCallback(async () => {
    if (ocrRunning || !detail) return;
    const pending = ocrTargets.filter((m) => !mediaText.some((t) => t.mediaId === m.id));
    if (pending.length === 0) {
      setOcrMsg('这篇的图片都已经识别过了');
      return;
    }
    // 逐张请求，不一次闷完：8 张要 40-60 秒，中间必须有反馈，
    // 否则用户看到的就是"点了没反应"（实测就是这个原因找上来的）。
    const batch = pending.slice(0, OCR_BATCH);
    setOcrRunning(true);
    setOcrOpen(true); // 刚识别完就让用户看见结果；下次进来仍是折叠的
    setOcrMsg(null);
    setOcrProgress({ done: 0, total: batch.length });
    onNotice?.(`开始识别 ${batch.length} 张图…（每张约 5–10 秒，可以继续看页面）`);

    let okCount = 0;
    let cachedCount = 0;
    const failures: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      setOcrProgress({ done: i, total: batch.length });
      try {
        const target = batch[i];
        if (!target) break;
        const out = await api.ocrNote(summary.id, target.id);
        const r = out.results[0];
        if (r?.ok) {
          okCount++;
          if (r.cached) cachedCount++;
          setMediaText(out.recognized); // 每张完成后立即出现，不等全部跑完
        } else if (r) {
          failures.push(r.reason ?? '未知原因');
        }
      } catch (e) {
        failures.push(e instanceof ApiError ? e.message : '请求失败');
        break; // 网络/服务端异常时不再继续打接口
      }
      setOcrProgress({ done: i + 1, total: batch.length });
    }

    setOcrProgress(null);
    setOcrRunning(false);
    const left = pending.length - batch.length;
    const parts = [`识别完成：${okCount} 张`];
    if (cachedCount) parts.push(`${cachedCount} 张用了已有结果`);
    if (failures.length) parts.push(`${failures.length} 张失败（${failures[0]}）`);
    if (left > 0) parts.push(`还有 ${left} 张没识别，点「识别其余 ${left} 张」继续`);
    const summaryText = parts.join(' · ');
    setOcrMsg(summaryText);
    onNotice?.(summaryText);
  }, [detail, ocrRunning, ocrTargets, mediaText, onNotice, summary.id]);

  const dropMediaText = useCallback(
    async (mediaId: string) => {
      try {
        await api.clearMediaText(summary.id, mediaId);
        setMediaText((prev) => prev.filter((t) => t.mediaId !== mediaId));
      } catch (e) {
        setOcrMsg(e instanceof ApiError ? e.message : '删除识别结果失败');
      }
    },
    [summary.id]
  );

  const copyMediaText = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    setOcrMsg(ok ? '已复制到剪贴板' : '复制失败（这个地址下浏览器不允许），请手动选中文字复制');
  }, []);

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
            {/* 识别图片文字：只在有本地图片时出现；结果按媒体内容 hash 缓存，不会重复烧额度 */}
            {ocrTargets.length > 0 && (
              <button
                type="button"
                className={`btn-icon btn-ocr${ocrRunning ? ' running' : ''}${mediaText.length ? ' has-text' : ''}`}
                disabled={ocrRunning}
                aria-label="识别图片文字"
                title={
                  ocrRunning
                    ? '识别中…（大图可能要十几秒）'
                    : mediaText.length
                      ? `识别图片文字（已有 ${mediaText.length} 张的结果，重复的图不会重复识别）`
                      : `识别这篇 ${ocrTargets.length} 张图里的文字，识别后可以被搜索到`
                }
                onClick={() => void runOcr()}
              >
                <IconScanText size={15} />
              </button>
            )}
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

              {/* 图片文字：折叠在正文流里（不再压在正文上方、也不默认全展开），
                  每条带缩略图——否则"图 1/图 2"这种标签根本认不出对的是哪张图 */}
              {(ocrRunning || ocrMsg || mediaText.length > 0) && (
                <section className={`ocr-section${ocrOpen ? ' open' : ''}`} aria-busy={ocrRunning}>
                  <div className="ocr-head">
                    <button
                      type="button"
                      className="ocr-toggle-btn"
                      aria-expanded={ocrOpen}
                      onClick={() => setOcrOpen((v) => !v)}
                    >
                      <IconChevronDown size={12} className={ocrOpen ? 'caret open' : 'caret'} />
                      <span className="ocr-title">图片文字</span>
                      {mediaText.length > 0 && <span className="ocr-count">{mediaText.length} 张</span>}
                    </button>
                    {ocrRunning && ocrProgress && (
                      <span className="ocr-progress" role="status">
                        识别中 {Math.min(ocrProgress.done + 1, ocrProgress.total)}/{ocrProgress.total}…
                      </span>
                    )}
                    {!ocrRunning && ocrTargets.length > 0 && mediaText.length < ocrTargets.length && (
                      <button type="button" className="link-clear" onClick={() => void runOcr()}>
                        识别其余 {ocrTargets.length - mediaText.length} 张
                      </button>
                    )}
                  </div>
                  {ocrRunning && (
                    <div className="ocr-bar" aria-hidden>
                      <span
                        style={{
                          width: `${ocrProgress ? Math.round((ocrProgress.done / Math.max(1, ocrProgress.total)) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  )}
                  {!ocrRunning && ocrMsg && <div className="ocr-msg">{ocrMsg}</div>}
                  {ocrOpen && (
                    <div className="ocr-list">
                      {mediaText.map((t) => {
                        const idx = ocrTargets.findIndex((m) => m.id === t.mediaId);
                        const noText = /^无文字[。.]?$/.test(t.text.trim());
                        // 要不要裁切由 OcrText 自己量（不数 \n——换行数不等于视觉行数）
                        const expanded = expandedOcr.has(t.mediaId);
                        return (
                          <div key={t.mediaId} className="ocr-item">
                            <a
                              className="ocr-thumb"
                              href={`/api/media/${encodeURIComponent(summary.id)}/${encodeURIComponent(t.mediaId)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="在新标签里看这张原图"
                            >
                              <img
                                src={`/api/media/${encodeURIComponent(summary.id)}/${encodeURIComponent(t.mediaId)}`}
                                alt={idx >= 0 ? `图 ${idx + 1}` : ''}
                                loading="lazy"
                              />
                            </a>
                            <div className="ocr-content">
                              <div className="ocr-item-head">
                                <span className="ocr-item-label">{idx >= 0 ? `图 ${idx + 1}` : t.mediaId}</span>
                                <span className="ocr-item-actions">
                                  <button
                                    type="button"
                                    className="link-clear"
                                    onClick={() => void copyMediaText(t.text)}
                                    disabled={noText}
                                  >
                                    复制
                                  </button>
                                  <button
                                    type="button"
                                    className="link-clear"
                                    onClick={() => void dropMediaText(t.mediaId)}
                                  >
                                    重来
                                  </button>
                                </span>
                              </div>
                              <OcrText
                                text={t.text}
                                noText={noText}
                                expanded={expanded}
                                onToggle={() =>
                                  setExpandedOcr((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(t.mediaId)) next.delete(t.mediaId);
                                    else next.add(t.mediaId);
                                    return next;
                                  })
                                }
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {ocrOpen && mediaText.length > 0 && (
                    <div className="ann-hint ocr-note">
                      只存在拾藏里，不写回 Obsidian；已经参与搜索，重新导出语料后会进入语料库
                    </div>
                  )}
                </section>
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
