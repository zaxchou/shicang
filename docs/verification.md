# 验收记录（verification）

日期：2026-09-27。执行环境：Windows 11（win32 10.0.26200）、Git Bash、Node v24.18.0、npm 11.16.0；内容源 `Z:\BaiduNetdiskWorkspace\mynote\mynote\RedNote`（Baidu 同步盘，项目与源同盘）。每条记录标注「通过 / 失败 / 未验证」，未验证不冒充通过。

## 运行环境与依赖

- Node ≥ 22（engines 声明）；开发实际使用 v24.18.0。
- 关键依赖（lockfile 锁定）：express 4.22.3、gray-matter 4.0.3、marked 15.0.12、sanitize-html 2.17.7、zod 3.25.76、vite 6.4.3、vitest 3.2.7、react 18.3.1、typescript 5.9.3。
- 启动方式：生产 `node dist/server/index.js`（环境变量见 deploy/compose.yaml）；开发 `start.cmd` / `scripts/start.ps1`（127.0.0.1:4317，独立 `.local/data`）。

## 首批数据

- Bookmarks 598 篇全部解析入库：scanned=598 added=598 errors=0；598 个 resourceId 唯一、无重复。
- 每篇笔记均有 H1 标题、至少一张本地图片；本地媒体 1,980 张 WebP 全部登记且全部读取到宽高（封面无缺失尺寸）。
- 402 篇包含远程 `<video>` 引用（sns-bak-v1 / sns-bak-v6.xhscdn.com，HTTP 协议）；当前库内无本地视频文件。
- 字段统计与计划一致：likedCount 591 / shareCount 589 / commentCount 574 / tags 541，缺失字段以 null 入库不影响展示。

## 首批分类

- 6 大类：书画 272 / AI 与编程 107 / 设计与 AIGC 55 / 语言与学习 53 / 生活 70 / 3D 打印与数码 41，合计 598，全覆盖无重复、无非法类别 ID。
- 执行方式与边界判定见 `docs/category-taxonomy.md`；逐条理由存于 `data-seed/categories-seed.json` 的 rationale 字段。
- 全量 598 条规则输出经逐条人工审查，29 条人工复核修正（含 23 条规则未命中 + 6 处规则误判，清单在 `scripts/classify.mjs` 的 MANUAL 段）。

## 自动化测试（vitest，35 个用例全部通过）

覆盖：frontmatter/正文解析（BOM、CRLF、缺日期、缺 tags、坏 YAML、缺 resourceId、H1 回退）；媒体路径（vault 前缀映射、中文与空格文件名、目录穿越拒绝、源外嵌入拒绝、缺失媒体标记不可用）；XSS 消毒（script/javascript: 链接）；WebP 尺寸解析；上海时区边界（UTC 跨午夜、不存在日期如 6/31、最近 7 天自然日、自定义区间）；JsonStore（回读、损坏后备份恢复且保留损坏文件、校验失败不覆盖、串行写入、备份保留上限）；幂等刷新（二扫新增 0、新增一篇只出现一次、文件变更更新、消失标记 missing、重启保留）；重复 resourceId 冲突保留先入记录；查询（多词 AND、覆盖标题/正文/作者/tags、desc/asc 排序、null 恒排末尾、同时间按 id 稳定、上海日历日过滤、同步时间过滤独立于排序、分页）；分类优先级（initial → override → 刷新 → 重启全部保留、人工置 null 不被 seed 恢复、expectedRevision 冲突、非法类别拒绝、刷新期间改分类两项结果都保留、未分类计数）。

## 浏览器实测（Chromium via Playwright，1280×800 / 1440×900 / 1920×900）

- 2026-09-27 用户反馈后卡片改为「无框缩略图 + 标题 + 作者 + 分类标签」样式（用户参考图），瀑布流列距 16px / 行距 22px，卡片自然比例限高 520px；日期与摘要移出卡片（详情中仍可见）。
- 新增动效：详情弹层开合（缩放+淡入淡出，关闭时先播退出动画再卸载并暂停视频）、卡片入场 stagger（每批新卡片依次浮现，筛选切换重播）、图片加载淡入、悬停图片轻微放大+投影、按钮按压反馈、瀑布流窗口变宽度平滑重排；全部尊重 `prefers-reduced-motion`。
- 2026-09-27 二轮反馈后新增：①亮色主题 + 亮/深/跟随系统三档切换（localStorage 持久化、首帧内联脚本防闪烁、跟随系统实时响应 matchMedia 变化，全站颜色收敛为 CSS 变量）；②标签总览页（侧栏「发现 → 标签」，`GET /api/tags` 返回 872 个标签按热度排序，点标签以 `tag` 参数过滤内容并与搜索/时间筛选叠加，标题栏带返回按钮）。标签过滤与计数有自动化测试覆盖。
- 首页三尺寸截图对照参考图检查通过：`docs/screenshots/home-1280.png`、`home-1440.png`、`home-1920.png`；1440 宽 4 列、1920 宽 6 列，无横向溢出、无控件截断。亮色首页与标签页见 `home-light-1440.png`、`tags-light-1440.png`。
- 分类筛选「书画」：标题与计数变为 272，结果全部为书画内容（`shuhua-1440.png`）；侧栏计数为全库口径、主区计数为筛选结果口径。
- 详情弹层（`detail-1440.png`）：遮罩居中、作者栏、查看原文、分类选择、发布/同步时间（上海时区）正确；Esc 关闭；关闭后焦点回到原卡片。
- 分类修改：详情内改「书画 → 生活」成功，`overrides.json` 落盘（revision 递增），侧栏计数即时更新（书画 271 / 生活 71），随后改回验证双向可用。
- 搜索：书画内搜「千里江山」精确返回 1 篇，与分类条件交集正确；清除筛选可一键重置。
- 刷新：点击刷新按钮 → 完成提示「新增 0 篇」（幂等），列表与计数保留；请求进行中按钮禁用防重复提交。
- 视频笔记：详情内 `<video controls poster=本地封面>` 元素正常，远程源 readyState=4、videoWidth=1280（可解析加载）；关闭详情即卸载播放器。
- 图片懒加载：卡片 `loading="lazy"`，瀑布流按 ResizeObserver 实测高度布局，滚动无跳动、无重叠。

## 只读边界验证

- 开发开始前对源目录 2,578 个文件（598 md + 1,980 webp + base 文件）生成 SHA-256 清单（`.local/source-hash.json`）；全部开发与测试结束后复查：added=0 / removed=0 / changed=0，**应用未写入源目录**。
- 自动化测试一律使用 `os.tmpdir()` 夹具，未向源目录写任何文件（早期测试脚本临时目录泄漏问题已修复并清理，发布包重建确认干净）。

## 分类体系重新整理（2026-09-28，v0.3.0）

- 触发：用户反馈分类混乱（AI/设计/生活混杂），要求按内容重新整理。
- 方式：`scripts/classify.mjs` 三层规则（人工表 20 条 > 标题命中 > 标签命中，六类固定顺序）+ 全量 598 行人工复核，共 4 轮迭代修正 30+ 处误判（单字「松/竹/狗」误伤、壁纸被「手机」抢走、博士/Claude 与学习类冲突、AI 视觉玩法被书画抢走等，逐条记录于 taxonomy 文档）。
- 结果：书画 269 / AI 工具 105 / 设计与创作 65 / 生活 69 / 学习语言 49 / 数码硬件 41 = 598，全覆盖、无重复、无非法 ID；每条带命中理由（seed rationale）。
- 数据迁移：**分类 seed 仅在未初始化的库导入**，故对本地 `.local/data` 与 NAS `runtime/data` 删除 `categories.json`（旧分类文件已备份为 categories.json.bak-old）与测试遗留 `overrides.json`，重启后由 `data-seed/categories-seed.json` 重新导入；索引与媒体不动，扫描 skipped=598 无需重读。
- 自动化测试 36/36 通过；本地与 NAS 计数经 /api/library 核对一致。

## 多收藏库（2026-09-28，v0.4.0）

- 新增两个内容源：`我的收藏品`（336 条，8 个「我的收藏-*」分类文件夹，CSV 导入的结构化字段）与 `flomo`（272 条日记/闪念，frontmatter 含 created_at/tags，附件在 attachments/YYYY/MM/DD）。
- 架构：配置驱动 `collections[]`；SOURCE_ROOT 改为 vault 根、容器挂载 `/source`（一次挂载三库）；索引含 collections 指纹，结构变化自动作废重建；总入库 1206 篇（598+336+272），扫描零错误。
- 解析器三类型：rednote（原逻辑回归）、treasures（封面图字段/本地相对与 vault 相对图片/表格 extra 字段/日期型 YAML 归一）、diary（标题=日期+摘要、附件图片转内联、音频走媒体路由）。
- 前端：侧栏收藏库切换；每库记忆瀑布流/列表偏好；DataTable 动态列+表头排序（价格数值、日期、标签）；详情弹层对宝贝显示字段网格、其它库分类只读。
- 修复过程：YAML 日期字段被 extra 过滤（购买时间 166 条丢失）→ 归一化 ISO；marked 对中文 URL 百分号编码导致 media:// 匹配失败、正文图片空 src → 解码后回查；文件夹回退仅认「我的收藏-*」避免垃圾分类。
- 自动化测试 43/43（新增多源解析与三库集成 7 例）；浏览器实测三库瀑布流/表格/详情均正常。

## Soft Glass 改版与性能修复（2026-09-28，v0.5.0）

触发：用户反馈两点——① 加了 Glass 之后不如之前流畅；② 玻璃观感与参考图（UWORK 一类
"近白面板 + 柔和光影 + 大留白"）差距大，装饰过多。用户要求把方法固化成 skill。

### 性能：先定位再改

同一份页面（1600×1000，Chromium）用浏览器内探针实测，改版前：

| 场景 | p50 | >32ms 帧数 |
| --- | --- | --- |
| 只滚动 | 8.7ms | 0 / 135 |
| 滚动 + 指针移动 | **32.8ms** | **73 / 135** |
| 静止 + 指针移动 | 25.4ms | 16 / 85 |

只滚动是快的，一动指针就崩 → 瓶颈不是玻璃本身，而是**跟随指针的高光**：
每帧给 `:root` 写 CSS 变量，高光层用 `background-attachment: fixed`
（背景绘制依赖滚动位置、无法合成，变量一变就大范围重绘）。

逐项 A/B（360 张卡片、同一 DOM、交错多轮）确认每个结论：

| 变体 | p50 |
| --- | --- |
| 基线 | 23.0 / 22.5ms |
| 瀑布流条目 `will-change: transform` | **8.1 / 8.1ms** |
| 只提升图片容器 `.card-media` | 21.2 / 21.1ms（无效） |
| `contain: layout paint style` | 6.7 / 33.6 / 21.6ms（不可复现，单次采样不可信） |
| `content-visibility: auto` | 12.5 / 12.4ms |
| 关掉主面板 `backdrop-filter` | 23.5ms（**无帮助**，证明"玻璃=卡"是误判） |

改动：删除指针跟随高光与 `background-attachment: fixed`；背景层去掉 `filter: blur(48/56px)`
改画 `radial-gradient` + 极慢 `translate3d`；`backdrop-filter` 从 242 处收敛到 2 处
（弹层打开时 4 处，含遮罩），半径 28px → 18px；恢复瀑布流条目的 `will-change: transform`；
用 CSS 胶囊替换 liquid-glass-react（其 SVG 位移滤镜会在 `mousemove` 里重建并触发重渲染），
依赖一并移除，产物 318KB → 264KB。

改版后（240 张卡片、`mode:'both'`）：

| 场景 | p50 | p90 | 最大 | >32ms |
| --- | --- | --- | --- | --- |
| 亮色 滚动 + 指针 | 4.2ms | 4.7ms | 9.0ms | 0 |
| 暗色 滚动 + 指针 | 4.2ms | 14.9ms | 29.0ms | 0 |
| 360 张卡片 滚动 + 指针 | 9.1ms | 11.6ms | 22.1ms | 0 |

### 观感：三层表面 + 柔和光影，取消描边

重写 `tokens.css` / `app.css`：表面收敛为浮起 / 平面 / 凹陷（+ 浅凹陷）四种；
按钮、胶囊、输入框、卡片一律去掉边框，靠投影与内阴影表达高低；加大留白
（外边距 12→18px、面板间距 10→14px、行距 22→28px、行内边距加深）；
`--glass-edge`（玻璃受光边，白）与 `--hairline`（内容分隔线，跟主题走）拆开
——此前混用导致亮色表格行线消失（白色压白色），由扫描线发现；
删除 6 个无用 token，token 定义与引用现已完全对齐。

复核脚本发现并修复：亮色主题 `--text-weak` 在浮起胶囊/浅凹陷块上对比度不足
（3.42 / 4.38 < 4.5）→ 调深至 `#656872`。

### 验收（4 视图 × 2 主题，全部通过）

| 视图 | 亮色对比度失败 | 暗色对比度失败 | 越界 / 重叠 |
| --- | --- | --- | --- |
| 瀑布流（小红书） | 0 | 0 | 0 / 0 |
| 列表（我的宝贝，21 列） | 0 | 0 | 0 / 0 |
| 详情弹层 | 0 | 0 | 0 / 0 |
| 标签目录 | 0 | 0 | 0 / 0 |

明度台阶（`__uiAudit` 合成色）：亮色 页面 `#edeff4` → 面板 `#f7f8fa`（差 0.073）；
暗色 页面 `#090a0e` → 面板 `#1f202b`（差 0.012）；浮起 / 凹陷相对面板各差 0.02 / 0.01 上下。

光影确实存在（`scanline.cjs` 明度扫描线）：亮色侧栏 243 → 面板间隙阴影带 218–222 →
玻璃亮边 253 → 主面板 247；凹陷搜索框 面板 248 → 框内 233；
分段控件 凹槽 234 → 选中白胶囊 255 → 面板 248。

### 验收方式的说明（重要）

本次改版期间，图像读取在本环境不可靠：让子代理读两张纯色图（文件名与实际颜色故意相反），
一张读对、一张把纯绿读成蓝色。因此**没有采用"肉眼看截图"作为验收依据**，
改为全部数字化：合成色审计、WCAG 对比度计算、亮度字符视图（`pngview.cjs`）、
明度扫描线（`scanline.cjs`）、几何越界/重叠检查。
上面所有数字均可复现；观感层面的最终判断仍以用户实际浏览为准。

### 方法固化

skill：`~/.agents/skills/soft-glass-ui/`（`SKILL.md` + `references/tokens.css`
+ `references/design-rules.md` + 三个探针脚本），项目内说明见 `docs/design-language.md`。

## NAS 实际部署（2026-09-27 已完成，此前为未验证项）

- 环境（现场核实）：DSM 7.3.1、x86_64、docker 位于 `/usr/local/bin`（需 sudo + 显式 PATH）、Compose v2.20.1；项目与源库路径 `/volume2/Media/BaiduNetdiskWorkspace/...`；端口 4317 空闲；共享目录属主 uid=1026/gid=100。
- 部署结果：镜像 `myinfobase:0.1.3`（NAS 上构建，容器内 npm ci + 全量构建成功）；容器 `myinfobase` 运行中，`0.0.0.0:4317->4317`；`restart: unless-stopped` + healthcheck。
- 验证：NAS 本机 health `{"ready":true,"version":"0.1.3"}`；**局域网**（Windows → 192.168.31.246:4317）首页 598 篇、六个分类计数与本地一致、媒体 200 image/webp、浏览器整页截图（`nas-deployed-1440.png`）正常。
- 持久化验证：LAN 上 PATCH 分类 → `runtime/data/overrides.json` 落盘；`docker restart` 后计数与覆盖保留、未重复导入 seed（NO-RESEED）。测试数据已复原（该笔记 override 恢复为 seed 的 life）。
- 首次扫描记录：scanned=598 added=598 errors=0（与本地一致）。
- 更新/回滚入口：`deploy/nas-update.sh`（构建+换 tag+重建+健康检查+版本校验）、`deploy/nas-rollback.sh`（本地镜像秒级切回）；旧 `update.sh`/`rollback.sh`（releases/current 方案）已废弃删除。SSH 助手 `scripts/nas-deploy.mjs`（凭据走环境变量）。
- 未验证项更新：~~NAS 实际部署~~ 已验证；~~容器重启恢复~~ 已验证；**整机断电重启恢复**仍未实测（restart 策略与 Docker 开机自启待观察一次真实重启）；NAS 文件系统 rename/replace 行为未单独验证（应用有 copy+replace 回退）。

## Apple 风格改版与版本管理（2026-09-28，v0.2.0/0.2.1）

- UI 改为 Apple Liquid Glass 风格：环境光色斑背景 + 全站玻璃表面（backdrop-filter blur/saturate、高光描边、大圆角）、SF Symbols 风格图标全套重绘、三档主题保留。
- liquid-glass-react（要求 React ≥19，已升级 React 19.3）用于暗色主题「刷新收藏库」按钮：fixed 槽位 + `.liquid-slot` 绝对定位修正其层定位，Tailwind 工具类以 12 行垫片补齐（relative/opacity-0/pointer-events-none 等）；亮色下该库折射层偏暗，回退手写玻璃胶囊——两主题均经浏览器截图验证。
- 命名「拾藏」：SVG 图标（渐变圆角方块 + 白色「拾」字）渲染为 icon.svg / icon-1024 / apple-touch-icon(180) / icon-32，接入 favicon 与侧栏品牌位。
- v0.2.1 修复 Dockerfile 缺 `COPY public` 导致 NAS 容器图标 404；已部署验证 `GET /icon.svg → 200 image/svg+xml`。
- GitHub 版本管理：仓库 https://github.com/zaxchou/shicang，main 分支首次提交 8cc0c35（v0.2.1 tag）；`.gitignore` 排除 node_modules/dist/.local/runtime/logs/releases/shots/deploy-production；本地 `core.autocrlf=false` 防止 .sh 变 CRLF 后在 NAS 执行失败。

## 已知限制（如实说明）

1. **远程视频可用性未全量保证**：402 篇视频均为小红书 CDN 的 HTTP 直链，实测样本可加载；防盗链、链接失效或网络策略都可能导致个别不可播，届时详情页显示「视频暂时无法播放」与原文入口。未实现下载/转码/登录（按计划范围排除）。
2. **NAS 部署参数待现场核实**：DSM/套件版本、CPU 架构、RedNote 在 NAS 上的本机路径、端口占用均需在部署时确认；`deploy/.env.example` 中路径为占位示例。NAS 上的首次部署、容器重启恢复、整机开机恢复为**未验证**（需要实际 NAS 操作窗口），部署步骤与回滚脚本已按 Container Manager Project 流程准备。
3. **NAS rename/replace 行为**：JsonStore 在 rename 失败时自动退化为 copy+replace，本地 Windows 实测通过；NAS 文件系统上的行为将在首次部署时验证。
4. **搜索为子串匹配**：中文按包含匹配，无语义检索或拼音模糊匹配（首版范围）。
5. **瀑布流视觉顺序**：DOM 与数据严格按发布时间排序，交错的瀑布流布局不保证同屏视觉行序完全等同时间序（计划已声明）。
6. 每篇详情的正文为服务端消毒后的 HTML；原始 wiki 嵌入路径已规范化，源外引用显示为不支持。

## 证据清单

- 截图：`docs/screenshots/`（softglass-light-masonry / softglass-dark-masonry / softglass-light-table / softglass-dark-detail 为 v0.5.0；早期 home-1280 / home-1440 / home-1920 / shuhua-1440 / detail-1440 为 v0.1.0）。
- 测试：`npm test` 43/43 通过（vitest；日志见会话记录）。
- 源哈希清单：`.local/source-hash.json`（基线与复查一致）。
- 发布包：`releases/0.1.0/`（59 个文件，含 manifest.json 与逐文件 SHA-256）。
- 分类 seed：`data-seed/categories-seed.json`；人工覆盖：`<DATA_DIR>/overrides.json`。
