# 代码审查交接说明（给新一轮审核 / ChatGPT）

> **这份文档解决什么**：这个仓库里有大量**看起来像 bug、其实是刻意决定**的写法，以及一批**已知但故意留着**的缺口。
> 不先读这些，审查会产出一堆误报，真正有价值的问题反而被淹没。所以：**先读第 2、3 节再看代码**；
> 第 4 节列的别再当新发现报；第 5 节是我们**最想听**的方向。
>
> 代码注释与文档都是中文，本文也用中文。文中提到的"证据"都给了符号/文件名（不给行号——行号会漂移）。

---

## 0. 一句话背景与自查方式

拾藏（Shícáng）：把 Obsidian vault（小红书剪藏、收藏品、日记、网页/微信公众号剪藏）读成一个网页库，
带分类、标星/归档/备注、语料导出、OCR/语音转录、AI 兜底分类。**Node 24 + Express + React 19 + Vite 6 +
TS strict（`noUncheckedIndexedAccess`）+ vitest**；单机部署到群晖 NAS（Docker Compose）。

审查前请自己跑一遍（预期数字，对不上就是你环境的问题，不是我们的）：

```bash
npm run typecheck        # 3 个 tsconfig（server/web/tests），必须 0 错
npx vitest run           # 17 个文件 / 273 个用例全绿；测试**绝不产生真实网络与 AI 花费**
                         #（tests/setup.ts 清空 AI_*/MIMO_* 并拦截 AI 主机，见下）
npm run build            # dist/server + dist/web
node scripts/source-hash.mjs --check   # 内容源只读核验（见第 6 节怎么解读）
```

本地预览：`.local/start-preview.mjs` 起 4399 端口（**只从 `deploy/production/.env` 挑 `AI_*` 注入**——
整份注入会把 `SOURCE_ROOT` 指成容器内路径，把内容源指错；这条踩过）。

**建议的审查范围**（按提交时间倒序，最近 5 个提交 = 最近 5 个功能）：

| 提交 | 版本 | 内容 |
|---|---|---|
| `3d99fa2` | v0.15.0 | **双维度分类**：分类（主题）与来源分字段、两维可叠加筛选 |
| `9b2c72b` | v0.14.0 | **微信公众号接入**：第二种剪藏方言解析 + 前端改按 type 判定 |
| `998866c` | v0.13.2 | **部署提速**：预编译 dist 随包发 + 版本号归一进 VERSION |
| `05e012c` | v0.13.1 | 网页库缺封面卡片的占位瓷片 |
| `0c1cb9e` | v0.13.0 | B站封面/时长抓取 + 详情站内播放器 |

规模：`server` + `src` + `shared` + `tests` 共 54 个 TS 文件；最重的两个是
`server/services/library.ts`（约 1450 行，查询/计数/分类/导出/刷新的中枢）与
`server/reader/parse.ts`（约 940 行，四种库的解析）。

---

## 1. 必须先知道的不变量（不知道这些，几乎必然误判）

### 1.1 内容源（Obsidian vault）：默认只读 + **一条受控写通道**（v0.17 起更新）

- `server/config.ts` 启动即校验"任何写入目录不得落在内容源内"（`assertOutsideVault`），
 **写错了是启动失败**而不是运行时才炸。数据/备份/导出/日志四类目录在 vault 外的约束**原样保留**。
- **v0.17 用户拍板加了"编辑写回 vault"**：compose 的 `/source` 去掉 `:ro`，新增受控写通道
 （`PUT /api/notes/:id/content`，`library.ts` 的 saveNoteContent）。这不是守卫失守，是**显式授权的
 唯一例外**，有四条防线：① `VAULT_WRITE_ENABLED` 总开关（默认开，false/0/no/off 关）；
 ② 只接受**索引内 available 记录**的 `sourceRelativePath`，写前 `isInsideDir` 复核——不存在任意路径写，
 `.obsidian` 结构上不可达；③ 乐观并发：`baseHash`（文件 SHA-256）对不上即 409 `SOURCE_CHANGED`，
 **盘上一个字都不动**；④ 原子写（tmp+回读校验+rename）+ 写前原文备份到 `dataDir/edit-backups/`（vault 外）。
 审查这条通道时按"这四条防线是否都在"来评，不要按"为什么能写 vault"报缺陷。
- **仍然成立的产品口径**：凡是"需要回写**源站点**（小红书/B 站等）才算完成"的设计，默认是错的——
 写回只针对**用户自己的 Obsidian 库**，且只限标题与正文（frontmatter 其它字段、文件改名、图片都不碰；
 4/5 个库的笔记身份=文件路径，改名=换笔记）。
- 所有"用户数据"存在 `runtime/data/`（生产）/`.local/data`（开发）：`overrides.json`（分类覆盖）、
 `annotations.json`（标星/归档/备注）、`media-text.json`（OCR/转录）、`web-covers.*`（封面缓存）、
 `edit-backups/`（v0.17 编辑前原文备份，每篇留 5 份）。

### 1.2 索引 = 可重建缓存；资产 = 永不进索引

`library-index.json` 会因 `PARSE_VERSION` / 收藏库结构变化整体重建。**重建绝不能让 1.1 的资产失效**。
反过来说：**改分类覆盖/备注这类资产不会、也不应该触发重扫**。

### 1.3 `PARSE_VERSION` 铁律，以及它**故意不 bump** 的情形

- 改 `server/reader/parse.ts` 的**解析逻辑**必须 +1（现值 **7**），否则旧索引不重建、改了看不见。
- **但 v0.15 改了分类语义却没 bump，这是对的**：分类在 v0.15 起是**查询期**从
 `stored derivedCategory + overrides + initialAssignments` 算出来的，索引里存的字段一个都没变
 （来源值本来就在 `derivedCategory` 里，只是换了个字段露出）。
 **审稿人最容易在这条上报假阳性**："改了分类却没升级索引版本"——请先确认改的是**存储字段**还是**查询口径**。

### 1.4 一处一义（用户对命名极其敏感）

用户反复强调的规则："同一个意思不给两个名字"、"别多搞一个东西让我困惑"、"别让一个动作独占一行"、
"附加内容默认折叠且要有进度可见"。落到代码上：

- 维度只有两个名字：**分类**（= 用户说的"主题"，与小红书同一份类目表）与**来源**（域名派生）。
 不要发明第三种叫法（topic/主题/类目混用会被打回）。
- `归档` 只有一个语义（"现在对我没用了"），没有"已过期/已取消收藏"之分。
- 卡片角标**只允许一枚**（分类优先、回落来源）；详情头部的星标/归档/备注是同一控件组，不各占一行。

### 1.5 按 **type** 判定，不按 collection **id** 判定

v0.12 起前端把 `'web'` 这个 id 硬编码得到处都是，v0.14 加微信公众号时**整块失效**过一次，于是立了规矩：
**同类型可以有多个库**（`web` 与 `wechat` 都是 `type: 'web'`），凡是"要不要网页列/底片/封面探测/分类选择器"
都必须问 type。服务端 `LibraryService.isManagedCategory()`、前端 `collectionType()` 都是这条规矩的产物。
（当前实现里这条规则有**三处定义**，见第 5 节——那是我们自己承认的待收敛项。）

### 1.6 测试不花钱、不碰真网

`tests/setup.ts`：清空 `AI_*`/`MIMO_*` 环境变量 + 拦截 AI 主机域名。所有 AI/OCR/ASR 测试都用 stub fetch。
**审查时别以为"没有 AI 调用日志 = 没测到"**——恰恰相反，真调用会被 setup 拦下。

### 1.7 单飞 gate-until-commit（防重复扣费）

OCR / 语音转录 / 封面抓取都是"按次计费"或"有出网成本"的动作。并发时如果 gate 在**模型返回**就放开，
会出现"模型已返回、缓存还没落盘"的窗口 → 第二个请求又花钱。所以 gate 要等**磁盘提交后**才放开
 （`library.ts` 里 OCR/ASR 的 flights map、`web-cover.ts` 的串行 commit）。看着像过度设计，删了会真丢钱。

### 1.8 时间字段一律取 frontmatter **原文**，不取 yaml 解析值

`parse.ts` 的 `rawFmValue()`：js-yaml 把 `2026-09-29 11:26:17` 这种**不带时区**的时间戳当 UTC 解析，
而全站展示按上海固定 `+8`（`shared/time.ts` 的 `formatShanghai`/`SHANGHAI_OFFSET_MS`，容器 `TZ=Asia/Shanghai`）——
直接用 yaml 值会让剪藏时间显示晚 8 小时（**实测踩过，11:26 显示成 19:26**）。
所以"重复解析 frontmatter"是修 bug 的手段，不是冗余。

### 1.9 两种 BOM 方向相反的纪律（PowerShell 特有）

- `manifest.json`、`.dockerignore` **绝不能有 BOM**（PS5.1 的 `Set-Content -Encoding UTF8` 会写 BOM →
 `JSON.parse` 失败、`.dockerignore` 首行模式静默失效 → 18MB 截图照进构建上下文。已踩）。
- **`.ps1` 脚本本身必须保留 BOM**（PS5.1 无 BOM 会按系统 ANSI 解码，中文注释里的引号解错 →
 "字符串缺少终止符"。已踩）。
 **审稿人若"统一清理 BOM"会同时弄坏两边**。写文件一律用 `[IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。

---

## 2. 高概率误判清单（按模块）

> 格式：**现象 → 审稿人会怎么说 → 真相与证据**。这些都不是新发现。

### 解析（`server/reader/parse.ts`）

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| `parseWeb` 里按 `fm.url` 是不是 http 链接来分派两种方言 | "应该按 collection type 分派，散落的形状嗅探不可靠" | 有意：同款格式出现在别的目录也能解析（微信公众号方言的识别不依赖目录名）；Web Clipper 用 `source` 存链接、笔记同步助手用 `url`，形状是唯一可靠信号 |
| `parseSyncClip` 里 `rawFmValue` 又解析了一遍 frontmatter | "重复解析、维护两套" | 见 1.8，这是时区 bug 的修复 |
| 元信息块（公众号名称/作者名称/发布时间/原文链接）只从**摘录**剔除、正文保留 | "该整块删掉，详情头部已有这些字段" | `公众号名称`只出现在那里，删了就丢信息且搜不到（`searchText` 含正文） |
| 无 frontmatter 的手写笔记被收进网页库、归未分类 | "脏数据没过滤" | 用户明确要求（《宿命论部分总结》那篇） |
| Web Clipper 方言 `searchText` 截断 `content.slice(0,2000)`，微信方言却全文入索引 | "不一致，该统一" | 故意差异：剪藏多为短文，微信单篇 6~10KB，截断会让文章后半段搜不到（已实测"2400 字处的词能搜到"）。**统一与否是合理议题**，别当 bug |
| `categoryFromSource` 对非 URL 字符串返回 null，靠 `?? source` 兜底 | "来源不是 URL 时分类会错" | 兜底分支就是给"来源是展示名（微信公众号）"这种方言准备的，测试钉住了 |

### 分类与查询（`server/services/library.ts`）

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| `categoryId` 对 rednote/web 走 `categories.effective()`（override > initial），对 treasures/diary 却是 `derivedCategory` | "同一个字段两种语义，模型不一致" | 有意：`isManagedCategory(type)` 三态分派。宝贝/日记的分类来自 Obsidian 笔记本身，**不许**在网页里改（`setCategory` 对它们抛 ValidationError，测试也钉了这条） |
| v0.15 之后 `categorySource` 只在宝贝/日记是 `'derived'` | "派生分类失效了/回归" | 语义搬家：web 的派生值现在在 `sourceCategory`，`categorySource` 只描述**分类维**的来源 |
| 派生分类的 `id === name`（如 `{id:'哔哩哔哩', name:'哔哩哔哩'}`） | "缺一个规范 id" | 有意：语料的 id→name 解析（`corpus.ts` 的 `catNames.get(...)??.id` 回落）依赖这个相等性；引入真 id 会牵动语料格式与外部嵌入 |
| `CollectionInfo.sources` 只有 web 型有值，其余库恒空数组 | "忘了填" | 有意：来源维只存在于 web 型（1.4 的一维/二维之分） |
| 两维同时激活时 `scopeCount` 用查询返回的 `total` 而不是某个维度的计数 | "绕过口径，计数不可信" | 反过来：单维各自的计数在交集里就是**错的**（会和列表打架）；这是为"数字不许撒谎"专门改的 |
| `tagCounts` 的缓存键**不含**分类 revision | "分类改了标签计数不更新" | 标签计数不依赖分类（正交），加键只会白白失效——这条曾是真 bug 的反面（当年是漏了 `annotationRevision`） |
| 语料 `contentHash` 纳入 `categoryId/categoryName/sourceCategory` | "改分类就重算嵌入，浪费" | 有意：`corpus.ts` 文件头写明"改备注、改分类、正文变了，语义就变了，必须重算"，下游按 hash 判失效 |
| `libraryInfo()` 顶层的 `categories/uncategorized` 只按 rednote 算 | "顶层口径漏了新库" | 前端只用 `collections[]` 里的每库口径（注释里写了"兼容口径"）；顶层是历史字段 |

### 自动分类与 AI（`classify.ts` / `ai-classify.ts`）

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| 三层规则（人工表 > 标题关键词 > 标签关键词）**手写死在代码里** | "规则该配置化/从数据学" | 有意的单一事实来源：`scripts/classify.ts` 生成 seed 时**引用**这份规则（方向是规则→seed，不是 seed→规则）；配置化会引入校验与热更新成本，当前 238 行可读性更高 |
| `classifyRednote` 被改名 `classifyByRules` 但规则表仍叫 `TITLE_RULES` 里的 rednote 类目 | "命名没改干净" | 类目表是**全局共享**的（红书与网页同一份），见 1.4；`REDNOTE_CATEGORIES` 常量仍服务于 seed 生成器 |
| AI 系统提示动态生成（`buildSystemPrompt`） | "prompt 变了没有回归测试" | 有：`tests/classify.test.ts` 断言主题对象与每条类目说明都会进 prompt、且不含写死的"小红书" |
| AI 兜底"失败静默返回 null、不阻塞刷新" | "错误被吞" | 有意：分类是增值功能，网络/鉴权失败必须让刷新继续（有测试覆盖 401/网络错/非 JSON） |
| `ensureClassified` 只挑"无 override 且无 initial"的笔记 | "为什么人工改过的不再自动分类" | 这是硬纪律：**自动分类永不触碰人工覆盖**（注释与测试都钉了） |
| 预算 `AI_CLASSIFY_MAX_PER_REFRESH`（默认 40）两库共用 | "新库会抢走旧库预算" | 有意：15 篇新库笔记远在预算内；按次计费的上限优先级高于"每库独立配额"的洁癖 |

### 索引 / 资产 / 出网

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| `webCover` 三态：对象 / null / `undefined`，而 JSON 会丢 `undefined` | "undefined 序列化是 bug" | 这**正是表达机制**：键不存在=还没试过、null=试过没有（防反复探测）、对象=有 |
| 封面抓取失败进**负缓存 6 小时**不重试 | "失败不恢复，功能坏了都不知道" | 有意省出网与配额；6 小时后自然重试，成功路径秒回 |
| OCR/ASR/封面的 single-flight map | "并发控制过度" | 见 1.7（重复扣费） |
| `media-text.json`/`annotations.json` 不参与 `indexSig` | "重建索引后这些数据会丢" | 恰恰相反：它们是资产，重建索引**必须**让它们存活（plan.md §18.1/18.2 有专门说明） |
| 出网只有字面量私网拒绝（`publicHttpUrl`） | "SSRF 防护不完整" | **承认不完整**：DNS 重绑定的二次解析校验是已知未做项（第 4 节），不是这次漏的 |

### 前端（`src/`）

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| `.card-media img` 默认 `opacity: 0`，必须拿到 `.loaded` 类才淡入 | "新图片不显示是加载 bug" | 这是既有的淡入机制（v0.9 引入），**同一容器里的新元素必须继承它**——黑块踩过两次（v0.9.x、v0.13.0） |
| 卡片的星标落点判断用 `!hasMedia` 而不是 `!note.cover` | "note.cover 判断更直观" | 网页卡片现在**总有**底片，按 `!note.cover` 会渲染**两颗星**（v0.13.1 修过） |
| 缺图占位瓷片固定 4:3（`aspect-ratio`） | "为什么不按图片比例" | 固定尺寸是为了封面异步到达时**不跳版**（实测 11 张全 262×196 / 248×186） |
| 组视图（剪藏）隐藏分类/来源区 | "功能不完整" | v0.12 明确决策："分类是各子库自己的概念，子分类靠点子库进去看"。**下一期可能改**（见第 5 节） |
| 侧栏 `managedCategoryTypes`、服务端 `isManagedCategory`、App 的 `showCategoryPicker` **三处**同一个判定规则 | "违反 DRY，会漂移" | **这条报得对**（我们自己也列进了第 5 节），但请注意：客户端不能 import 服务端，正确修法是把函数下沉到 `shared/`，而不是随手删一处 |
| 前端**没有任何组件测试** | "UI 没有回归保障" | 有意的替代方案：typecheck + 273 单测 + **浏览器 DOM 量化验收**（量 `naturalWidth`/`opacity`/包围盒/计数，不看截图——"测量工具也会撒谎"是本项目的方法论）。合理议题：是否补组件测试（第 5 节） |
| `UNCATEGORIZED_ID` 常量定义了但全项目在用字面量 `'uncategorized'` | "死代码" | 是死代码，已知（第 4 节），改起来一行但一直没排上 |

### 部署与打包（`scripts/release.ps1` / `deploy/`）

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| 发布包里的 `package.json`/`package-lock.json` 版本被归一成 `0.0.0` | "打包损坏/版本信息丢了" | 关键设计：Dockerfile 第一行就是 `COPY package.json package-lock.json`，版本号一变**整条依赖层缓存失效**（历史 9 分钟构建的根因）。真实版本写进 `VERSION` 文件，`config.ts` 的 `readVersion()` 优先读它 → 健康门断言的仍是真版本。有次数断言（package.json 1 次、lock 2 次），防止把**每个依赖**的 version 覆盖掉 |
| `.dockerignore` 排除 `src`/`server`/`tests` | "镜像没法从源码构建" | 故意：v0.13.2 起**本地预编译 dist 随包发**（运行时依赖 5 个纯 JS 包、`target ES2022`、容器 node:22），NAS 只搬运不编译 |
| Dockerfile 里 `COPY VERSION` 放在依赖层**之后** | "顺序随意" | VERSION 每版都变；放后面只打掉本来就必变的 `COPY dist` 层，不动 `npm ci`/`apk` 缓存 |
| `.ps1` 带 BOM、manifest 不带 BOM（见 1.9） | "不一致，应统一" | 两条方向相反的纪律，都有事故记录 |
| `nas-update.sh` 用 `set -eu` 且健康门最长等 3 分钟 | "构建失败会不会把线上搞挂" | 不会：构建失败发生在 `docker compose up` **之前**（安全失败）；真正要防的是"健康门失败时新容器已经在跑"，所以有 `nas-rollback.sh`（只切回已存在的镜像 tag，不重建） |

### 安全与凭据

| 现象 | 可能的误判 | 真相 |
|---|---|---|
| 仓库里没有 NAS 密码 / AI key / GitHub PAT | "凭据缺失，跑不起来" | **刻意**：NAS 密码只在 gitignored 的 `deploy/production/.env` 与记忆里；AI key 只在 gitignored `.env`；PAT 只在 Windows 凭据管理器（曾出现在聊天记录，已建议轮换）。审查报告里也**不要**索要或回填这些值 |
| 生产挂载已去 `:ro`（v0.17）+ 启动写入守卫 | "守卫失守/可以顺手放开其它写入" | 1.1 的产品决策：写回是**显式授权的唯一例外**，四条防线见 1.1；数据/导出/备份/日志目录在 vault 外的约束**没有变**，那些仍然不许动 |
| 局域网访问无鉴权 | "严重安全问题" | **已知且接受**（家庭 NAS、单机使用的设计假设），已记录在案；若你认为风险升级，请给论证而不是直接判 P0 |

---

## 3. 已知但**故意留着**的（第 4 节之前先看，别当新发现报）

1. **没有文件监听/Obsidian 自动同步**：改动靠用户点「刷新收藏库」（增量 mtime/size 快路径）。刚与用户讨论过：
 他有 FastNote 多端同步，**是否加"编辑写回 vault"还在待定**。
2. **vault 根目录的文件不属于任何收藏库**（五个库的 root 都在其下，如根上的 `2026-09-29.md`）——扫不到是当前语义，已知。
3. **DNS 重绑定型 SSRF** 二次解析校验未做（字面量私网拒绝已做）。
4. **封面不定期刷新**（B站换封面不会跟进；负缓存 6h）。
5. **组视图不聚合分类/来源**（v0.12 决策；三库共用类目表后语义已成立，**等用户点头做下一期**）。
6. **局域网无鉴权**（设计假设）。
7. **视频转录未做**（405 篇远程视频可下载；音频 m4a 转录已在 v0.11 做完）。
8. **`UNCATEGORIZED_ID` 死常量**（各处用字面量 `'uncategorized'`）。
9. **快路径只看 mtime+size**：同 mtime 同 size 的内容变化会漏（实际几乎不可能，文件系统都会变 mtime）。
10. **前端无组件测试**（替代方案见上表）。
11. **两个方言的 `searchText` 范围不一致**（2000 字 vs 全文）——合理议题，未定。

---

## 4. 我们**最想听**的真问题（欢迎往这些方向审）

1. **三处"managed 分类"判定的收敛**：`library.ts:isManagedCategory` / `Sidebar:managedCategoryTypes` /
 `App:showCategoryPicker` 内联表达式。建议下沉成 `shared/` 的一个导出函数，两端共用——如果你有更稳的做法
 （或认为客户端判定不该和服务端同源），说来听。
2. **`library.ts` 体量**（1450 行）：查询/计数/分类/导出/刷新都在一个类里，是不是该拆？
 拆分要保住三件事：计数口径统一到 `inWorkSet`、每库分支集中在少数几处、测试不跟着大改。
3. **刷新链路的耦合**：`doScan → 索引持久化 → autoClassify → 语料导出`。已知坑：**改了解析但
 PARSE_VERSION 已经在同一次改动里 bump 过**时，第二次修复不会触发重建（要手动删索引）。
 有没有更稳的失效机制？
4. **前端测试策略**：现在的浏览器 DOM 量化验收是一次性的（人跑）。值得投入组件测试吗？哪一层？
5. **组视图的分类语义**：现在隐藏，聚合时红书的 override 与网页的 override 要怎么合、"来源"在组里
 显不显示——这块设计还是空白。
6. **时间处理的统一**：`normalizeDate` / `rawFmValue` / `formatShanghai` 三件套 + 硬编码 +8。
 换时区的用户会怎样？（当前用户在中国，容器 `TZ=Asia/Shanghai`，但代码里是散落的假设。）
7. **语料 schema 演进**：`schemaVersion`、`CORPUS_SCHEMA_VERSION`、`sourceCategory` 新增字段与
 外部嵌入管道的兼容性——下游（另一个 agent 的项目）怎么知道要重算？
8. 任何**真的**正确性 bug：并发丢更新、计数口径不一致、只读不变量被绕过、测试假绿。

**测试假绿的历史**（审查时特别欢迎"这条测试其实测不到"）：本项目修过多次——
`分类默认值测试走 loadConfig 导致默认值分支从未执行`、`OCR 单飞在模型返回就放开导致重复扣费`、
`0 字节媒体测试没挂媒体路由`、`AI 上限测试用相同字节导致缓存命中假绿`。
**新断言必须在旧代码上先红过**（例：时区那条用 `formatShanghai` 断言钟点，旧代码上是 19:23 ≠ 11:23）。

---

## 5. 关键文件地图（想审哪块看哪）

| 关注点 | 文件 |
|---|---|
| 查询/计数/分类口径/刷新/导出 | `server/services/library.ts`（`query` / `collectionInfo` / `toSummary` / `autoClassify` / `setCategory` / `corpusCategoryOf`） |
| 四种库的解析与两种剪藏方言 | `server/reader/parse.ts`（`parseRednote` / `parseTreasures` / `parseDiary` / `parseWeb` / `parseSyncClip` / `rawFmValue` / `categoryFromSource`） |
| 分类存储与覆盖 | `server/services/categories.ts`（`effective` / `setOverride` / `ensureClassified`） |
| 规则与 AI | `server/services/classify.ts`、`server/services/ai-classify.ts` |
| 语料 | `server/services/corpus.ts`（`computeContentHash` 语义关键） |
| 出网抓取（封面） | `server/services/web-cover.ts`（SSRF 守卫、负缓存、单飞） |
| 配置与启动守卫 | `server/config.ts`（`readVersion` / `validateGroups` / `assertOutsideVault`） |
| 双维度的前端面 | `src/App.tsx`（QueryState/source/标题/计数）、`src/components/Sidebar.tsx`（两段）、`Table.tsx`（两列）、`NoteCard.tsx`（角标/占位）、`DetailDialog.tsx`（选择器+来源胶囊） |
| 部署 | `scripts/release.ps1`、`deploy/Dockerfile`、`deploy/nas-update.sh`、`docs/deploy-handoff.md`、`docs/deploy-pitfalls.md` |
| 设计与验收记录 | `plan.md`（§18.x 各功能的设计与状态）、`docs/verification.md`（每个版本的实测记录与踩坑） |

---

## 6. 验证纪律（审查结论请按这个标准给证据）

1. **可证伪优先**：新断言必须能描述"在旧代码上它为什么会红"。给不出就不是回归测试。
2. **量，不看**：浏览器验收量化 DOM（`naturalWidth > 0`、`getComputedStyle(img).opacity`、
 包围盒尺寸、匹配计数、console 错误数=0），截图只作辅助——本项目明确记录过"测量工具也会撒谎"，
 请同样对待你的直觉判断：**贴出你复现的命令与输出**。
3. **只读不变量用哈希证明**：`node scripts/source-hash.mjs --check` 的
 `added/changed/removed` 要**分类解读**再下结论——`added` 大概率是用户自己新增的笔记，
 `changed` 常见的是 Obsidian 自己重算的索引文件；**v0.17 起"应用侧写入"有第三种合法来源：
 用户在拾藏里做的编辑写回**（每笔都会在 `dataDir/edit-backups/` 留原文备份），任何"应用写入源"的
 指控请先排除这三类。
4. **数字要对**：`typecheck 0 错 / 293 tests / 18 files` 是当前基线，
 报告里引用数字请注明是在哪个环境跑出来的。
5. **别改凭据来"让它跑起来"**（安全表）；也别把写回通道的防线（1.1 四条）当成可以顺手简化的东西。
6. **部署要用户明确下令**（本项目历史上多次"不要改完就部署"；最新政策是"验证通过即可部署"，
 但审查阶段**不要**触发任何部署或 `release.ps1` 之外的写操作）。

---

## 7. 交付形式建议（给我们最好用的报告）

- 按 **P0 正确性 / P1 设计风险 / P2 一致性与命名 / P3 清理** 分级，每条给：文件符号名 + 复现命令或断言 +
 为什么它是问题（对照第 1 节的不变量说明它没有违反哪条）。
- 第 2 节表格里已经解释过的写法，请**不要**重复报；如果你认为某个"刻意决定"本身就是错的，
  请直接挑战那个决定（附代价与替代方案），这比报成 bug 有用得多。
- 第 3 节的已知项请标注"已知"，除非你发现了它们**比记录更严重**的新证据。
