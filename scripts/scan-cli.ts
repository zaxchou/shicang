// 手动扫描 CLI：初始化或重建开发/生产索引（不涉及分类覆盖）。
// 用法：npm run scan [-- --full]（当前均为全量枚举+增量解析）
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { initLogFile, log } from '../server/log.js';
import { LibraryService } from '../server/services/library.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogFile(cfg.logDir);
  const lib = new LibraryService(cfg);
  await lib.init();
  const info = lib.libraryInfo();
  log.info(`扫描完成: 总数=${info.total} 未分类=${info.uncategorized}`);
  log.info(`最近扫描: ${JSON.stringify(info.lastScan)}`);
  if (info.diagnostics.length) log.info(`诊断: ${info.diagnostics.slice(0, 10).join(' | ')}`);
  const idx = path.join(cfg.dataDir, 'library-index.json');
  log.info(`索引文件: ${idx}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
