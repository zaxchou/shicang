// API 路由：统一错误封装、查询校验、Origin 白名单。
import express from 'express';
import { z } from 'zod';
import type {
  LibraryInfo,
  NoteDetail,
  NoteListResult,
  RefreshJobInfo,
  Category,
} from '../../shared/types.js';
import { DEFAULT_PAGE_SIZE } from '../../shared/types.js';

/** 表格模式一次取全量（列排序在前端做） */
const MAX_PAGE_SIZE_TABLE = 1000;
import type { LibraryService } from '../services/library.js';
import {
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
  tag: z.string().trim().min(1).max(40).optional(),
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

const patchCategorySchema = z.object({
  categoryId: z.string().max(64).nullable(),
  expectedRevision: z.number().int().nonnegative(),
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
      const cid = typeof req.query.collection === 'string' ? req.query.collection : undefined;
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
        tag: p.tag ?? null,
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] ${req.method} ${req.path}: ${msg}`);
      res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误，请查看服务日志' } });
    }
  );

  return router;
}
