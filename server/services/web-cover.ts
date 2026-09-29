// 网页剪藏的封面（缩略图）：B 站剪藏走官方 API 拿视频封面与时长，其余站点取正文第一张远程图；
// 下载后缓存在**拾藏自己的数据目录**（`runtime/data/web-covers/`）——不进索引、不进 vault、不进语料。
//
// 四条纪律：
//   · **解析器绝不联网**（parse.ts 保持纯函数）——封面是**按需**拉取：卡片渲染时请求
//     `GET /api/web-cover/:noteId`，命中缓存秒回，未命中才抓一次；
//   · **防内网探测**：只允许公网 http(s)（拒 localhost/.local/字面私网 IP/IPv6 字面量），
//     重定向**手动跟随、逐跳过同一道闸**（fetch 默认 follow 会让公网 302 直接带到内网，评审 R3）；
//     DNS 解析后才落私网的情形属已知残余风险（不做二次解析，记录在文档里）；
//   · **有闸**：连接/读取超时 12s、下载体积 ≤6MB、Content-Type 必须是 image/*；
//   · **失败进负缓存**（6 小时内不再重试），列表与详情永不因抓封面报错——卡片拿不到图就不显示图。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NoteRecord } from '../reader/parse.js';
import { JsonStore } from '../storage/json-store.js';
import { log } from '../log.js';

export const WEB_COVER_SCHEMA_VERSION = 1;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const NEGATIVE_TTL_MS = 6 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface WebCoverEntry {
  noteId: string;
  /** 文件名（dataDir/web-covers/ 下） */
  file: string;
  contentType: string;
  /** B 站视频时长（秒）；其它站点为 null */
  durationSec: number | null;
  /** 封面来源：bilibili=官方 API；first-image=正文第一张远程图 */
  source: 'bilibili' | 'first-image';
  at: string;
  /** 最近一次失败时间（负缓存用）；成功条目为 null */
  failedAt: string | null;
  failReason?: string;
}

export interface WebCoverDoc {
  schemaVersion: number;
  revision: number;
  entries: Record<string, WebCoverEntry>;
}

/** 从 B 站视频链接里取 BV 号（形如 https://www.bilibili.com/video/BV1xx.../） */
export function bvidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url);
  return m ? m[1]! : null;
}

/**
 * 只放行公网 http(s)。挡掉：非 http(s) 协议、localhost、*.local/*.internal、
 * 字面 IPv4 的私网/回环/链路本地/运营商级 NAT 段、一切 IPv6 字面量。
 */
export function publicHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (host.startsWith('[')) return null; // IPv6 字面量一律拒绝
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number, number, number];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return null;
    }
  }
  return u;
}

/** 从已渲染的正文里取第一张远程图（跳过 data:/media: 等非 http 资源）；HTML 实体先还原 */
export function firstRemoteImage(bodyHtml: string): string | null {
  for (const m of bodyHtml.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
    const src = m[1]!.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(src)) return src;
  }
  return null;
}

/** 手动跟随重定向的跳数上限（初始请求之外最多再跟 3 跳） */
const MAX_REDIRECTS = 3;

/**
 * 带重定向纪律的 fetch：`redirect:'manual'` + 逐跳把 Location 解析后过 `publicHttpUrl`。
 * 直接用默认 follow 的话，字面私网检查只验第一个 URL，公网 302 一跳就进了内网（评审 R3）。
 * 返回 null 表示"拒绝跟随或跳数超限"；其余返回最后一跳的响应（包括 3xx 本身——调用方按 !ok 处理）。
 */
async function fetchGuarded(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response | null> {
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(cur, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    let next: URL | null;
    try {
      next = publicHttpUrl(new URL(loc, cur).href);
    } catch {
      return res; // Location 畸形：当作失败，不跟随
    }
    if (!next) return null; // 私网/非 http(s) 目标：拒绝跟随
    cur = next.href;
  }
  return null; // 跳数超限
}

function validateDoc(data: unknown): WebCoverDoc | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as WebCoverDoc;
  if (d.schemaVersion !== WEB_COVER_SCHEMA_VERSION || typeof d.revision !== 'number' || typeof d.entries !== 'object' || d.entries === null) {
    return null;
  }
  const entries: Record<string, WebCoverEntry> = {};
  for (const [id, raw] of Object.entries(d.entries)) {
    const e = raw as WebCoverEntry;
    if (!e || typeof e.file !== 'string' || !e.file) continue;
    entries[id] = {
      noteId: id,
      file: e.file,
      contentType: typeof e.contentType === 'string' ? e.contentType : 'image/jpeg',
      durationSec: typeof e.durationSec === 'number' && Number.isFinite(e.durationSec) ? e.durationSec : null,
      source: e.source === 'bilibili' ? 'bilibili' : 'first-image',
      at: typeof e.at === 'string' ? e.at : '',
      failedAt: typeof e.failedAt === 'string' ? e.failedAt : null,
      failReason: typeof e.failReason === 'string' ? e.failReason.slice(0, 200) : undefined,
    };
  }
  return { schemaVersion: WEB_COVER_SCHEMA_VERSION, revision: d.revision, entries };
}

function extFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

interface FetchTarget {
  url: string;
  /** 小图参数版失败时的回退（B 站图床） */
  fallbackUrl?: string;
  referer: string;
  source: WebCoverEntry['source'];
  durationSec: number | null;
}

export class WebCoverService {
  private doc: WebCoverDoc = { schemaVersion: WEB_COVER_SCHEMA_VERSION, revision: 0, entries: {} };
  private store: JsonStore<WebCoverDoc>;
  private dir: string;
  /** 串行化「读-判-写」（与其它资产存储同一条纪律） */
  private queue: Promise<unknown> = Promise.resolve();
  /** 单飞：同一篇的并发请求共享一次抓取 */
  private flights = new Map<string, Promise<WebCoverEntry | null>>();

  constructor(dataDir: string, backupDir: string) {
    this.dir = path.join(dataDir, 'web-covers');
    this.store = new JsonStore<WebCoverDoc>(path.join(dataDir, 'web-covers.json'), backupDir, validateDoc);
  }

  async init(): Promise<string[]> {
    const diagnostics: string[] = [];
    const loaded = this.store.load();
    if (loaded.doc) {
      this.doc = loaded.doc;
      if (loaded.recoveredFrom) diagnostics.push(`web-covers.json 损坏，已从备份恢复: ${path.basename(loaded.recoveredFrom)}`);
    } else if (loaded.corruptedFile) {
      diagnostics.push('web-covers.json 损坏且无可用备份，封面缓存按空处理（会重新抓取）');
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* 目录建不了时抓取会失败进负缓存，不阻塞启动 */
    }
    return diagnostics;
  }

  get revision(): number {
    return this.doc.revision;
  }

  /** 命中即返回（含负缓存条目——调用方用 failedAt 判断）；没有返回 null */
  get(noteId: string): WebCoverEntry | null {
    return this.doc.entries[noteId] ?? null;
  }

  /** 负缓存是否已过期：过期（或时间戳损坏）后应允许重新探测/抓取。
   *  ensure 与摘要三态共用这一个判断——两处各写一套时钟正是"过期了却探不了"这类 bug 的温床（评审 R5）。 */
  negativeExpired(failedAt: string): boolean {
    const t = Date.parse(failedAt);
    return !Number.isFinite(t) || Date.now() - t >= NEGATIVE_TTL_MS;
  }

  /** 可用条目（有文件且不在负缓存期）的绝对路径；不存在返回 null */
  filePathOf(noteId: string): string | null {
    const e = this.doc.entries[noteId];
    if (!e || e.failedAt) return null;
    const abs = path.join(this.dir, e.file);
    return fs.existsSync(abs) ? abs : null;
  }

  /** 确保封面存在：命中直接返回；负缓存期内 null；否则抓取（单飞 + 串行落盘） */
  async ensure(note: NoteRecord, fetchImpl: typeof fetch = fetch): Promise<WebCoverEntry | null> {
    const cur = this.doc.entries[note.id];
    if (cur && !cur.failedAt) return cur;
    if (cur?.failedAt && !this.negativeExpired(cur.failedAt)) return null;
    const flight = this.flights.get(note.id);
    if (flight) return flight;
    const p = this.fetchAndStore(note, fetchImpl).finally(() => this.flights.delete(note.id));
    this.flights.set(note.id, p);
    return p;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(entry: WebCoverEntry, bytes: Buffer | null): Promise<WebCoverEntry> {
    return this.enqueue(async () => {
      if (bytes) {
        fs.mkdirSync(this.dir, { recursive: true });
        const abs = path.join(this.dir, entry.file);
        const tmp = path.join(this.dir, `.${entry.file}.tmp-${process.pid}`);
        await fs.promises.writeFile(tmp, bytes);
        try {
          await fs.promises.rename(tmp, abs);
        } catch (e) {
          await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
          throw e;
        }
      }
      const entries = { ...this.doc.entries, [entry.noteId]: entry };
      const next: WebCoverDoc = { ...this.doc, revision: this.doc.revision + 1, entries };
      await this.store.save(next);
      this.doc = next;
      return entry;
    });
  }

  private async markFailed(note: NoteRecord, reason: string): Promise<null> {
    const prev = this.doc.entries[note.id];
    const entry: WebCoverEntry = {
      noteId: note.id,
      file: prev?.file ?? `${crypto.createHash('sha1').update(note.id).digest('hex').slice(0, 16)}.jpg`,
      contentType: prev?.contentType ?? 'image/jpeg',
      durationSec: prev?.durationSec ?? null,
      source: prev?.source ?? 'first-image',
      at: prev?.at ?? new Date().toISOString(),
      failedAt: new Date().toISOString(),
      failReason: reason,
    };
    try {
      await this.commit(entry, null);
    } catch {
      /* 负缓存写失败也无妨：下次再试一遍 */
    }
    log.warn(`网页封面抓取失败（${note.id.slice(0, 40)}）: ${reason}`);
    return null;
  }

  private async fetchAndStore(note: NoteRecord, fetchImpl: typeof fetch): Promise<WebCoverEntry | null> {
    try {
      const target = await this.resolveTarget(note, fetchImpl);
      if (!target) return this.markFailed(note, '没有可用的封面来源（非 B 站且正文无远程图）');
      let bytes = await this.downloadImage(target.url, target.referer, fetchImpl);
      if (!bytes && target.fallbackUrl) {
        bytes = await this.downloadImage(target.fallbackUrl, target.referer, fetchImpl);
      }
      if (!bytes) return this.markFailed(note, `封面下载失败: ${target.url.slice(0, 80)}`);
      const entry: WebCoverEntry = {
        noteId: note.id,
        file: `${crypto.createHash('sha1').update(note.id).digest('hex').slice(0, 16)}.${extFor(bytes.contentType)}`,
        contentType: bytes.contentType,
        durationSec: target.durationSec,
        source: target.source,
        at: new Date().toISOString(),
        failedAt: null,
      };
      await this.commit(entry, bytes.body);
      log.info(`网页封面已缓存: ${note.id.slice(0, 40)}（${target.source}，${Math.round(bytes.body.length / 1024)}KB）`);
      return entry;
    } catch (e) {
      return this.markFailed(note, (e as Error).message);
    }
  }

  private async resolveTarget(note: NoteRecord, fetchImpl: typeof fetch): Promise<FetchTarget | null> {
    const bvid = bvidFromUrl(note.originalUrl);
    if (bvid) {
      const api = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
      try {
        const res = await fetchGuarded(fetchImpl, api, {
          headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res && res.ok) {
          const j = (await res.json()) as {
            code?: number;
            data?: { pic?: unknown; duration?: unknown };
          };
          if (j.code === 0 && typeof j.data?.pic === 'string') {
            const pic = j.data.pic.replace(/^http:/, 'https:');
            return {
              // B 站图床支持尺寸处理后缀；小图失败回退原图
              url: `${pic}@480w_270h_1c.webp`,
              fallbackUrl: pic,
              referer: 'https://www.bilibili.com/',
              source: 'bilibili',
              durationSec: typeof j.data.duration === 'number' && Number.isFinite(j.data.duration) ? j.data.duration : null,
            };
          }
        }
      } catch {
        /* B 站失败就落到正文首图 */
      }
    }
    const img = firstRemoteImage(note.bodyHtml);
    if (img) {
      const u = publicHttpUrl(img);
      if (u) return { url: u.href, referer: `${u.origin}/`, source: 'first-image', durationSec: null };
    }
    return null;
  }

  private async downloadImage(
    rawUrl: string,
    referer: string,
    fetchImpl: typeof fetch
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const u = publicHttpUrl(rawUrl);
    if (!u) return null;
    try {
      const res = await fetchGuarded(fetchImpl, u.href, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: 'image/*,*/*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res || !res.ok) return null;
      const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!ct.startsWith('image/')) return null;
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > MAX_IMAGE_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      return { body: buf, contentType: ct };
    } catch {
      return null;
    }
  }
}
