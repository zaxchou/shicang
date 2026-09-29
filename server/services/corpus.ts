// 语料导出：把索引里的正文 + 人工标注导成「上下文可索引」的静态文件（plan §18.3）。
//
// 纪律（与 overrides.json / annotations.json 同源）：
//   · 只写 runtime/export/（gitignore、不进发布包、**绝不写进 vault**，有硬断言拦着）；
//   · 导出物是**派生产物**，随时可重建，所以不做备份轮换——重建比恢复便宜；
//   · 索引是缓存、标注是资产，这里把两者合成一份对外可消费的快照。
//
// 为什么 contentHash 只覆盖"文本内容"：外部 embedding 管道靠它做增量。
// 归档一篇、改个时间、挪个路径，都不该让人家把 embedding 重算一遍；
// 但改备注、改分类、正文变了，语义就变了，必须重算。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  CorpusManifest,
  CorpusRecord,
  ExtraFields,
  NoteAnnotation,
  NoteSummary,
  RecognizedText,
} from '../../shared/types.js';
import { CORPUS_SCHEMA_VERSION } from '../../shared/types.js';
import type { NoteRecord } from '../reader/parse.js';
// 守卫已抽到 storage/vault-guard.ts（启动时对所有写入目录统一校验），这里继续对外导出，
// 让 corpus 的测试与调用方不必改导入路径。
export { assertOutsideVault, isInsideDir } from '../storage/vault-guard.js';
import { assertOutsideVault } from '../storage/vault-guard.js';

// ---------- HTML → 纯文本 ----------

/** 常见命名实体。只覆盖我们正文里真会出现的；不认识的**原样保留**，丢信息比留着符号更糟 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', divide: '÷',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', permil: '‰',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 代理区码点会让 fromCodePoint 抛错，非法值一律原样返回
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * 已消毒的正文 HTML → 纯文本。索引里存的就是 bodyHtml（约 6 MB），所以导出不用重新解析源文件。
 * 顺序很重要：**先剥标签再解实体**——否则正文里写成 `&lt;p&gt;` 的字面量会被当成标签吃掉。
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // 块级边界要在剥标签之前换成换行，否则段落与列表的结构信息就没了
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, lvl: string) => `\n${'#'.repeat(Number(lvl))} `);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // 注意列表项**不在**这里：<li> 已经带了换行，末尾再来一个就会在条目之间多出空行
  s = s.replace(
    /<\/(p|div|section|article|ul|ol|h[1-6]|blockquote|tr|pre|figure|figcaption|table|dd|dt)\s*>/gi,
    '\n'
  );
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 记录构造 ----------

export interface CorpusCollectionMeta {
  id: string;
  name: string;
  /** 已排好序的分类（含 id→name 映射；非 rednote 库里 id 就是分类名） */
  categories: Array<{ id: string; name: string }>;
}

export interface CorpusBuildContext {
  /** 顺序即 catalog.md 的目录顺序 */
  collections: CorpusCollectionMeta[];
  categoryIdOf(record: NoteRecord): {
    id: string | null;
    source: NoteSummary['categorySource'];
    sourceCategory: string | null;
  };
  annotationOf(noteId: string): NoteAnnotation;
  /** OCR / 转录文本的来源（plan §18.2）。不提供 = 识别能力还没接，recognized 一律空数组 */
  recognizedOf?(noteId: string): RecognizedText[];
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

type ContentHashInput = Pick<
  CorpusRecord,
  | 'collection'
  | 'title'
  | 'author'
  | 'tags'
  | 'categoryId'
  | 'categoryName'
  | 'sourceCategory'
  | 'remark'
  | 'text'
  | 'extra'
  | 'recognized'
>;

/** 语义内容 hash。用数组而非对象字面量：键顺序问题从根上不存在，同一内容必然同一 hash */
export function computeContentHash(rec: ContentHashInput): string {
  return sha256(
    JSON.stringify([
      CORPUS_SCHEMA_VERSION,
      rec.collection,
      rec.title,
      rec.author,
      rec.tags,
      rec.categoryId,
      rec.categoryName,
      rec.sourceCategory,
      rec.remark,
      rec.text,
      rec.extra,
      rec.recognized.map((r) => [r.kind, r.mediaId, r.text]),
    ])
  );
}

export function buildCorpusRecords(
  records: readonly NoteRecord[],
  ctx: CorpusBuildContext
): CorpusRecord[] {
  const catNames = new Map<string, Map<string, string>>();
  const colNames = new Map<string, string>();
  for (const c of ctx.collections) {
    colNames.set(c.id, c.name);
    catNames.set(c.id, new Map(c.categories.map((x) => [x.id, x.name])));
  }

  const out = records.map((r) => {
    const ann = ctx.annotationOf(r.id);
    const cat = ctx.categoryIdOf(r);
    const name = cat.id ? (catNames.get(r.collection)?.get(cat.id) ?? cat.id) : null;
    const extra: ExtraFields | null = r.extra && Object.keys(r.extra).length > 0 ? r.extra : null;
    const base: Omit<CorpusRecord, 'contentHash'> = {
      schemaVersion: CORPUS_SCHEMA_VERSION,
      id: r.id,
      collection: r.collection,
      collectionName: colNames.get(r.collection) ?? r.collection,
      title: r.title,
      author: r.author,
      tags: r.tags,
      categoryId: cat.id,
      categoryName: name,
      categorySource: cat.source,
      sourceCategory: cat.sourceCategory,
      starred: ann.starred,
      status: ann.status,
      remark: ann.remark,
      publishedAt: r.publishedAt,
      syncedAt: r.syncedAt,
      originalUrl: r.originalUrl,
      sourcePath: r.sourceRelativePath,
      sourceStatus: r.sourceStatus,
      mediaCount: r.media.filter((m) => m.kind === 'image').length,
      hasVideo: r.media.some((m) => m.kind === 'video'),
      extra,
      text: htmlToText(r.bodyHtml),
      recognized: ctx.recognizedOf?.(r.id) ?? [],
      sourceHash: r.sourceHash,
    };
    return { ...base, contentHash: computeContentHash(base) };
  });

  // 决定论排序：让文件 diff 只反映内容变化，不反映遍历顺序。收藏库顺序按 ctx.collections。
  const colOrder = new Map(ctx.collections.map((c, i) => [c.id, i]));
  out.sort((a, b) => {
    const ca = colOrder.get(a.collection) ?? 999;
    const cb = colOrder.get(b.collection) ?? 999;
    if (ca !== cb) return ca - cb;
    const pa = a.publishedAt ?? '';
    const pb = b.publishedAt ?? '';
    if (pa !== pb) return pb.localeCompare(pa); // 新的在前
    return a.id.localeCompare(b.id);
  });
  return out;
}

// ---------- catalog.md ----------

function remarkSnippet(remark: string | null, max = 60): string | null {
  if (!remark) return null;
  const one = remark.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 单行化：标题/路径里若混进换行（畸形 H1 等），会把目录的多行结构撑坏——压成一行 */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateOf(r: CorpusRecord): string {
  const iso = r.publishedAt ?? r.syncedAt;
  return iso ? iso.slice(0, 10) : '无日期';
}

export function buildCatalog(
  records: readonly CorpusRecord[],
  manifest: Omit<CorpusManifest, 'files'>,
  collections: readonly CorpusCollectionMeta[]
): string {
  const L: string[] = [];
  L.push('# 拾藏语料目录');
  L.push('');
  L.push(`生成时间：${manifest.generatedAt}`);
  L.push(`内容源：${manifest.contentSource}`);
  L.push(
    `版本：schema ${manifest.schemaVersion} · 应用 ${manifest.appVersion} · 索引 r${manifest.indexRevision} · ` +
      `标注 r${manifest.annotationRevision} · 分类 r${manifest.categoryRevision} · 解析器 v${manifest.parseVersion}`
  );
  const c = manifest.counts;
  L.push(
    `篇数：${c.total}（在用 ${c.active} / 已归档 ${c.archived} / 已标星 ${c.starred} / 源文件已移除 ${c.missing}）`
  );
  L.push('');
  L.push('> 正文与全部字段在 `corpus.jsonl`（每行一条）；本文件只做人和 grep 能用的目录。');
  L.push('');

  for (const col of manifest.counts.byCollection) {
    const inCol = records.filter((r) => r.collection === col.id);
    L.push(`## ${col.name}（${col.count}）`);
    L.push('');

    // 分类顺序跟侧栏一致（父级给的是排好序的列表）；记录里出现了但列表里没有的，按名字补在最后。
    const listed = collections.find((x) => x.id === col.id)?.categories ?? [];
    const seen = new Set(listed.map((x) => x.id));
    const extras = [...new Set(inCol.map((r) => r.categoryId))].filter(
      (id): id is string => !!id && !seen.has(id)
    );
    extras.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    const groups = listed
      .map((x) => x.id)
      .concat(extras)
      .map((id) => ({
        id,
        items: inCol.filter((r) => r.categoryId === id && r.status === 'active'),
      }))
      .filter((g) => g.items.length > 0);
    const uncat = inCol.filter((r) => !r.categoryId && r.status === 'active');

    const sections = [
      ...groups.map((g) => ({ title: g.items[0]?.categoryName ?? g.id, items: g.items })),
      ...(uncat.length ? [{ title: '未分类', items: uncat }] : []),
    ];
    for (const sec of sections) {
      L.push(`### ${sec.title}（${sec.items.length}）`);
      L.push('');
      for (const r of sec.items) {
        const bits = [dateOf(r), oneLine(r.title) || '(无标题)'];
        if (r.starred) bits.push('★');
        const snip = remarkSnippet(r.remark);
        if (snip) bits.push(`「${snip}」`);
        if (r.sourceStatus === 'missing') bits.push('（源文件已移除）');
        L.push(`- ${bits.join(' · ')} — \`${oneLine(r.sourcePath)}\``);
      }
      L.push('');
    }

    const arch = inCol.filter((r) => r.status === 'archived');
    if (arch.length) {
      L.push(`### 已归档（${arch.length}）`);
      L.push('');
      for (const r of arch) {
        L.push(`- ${dateOf(r)} · ${oneLine(r.title) || '(无标题)'} — \`${oneLine(r.sourcePath)}\``);
      }
      L.push('');
    }
  }

  // 标签目录：按使用次数降序，全量列出（标签是检索的主要入口，截断反而不方便）
  const tagCount = new Map<string, number>();
  for (const r of records) {
    for (const t of r.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  }
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
  L.push(`## 标签（${tags.length}）`);
  L.push('');
  for (const [t, n] of tags) L.push(`- #${t}（${n}）`);
  L.push('');
  return L.join('\n');
}

// ---------- 落盘 ----------

export interface CorpusExportMeta {
  app: string;
  appVersion: string;
  contentSource: string;
  indexRevision: number;
  annotationRevision: number;
  categoryRevision: number;
  parseVersion: number;
}

export interface CorpusExportOptions {
  dir: string;
  vaultRoot: string;
  records: CorpusRecord[];
  /** 只用于 catalog.md 的分类顺序（与侧栏一致） */
  collections: CorpusCollectionMeta[];
  meta: CorpusExportMeta;
  now?: Date;
}

export interface CorpusExportResult {
  manifest: CorpusManifest;
  /** false = 语义内容与上次完全一致，**一个字节都没写** */
  written: boolean;
  dir: string;
  /** 实际写出的文件（written=false 时为空） */
  files: string[];
}

export const CORPUS_FILE = 'corpus.jsonl';
export const CATALOG_FILE = 'catalog.md';
export const MANIFEST_FILE = 'manifest.json';

/** 临时文件 + 回读 + rename 提交；rename 覆盖失败时退化为 copy+replace（NAS 上真遇到过） */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  const check = await fsp.readFile(tmp, 'utf8');
  if (check !== content) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new Error(`写入校验失败: ${file}`);
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    // copy 回退的成败都要清 tmp（与 json-store 同一条纪律，深审发现的累积泄漏）
    try {
      await fsp.copyFile(tmp, file);
    } catch {
      throw new Error(`提交失败: ${(e as Error).message}`);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

export function corpusManifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILE);
}

/** 读回上次的 manifest（路由用来展示"上次导出是什么时候"）；没有或坏了都返回 null */
export function readCorpusManifest(dir: string): CorpusManifest | null {
  try {
    const raw = fs.readFileSync(corpusManifestPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as CorpusManifest;
    if (typeof parsed?.contentDigest !== 'string' || typeof parsed?.counts?.total !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function exportCorpus(opts: CorpusExportOptions): Promise<CorpusExportResult> {
  const dir = path.resolve(opts.dir);
  assertOutsideVault(dir, opts.vaultRoot);

  const records = opts.records;
  const counts = {
    total: records.length,
    active: records.filter((r) => r.status === 'active').length,
    archived: records.filter((r) => r.status === 'archived').length,
    starred: records.filter((r) => r.starred).length,
    missing: records.filter((r) => r.sourceStatus === 'missing').length,
    byCollection: opts.records.reduce<Array<{ id: string; name: string; count: number }>>((acc, r) => {
      const hit = acc.find((x) => x.id === r.collection);
      if (hit) hit.count++;
      else acc.push({ id: r.collection, name: r.collectionName, count: 1 });
      return acc;
    }, []),
  };
  const contentDigest = sha256(records.map((r) => r.contentHash).sort().join('\n'));
  // 判断"要不要重写"必须用整条记录的摘要：contentDigest 有意不含星标/归档状态，
  // 拿它当判据会让"只归档一篇"被当成没变化，文件里的状态就停在旧值（写测试时才发现的坑）。
  const digest = sha256(records.map((r) => JSON.stringify(r)).join('\n'));
  /**
   * `catalog.md` 的排版**也依赖记录以外的东西**：分类顺序/名称来自 collections（改分类顺序、
   * 改分类名都不会动任何一条记录），解析器版本会写进目录头部。所以重写判据里再加一个 meta 摘要，
   * 否则"重新排了分类顺序"之后目录会一直是旧的（深审发现）。
   */
  const metaDigest = sha256(
    JSON.stringify({
      parseVersion: opts.meta.parseVersion,
      collections: opts.collections.map((c) => ({ id: c.id, name: c.name, categories: c.categories })),
    })
  );

  const base: Omit<CorpusManifest, 'files'> = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    app: opts.meta.app,
    appVersion: opts.meta.appVersion,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    contentSource: opts.vaultRoot,
    indexRevision: opts.meta.indexRevision,
    annotationRevision: opts.meta.annotationRevision,
    categoryRevision: opts.meta.categoryRevision,
    parseVersion: opts.meta.parseVersion,
    counts,
    contentDigest,
    digest,
    metaDigest,
  };

  // 一模一样就不写：省掉 NAS 上几 MB 的写入，也让 generatedAt 只在真有变化时前进。
  // 注意 revision 不进这个判断——每次扫描都会 +1，拿它当条件等于每次刷新都重写几 MB。
  const prev = readCorpusManifest(dir);
  const allThere =
    fs.existsSync(path.join(dir, CORPUS_FILE)) && fs.existsSync(path.join(dir, CATALOG_FILE));
  if (
    prev &&
    prev.digest === digest &&
    prev.metaDigest === metaDigest &&
    allThere &&
    prev.schemaVersion === CORPUS_SCHEMA_VERSION &&
    prev.appVersion === opts.meta.appVersion
  ) {
    return { manifest: prev, written: false, dir, files: [] };
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const catalog = buildCatalog(records, base, opts.collections);
  const manifest: CorpusManifest = {
    ...base,
    files: {
      corpus: { path: path.join(dir, CORPUS_FILE), bytes: Buffer.byteLength(jsonl, 'utf8'), lines: records.length },
      catalog: { path: path.join(dir, CATALOG_FILE), bytes: Buffer.byteLength(catalog, 'utf8') },
    },
  };

  // 顺序有意为之：**manifest 最后写**。中途失败时 manifest 仍是旧的，
  // 一眼就能看出"这次导出没走完"，而不是拿着半套文件当完整的用。
  await writeFileAtomic(path.join(dir, CORPUS_FILE), jsonl);
  await writeFileAtomic(path.join(dir, CATALOG_FILE), catalog);
  await writeFileAtomic(corpusManifestPath(dir), JSON.stringify(manifest, null, 2));

  return {
    manifest,
    written: true,
    dir,
    files: [path.join(dir, CORPUS_FILE), path.join(dir, CATALOG_FILE), corpusManifestPath(dir)],
  };
}
