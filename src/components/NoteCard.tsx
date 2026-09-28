import { useState } from 'react';
import type { NoteSummary } from '../../shared/types';
import { IconLayers, IconPlay, IconStar } from './Icons';

interface Props {
  note: NoteSummary;
  categoryName: string | null;
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

export function NoteCard({ note, categoryName, enterDelay = 0, onOpen, onToggleStar, registerEl }: Props) {
  const [imgLoaded, setImgLoaded] = useState(false);
  return (
    <article
      ref={(el) => registerEl(note.id, el)}
      className={`note-card${note.cover ? '' : ' card-no-cover'}${enterDelay > 0 ? ' enter' : ''}`}
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
      {note.cover && (
        <div className="card-media">
          {note.cover.available ? (
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
          {/* 有封面时星标浮在图片左上角（右上角被多图角标占用、左下角是视频角标） */}
          <StarButton starred={note.annotation.starred} onToggle={() => onToggleStar(note)} />
        </div>
      )}
      <div className="card-info">
        <h3 className="card-title">{note.title}</h3>
        <div className="card-meta">
          <span className="card-avatar" aria-hidden>
            {note.author.slice(0, 1)}
          </span>
          <span className="card-author-name">{note.author}</span>
          {categoryName && <span className="card-cat">{categoryName}</span>}
          {/* 无封面的卡片（日记居多）没有图片可压，星标落在元信息行右端，避免压住标题 */}
          {!note.cover && <StarButton starred={note.annotation.starred} onToggle={() => onToggleStar(note)} />}
        </div>
      </div>
    </article>
  );
}
