// 配置加载：环境变量 > config/app.json > 内置默认值。
// 生产缺 SOURCE_ROOT / DATA_DIR 时启动报错，不静默回退到开发路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  app: string;
  contentSource: string;
  host: string;
  port: number;
  timezone: string;
  publicOrigin: string;
  /** 生产模式下允许的额外 Origin（逗号分隔 env） */
  extraAllowedOrigins: string[];
  dataDir: string;
  backupDir: string;
  logDir: string;
  isProduction: boolean;
  version: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function projectRoot(): string {
  // 编译后为 dist/server/config.js，开发与测试从源码运行；统一向上找 package.json
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate project root (package.json not found)');
}

function readConfigFile(): Record<string, unknown> {
  const p = path.join(projectRoot(), 'config', 'app.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const file = readConfigFile();
  const isProduction = env.NODE_ENV === 'production';

  const contentSource = normalizeDir(
    env.SOURCE_ROOT ?? (file['contentSource'] as string | undefined) ?? ''
  );
  const dataDirEnv = env.DATA_DIR ? normalizeDir(env.DATA_DIR) : null;
  const dataDir =
    dataDirEnv ??
    (isProduction ? path.join(projectRoot(), 'runtime', 'data') : path.join(projectRoot(), '.local', 'data'));
  // 默认与数据目录同级：开发 .local/backups，生产 runtime/backups
  const backupDir = env.BACKUP_DIR ? normalizeDir(env.BACKUP_DIR) : path.join(dataDir, '..', 'backups');

  const cfg: AppConfig = {
    app: (file['app'] as string) ?? 'myinfobase',
    contentSource,
    host: env.HOST ?? (file['host'] as string | undefined) ?? '127.0.0.1',
    port: Number(env.PORT ?? (file['port'] as number | undefined) ?? 4317),
    timezone: env.TZ ?? (file['timezone'] as string | undefined) ?? 'Asia/Shanghai',
    publicOrigin: (env.PUBLIC_ORIGIN ?? (file['publicOrigin'] as string | undefined) ?? '').replace(/\/$/, ''),
    extraAllowedOrigins: (env.EXTRA_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    dataDir,
    backupDir: path.resolve(backupDir),
    logDir: env.LOG_DIR ? normalizeDir(env.LOG_DIR) : path.join(projectRoot(), 'logs'),
    isProduction,
    version: readVersion(),
  };

  if (isProduction && !cfg.contentSource) {
    throw new Error('生产环境必须设置 SOURCE_ROOT（RedNote 目录）');
  }
  if (isProduction && !dataDirEnv) {
    throw new Error('生产环境必须设置 DATA_DIR，禁止使用开发默认数据目录');
  }
  return cfg;
}

function normalizeDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 允许变更的来源列表（用于变更类请求的 Origin 校验） */
export function allowedOrigins(cfg: AppConfig): string[] {
  const list = new Set<string>();
  list.add(`http://localhost:${cfg.port}`);
  list.add(`http://127.0.0.1:${cfg.port}`);
  if (cfg.publicOrigin) list.add(cfg.publicOrigin);
  if (cfg.contentSource && !cfg.isProduction) {
    // 开发：vite 默认端口来源
    list.add('http://localhost:5173');
    list.add('http://127.0.0.1:5173');
  }
  for (const o of cfg.extraAllowedOrigins) list.add(o);
  return [...list];
}
