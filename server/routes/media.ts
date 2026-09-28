// 媒体路由：只允许索引中登记过的本地媒体，杜绝任意路径读取。
// 支持 GET/HEAD、Content-Length、ETag、单段 Range（为将来本地视频预留）。
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { sniffImageMime } from '../reader/image-size.js';
import { log } from '../log.js';
import type { LibraryService } from '../services/library.js';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  // 藏品库的统一占位封面就是 SVG（35 篇引用）：缺了会按 application/octet-stream 下发，<img> 不渲染
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  // 日记里的附件音频：类型不对浏览器只会下载而不是内联播放
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

/** 扩展名无法判断时按文件头嗅探（藏品库有名为 `640` 的无扩展名图片） */
function contentTypeFor(abs: string): string {
  const byExt = CONTENT_TYPES[path.extname(abs).toLowerCase()];
  if (byExt) return byExt;
  return sniffImageMime(abs) ?? 'application/octet-stream';
}

export function mediaRouter(getLibrary: () => LibraryService): express.Router {
  const router = express.Router();

  const handler = (req: express.Request, res: express.Response): void => {
    const lib = getLibrary();
    const noteId = req.params.noteId;
    const mediaId = req.params.mediaId;
    if (!noteId || !mediaId) {
      res.status(400).json({ error: { code: 'INVALID_MEDIA', message: '媒体路径不完整' } });
      return;
    }

    let record;
    try {
      record = lib.detail(noteId);
    } catch {
      res.status(404).json({ error: { code: 'NOTE_NOT_FOUND', message: '未找到对应笔记' } });
      return;
    }
    const item = record.media.find((m) => m.id === mediaId);
    if (!item || !item.localRelativePath) {
      res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND', message: '该笔记没有此媒体' } });
      return;
    }
    if (item.available === false) {
      res.status(404).json({ error: { code: 'MEDIA_MISSING', message: '媒体文件缺失' } });
      return;
    }

    const root = path.resolve(lib.sourceRoot);
    const abs = path.resolve(root, item.localRelativePath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      res.status(403).json({ error: { code: 'MEDIA_FORBIDDEN', message: '媒体路径越界' } });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      res.status(404).json({ error: { code: 'MEDIA_MISSING', message: '媒体文件不存在' } });
      return;
    }

    const contentType = contentTypeFor(abs);
    const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    // no-cache 而不是 max-age=86400：URL 就是文件名，不含内容 hash——同名文件被换掉后，
    // 长缓存会让浏览器 24 小时内连条件请求都不发，ETag 形同虚设（改图/换图后一直看旧的）。
    // no-cache 允许存储但每次回源问一句，命中 304，开销可忽略。
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // SVG 以文档形式直接打开时可执行脚本；虽然媒体只来自索引登记过的库内文件，仍禁掉脚本
    if (contentType === 'image/svg+xml') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    // 0 字节文件：createReadStream({start:0, end:-1}) 会同步抛 ERR_OUT_OF_RANGE，
    // 落到最后变成带堆栈的 HTML 500（索引里登记的是 existsSync，空文件照样登记）。如实下发空 body。
    if (stat.size === 0) {
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    // 单段 Range
    const rangeHeader = req.headers['range'];
    let start = 0;
    let end = stat.size - 1;
    let partial = false;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader));
      if (m) {
        const [, s, e] = m;
        if (s === '' && e === '') {
          res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
          return;
        }
        if (s === '') {
          const len = Number(e);
          start = Math.max(0, stat.size - len);
          end = stat.size - 1;
        } else {
          start = Number(s);
          end = e === '' ? stat.size - 1 : Math.min(Number(e), stat.size - 1);
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
          res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
          return;
        }
        partial = true;
      }
    }

    const size = end - start + 1;
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Length', String(size));
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.destroy();
    });
    stream.pipe(res);
  };

  router.get('/:noteId/:mediaId', handler);
  router.head('/:noteId/:mediaId', handler);

  // 兜底：媒体路由的任何错误也必须回 JSON。没有这层时同步抛错会穿过 /api 的错误处理器，
  // 被 finalhandler 渲染成 HTML 500 并**带完整堆栈**（深审复现过）。
  router.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.warn(`媒体路由错误: ${(err as Error).message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).json({ error: { code: 'MEDIA_READ_FAILED', message: '媒体读取失败' } });
  }) as express.ErrorRequestHandler);
  return router;
}
