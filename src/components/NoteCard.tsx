import { useEffect, useState } from 'react';
import type { NoteSummary } from '../../shared/types';
import { formatDurationSec } from '../../shared/time';
import { api } from '../api/client';
import { IconGlobe, IconLayers, IconPlay, IconStar } from './Icons';

interface Props {
  note: NoteSummary;
  categoryName: string | null;
  /** 笔记所属收藏库的类型；'web' = 网页/微信公众号剪藏（按类型判定，不认 id——同类型可以有多个库） */
  collectionType: string | null;
  /** 入场动画延迟（毫秒），0 表示不播放入场动画 */
  enterDelay?: number;
  onOpen(note: NoteSummary, el: HTMLElement): void;
  onToggleStar(note: NoteSummary): void;
  registerEl(id: string, el: HTMLElement | null): void;
}

/** 卡片上的标星按钮。卡片本身是 role="button"，所以点击与回车都必须就地截断，
 *  否则会顺手把详情弹层打开（键盘还要挡 keydown：Enter 在按钮上既触发 click 又冒泡） */
function StarButton({ starred, onToggle }: { starred: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className={`btn-star${starred ? ' starred' : ''}`}
      aria-pressed={starred}
      aria-label={starred ? '取消标星' : '标星'}
      title={starred ? '取消标星' : '标星'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <IconStar size={13} filled={starred} />
    </button>
  );
}

/** 无框卡片：图片自然比例铺满列宽，超高图限高裁切；无尺寸时 4:3 占位 */
function coverStyle(note: NoteSummary): React.CSSProperties {
  const c = note.cover;
  if (c?.width && c?.height) {
    return { aspectRatio: `${c.width} / ${c.height}`, maxHeight: 520 };
  }
  return { aspectRatio: '4 / 3' };
}

export function NoteCard({ note, categoryName, collectionType, enterDelay = 0, onOpen, onToggleStar, registerEl }: Props) {
  const [imgLoaded, setImgLoaded] = useState(false);
  // 网页剪藏封面三态（与 summary.webCover 的语义对应）：
  //   对象 = 服务端已有封面；null = 试过没有；undefined = 还没试过 → 这里按需探测一次
  const [webCoverFailed, setWebCoverFailed] = useState(false);
  const [probedReady, setProbedReady] = useState(false);
  const [probedDuration, setProbedDuration] = useState<number | null>(null);
  const isWebLike = collectionType === 'web';
  const needProbe = !note.cover && isWebLike && note.webCover === undefined;
  useEffect(() => {
    if (!needProbe) return;
    let alive = true;
    api
      .webCoverMeta(note.id)
      .then((r) => {
        if (!alive) return;
        setProbedDuration(r.durationSec);
        setProbedReady(true);
      })
      .catch(() => {
        // 404 = 这篇没有封面（服务端已进负缓存）：本会话就不再折腾，当作无封面卡片
        if (alive) setWebCoverFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [needProbe, note.id]);
  // 网页剪藏一律给一块固定 4:3 的"底片"：抓到封面就换成图，抓不到就用站点瓷片占位。
  // 不留空位是刻意的——网页库里大半剪藏没有首图，缺图的卡片混在封面卡片中间会让整列看着塌一块。
  const isWebMedia = !note.cover && isWebLike;
  const showWebCover = isWebMedia && !webCoverFailed && (note.webCover ? true : probedReady);
  const webCoverUrl = note.webCover?.url ?? `/api/web-cover/${encodeURIComponent(note.id)}`;
  const webDuration = formatDurationSec(note.webCover?.durationSec ?? probedDuration);
  const hasMedia = !!note.cover || isWebMedia;
  return (
    <article
      ref={(el) => registerEl(note.id, el)}
      className={`note-card${hasMedia ? '' : ' card-no-cover'}${enterDelay > 0 ? ' enter' : ''}`}
      style={enterDelay > 0 ? { animationDelay: `${enterDelay}ms` } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${note.title}，作者 ${note.author}`}
      onClick={(e) => onOpen(note, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(note, e.currentTarget);
        }
      }}
    >
      {hasMedia && (
        <div className={`card-media${isWebMedia ? ' web-media' : ''}`}>
          {note.cover ? (
            note.cover.available ? (
              /* 缓存命中时不触发 load 事件：挂载时若图片已完成就补一次，否则封面永远停在 opacity: 0 */
              <img
                src={note.cover.url}
                alt={note.title}
                loading="lazy"
                decoding="async"
                style={coverStyle(note)}
                ref={(el) => {
                  if (el && el.complete && el.naturalWidth > 0) setImgLoaded(true);
                }}
                className={imgLoaded ? 'loaded' : ''}
                onLoad={() => setImgLoaded(true)}
                onError={(e) => {
                  const el = e.currentTarget;
                  el.style.display = 'none';
                  el.parentElement?.insertAdjacentHTML(
                    'beforeend',
                    '<div class="media-placeholder">图片暂不可用</div>'
                  );
                }}
              />
            ) : (
              <div className="media-placeholder">图片缺失</div>
            )
          ) : (
            <>
              {/* 网页剪藏的封面（B 站/首图，服务端按需抓取）；图没就位时下面垫占位瓷片，
                  加载完 .loaded 淡入后占位层卸载。同样必须走 .loaded（.card-media img 默认 opacity:0） */}
              {showWebCover && (
                <img
                  src={webCoverUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className={imgLoaded ? 'loaded' : ''}
                  ref={(el) => {
                    if (el && el.complete && el.naturalWidth > 0) setImgLoaded(true);
                  }}
                  onLoad={() => setImgLoaded(true)}
                  onError={() => setWebCoverFailed(true)}
                />
              )}
              {(!showWebCover || !imgLoaded) && (
                <div className="web-placeholder">
                  <span className="web-placeholder-icon" aria-hidden>
                    <IconGlobe size={26} />
                  </span>
                  <span className="web-placeholder-label">{categoryName ?? '网页'}</span>
                </div>
              )}
            </>
          )}
          {note.mediaCount > 1 && (
            <span className="card-media-badge">
              <IconLayers />
              {note.mediaCount}
            </span>
          )}
          {note.hasVideo && (
            <span className="card-media-badge video-badge">
              <IconPlay />
              视频
            </span>
          )}
          {/* B 站时长角标（右下，和左下"视频"角标错开） */}
          {showWebCover && webDuration && <span className="card-media-badge duration-badge">{webDuration}</span>}
          {/* 有封面时星标浮在图片左上角（右上角被多图角标占用、左下角是视频角标） */}
          <StarButton starred={note.annotation.starred} onToggle={() => onToggleStar(note)} />
        </div>
      )}
      <div className="card-info">
        {(note.annotation.status === 'archived' || note.sourceStatus === 'missing') && (
          <div className="card-status-row">
            {note.annotation.status === 'archived' && (
              <span className="card-status archived">已归档</span>
            )}
            {note.sourceStatus === 'missing' && <span className="card-status missing">源文件已移除</span>}
          </div>
        )}
        <h3 className="card-title">{note.title}</h3>
        <div className="card-meta">
          <span className="card-avatar" aria-hidden>
            {note.author.slice(0, 1)}
          </span>
          <span className="card-author-name">{note.author}</span>
          {categoryName && <span className="card-cat">{categoryName}</span>}
          {/* 没有底片的卡片（日记居多）星标落在元信息行右端，避免压住标题 */}
          {!hasMedia && <StarButton starred={note.annotation.starred} onToggle={() => onToggleStar(note)} />}
        </div>
        {/* 自己的备注：只藏在详情里等于废掉一半价值，卡片上要能看见（最多两行） */}
        {note.annotation.remark && <p className="card-remark">{note.annotation.remark}</p>}
      </div>
    </article>
  );
}
