// 服务入口：单进程同时提供前端静态文件与 /api。
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadConfig, allowedOrigins, projectRoot } from './config.js';
import { initLogFile, log } from './log.js';
import { LibraryService } from './services/library.js';
import { apiRouter } from './routes/api.js';
import { mediaRouter } from './routes/media.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogFile(cfg.logDir);
  log.info(`启动 myinfobase v${cfg.version} (NODE_ENV=${process.env.NODE_ENV ?? 'development'})`);
  log.info(`内容源(vault): ${cfg.vaultRoot}`);
  log.info(`数据目录: ${cfg.dataDir}`);

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.backupDir, { recursive: true });

  const library = new LibraryService(cfg);
  let ready = false;

  const app = express();
  app.disable('x-powered-by');

  const webDist = path.join(projectRoot(), 'dist', 'web');

  app.use('/api/media', mediaRouter(() => library));
  app.use(
    '/api',
    apiRouter({
      library: () => library,
      allowedOrigins: () => allowedOrigins(cfg),
      isReady: () => ready,
    })
  );

  if (fs.existsSync(webDist)) {
    // 资源带内容哈希 → 长缓存；index.html 必须每次回源校验，
    // 否则部署新版本后浏览器在缓存有效期内仍会拿旧壳（表现为"部署了但没变化"）
    app.use(
      express.static(webDist, {
        index: false,
        etag: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (/[\\/]assets[\\/]/.test(filePath)) {
            // Vite 只在 assets/ 下输出带内容哈希的文件名（哈希长度会变，别按长度猜）
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      })
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const indexFile = path.join(webDist, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(indexFile);
      }
      res.status(503).send('前端尚未构建（dist/web 缺失）。请先运行 npm run build。');
    });
  } else {
    app.use((req, res) => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: '未知 API 路径' } });
      } else {
        res.status(503).send('前端尚未构建（dist/web 缺失）。请先运行 npm run build。');
      }
    });
  }

  const server = app.listen(cfg.port, cfg.host, () => {
    log.info(`监听 http://${cfg.host}:${cfg.port}`);
  });
  server.keepAliveTimeout = 65_000;

  // 后台初始化：加载缓存 / 首次扫描
  library
    .init()
    .then(() => {
      ready = true;
      log.info(`索引就绪：${library.libraryInfo().total} 篇`);
    })
    .catch((e) => {
      log.error(`初始化失败: ${(e as Error).message}`);
      // 服务保持运行，页面会显示错误状态；可用刷新按钮重试
    });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，停止接收新请求…`);
    server.close(() => {
      log.info('已退出');
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('等待超时，强制退出');
      process.exit(0);
    }, 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
