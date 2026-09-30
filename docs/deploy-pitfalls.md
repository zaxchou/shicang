# Deploy Method — Field Notes（`deploy-handoff.md` 的续篇）

> **中文摘要（给先看中文的人）**：这是把方法真正落地后（v0.13.2 → v0.14.0 两个版本）咬过我的坑，
> 按"症状 → 根因 → 修法 → 怎么提前发现"记。最值得先看的四条：
> ① **测试绿 ≠ 跑起来的是新代码**（测试跑源码、服务跑编译产物，改完必须重建+重启再验）；
> ② **测试绿 ≠ 类型过**（esbuild 不做类型检查，`noUncheckedIndexedAccess` 这类只有 tsc 报）；
> ③ **改完解析器但版本常量已经 bump 过 → 生成缓存不会失效**，得手动删索引（只删索引，别删标注资产）；
> ④ **写一个"在旧代码上是红的"的断言再修**——我那个时间差 8 小时的 bug 是浏览器详情页看出来的，不是测试。
> 另有 shell/PowerShell/Git Bash 的三个引号与转义坑、以及"部署前必须先备好回滚目标"。

**Scope**: this is the "day 2" companion to `deploy-handoff.md`. That document describes how the method
works; this one records what **actually went wrong** while shipping two versions with it, so you don't
have to rediscover them. Same structure throughout: **symptom → root cause → fix → how to catch it early**.

---

## A. The artifact you ship is not the code you tested

### A1. Tests run from source; the server runs from compiled output

- **Symptom**: tests all green, but the running service behaved like the old code — and its reported
  version silently lagged `package.json`.
- **Root cause**: `vitest` (and tsx) execute the **TypeScript source**; the service executes `dist/`.
  If you change server code and don't rebuild, `dist/` is stale. The version field is also read **once
  at boot**, so a long-lived process keeps reporting its birth version forever.
- **Fix**: after touching shipped code → `npm run build` (or your equivalent) → **restart** the process
  → then verify. Verify the *artifact*, not the source.
- **Catch it early**: assert the running service's version equals the version you believe you deployed.
  Mismatch = you are looking at stale code. I hit this twice before it clicked.

### A2. Stale build output can ship inside the package

- **Symptom**: the release package contained `dist/` built from an older revision of the sources.
- **Root cause**: I had made "build the artifact" an *optional* precheck step. With a skip flag
  (`-SkipChecks`) the package happily shipped yesterday's build.
- **Fix**: make **fresh build + artifact existence check mandatory** — even under a skip flag.
  A package without a program is not a release; a package with an *old* program is worse.
- **Catch it early**: the packaging script should fail loudly if `dist/entry.js` / `dist/index.html`
  is missing, and the build step should run **inside** packaging, immediately before the copy.

### A3. Tests green ≠ typecheck green

- **Symptom**: full test suite passed; `tsc` failed with `TS2532: Object is possibly 'undefined'`
  on a line the tests exercised without complaint.
- **Root cause**: the test runner transpiles (esbuild/babel-style, **no type checking**); `tsc` enforces
  strictness (here `noUncheckedIndexedAccess`: `m[1]` is `string | undefined` even right after `.exec()`).
- **Fix**: run **both** gates; never treat "tests pass" as type safety.
- **Catch it early**: put typecheck *first* in the precheck so you fail before spending test minutes.

---

## B. Version normalization — the two ways to corrupt it

### B1. The lockfile has a `version` field per dependency

- **Symptom (averted)**: a naive `"version"` replace across `package-lock.json` would rewrite **every
  dependency's** version to my release number, and `npm ci` would then refuse/mis-install.
- **Root cause**: `package.json` has 1 root version; the lockfile has **2** (root + `packages[""]`),
  plus N dependency versions that must never be touched.
- **Fix**: replace only the exact root occurrence and **assert the hit count** (1 in package.json,
  2 in lockfile). If the count differs → abort the release instead of shipping a suspect lockfile.
- **Catch it early**: after packaging, `grep` your real version string inside the package's two files —
  it must be **zero** hits, and dependency versions must still look like `4.21.2`, not `0.0.0`.

### B2. The app must read the *same* place you wrote the version

- **Symptom (averted)**: after normalizing `package.json` to `0.0.0`, the app's self-reported version
  (and therefore the health gate's assertion) would have returned `0.0.0` → every deploy would "fail"
  at the version check *after* the container was already replaced.
- **Fix**: write a separate `VERSION` file; make the app prefer it; **COPY it into the image after the
  dependency layers**. Then prove it end-to-end *before* deploying: run the packaged build locally on a
  spare port and hit its health endpoint — it must report the real version.
- **Catch it early**: this local boot test is cheap (seconds) and validates the whole chain:
  package → VERSION → boot → health.

---

## C. Caching: when it holds, when it lies

### C1. Expect exactly two "slow" deploy triggers

1. the Dockerfile changed,
2. the dependency set changed (`package-lock.json`).

Everything else should hit cache. **Tell the human before the slow one** ("this build is the slow
path, next one is fast") — otherwise they conclude your method doesn't work.

### C2. A fixed parser does NOT invalidate an already-built cache

- **Symptom**: I fixed a parsing bug, restarted… and the wrong values were still served.
- **Root cause**: my generated cache (an index) invalidates **only** when its version constant or
  structure fingerprint changes. I had already bumped that constant earlier in the same change, so
  the second fix produced **no fingerprint change** → the stale (buggy) index was trusted.
- **Fix**: when you change semantics *after* the fingerprint moved, **delete the cache explicitly**.
  Delete **only** the derived cache file — the user's annotations/overrides are *assets* and must
  survive (they don't participate in the fingerprint by design).
- **Catch it early**: after a parser/serializer fix, don't just restart — check that a record's stored
  value actually changed (query one known record). "Service restarted" is not "cache rebuilt".

### C3. First build with a revised Dockerfile is always full-price

The health gate in my flow allows ~3 minutes *after* the container starts; the build phase is separate.
Budget accordingly: a first build of ~5–9 minutes is **expected**, not a regression. The payoff starts
on the *next* deploy. Also: a failed `docker build` aborts **before** the running container is touched
(`set -eu`) — that's a safe failure mode; keep it.

---

## D. Shell & tooling traps (all hit in practice)

| Trap | Symptom | Fix |
|---|---|---|
| **Pipeline exit status** | `npm run build … \| tail -2 && next-step` — the build **failed**, yet `next` ran (the pipe's status came from `tail`), so I restarted a service from a stale `dist` and rebuilt the index with stale code | Check the real command's status: `cmd >log 2>&1; echo "exit=$?"; tail log` — never chain off a piped command |
| **Git Bash eats backslashes** | `powershell -File scripts\release.ps1` → "scriptsrelease.ps1 does not exist" (`\r` eaten) | Use forward slashes: `-File scripts/release.ps1` |
| **Synology PATH** | `docker: command not found` when running over SSH as a non-login shell | Prefix `export PATH=/usr/local/bin:$PATH` in **every** docker command (bit me twice) |
| **BOM (covered in the handoff)** | `.json` no longer parses; the first line of `.dockerignore` silently never matches | Write files with an explicit no-BOM writer; verify the first bytes after writing |
| **`--follow-tags` pushes annotated tags only** | "push succeeded" but the tag never appeared remotely | Create tags with `git tag -a` (annotated), and compare `git ls-remote` against local HEAD |

---

## E. Verification that actually catches things

### E1. Write the falsifiable assertion **before** the fix

The bug I shipped to myself: a frontmatter timestamp without a timezone was parsed as **UTC** by the
YAML library, while the UI renders a fixed +8 → `11:26` displayed as `19:26`. Nothing in my unit tests
would have caught it, because they asserted the internal ISO string — which was internally consistent.

- **What caught it**: opening the **real detail page** and comparing against the source file.
- **What prevents regression**: an assertion on the **user-visible value** — `expect(displayTime).toBe('11:23')`
  — written against the old code first, confirmed **red**, then fixed. ISO-string assertions can't fail
  if both sides share the same wrong interpretation.
- **Rule**: assert the number/time/text *the human sees*, not the internal representation.

### E2. Measure with DOM/geometry when you can't (or shouldn't) eyeball

- Screenshots you cannot actually view are worthless — measure instead: `naturalWidth > 0`,
  `getComputedStyle(img).opacity`, bounding boxes, element counts.
- Compare **before/after numbers** in your report (e.g. "all 11 media boxes 248×186, 10 covers +
  1 placeholder"), and keep the count of *how many* matched your expectation.
- Strict-mode selector failures (`locator resolved to 4 elements`) mean your selector is ambiguous —
  scope it (`nth=0`) rather than loosening it; a loose selector silently checks the wrong node.
- **Console errors = 0** is a cheap gate after any frontend change.

### E3. Interpret the read-only hash manifest correctly

A non-zero diff does **not** mean your app wrote to the source. Classify before alarming:

- `added` = the human's own new content files (compare against what they told you they added),
- `changed` = the host application's own index/metadata files,
- anything else = investigate seriously.

Also check the **totals** (my totals moved exactly by the number of files the human had added).

### E4. Verify the deployed behavior, not just the health string

Health passing proves process up + version matched. It does **not** prove your feature works.
After each deploy I ran: one real query against the new collection, one asset request
(`200 image/png`, size + latency), one cross-scope search, frontend `200`. Two minutes, catches everything
health can't.

---

## F. Rollback before you need it

Before the **first** deploy of a changed Dockerfile, confirm the rollback path works: your rollback
should only flip the image tag to an image that **already exists locally** (no rebuild). If you cannot
roll back, you are one bad health gate away from a broken production service — the health gate's
failure mode leaves the *new* (bad) container running.

---

## Pre-deploy checklist (paste-able)

```text
[ ] typecheck green (before tests — cheaper to fail first)
[ ] tests green
[ ] artifact built inside packaging; dist entry files exist
[ ] package inspected: VERSION present; real version string absent from package.json/lock;
    dependency versions untouched; dist is fresh; .dockerignore first bytes have no BOM; no .env*
[ ] rollback target exists (previous image tag) — required if Dockerfile/lock changed
[ ] told the human if this build is the slow path
[ ] launched in background with a log file; polling with a timeout (never trust "LAUNCHED")
[ ] success = health ready:true AND version == the one requested
[ ] post-deploy: one real query + one asset + one search + frontend 200; console errors 0
[ ] if semantics changed but the version constant cannot move again: force-delete the derived cache
[ ] recorded the build duration — it is your signal for whether caching still holds
```

---

## Old image cleanup (2026-09-30, the NAS filled up once)

Every rebuild turns the previous image's layers into `<none>` dangling images. One afternoon of
frequent deploys piled up **26 dangling images (~2 GB)** on the shared NAS, plus three exited
test containers (`docker run` without `--rm`) pinning more. Fix shipped in myinfobase
`deploy/nas-update.sh` (runs after the health gate, before the final "done" line — the deploy
poll matches the last line, don't reorder), and it is **non-fatal**:

```sh
KEEP_OLD=2   # keep current + 2 most recent tags — rollback needs those tags
docker image prune -f >/dev/null 2>&1 || true
OLD_TAGS=$(docker images <your-image-name> --format '{{.Tag}}' 2>/dev/null \
  | grep -v '^<none>' | grep -vx "$VER" | tail -n +"$((KEEP_OLD + 1))")
for t in $OLD_TAGS; do docker rmi "<your-image-name>:$t" >/dev/null 2>&1 || true; done
```

Rules learned the hard way:

- `docker image prune -f` cannot remove a dangling image that a **stopped container** still
  references — random-named exited test containers silently pin ~300 MB each. Ad-hoc test runs
  on the NAS should use `docker run --rm`; to reclaim, remove the exited container first, then prune.
- Keep a couple of old **tagged** images: rollback is `docker image inspect <name>:<old-tag>`
  and a container recreate — delete the tags and you lose the cheap rollback path.
- Never `docker rmi -f` / `docker system prune -a` on this NAS: it hosts unrelated services
  (mt-photos, jellyfin, fast-note-sync…). Dangling-only prune and your own image name only.
- Cleanup output must come **before** the final success line, or a last-line-matching deploy
  poll will spin until timeout.
