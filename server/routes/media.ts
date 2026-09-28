// 媒体路由：只允许索引中登记过的本地媒体，杜绝任意路径读取。
// 支持 GET/HEAD、Content-Length、ETag、单段 Range（为将来本地视频预留）。
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { LibraryService } from '../services/library.js';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  // 藏品库的统一占位封面就是 SVG（39 篇引用）：缺了会按 application/octet-stream 下发，<img> 不渲染
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

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

    const ext = path.extname(abs).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // SVG 以文档形式直接打开时可执行脚本；虽然媒体只来自索引登记过的库内文件，仍禁掉脚本
    if (contentType === 'image/svg+xml') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
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
  return router;
}
