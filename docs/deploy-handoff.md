# Deploy Methodology — Handoff

> **中文摘要（给先看中文的人）**：这份文档是把拾藏（Shícáng）的部署方法抽出来的可移植版本，给隔壁同样往 NAS 部署的项目用。
> 核心只有四条：①**别在目标机器上编译**，预编译产物随包发；②**让第一次 `COPY` 的内容每次发版都逐字节相同**（把版本号从构建上下文里挪出去），否则依赖层缓存必废、每次部署重跑 `npm ci`——这就是"部署要 9 分钟"的主因；③版本号改用独立的 `VERSION` 文件，程序自报的版本仍然真实；④上线判定必须是**带版本断言的健康检查**，回滚直接切回已存在的镜像 tag。下面是完整说明、落地清单、以及踩过的坑。
>
> 适用范围：Node/Express 类应用、目标机是 NAS/Synology、通过 Docker Compose 常驻运行。换语言换框架也成立，只要"产物可移植、依赖层可缓存"。

**Context**: this is the methodology we used to take a NAS deployment from **~9 minutes to ~1 minute** of actual build work, without giving up the "one image tag = one known code version" discipline. It is written to be portable — English Forge can follow the recipe directly.

> **续篇**：真正落地时踩的坑见 [`docs/deploy-pitfalls.md`](deploy-pitfalls.md)（day-2 篇）——
> 测试跑源码而服务跑编译产物、类型检查与测试是两道门、版本归一的两个毁法、解析器修了但缓存指纹没动、
> shell/PowerShell/Git Bash 的转义坑、以及"能证伪的断言要先红后绿"。

---

## TL;DR — the four levers

1. **Compile on your machine, not on the NAS.** Ship the prebuilt artifact (`dist/`) inside the release package. If the target has to run `tsc`/`vite`/`go build`/`npm run build`, every release pays for its slow CPU.
2. **Make the first `COPY` layer byte-identical across releases.** Any file in the build context that changes every release (the version field being the classic one) invalidates *every layer after it* — that is how `npm ci` ended up downloading hundreds of MB on every deploy. Keep the version **out** of that layer.
3. **Put the real version in a separate `VERSION` file** so the app can still report the truth (`/api/health → {"version":"0.13.2"}`) after you normalized `package.json`.
4. **Gate the deploy on a health check that asserts the version**, and make rollback a tag flip to an image that already exists (no rebuild).

---

## Step 1 — Diagnose before changing anything

Write down where the wall-clock time actually goes. For us:

| stage | what it did | cost |
|---|---|---|
| `COPY package.json package-lock.json` → `npm ci` ×2 stages | rebuilt **because the version field changed** | ~minutes, hundreds of MB from mirror |
| `RUN npm run build` | `tsc` + `vite` **on the NAS CPU** | minutes |
| everything else | `apk add ffmpeg`, container recreate, health gate | seconds |

**The general rule:** *a file that differs on every release, placed before expensive `RUN` steps, converts every layer after it into a full rebuild.* Once you see it this way, the fix is mechanical.

**Checklist of usual suspects** — inspect these before blaming Docker or the network:

- `version` in `package.json` / `package-lock.json` (npm writes it in **three** places: package.json, lock root, `packages[""]`)
- generated manifests, build metadata, `git describe` outputs, timestamps written during build
- lockfile churn that does not change actual dependencies (registry host rewrites)
- `.env` / config files copied into the context "just in case"

**Verify the suspicion** with the previous build log: if you see `CACHED` lines up to some layer and then a full re-run of `npm ci` from a `COPY` step, that is it.

---

## Step 2 — Release script (the Windows/dev side)

One script produces a *complete, self-contained* release directory: `releases/<version>/`.

Responsibilities, in order:

1. **Precheck:** typecheck + tests + **`npm run build`** (now part of the release — if you ship `dist/`, the release must produce it fresh, or you may ship stale artifacts from older sources).
2. **Guard:** fail hard if `dist/server/index.js` (or equivalent) is missing — even with a `-SkipChecks` escape hatch. A package without a program is not a release.
3. **Copy sources needed at runtime** (`config`, `data-seed`); exclude dev junk, secrets, data, duplicate docs.
4. **Normalize the version** in the staged `package.json` + `package-lock.json` → constant (we use `0.0.0`), and **assert the replacement hit counts** (1 in package.json, 2 in package-lock) — if npm's structure ever changes, fail loudly instead of silently busting the cache again.
5. **Write `VERSION`** containing the real version (UTF-8, no BOM).
6. **Write `.dockerignore`** (BOM-free, LF): exclude everything the image does not need — sources if you precompile, docs, tests, screenshots, `.env*`, `manifest.json`.
7. **Write `manifest.json`**: version, build time, machine, and `sha256 + size` per file. It is your audit trail for "what exactly went up".

> **Pitfall (PowerShell 5.1):** `Set-Content -Encoding UTF8` writes a **BOM**. A BOM in `manifest.json` breaks every `JSON.parse`; a BOM before the first `.dockerignore` line means that pattern silently never matches (we shipped 18MB of screenshots to the Docker daemon because of this). Use `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.

---

## Step 3 — Dockerfile (the NAS side)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./     # ← content is stable across releases ⇒ cache holds
RUN npm ci --omit=dev && npm cache clean --force
RUN apk add ...                            # only when you truly need a system tool
COPY dist ./dist                           # ← changes every release: one cheap layer
COPY VERSION ./                            # ← after the dependency layers, never before
COPY config ./config
CMD ["node", "dist/server/index.js"]
```

Key ordering facts:

- **No build stage at all** — there is nothing to compile.
- **`VERSION` goes last** so it only invalidates the layers that change anyway (`COPY dist`), never the dependency layers.
- The image is *runtime-only*: 5 pure-JS runtime deps + ffmpeg + `dist/` + config + seed. Keep it that way.

**When do you rebuild the image?** Whenever `package-lock.json`'s dependency set or the Dockerfile changes — a few times a year, not a few times a week.

---

## Step 4 — Deploy + verify (the NAS side)

One script, four steps, and **never declare success without a version assertion**:

1. `docker build -t <app>:<version> releases/<version>`
2. rewrite `MYINFOBASE_TAG=<version>` in the env file (with a guard: fail if the line is missing, otherwise `sed` silently does nothing and you "ship" an old version)
3. `docker compose up -d --force-recreate`
4. poll `/api/health` until `ready:true` **and** `"version":"<requested>"`, with a hard timeout

Rollback = point `MYINFOBASE_TAG` at an image that already exists locally → `up -d --force-recreate` → same health gate. No rebuild, so it is fast and safe; `docker images` tells you what you can roll back to.

**Rules we keep around the flow:**

- Deploy only on an explicit human command. Never "changed it, so deployed it".
- The app must refuse to start if its data directories would land **inside the content source** (boot-time guard, not a runtime surprise).
- The content source is mounted **read-only**; user data (annotations, overrides, caches) lives in a separate data dir and never gets written back.
- Secrets live only in a gitignored `.env` on the target. When starting a local preview, inject **only the keys you need** (e.g. `AI_*`) — injecting the whole production env into dev drags the container paths in with it and silently repoints the source root.
- Read-only invariants are proven with a **hash manifest of the source tree**, not by eyeballing.

---

## Step 5 — Prove it locally before touching the target

You cannot `docker build` on Windows here, so prove the parts you can:

1. Run the **packaged** server from `releases/<version>/` on a spare port with a temp data dir → `/api/health` must report the real version. This proves the `VERSION` chain end-to-end (that is exactly what the NAS health gate will assert).
2. Inspect the package: version normalized, `VERSION` present, artifact present, `.dockerignore` has no BOM, no `.env*`, no `deploy/production/`.
3. Read-only check: hash-manifest diff of the content source must show only the user's own edits.

The first deploy after a Dockerfile change is still a full rebuild (the base layers changed) — the payoff starts on the **next** one. Say that out loud so nobody panics at the first slow deploy.

---

## Numbers (this project, 2026-09)

- before: **~9 min** per deploy (version bump → `npm ci` rebuilt twice + `tsc`/`vite` on NAS)
- after: build context **~2MB**, no compilation on the NAS; dependency layers cached permanently; per-deploy work = `COPY dist` + container recreate + health gate
- release package **22MB → 4.2MB** (dropped the duplicated `docs/` screenshots; the NAS already syncs the whole project once)

## Pitfalls that actually bit us

| pitfall | symptom | fix |
|---|---|---|
| version field inside the first `COPY` | `npm ci` re-runs every deploy | normalize version in the package; real version → `VERSION` |
| `package-lock.json` has `"version"` per dependency | a blanket regex corrupts the lockfile | replace only the root occurrences; assert hit counts |
| PS 5.1 UTF8 writes BOM | `.dockerignore` first pattern never matches; `JSON.parse` fails | write with `UTF8Encoding($false)` |
| compiling on the target | minutes of CPU per deploy | ship prebuilt artifacts (pure JS / no native deps makes this safe) |
| self-reported version ≠ image tag | you think you rolled back, you did not | health gate asserts `version` against the requested one; `sed` guard on the tag line |
| image self-heals wrongly: `COPY` order | touching `VERSION` busts `npm ci` cache | copy version **after** the dependency layers |

## Artifacts in this repo (as reference implementations)

- `scripts/release.ps1` — package, normalize, manifest, `.dockerignore`
- `deploy/Dockerfile` — single-stage, no compile
- `deploy/nas-update.sh` — build → tag → recreate → health+version gate
- `deploy/nas-rollback.sh` — tag flip to an existing image + same gate
