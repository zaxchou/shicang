// 语料导出 CLI：不经过浏览器也能把语料写出来（NAS 上跑、或接 cron/计划任务用）。
// 用法：npm run export:corpus [-- --quiet]
//
// 与网页上的「导出语料」按钮走的是同一条服务方法，所以结果、跳过规则（内容没变不写盘）
// 和 vault 保护断言完全一致。
import { loadConfig } from '../server/config.js';
import { initLogFile, log } from '../server/log.js';
import { LibraryService } from '../server/services/library.js';

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const cfg = loadConfig();
  initLogFile(cfg.logDir);
  const lib = new LibraryService(cfg);
  await lib.init();

  const info = lib.libraryInfo();
  if (!quiet) {
    console.log(`索引 ${info.total} 篇（${info.collections.map((c) => `${c.name} ${c.total}`).join(' / ')}）`);
    console.log(`索引 revision r${info.indexRevision} · 标注 r${info.annotationRevision} · 分类 r${info.categoryRevision}`);
  }

  const t0 = Date.now();
  const result = await lib.exportCorpus();
  const m = result.manifest;
  console.log(
    result.written
      ? `已导出：${m.counts.total} 篇（在用 ${m.counts.active} / 归档 ${m.counts.archived} / 标星 ${m.counts.starred} / 源文件已移除 ${m.counts.missing}）` +
          `，用时 ${Date.now() - t0}ms`
      : `内容未变，跳过写入（digest ${m.digest.slice(0, 12)}…，上次导出 ${m.generatedAt}）`
  );
  console.log(`目录：${result.dir}`);
  console.log(`  ${m.files.corpus.path}  ${(m.files.corpus.bytes / 1048576).toFixed(2)} MB · ${m.files.corpus.lines} 行`);
  console.log(`  ${m.files.catalog.path}  ${(m.files.catalog.bytes / 1024).toFixed(1)} KB`);
  console.log(
    `  manifest: schema ${m.schemaVersion} · digest ${m.digest.slice(0, 12)}…（判断要不要重写）` +
      ` · contentDigest ${m.contentDigest.slice(0, 12)}…（外部管道增量用）`
  );
  log.info(`语料导出(${result.written ? '写入' : '跳过'}): ${m.counts.total} 篇 → ${result.dir}`);
  process.exit(0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
