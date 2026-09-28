// 配置加载：环境变量 > config/app.json > 内置默认值。
// 生产缺 SOURCE_ROOT / DATA_DIR 时启动报错，不自动回退到开发路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionDef } from '../shared/types.js';
import { assertOutsideVault } from './storage/vault-guard.js';

export interface AppConfig {
  app: string;
  /** Obsidian vault 根（含 RedNote / 我的收藏品 / flomo） */
  vaultRoot: string;
  collections: CollectionDef[];
  host: string;
  port: number;
  timezone: string;
  publicOrigin: string;
  extraAllowedOrigins: string[];
  dataDir: string;
  backupDir: string;
  /** 语料导出目录（corpus.jsonl / catalog.md / manifest.json）；开发 .local/export，生产 runtime/export */
  exportDir: string;
  /** 刷新成功后自动重导语料（内容没变时不会真写盘）；设 EXPORT_AFTER_REFRESH=false 关掉 */
  exportAfterRefresh: boolean;
  logDir: string;
  isProduction: boolean;
  version: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function projectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate project root (package.json not found)');
}

/** 内置默认值：与 config/app.json 保持一致，避免配置文件缺失时行为悄悄变差。
 * 导出给测试直接断言——走 loadConfig 会读到真实的 config/app.json，这个默认值分支根本执行不到（深审发现的假绿）。 */
export const DEFAULT_COLLECTIONS: CollectionDef[] = [
  { id: 'rednote', name: '小红书收藏', root: 'RedNote/Bookmarks', type: 'rednote' },
  {
    id: 'treasures',
    name: '我的宝贝',
    root: '我的收藏品',
    type: 'treasures',
    exclude: ['-索引\\.md$', '^MOC\\.md$', '^未命名页面\\.md$'],
  },
  {
    id: 'diary',
    name: '日记',
    root: 'flomo',
    type: 'diary',
    // flomo 导出工具自带的首页/导航页不是日记条目（v0.5.3 修的就是这几篇）
    exclude: ['^闪念笔记概览\\.md$', '^flomo-首页\\.md$', '^flomo-.+-首页\\.md$'],
  },
];

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

  // 生产必须**显式**给 SOURCE_ROOT：镜像里带着开发机的 config/app.json，
  // 若允许回退到文件里的 vaultRoot，容器会抱着一个 Windows 路径跑起来（下面那句报错永远不触发）。
  if (isProduction && !(env.SOURCE_ROOT ?? '').trim()) {
    throw new Error('生产环境必须设置 SOURCE_ROOT（Obsidian vault 根目录）');
  }

  const vaultRoot = normalizeDir(env.SOURCE_ROOT ?? (file['vaultRoot'] as string | undefined) ?? '');
  const dataDirEnv = env.DATA_DIR ? normalizeDir(env.DATA_DIR) : null;
  const dataDir =
    dataDirEnv ??
    (isProduction ? path.join(projectRoot(), 'runtime', 'data') : path.join(projectRoot(), '.local', 'data'));
  // 默认与数据目录同级：开发 .local/backups，生产 runtime/backups
  const backupDir = env.BACKUP_DIR ? normalizeDir(env.BACKUP_DIR) : path.join(dataDir, '..', 'backups');

  const collections = Array.isArray(file['collections'])
    ? (file['collections'] as CollectionDef[])
    : DEFAULT_COLLECTIONS;

  // 端口必须是合法的 1..65535 整数：PORT=abc → NaN 会让 listen 抛看不懂的错，
  // PORT=（空串）→ 0 变成随机端口而 Origin 白名单还按 0 校验，全部回退默认值。
  const portRaw = Number(env.PORT ?? (file['port'] as number | undefined) ?? 4317);
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 4317;

  const cfg: AppConfig = {
    app: (file['app'] as string) ?? 'myinfobase',
    vaultRoot,
    collections,
    host: env.HOST ?? (file['host'] as string | undefined) ?? '127.0.0.1',
    port,
    timezone: env.TZ ?? (file['timezone'] as string | undefined) ?? 'Asia/Shanghai',
    publicOrigin: (env.PUBLIC_ORIGIN ?? (file['publicOrigin'] as string | undefined) ?? '').replace(/\/$/, ''),
    extraAllowedOrigins: (env.EXTRA_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    dataDir,
    backupDir: path.resolve(backupDir),
    // 默认与数据目录同级：开发 .local/export，生产 runtime/export（runtime/ 不进 git、不进发布包）
    exportDir: env.EXPORT_DIR ? normalizeDir(env.EXPORT_DIR) : path.join(dataDir, '..', 'export'),
    // 关闭开关认 false/0/no/off（只认字面 false 的话，填 0/no 会"配了却不生效"）
    exportAfterRefresh: !['false', '0', 'no', 'off'].includes((env.EXPORT_AFTER_REFRESH ?? 'true').trim().toLowerCase()),
    logDir: env.LOG_DIR ? normalizeDir(env.LOG_DIR) : path.join(projectRoot(), 'logs'),
    isProduction,
    version: readVersion(),
  };

  if (isProduction && !cfg.vaultRoot) {
    throw new Error('生产环境必须设置 SOURCE_ROOT（Obsidian vault 根目录）');
  }
  if (isProduction && !dataDirEnv) {
    throw new Error('生产环境必须设置 DATA_DIR，禁止使用开发默认数据目录');
  }
  // 所有写入目录都不许落在内容源里——**启动即失败**，而不是等出错那一天才发现污染了 Obsidian。
  // （此前只有语料导出那一处有守卫，数据/备份/日志目录配错了照样会写进 vault。）
  if (cfg.vaultRoot) {
    assertOutsideVault(cfg.dataDir, cfg.vaultRoot, 'DATA_DIR（数据目录）');
    assertOutsideVault(cfg.backupDir, cfg.vaultRoot, 'BACKUP_DIR（备份目录）');
    assertOutsideVault(cfg.exportDir, cfg.vaultRoot, 'EXPORT_DIR（语料导出目录）');
    assertOutsideVault(cfg.logDir, cfg.vaultRoot, 'LOG_DIR（日志目录）');
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
  if (cfg.vaultRoot && !cfg.isProduction) {
    list.add('http://localhost:5173');
    list.add('http://127.0.0.1:5173');
  }
  for (const o of cfg.extraAllowedOrigins) list.add(o);
  return [...list];
}
