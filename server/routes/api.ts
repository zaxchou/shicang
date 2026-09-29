// API 路由：统一错误封装、查询校验、Origin 白名单。
import fs from 'node:fs';
import express from 'express';
import { z } from 'zod';
import type {
  LibraryInfo,
  NoteDetail,
  NoteListResult,
  RefreshJobInfo,
  Category,
} from '../../shared/types.js';
import { DEFAULT_PAGE_SIZE, MAX_REMARK } from '../../shared/types.js';

/** 表格模式一次取全量（列排序在前端做） */
const MAX_PAGE_SIZE_TABLE = 1000;
import type { LibraryService } from '../services/library.js';
import {
  AnnotationConflictError,
  AnnotationValidationError,
  CategoryConflictError,
  CategoryValidationError,
  NotFoundError,
  ValidationError,
} from '../services/library.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ApiDeps {
  library: () => LibraryService;
  allowedOrigins: () => string[];
  isReady: () => boolean;
}

const noteQuerySchema = z.object({
  collection: z.string().max(32).optional(),
  q: z.string().max(200).optional(),
  category: z.string().max(64).optional(),
  /** 来源维（web/微信：哔哩哔哩/微信公众号…）；与 category 正交组合 */
  source: z.string().max(64).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  // 用字面量而不是 z.coerce.boolean()：后者把字符串 "false" 也当 true（非空即真）
  starred: z.enum(['true', 'false']).optional(),
  // 默认只用工作集（在用）；归档视图才去看已归档的
  status: z.enum(['active', 'archived']).default('active'),
  includeMissing: z.enum(['true', 'false']).optional(),
  timeField: z.enum(['published', 'synced']).default('published'),
  range: z.enum(['all', '7d', '30d', 'custom']).default('all'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from 应为 YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to 应为 YYYY-MM-DD')
    .optional(),
  order: z.enum(['desc', 'asc']).default('desc'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE_TABLE).default(DEFAULT_PAGE_SIZE),
});

/** 批量标注补丁：一次归档 / 取回多条（表格里勾选后用）。上限 1000 与表格一次取全量一致 */
const patchAnnotationsBatchSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(1000),
  star: z.boolean().optional(),
  status: z.literal('archived').nullable().optional(),
});

const patchCategorySchema = z.object({
  categoryId: z.string().max(64).nullable(),
  expectedRevision: z.number().int().nonnegative(),
});

/** 人工标注补丁：至少要带一个待改字段；expectedRevision 仅星标可省（单字段幂等动作） */
const patchAnnotationSchema = z
  .object({
    star: z.boolean().optional(),
    /** null = 取回（回到在用） */
    status: z.literal('archived').nullable().optional(),
    /** 备注（纯文本）；null 或空串 = 清空。上限与存储侧同一个常量 */
    remark: z.string().max(MAX_REMARK, `备注最多 ${MAX_REMARK} 字`).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  // 状态/备注必须带 expectedRevision：schema 注释与存储层都这么约定，API 层此前却放行，
  // 裸调用方能绕过冲突检测（深审发现）。星标不强制（单字段幂等，见注释）。
  .refine((v) => v.status === undefined && v.remark === undefined ? true : v.expectedRevision !== undefined, {
    message: '改状态或备注必须带 expectedRevision',
  });

/** 按需识别图片文字：不带 mediaId = 识别这篇里还没识别过的图（服务端有单次上限） */
const ocrSchema = z.object({
  mediaId: z.string().min(1).max(300).optional(),
});

/** 按需转录语音：不带 mediaId = 转录这篇里还没结果的段（服务端有单次上限） */
const transcribeSchema = z.object({
  mediaId: z.string().min(1).max(300).optional(),
});

/** 变更类请求的 Origin 校验；同源浏览器地址栏访问无 Origin，直接放行 */
function originGuard(req: express.Request, deps: ApiDeps): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers['origin'];
  if (!origin) return;
  if (!deps.allowedOrigins().includes(String(origin))) {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN', `来源不被允许: ${String(origin).slice(0, 60)}`);
  }
}

function requireParam(req: express.Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'INVALID_PARAM', `缺少路径参数 ${name}`);
  return v;
}

export function apiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // 统一异常 → JSON envelope
  const wrap =
    <T extends express.RequestHandler>(h: T): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve()
        .then(() => h(req, res, next))
        .catch(next);
    };

  router.use((req, res, next) => {
    try {
      originGuard(req, deps);
      next();
    } catch (e) {
      next(e);
    }
  });

  // 初始化完成前拒绝**变更类**请求：启动窗口里 seed 导入正在 await 磁盘，
  // 此刻到达的写请求会与 init 的 load 交叉——内存/磁盘分叉，甚至旧数据被覆盖（深审发现）。
  // GET 不拦：前端要靠它渲染"正在初始化"的状态。
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || deps.isReady()) {
      next();
      return;
    }
    res.status(503).json({ error: { code: 'NOT_READY', message: '服务正在初始化，请稍后再试' } });
  });

  router.get(
    '/health',
    wrap((req, res) => {
      const lib = deps.library();
      res.json({
        app: lib.cfg.app,
        version: lib.cfg.version,
        ready: deps.isReady(),
        indexRevision: lib.indexRevision,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
      });
    })
  );

  router.get(
    '/library',
    wrap((req, res) => {
      const info: LibraryInfo = deps.library().libraryInfo();
      res.json(info);
    })
  );

  router.get(
    '/categories',
    wrap((req, res) => {
      const cats: Category[] = deps.library().listCategories();
      res.json({ categories: cats });
    })
  );

  router.get(
    '/tags',
    wrap((req, res) => {
      const raw = req.query.collection;
      // 与其它查询同一校验纪律：长度上限 + 只认字符串（此前只做 typeof 判断，裸字符串随便进）
      if (raw !== undefined && (typeof raw !== 'string' || raw.length > 32)) {
        throw new HttpError(400, 'INVALID_QUERY', 'collection 参数无效');
      }
      const cid = typeof raw === 'string' ? raw : undefined;
      res.json({ tags: deps.library().tagCounts(cid) });
    })
  );

  router.get(
    '/notes',
    wrap((req, res) => {
      const parsed = noteQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpError(400, 'INVALID_QUERY', '查询参数无效', parsed.error.flatten());
      }
      const p = parsed.data;
      const result: NoteListResult = deps.library().query({
        collection: p.collection,
        q: p.q,
        categoryId: p.category ?? null,
        source: p.source ?? null,
        tag: p.tag ?? null,
        starred: p.starred === 'true',
        status: p.status,
        includeMissing: p.includeMissing === 'true',
        timeField: p.timeField,
        range: p.range,
        from: p.from,
        to: p.to,
        order: p.order,
        offset: p.offset,
        limit: p.limit,
      });
      res.json(result);
    })
  );

  router.get(
    '/notes/:id',
    wrap((req, res) => {
      const detail: NoteDetail = deps.library().detail(requireParam(req, "id"));
      res.json(detail);
    })
  );

  router.patch(
    '/notes/:id/category',
    wrap(async (req, res) => {
      const body = patchCategorySchema.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, 'INVALID_BODY', '请求体无效', body.error.flatten());
      }
      try {
        const out = await deps.library().setCategory(requireParam(req, "id"), body.data.categoryId, body.data.expectedRevision);
        res.json(out);
      } catch (e) {
        if (e instanceof CategoryConflictError) {
          throw new HttpError(409, 'REVISION_CONFLICT', e.message);
        }
        if (e instanceof CategoryValidationError) {
          throw new HttpError(400, 'INVALID_CATEGORY', e.message);
        }
        throw e;
      }
    })
  );

  router.patch(
    '/notes/:id/annotation',
    wrap(async (req, res) => {
      const body = patchAnnotationSchema.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, 'INVALID_BODY', '请求体无效', body.error.flatten());
      }
      if (body.data.star === undefined && body.data.status === undefined && body.data.remark === undefined) {
        throw new HttpError(400, 'EMPTY_PATCH', '请求体至少要带一个待修改字段');
      }
      try {
        const out = await deps.library().setAnnotation(
          requireParam(req, 'id'),
          { star: body.data.star, status: body.data.status, remark: body.data.remark },
          body.data.expectedRevision
        );
        res.json(out);
      } catch (e) {
        if (e instanceof AnnotationConflictError) {
          throw new HttpError(409, 'REVISION_CONFLICT', e.message);
        }
        if (e instanceof AnnotationValidationError) {
          throw new HttpError(400, 'INVALID_ANNOTATION', e.message);
        }
        throw e;
      }
    })
  );

  router.patch(
    '/annotations',
    wrap(async (req, res) => {
      const body = patchAnnotationsBatchSchema.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, 'INVALID_BODY', '请求体无效', body.error.flatten());
      }
      if (body.data.star === undefined && body.data.status === undefined) {
        throw new HttpError(400, 'EMPTY_PATCH', '请求体至少要带一个待修改字段');
      }
      try {
        const out = await deps
          .library()
          .setAnnotationMany(body.data.ids, { star: body.data.star, status: body.data.status });
        res.json(out);
      } catch (e) {
        if (e instanceof AnnotationValidationError) {
          throw new HttpError(400, 'INVALID_ANNOTATION', e.message);
        }
        throw e;
      }
    })
  );

  // 识别图片文字（OCR，plan §18.2）：按需触发，结果按媒体内容 hash 缓存。
  // 前端只发 noteId/mediaId——图片由服务端自己从磁盘读、自己 base64，浏览器不传文件
  // （API 请求体上限 64 KB，一张封面 base64 后约 700 KB，直接传会 413）。
  router.get(
    '/notes/:id/media-text',
    wrap((req, res) => {
      const id = requireParam(req, 'id');
      if (!deps.library().hasNote(id)) throw new HttpError(404, 'NOTE_NOT_FOUND', `未找到笔记 ${id}`);
      res.json({ items: deps.library().mediaTextFor(id) });
    })
  );

  router.post(
    '/notes/:id/ocr',
    wrap(async (req, res) => {
      const id = requireParam(req, 'id');
      const body = ocrSchema.safeParse(req.body ?? {});
      if (!body.success) {
        throw new HttpError(400, 'INVALID_BODY', '请求体无效', body.error.flatten());
      }
      try {
        // 客户端中途断开（关窗/刷新页面）后就别再往下发新调用了——钱和时间都不该继续花
        let gone = false;
        res.on('close', () => {
          if (!res.writableEnded) gone = true;
        });
        res.json(
          await deps.library().ocrNote(id, {
            mediaId: body.data.mediaId,
            shouldStop: () => gone,
          })
        );
      } catch (e) {
        if (e instanceof NotFoundError) throw new HttpError(404, 'NOTE_NOT_FOUND', e.message);
        if (e instanceof ValidationError) throw new HttpError(400, 'INVALID_OCR_TARGET', e.message);
        throw e;
      }
    })
  );

  router.post(
    '/notes/:id/transcribe',
    wrap(async (req, res) => {
      const id = requireParam(req, 'id');
      const body = transcribeSchema.safeParse(req.body ?? {});
      if (!body.success) {
        throw new HttpError(400, 'INVALID_BODY', '请求体无效', body.error.flatten());
      }
      let gone = false;
      res.on('close', () => {
        if (!res.writableEnded) gone = true;
      });
      try {
        res.json(
          await deps.library().transcribeNote(id, {
            mediaId: body.data.mediaId,
            shouldStop: () => gone,
          })
        );
      } catch (e) {
        if (e instanceof NotFoundError) throw new HttpError(404, 'NOTE_NOT_FOUND', e.message);
        if (e instanceof ValidationError) throw new HttpError(400, 'INVALID_TRANSCRIBE_TARGET', e.message);
        throw e;
      }
    })
  );

  // 网页封面（B 站剪藏走官方 API 拿视频封面/时长，其它站点取正文首图）：按需抓取并缓存在数据目录。
  // 拿不到就 404——前端把 404 当作"没有封面"直接隐藏，不显示碎图、更不报错。
  router.get(
    '/web-cover/:id',
    wrap(async (req, res) => {
      const id = requireParam(req, 'id');
      let out: { abs: string; contentType: string } | null;
      try {
        out = await deps.library().ensureWebCover(id);
      } catch (e) {
        if (e instanceof NotFoundError) throw new HttpError(404, 'NOTE_NOT_FOUND', e.message);
        throw e;
      }
      if (!out) {
        res.status(404).json({ error: { code: 'WEB_COVER_UNAVAILABLE', message: '这篇没有可用的封面' } });
        return;
      }
      // 轻量探测：卡片先问一句"有没有封面、多久"，拿到了再挂 <img>（首屏就能出时长角标，也避免碎图请求）
      if (String(req.query.meta) === '1') {
        const entry = deps.library().webCoverMeta(id);
        res.json({ durationSec: entry?.durationSec ?? null, contentType: out.contentType });
        return;
      }
      const stat = fs.statSync(out.abs);
      const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(out.abs)
        .on('error', () => res.destroy())
        .pipe(res);
    })
  );

  router.delete(
    '/notes/:id/media-text/:mediaId',
    wrap(async (req, res) => {
      const id = requireParam(req, 'id');
      // 与同族的 GET 一样先确认笔记存在：否则一个 id 打错也返回 200，客户端分不清
      // "笔记不在了"和"本来就没有可删的"
      if (!deps.library().hasNote(id)) throw new HttpError(404, 'NOTE_NOT_FOUND', `未找到笔记 ${id}`);
      const removed = await deps.library().clearMediaText(id, requireParam(req, 'mediaId'));
      res.json({ removed });
    })
  );

  router.post(
    '/refresh',
    wrap((req, res) => {
      const job: RefreshJobInfo = deps.library().startRefresh();
      res.status(202).json({ job });
    })
  );

  router.get(
    '/refresh/latest',
    wrap((req, res) => {
      const job = deps.library().latestJob;
      res.json({ job });
    })
  );

  router.get(
    '/refresh/:jobId',
    wrap((req, res) => {
      const job = deps.library().getRefreshJob(requireParam(req, "jobId"));
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '未找到该刷新任务');
      res.json({ job });
    })
  );

  // 语料导出（plan §18.3）：GET 看上次导出，POST 立刻重导。
  // 导出物在 runtime/export/（生产）/ .local/export/（开发），不在 vault 里，也不进发布包。
  router.get(
    '/export/corpus',
    wrap((req, res) => {
      const lib = deps.library();
      res.json({ manifest: lib.corpusManifest(), dir: lib.corpusDir });
    })
  );

  router.post(
    '/export/corpus',
    wrap(async (req, res) => {
      const lib = deps.library();
      try {
        const result = await lib.exportCorpus();
        res.json({ manifest: result.manifest, written: result.written, dir: result.dir });
      } catch (e) {
        // 导出目录被守卫拒绝（配到内容源里了）是可操作的配置错误，不该显示成"服务器内部错误"
        const msg = (e as Error).message ?? '';
        if (msg.includes('落在内容源里')) {
          throw new HttpError(500, 'EXPORT_DIR_IN_VAULT', msg);
        }
        throw e;
      }
    })
  );

  // API 404
  router.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `未知 API 路径: ${req.path}` } });
  });

  // 错误处理器
  router.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: { code: 'NOTE_NOT_FOUND', message: err.message } });
        return;
      }
      if (err instanceof ValidationError) {
        res.status(400).json({ error: { code: 'VALIDATION', message: err.message } });
        return;
      }
      if ((err as { type?: string })?.type === 'entity.parse.failed') {
        res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是有效 JSON' } });
        return;
      }
      // express.json 的 64kb 限制：不单独处理会落到兜底 500（用户看到"服务器内部错误"，
      // 日志里却是一条 ERROR），实际是客户端请求过大
      if ((err as { type?: string })?.type === 'entity.too.large') {
        res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大（上限 64KB）' } });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] ${req.method} ${req.path}: ${msg}`);
      res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误，请查看服务日志' } });
    }
  );

  return router;
}
