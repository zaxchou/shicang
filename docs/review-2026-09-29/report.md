# 拾藏代码审查报告（2026-09-29）

审查基线：`15746b856567bad138c626aa600a0744a761e7f3`，版本 0.15.1。开始时工作区干净。已阅读 review-handoff.md，并检查近期分类、解析、封面、刷新和发布改动及其相关调用链。交接文档中的产品取舍作为背景，验证结论以代码与本次实测为准。

结论：发现 6 个可行动问题，其中 5 个有隔离运行证据，另 1 个为明确的脚本路径问题但未在 NAS 实测。现有 273 项测试全绿不能覆盖这些失败路径。未发现需要按 P0 紧急事故处理的证据。

分级按修复紧迫程度：P1 应优先修复，P2 常规修复；不将文件过大、已知无鉴权、已接受的搜索截断或重复命名列作新缺陷。

## R1 · P1 · AI 分类预算只统计成功结果，失败响应可以突破调用上限

位置：`server/services/library.ts:1315–1326`，`LibraryService.autoClassify`。

判断上限用 `byAi + aiDeferred`，但实际请求之后只有 `hit` 非空才增加 byAi。HTTP 错误、超时、模型输出无合法类目时都不增加请求数。因此当模型持续返回不合格答案或供应商故障时，一次刷新会尝试全部待分类笔记，突破配置的按次预算；无效答案也可能已经计费。全部超时时还会把刷新拖长到“待分类总数 × 超时”。

隔离复现：5 篇无规则命中的测试笔记，`AI_CLASSIFY_MAX_PER_REFRESH=2`，fetch 替身每次返回 HTTP 200 但无合法分类；实际 `requests=5`、`unclassified=5`。没有真实模型请求或费用。

修复建议：单独维护 attempted，在发请求之前递增；成功数仅用于报告，deferred 只统计因预算未调用的条目。补充成功、无效输出、401、网络错误及混合结果的预算测试，断言实际 fetch 次数均不超过上限。当前代码下“5 个无效结果只允许最多 2 次 fetch”的断言会失败。

## R2 · P1 · 小红书笔记改名后，旧 missing 记录覆盖新路径的详情

位置：`server/reader/scan.ts:186–190`；关联 `server/services/library.ts:251–256` 的 rebuildMaps。

源 Markdown 改名或移到同一个库的另一个目录时，resourceId 保持不变。扫描先把新路径加入 records，末尾按旧路径找不到记录，又补入相同 ID 的 missing 旧记录。rebuildMaps 顺序 set，相同 ID 的旧记录反而最后覆盖新记录。

隔离复现：`old.md` 改成 `new.md`，保留 `stable-note-1`。刷新显示 completed、errors=0，但落盘记录为：

```json
[
  {"id":"stable-note-1","path":"RedNote/Bookmarks/new.md","status":"available"},
  {"id":"stable-note-1","path":"RedNote/Bookmarks/old.md","status":"missing"}
]
```

`detail('stable-note-1')` 返回 old.md、missing。结果是列表可见新条目，详情却报告旧路径/源缺失，索引总数也膨胀；相同 ID 的标注和媒体操作会命中错误记录。

修复建议：补 missing 之前检查该 ID 是否已由新的有效路径接管，识别重命名并仅保留新记录；提交前验证 ID 全局唯一，并覆盖改名后刷新、再次刷新和重启场景。不能简单丢弃真正删除的笔记，那仍须保留其资产。断言“改名后相同 ID 仅一条且详情指向 new.md”当前失败。

## R3 · P1 · 封面抓取自动跟随重定向，可绕过已实现的字面私网拒绝

位置：`server/services/web-cover.ts:310–316`，WebCoverService.downloadImage。

publicHttpUrl 只验证第一次传入的 URL，fetch 未设置 redirect，默认继续请求 Location 指定的目标。一个通过检查的公网封面 URL 若返回 302 到 127.0.0.1 或 NAS 内网地址，服务就会发出内网请求；Content-Type 检查在请求完成后，无法阻止访问。内网响应若被标作图片，还会缓存并经封面路由返回。

这与交接文档中已知的 DNS 重绑定不是同一个问题：不需要特殊 DNS，只要标准 HTTP 重定向即可绕过现有字面地址检查。

隔离复现：传给服务的是 public.example/image；注入适配器仅将最初请求导向本机测试服务器，保留服务传入的请求选项，由原生 fetch 处理 302 到另一 loopback 路径。结果 `redirectOption=follow (default)`、`privateHits=1`、`cached=true`。没有访问真实公网或 NAS 私有接口。这验证自动跟随行为与缺失检查，未声称对线上做过攻击测试。

修复建议：如不需要跳转，设置 redirect:error；否则 redirect:manual，限定跳数、逐跳解析并验证 Location。B 站元信息请求也应按相同出网纪律复核。该修复只能解决重定向绕过，不能据此宣称已解决 DNS 重绑定。回归应断言私网重定向目标的 hit 为 0。

## R4 · P1 · -SkipChecks 跳过构建，旧 dist 可被贴成新版本且通过版本门

位置：`scripts/release.ps1:33–45`；关联 deploy/Dockerfile 的 COPY dist/COPY VERSION 和 server/config.ts 的 readVersion。

npm run build 被放在 `if (-not $SkipChecks)` 内，跳过检查时仅检查两个 dist 文件存在。随后脚本仍按当前 package.json 写 VERSION 并打包。旧 JS 配合新的 VERSION，运行时 readVersion 和健康检查都能报告“新版本”，但实际逻辑仍是旧构建。

隔离复现：全新临时假项目，复制当前 release.ps1 与 Dockerfile，源码放 NEW_SOURCE_SENTINEL，dist 放 OLD_BUILD_SENTINEL，版本 9.9.9。执行 `-SkipChecks` 返回 0：

```text
PublishedVersion = 9.9.9
PackedBuild      = // OLD_BUILD_SENTINEL
CurrentSource    = // NEW_SOURCE_SENTINEL
```

没有在真实 releases 生成包，没有执行 Docker 或部署。

修复建议：现场构建移出 SkipChecks 条件，SkipChecks 只跳类型和测试。如确实需要复用产物，另设明确开关，并验证该产物与当前源码、依赖锁和构建参数的指纹匹配。只加 dist 存在性或 VERSION 比较无法解决。

## R5 · P2 · 封面负缓存六小时后，普通卡片浏览仍不触发重试

位置：`server/services/library.ts:434–441`；关联 `src/components/NoteCard.tsx:64–66`。

WebCoverService.ensure 有 6 小时过期逻辑，但 toSummary 只要看到 failedAt 就永久输出 webCover:null。卡片仅在 webCover===undefined 时调用探测接口，所以缓存过期后即使刷新页面、刷新收藏库或重启，普通网页卡片也不会进入 ensure 的重试路径。

隔离复现：临时 web-covers.json 写入 2020-01-01 的失败条目，重新初始化 LibraryService 并查询普通网页笔记，仍得到 `webCover=null`、`needProbe=false`。这是服务查询结果加卡片实际条件的验证，没有执行浏览器端到端。B 站详情中直接挂封面 img 的路径可能另行触发重试，不能因此认为所有卡片都会自动恢复。

修复建议：服务端用统一过期函数区分“未过期失败”与“过期可重试”，后者返回可探测状态；同时处理卡片本地 webCoverFailed 的复位时机。无需取消 6 小时负缓存这一已接受取舍。补充“到期前不请求，到期后重新查询/挂载会探测”的集成测试。

## R6 · P2 · 部署健康检查的“三分钟”不限制单次 wget

位置：`deploy/nas-update.sh:45–47`。

循环限制 90 次，并在每次失败后 sleep 2，但 wget 没有请求超时。连接建立后服务不返回响应，单次 wget 就可能长期阻塞，计数器不会前进；此时新容器已经替换旧容器，部署命令不能按宣称的三分钟退出，人工回滚判断被拖延。

证据层级：静态脚本路径核对，未在 NAS 模拟服务卡住，也没有从 JunEnglish 文档借用事故作为本项目证据。Dockerfile 的 HEALTHCHECK 超时不能限制此独立宿主脚本中的 wget。

修复建议：设置每次请求超时，并采用单调整体截止时间或等价可靠超时机制；每轮先检查剩余时间。回归在隔离本地服务中接受连接但不返回数据，确认探针在配置截止时间内退出。部署与回滚不能在审查阶段自动执行。

## 验证结果与范围

- Node v24.18.0，Windows，仓库映射盘 Z:。HEAD 在复现前再次检查仍为 15746b8。
- 三个 TypeScript 配置检查均 exit 0：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.tests.json
```

- `node node_modules/vitest/vitest.mjs run`：17 files passed、273 tests passed，Duration 51.30s。最初在 UNC 工作目录触发 vite-node 正则构造错误，改同一仓库 Z: 路径后通过；这不作为应用缺陷。
- 服务端 tsc 与 Vite production build 均通过，输出到新建系统临时目录，不覆盖真实 dist。Vite 6.4.3，43 modules transformed。
- 新增探针命令（均从项目根 Z: 运行）：

```powershell
node --import tsx docs/review-2026-09-29/probes.mts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs/review-2026-09-29/release-probe.ps1
```

探针打印当前错误行为，exit 0 只代表完成实验，不代表问题已修复。修复者应将上述预期转换成真正先红后绿的回归断言。所有夹具在系统临时目录；未加载 deploy/production/.env，AI 只使用替身。

- `node scripts/source-hash.mjs --check` 返回非零：相对既有清单 total=4323、added=102、removed=1、changed=4。4 个 changed 是收藏品的价格区间/时代/杂件/作者索引页；新增包含日记和剪藏。此清单早于本轮，不能把变化归因于应用或本次审查，也不能据此宣称“零变化”。没有改写既有清单。
- 哈希脚本当前按 collection.root 遍历，RedNote/Bookmarks 不包含其兄弟 Media，因此该命令不是完整媒体只读证明。本轮只读代码、源哈希读取与临时夹具操作，没有向真实源写数据。
- 未做浏览器端到端、真实模型、真实视频供应商或 NAS 运行态测试；NAS 部署状态未作推断。前端视觉是否符合既有设计不在这次静态代码结论内。

## 修复顺序与保留事项

建议先修 R1/R2/R3/R4，避免费用预算失效、稳定 ID 失效、内网请求绕过和假版本发布；再修 R5/R6。各修复使用独立回归证据，不需要重写全局分类模型或把全部资产搬进索引。

未将三处 managed 分类判定、library.ts 体量、已知无登录、已接受的标签/搜索语义或未做视频转录当作新缺陷。单飞直到磁盘提交、源只读、人工覆盖优先等约束应继续保留。

本轮仅新增 docs/review-2026-09-29 下的报告及两个复现脚本。未改应用代码、未提交、未推送、未部署、未修改 plan.md 的产品决定。