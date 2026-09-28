# 验收记录（verification）

日期：2026-09-27。执行环境：Windows 11（win32 10.0.26200）、Git Bash、Node v24.18.0、npm 11.16.0；内容源 `Z:\BaiduNetdiskWorkspace\mynote\mynote`（vault 根，含 RedNote / 我的收藏品 / flomo；Baidu 同步盘，项目与源同盘）。每条记录标注「通过 / 失败 / 未验证」，未验证不冒充通过。

## 运行环境与依赖

- Node ≥ 22（engines 声明）；开发实际使用 v24.18.0。
- 关键依赖（lockfile 锁定）：express 4.22.3、gray-matter 4.0.3、marked 15.0.12、sanitize-html 2.17.7、zod 3.25.76、vite 6.4.3、vitest 3.2.7、react 19.3.0、typescript 5.9.3。
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

## 自动化测试（vitest；本节为首批 35 个用例，当前 102 个——见文末「全项目深度审查」）

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

## 收藏库解析修复（2026-09-28，v0.5.1）

触发：用户报告「我的宝贝 / 无辨色」详情内页图片全部不显示（缩略图正常）。排查后发现是
 treasures 库的一组解析问题，共修四类，并顺带修了用户指出的 MOC 笔记分类与标题问题。

### 1) 正文图片不显示（根因：文件名带空格）

`![[Pasted image 20260426145213.png]]` 这类嵌入被改写成 markdown 图片
`![图](media://Pasted image ….png)`——**媒体 id 里有空格**，marked 把链接目标在空格处截断，
后续 `media://` 回查查不到，图片被整体丢弃；而缩略图走的是 `cover.url`（不经 markdown），
所以"缩略图正常、内页全空"，与用户观察一致。修复：媒体 id 写入 markdown 时按
`encodeURIComponent`（外加 `!'()*`）编码，`renderBody` 回查时解码。同样修复了 md 语法
`![图](Attachments/image 1.png)` 目标带空格时直接不匹配的问题（原正则 `[^)\s]+` 在空格截断）。
此前 parse.test.ts 的「中文与空格文件名」用例只断言"登记了媒体"，没断言"渲染出 <img>"，
所以一直没抓到——已补断言。附带收益：重名后缀 `#2`（`#` 不编码会被当 fragment）与
文件名含括号的情况一并修复。

### 2) 封面路径解析基准不全

frontmatter 的 `封面图: 我的收藏-书法/Attachments/xxx/….jpg` 是**相对收藏库根**的路径，
而 `resolveLocal` 只试「笔记目录」与「vault 根」两个基准 → 318 篇里 301 篇解析失败，
静默回退到"正文第一张图"（所以看起来正常，其实大多不是用户指定的封面）。
修复：解析基准改为「笔记目录 → 笔记父目录 → 收藏库根 → vault 根」逐级尝试。
另：同一文件被正文和封面重复引用时复用同一条媒体（消除 `xxx.png#2` 冗余条目）；
HEIC/HEIF/TIFF 浏览器无法显示，不再选作封面（改用正文首图，正文里保留原文并给加载失败提示）；
`/api/media` 补 `.svg` 的 MIME（39 篇的统一占位封面是 SVG，此前按二进制下发导致 `<img>` 不渲染），
并对 SVG 响应加 `Content-Security-Policy: sandbox` 禁脚本。

### 3) MOC 笔记进了「未分类」、标题显示成 MOC（用户指出）

`我的收藏-书法/豪翰斋/MOC.md` 这类笔记在**分类文件夹的子目录**里，原分类推导只看直接父目录
→ 归不进分类；且无 frontmatter，标题回退到文件名 → 显示成 "MOC"。修复：
① 分类改按路径段推导（路径里任意一段是 `我的收藏-X` 即归入 X）；
② 标题改为「CSV标题 > 正文 H1 > 文件名」（限 60 字），4 篇 MOC 现在显示
豪翰斋 / 苏孝慈墓志铭 / 大红袍+水平+1200，且归入正确分类。
说明：库里本来就同时存在 `豪翰斋.md`（CSV 条目）与 `豪翰斋/MOC.md`（手写笔记）两个文件，
现在两者都以真实标题出现，属数据本身的结构，未做合并。

### 4) 索引/总览页混进藏品库

`我的收藏品-首页.md`（笔记类型=收藏总索引）、3 个「收藏多维索引」、空的`未命名页面.md`
此前都进了库（旧的 `-索引\.md$` 排除规则匹配不到它们）。修复：解析器按 vault 自带的
`笔记类型` 字段识别 `收藏索引 / 收藏多维索引 / 收藏总索引`，与空笔记一起**有意跳过**
（`ParseOutcome.skippedReason`，扫描计为 skipped 而非 error；若之前在库里则移除）。

### 索引失效机制（本次新加）

解析结果缓存在 `library-index.json`，扫描按 mtime/size 跳过未变更文件——**解析逻辑修好了，
用户看到的却还是旧索引**。故给索引加入指纹：`收藏库结构 + PARSE_VERSION`，任一变化即整体重建；
`PARSE_VERSION` 常量注释写明"改解析逻辑必须 +1"。本次上线即自动重建（诊断里可见
「收藏库结构或解析器版本已变化，索引作废并重建」）。

### 验收（真实 vault 全量解析 + HTTP + 浏览器）

- 全量 341 篇 treasures 逐篇解析：正文残留 markdown 0 篇（修复前 18 篇）；标题仍为 MOC/未命名 0 篇。
- 条目 336 → 331（移除 1 首页 + 3 多维索引 + 1 空笔记）；未分类 9 → 1（只剩真·未分类的 `最近买纸.md`）；
  分类计数 茶器 111 / 拓片 104 / 书法 40 / 篆刻 35（各 +1，来自 MOC 归类）。
- 无辨色详情：6 张图全部 `naturalWidth>0` 且实际渲染；无 `media://` 残留、无残留 markdown 文本。
- `/api/media/.../Pasted image ….png` → 200 image/png（约 2.5MB）；默认封面 SVG → 200 image/svg+xml。
- 意翠 封面从 HEIC 改为可显示的 image.png。
- 自动化测试 45/45（新增：空格路径必须真正渲染、子目录 MOC 归类与 H1 标题、索引页/空笔记跳过）。

## 刷新自动分类 + AI 兜底（2026-09-28，v0.5.2）

触发：用户在 Obsidian 新增 8 篇小红书笔记，要求**不借助外部 Agent**，只点网页上的
「刷新收藏库」就完成导入与分类（"以后再加笔记前端就能直接做到"）。

### 基线测试（先证实缺口）

启动 v0.5.1，调用前端按钮同款接口 `POST /api/refresh`：

- 导入侧完好：`scanned=8 added=8 skipped=1206 errors=0`（增量只解析新文件，约 5 秒），总数 598 → 606。
- **但 8 篇全部落「未分类」**——v0.3.0 的分类器只是离线脚本（生成 seed），seed 又只在
  分类库未初始化时导入一次，服务端刷新管道从未对新笔记套用规则。用户的预期正是缺失的一环。

### 实现

1. **规则移植进服务端**（`server/services/classify.ts`，单一事实来源）：
   v0.3.0 的三层规则（人工复核表 > 标题关键词 > 标签关键词，六类固定顺序）原样移植；
   `scripts/classify.mjs` 改写为 `scripts/classify.ts`，引用服务端模块生成 seed，避免两份规则漂移。
   人工复核表新增一条：`6aacad1a AI 让古画活起来 → 设计与创作`（同 `6aa5062d 名画变电影` 先例）。
2. **刷新管道接入**（`LibraryService.autoClassify`，扫描提交后调用）：
   对「既无 seed/初始分类、也无人工覆盖」的小红书笔记执行规则；**只新增 initialAssignments，
   永不修改 overrides.json**（人工分类永远优先）；串行执行防止打爆 AI 配额；幂等（已分类不重跑）。
3. **AI 兜底**（`server/services/ai-classify.ts`，规则未命中才调用）：
   接口形态照搬 molin-wiki（OpenAI 兼容 `/chat/completions`；MiMo 系推理模型必须带
   `thinking:{type:'disabled'}`，否则 max_tokens 被思考吃光——该经验来自 molin-wiki 的 providers.py）。
   输入 标题+标签+正文摘要，输出 JSON 类别；解析宽松（容忍围栏/说明文字）、非法类别丢弃。
   配置走环境变量 `AI_CLASSIFY_API_KEY / AI_CLASSIFY_BASE_URL / AI_CLASSIFY_MODEL`，
   **未配置时静默跳过**（行为同 v0.5.1）；.mcp.json 里的旧 MiMo key 已失效（401），
   实际启用的是 molin-wiki backend/.env 的现行配置（mimo-v2.6-flash）。
   密钥只写入 gitignored 的 `deploy/production/.env`（compose 透传进容器），**未进 git**。

### 验收（真实管道）

- 8 篇全部自动分类，刷新诊断：`自动分类 8 篇（规则 7 / AI 1），未分类 0 篇`：

| 笔记 | 分类 | 依据 |
| --- | --- | --- |
| 中年男人下班后，深夜独自喝茶的快乐。 | 生活 | 规则：标题含「茶」 |
| 分享我最近手搓的两个内容管理的小工具💪 | AI 工具 | 规则：标签含「ai」 |
| 《心经》居然可以这样被看见！ | 设计与创作 | **AI**：「佛学视觉化设计，信息可视化」（正文讲书籍信息可视化） |
| 笔墨迭代与重构（4） | 书画 | 规则：标签含「写意」 |
| 最近又开始流行的清透质感 UI | 设计与创作 | 规则：标题含「UI」 |
| 数据一目了然｜高颜值Dashboard界面灵感 | 设计与创作 | 规则：标签含「设计」 |
| 🌲【干货｜松树核心结构画法全解析】 | 书画 | 规则：标题含「画法」 |
| AI驯化｜古画活起来教程 | 设计与创作 | 规则：人工表（AIGC 视频教程，同名画变电影先例） |

- 未分类计数 8 → 0；老笔记 categorySource 不变（抽查仍为 initial）；人工覆盖路径未被触碰（测试覆盖）。
- AI 兜底单测：真实调用一次 `《心经》` 4.9s 返回合法 JSON；解析器对围栏/夹带/非法类别均有测试。
- 自动化测试 52/52（新增 classify.test.ts：8 篇期望、AI 解析、ensureClassified 只补缺/不动覆盖/幂等/持久化）。

### 说明

- 《心经》一文规则未命中是**有意留给 AI 的**：其正文明确是"书籍的信息可视化设计"，
  简单加「心经→书画」关键词反而会误伤真正的书法内容；AI 读了摘要后判为设计与创作，与人工判断一致。
- 若未配置 AI key，规则未命中的新笔记会进未分类（与既往行为一致），网页上仍可手动改分类。

## 我的宝贝 / 日记 导入核验（2026-09-28，v0.5.3）

用户要求：这两个库的分类都是自己手工分好的（宝贝靠 frontmatter「收藏分类」、日记靠标签/文件名），
不需要 AI 参与，只要确认导入没问题。

### 核验方式（新增 `scripts/verify-manual-collections.ts`）

对真实 vault 逐篇解析，把**导入结果与用户的手工分类逐条比对**，并统计未分类：

| 收藏库 | 条目 | 未分类 | 手工分类一致性 |
| --- | --- | --- | --- |
| 我的宝贝 | 331（跳过索引/空笔记 5） | 1 | 336 篇 frontmatter「收藏分类」与导入结果**全部一致** |
| 日记 | 267（排除导出工具的首页/导航页 6） | 0 | 全部等于 tags[0] 或文件名主题段 |

- 宝贝剩余 1 篇未分类是 `最近买纸.md`（收藏库根目录下、无 frontmatter 的买纸清单）——属真·未分类，非解析问题。
- 自动分类管道的作用范围在代码层确认只碰 rednote（`autoClassify` 过滤 `collection === 'rednote'`），
  宝贝/日记的分类来自笔记自身的派生值，刷新不会改动它们（测试 `parse-multisource` 断言 categorySource=derived）。

### 发现并修复的问题

日记库里混进 5 篇 flomo 导出工具自动生成的**首页/导航页**（`flomo-首页.md`、`flomo-书法-首页.md`、
`flomo-哲学思考-首页.md`、`flomo-画画-首页.md`、`flomo-礼器碑-首页.md`）——内容是概览统计与链接列表，
不是日记条目，此前被当作日记导入并成为「日记 未分类 5」的全部来源。修复：日记收藏库的 exclude 增加
`^flomo-首页\.md$` 与 `^flomo-.+-首页\.md$`（与既有的 `^闪念笔记概览\.md$` 同一机制）。
exclude 属于索引指纹的一部分，改动后索引自动重建，无需手工干预。

修复后：日记 272 → 267，未分类 5 → 0；测试夹具同步加入两个首页文件并由「三库分别入库」用例断言其被排除。

## 未分类置底（2026-09-28，v0.5.4）

用户要求：侧栏「未分类」放到分类列表**末尾**（原先排在最前，会挡住常用分类）。

- `Sidebar.tsx`：先渲染派生分类，再渲染「未分类」，并加 `nav-item-last` 类；
  CSS 给一条 `--hairline` 细线 + 12px 间距，与上面的类目分隔（其余条目不受影响）。
- 浏览器实测：三个收藏库的顺序均为「…类目… → 未分类」（末）；间隔线在 y=607 实测明度 232
  对比面板 247（1px，符合设计）；其他条目的 `::before` 为 none。
- 注意：日记库里另有一个**真实派生分类**叫「未分类」（来自某篇 flomo 笔记文件名第二段），
  与系统的未分类分桶不是一回事；该笔记在 flomo 补标签后即会归到正确主题。

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
2. **整机断电重启恢复未实测**：DSM 7.3.1 / x86_64 / 端口 / NAS 本机路径均已在部署时核实（见上文「NAS 实际部署」），NAS 首次部署与容器重启恢复均已验证；仅「整机断电后 Docker 自启」未观察过一次真实重启。
3. **NAS rename/replace 行为**：JsonStore 在 rename 失败时自动退化为 copy+replace，本地 Windows 实测通过；NAS 文件系统上的行为将在首次部署时验证。
4. **搜索为子串匹配**：中文按包含匹配，无语义检索或拼音模糊匹配（首版范围）。
5. **瀑布流视觉顺序**：DOM 与数据严格按发布时间排序，交错的瀑布流布局不保证同屏视觉行序完全等同时间序（计划已声明）。
6. 每篇详情的正文为服务端消毒后的 HTML；原始 wiki 嵌入路径已规范化，源外引用显示为不支持。

## 证据清单

- 截图：`docs/screenshots/`（softglass-light-masonry / softglass-dark-masonry / softglass-light-table / softglass-dark-detail 为 v0.5.0；早期 home-1280 / home-1440 / home-1920 / shuhua-1440 / detail-1440 为 v0.1.0）。
- 测试：`npm test` 52/52 通过（vitest；日志见会话记录；v0.5.3 未新增用例，复用三库集成断言）。
- 源哈希清单：`.local/source-hash.json`（基线与复查一致）。
- 发布包：`releases/0.5.4/`（94 个文件，含 manifest.json 与逐文件 SHA-256；v0.1.0 的旧记录已随版本更新）。
- 分类 seed：`data-seed/categories-seed.json`；人工覆盖：`<DATA_DIR>/overrides.json`。

## 全项目深度审查与修复（2026-09-28，v0.6.0）

方式：逐行读完全部源码（服务端 / 前端 / 脚本，约 8900 行）+ 三路并行审查（样式死代码、部署脚本与
文档一致性、测试覆盖缺口）。每条结论都先用真实 vault 数据或代码核实，修复后**回退旧代码验证新测试
确实失败**，再跑全量回归。发现的问题分「真实影响用户」与「潜在/工具链」两类，全部落地。

### 真实影响用户（按影响排序）

1. **938 张封面里 293 张读不到尺寸，被强行按 4:3 裁切**。`server/reader/webp-size.ts` 只解析 WebP，
   而 2375 个 jpg / 391 个 png 媒体全部拿不到宽高。改为按**文件头**解析 WebP/PNG/GIF/JPEG
   （`server/reader/image-size.ts`），并支持无扩展名文件。修复后：解析审计 938 张封面 **0 张缺尺寸**。
2. **无扩展名图片以 `application/octet-stream` 下发**（藏品库里有 37 个名为 `640` 的无扩展名图片）。
   媒体路由现按文件头嗅探 MIME，并补齐音频类型（`.m4a/.mp3/.wav/.ogg/.aac`，此前日记音频只能下载）。
   实测：`/api/media/<宝贝>/640` → `Content-Type: image/webp`。
3. **3 个"破图"文件其实是下载失败时存下的 500 JSON 响应**（`{"code":500,"msg":"服务器异常…"}`）。
   现在解析时判定 `displayable=false`：不选作封面，并在 `parse-audit` 里列出来（用户可去修那几篇笔记）。
4. **扫描完整性三处缺陷**：
   - 「有意跳过」的笔记诊断写着"已从库中移除"，实际会被扫描尾部的 missing 兜底重新加回（行为与诊断不符）；
   - ID 冲突时同一路径会被推入两条记录（一条 available 一条 missing），`total` 多算、`detail` 指向 missing 副本；
   - 快路径（mtime/size 未变）不登记 ID，导致撞 ID 的文件在**第二轮刷新**被当成首个占用者收进索引。
   三处都已修，并用"回退旧代码 → 新用例失败"验证。
5. **「零可用笔记」保护从不生效**：判据是 `records.length === 0`，而消失的文件会以 missing 保留，
   该条件永远不成立。改为看 available 计数：一篇都读不到而旧库非空时给出醒目诊断
   （**不**硬失败——硬失败会让"确实清空库"的用户没有出路；记录与分类始终保留）。
6. **AI 兜底没有调用上限**：分类表被重置（删 categories.json）或一次导入几百篇时会串行打几百次接口。
   新增 `AI_CLASSIFY_MAX_PER_REFRESH`（默认 40），超出的留待下次刷新并在诊断里说明。
   顺带修掉 `AI_CLASSIFY_TIMEOUT_MS` 写错（NaN）时会"立即超时"从而静默关闭 AI 的问题。
7. **首扫的自动分类结果只进服务端日志、不进页面诊断**（`job` 为空时消息丢失），现在会写进索引诊断。
8. **静态缓存把 `index.html` 也缓存 1 小时**：部署完浏览器可能仍拿旧壳（"部署了但没变化"）。现按
   Vite 的 assets 目录判定——`index.html` 为 `no-cache`，`/assets/*` 为一年 immutable。
   注：第一版按"哈希长度 ≥8"猜，实测该构建的哈希是 7 位，被自己的测试头打回，已改为按目录判定。
9. **自定义时间范围的预填用浏览器本地日期**，与全站 Asia/Shanghai 口径不一致（设备不在东八区会差一天）。
   改为 `shanghaiDateDaysAgo()`。
10. **`categories.json` 里 `initialAssignments: null` 会通过校验后崩溃**（`typeof null === 'object'`）。
    校验改为非空对象判定，损坏文件按损坏处理并出诊断。

### 潜在问题与工具链

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `scripts/classify.ts` | 不过滤收藏库，会把宝贝/日记（id 是路径）写进 seed；且只要有一篇没命中就 throw | 只处理 rednote，未命中改为提示；重新生成 seed 后与旧 seed 逐条比对：**598 条类目零变化**，新增 7 条 |
| `scripts/parse-audit.ts` | 排除项按 vault 相对路径匹配（`^MOC\.md$` 永不命中），审计比库内多 6 篇 | 与 `scan.ts` 统一按收藏库相对路径；现与库内一致（1204 篇） |
| `scripts/source-hash.mjs` | 只哈希 RedNote，多收藏库后只读边界漏了两个库 | 按 `collections` 覆盖三库（4220 个文件），并支持 `--check` 非零退出口 |
| `pngview.cjs` / `scanline.cjs` | 调色板/灰度/隔行 PNG 会静默解出乱码亮度（"体检测量"失真） | 不支持的格式直接报错退出；通道数按 color type 计算 |
| `scripts/release.ps1` | 版本号未校验，`-Version ..\foo` 可把发布包写到 releases 之外；不跑任何检查 | 校验 `x.y.z`；新增 typecheck+测试预检（`-SkipChecks` 可跳过）；排除 `.git`；加 `.dockerignore` |
| `deploy/nas-update.sh` | `.env` 缺失分支缺 `exit 1`，报错信息误导 | 补 `exit 1` |
| `deploy/nas-rollback.sh` | 无 `.env` 守卫、无健康检查，失败也打印"已回滚" | 补守卫 + 健康检查与版本核对 |
| `deploy/.env.example` | `SOURCE_ROOT` 指向 `.../RedNote`（v0.4.0 起应为 vault 根）→ 照抄会挂不到宝贝/日记 | 改为 vault 根并加说明；`MYINFOBASE_TAG` 示例更新 |
| `deploy/compose.yaml`（模板） | 缺 AI 三项透传，照模板部署会静默关掉 AI 兜底 | 与 production 版同步（含新增的上限/超时项） |
| `server/config.ts` | 内置默认 collections 的 diary 排除项落后于 `config/app.json`（配置读不到时 flomo 首页会混进日记） | 同步默认值 |
| `src/styles/app.css` | `.raised`/`.sunken` 两条死规则；reduced-motion 只压时长不压延迟（卡片最长 420ms 不可见） | 删除死规则；补 `animation-delay: 0s` |
| `scripts/probe-client.js` | 探针自身缺陷：等"动画列表为空"对无限循环的环境光漂移永远不成立；切主题过渡期读数会把合格界面判成不合格 | 改为"两次读数一致"判稳，新增 `__uiSettle()`，并把正确用法写进注释与 README |

### 测试（52 → 102 个用例）

新增 5 个文件：`tests/image-size.test.ts`（文件头识别 14 例）、`tests/http.test.ts`（媒体路由的
Range/416/304/HEAD/越界/缺失/MIME + API 的 Origin 守卫、查询校验、409/400/404 映射、JSON 404）、
`tests/scan-integrity.test.ts`（快路径计数、跳过移除、ID 冲突去重、零可用告警、AI 上限、分类表损坏）、
`tests/config-guards.test.ts`（生产守卫、Origin 白名单构造）。同时强化既有弱断言：
`waitForJob` 现在要求 `state === 'completed'` 且 `errors === 0`（此前刷新失败也能让测试通过）、
`JsonStore` 备份数由 `≤3` 改为"恰好 3 份且是最新的三份"、`lastNDaysRangeMs` 锚定到今天而不只比跨度。

**回退验证**：把 `scan.ts`/`library.ts`/`categories.ts` 临时换回旧版本运行新用例，5/7 失败；换回后 7/7 通过。

### 端到端（真实 vault，只读）

- 全量扫描：1204 篇（小红书 606 / 宝贝 331 / 日记 267），`added=1204 skipped=5 errors=0`。
- 刷新幂等：`scanned=0 added=0 updated=0 skipped=1209 errors=0`，计数与分类不变。
- 解析审计：1210 → **1204 篇**（与库内一致），封面 938 张 **0 张缺尺寸**，4 条警告全部可解释
  （1 张 HEIC 封面按设计回退、3 个损坏文件被排除封面候选）。
- HTTP：`/api/media/<宝贝>/640` → `image/webp`；`/` → `Cache-Control: no-cache`；
  `/assets/index-*.js|css` → `max-age=31536000, immutable`；`/icon-32.png` 等非 assets 文件 → `3600`。
- 浏览器（Playwright）：浅色 11 项文字对比度**零失败**（最低 5.22）、暗色零失败（最低 5.01）；
  `__uiLayout()` 无越界、无重叠；`backdrop-filter` 计 2（侧栏 + 主面板，弹层未开）。
- 宝贝库封面比例从"全部 4:3"变为真实比例（首屏 120 张里仅 12 张是 SVG 占位按 4:3，其余为
  0.48–1.78 的真实比例）。这是本次唯一**可见**的变化，属于修复目标本身。
- **只读不变量**：审查前后对三库 4220 个文件做 SHA-256 清单比对 → `added=0 removed=0 changed=0`。

### 未修但已记录

- 详情弹层没有焦点陷阱（Tab 可以跑到弹层后面的页面元素）；`Escape`/焦点回归已实现。
- 反向自定义时间范围（from > to）返回空区间而非报错——已用测试固定现状。
- 扫描并发下"ID 冲突保留先入"依赖 worker 认领顺序（前 6 个文件按序认领，之后不保证）；
  真实库无重复 resourceId，故未重构扫描循环。
- 3 个损坏的图片附件属于 vault 数据问题，需要用户在 Obsidian 里重新下载（审计脚本会持续列出）。

## 第二轮深度审查（2026-09-28，v0.6.1）

第一轮读代码找问题；这轮换了三个切入角度，都抓到了第一轮漏掉的东西。

### 1) 审"上一轮我自己的改动"与长尾文件

- 上一轮把探针、审计脚本、seed 生成器、源哈希都改过，这轮逐个复核，未发现新问题。
- 补读第一轮委托出去的部分：`src/styles/app.css` 全文、`Icons/ThemeToggle/main.tsx`、
  `vite.config.ts`、`vitest.config.ts`、`tsconfig*.json`、`index.html`、`config/app.json`。

### 2) 前端行为层（第一轮完全没覆盖的领域，本轮最重的发现）

| 问题 | 证据 | 修复 |
| --- | --- | --- |
| **切换「瀑布流/列表」根本不重新加载** | 浏览器实测：点「列表」**0 个请求**，表格只有 120 行（瀑布流已加载的部分）而标题写着「当前结果 606 篇」；反向切回则把 1000 行灌进瀑布流 | 重载 effect 补上 `viewMode` 依赖，并在定时器内按当前模式选择加载器 |
| **表格模式下刷新/失败重试后掉成 60 行** | `startRefresh` 完成分支与错误态重试都调 `fetchPage(0)`（只取 60 条），表格 footer 会变成「共 60 行」 | 新增 `reload()`，按当前模式取全量；实测刷新后仍是 267/267 行 |
| **>1000 条时表格静默截断、排序只作用于前 1000** | `limit=1000` 一次取全量，footer 只显示行数 | footer 显示「当前筛选共 N 条，只加载了前 M 条；列排序仅作用于已加载部分」（临时把上限调到 60 验证过渲染与配色，随后还原） |
| **追加请求遇到索引重建时会把中间页当成首页** | `append` 分支在 revision 不匹配时直接 `setItems(res.items)`，而这份是从 offset 开始的页；之后每次「加载更多」都重取同一段（看起来点了没反应） | revision 不匹配即从 offset 0 重开 |
| **改完分类后条目仍留在已不匹配的筛选里** | 在「未分类」里给笔记归了类，toast 说保存成功、侧栏计数也变了，卡片却还在列表里 | 不再匹配时从列表移除并提示「已移出当前筛选」 |
| **标签目录会显示上一个库的标签；加载失败无任何提示** | `tags` 在切库时不清理，组件只在 `!tags` 时渲染错误态 | 切库/进入标签视图前清空，错误优先展示 |
| 首次进入标签结果无骨架（空白） | `selectTag` 未设 `listLoading` | 补上 |
| 从标签结果点分类：标题已换、内容还是旧结果 | `selectCategory` 不清 items | 仅在离开标签视图时清空（库内切分类保持无闪烁） |
| 刷新页后忽略上次选的展示模式 | 初始 state 硬编码 `masonry`，只有切库才读 localStorage | 初始值改为 `readViewMode('rednote')`（实测重载后直接进列表模式） |
| 「加载更多」可能永久卡在「加载中…」 | 追加被 `loadAll` 顶掉时 `loadingMore` 无人复位 | `loadAll` 起止都复位 |
| 搜索词变化不回到列表顶部 | 滚动 effect 漏了 `query.q` | 补上 |
| 输入法组合状态卡死会让所有重查失效 | `composingRef` 只在 compositionend 复位 | 加窗口失焦兜底 |
| 相同文案的两条 toast 会提前消失 | 用消息文本判归属 | 改用自增 id |

### 3) 可访问性与视觉逻辑（读两份 CSS 全文 + 组件交叉核对）

- **无封面卡片的键盘焦点完全不可见**：`.note-card { outline: none }` 而焦点环只画在 `.card-media` 上，
  日记库 120 张卡片全部无封面 → 实测 `outline: none`、无任何阴影。修复：无封面时把焦点环画在文字块上
  （实测 `box-shadow: 0 0 0 3px rgba(0,122,255,.55)`）。
- **下拉/日期输入无焦点反馈**：`.pill-select select`、`.filter-custom-dates input` 都是 `outline: none`
  且无替代样式。修复：`.pill-select:focus-within` 与 `input:focus-visible` 加环（实测生效）。
- **表格排序箭头是反的**：CSS 只有 `.sorted.dir--1 svg { rotate(180deg) }`，而 `dir-1` 是升序 →
  升序显示成向下箭头。修复并顺手补键盘可用性：`th` 现在可聚焦、回车排序、带 `aria-sort`
  （实测升序 `matrix(-1,0,0,-1,0,0)`、降序 none、Enter 可切换）。
- 亮色主题 `--surface-raised-hover` 与 `--surface-raised` 同为 `#ffffff`，5 条 hover 规则在亮色下等于没有反馈
  → 改为 `#f4f5f9`（实测两者已区分）。
- 错误/警示小字用 `--accent`：亮色下 `#ff375f` 在近白底上只有 3.3~3.5:1，不到 AA。新增 `--danger-text`
  （亮 `#c2183f` = 5.65:1，暗 `#ff7b8c` = 4.78:1 在抬升面上也达标），替换 toast/日期错误/「源文件暂不可用」。
- 详情遮罩淡出期间仍拦截点击：`.closing` 补 `pointer-events: none`（若 `animationend` 因故不到，
  遮罩会透明但吃掉全站点击）。
- `.detail-state .state-title` 无样式（详情加载失败的标题按正文大小渲染）；补上与结果区一致的排版。
- toast 长路径不换行会溢出胶囊 → 加 `overflow-wrap: anywhere`；骨架卡固定 236px 在 480px 视口溢出 → 加 `max-width: 100%`。
- 封面图 `opacity: 0` 只在 `onLoad` 时解除：缓存命中的图片不触发 load 事件，挂载时补查 `img.complete`。
- **瀑布流首帧位移过渡**：`.ready` 与第一个 `transform` 在同一提交里生效 → 过渡起点是 `none`，
  卡片会从容器左上角飞到各自位置。改为按条目判定：只有"上一次布局里已定位过"的条目才带过渡
  （实测首帧 `0/60` 带 settled，追加第二批后 `60/120`——首批首帧确实不带过渡，重排仍有过渡）。
  过程中我先写了"首帧后再打开过渡"的 rAF 方案，实测 1.8s 都没生效（resize observer 的重排不断取消 rAF），
  已换成不依赖帧时序的判定。

### 4) 黑盒边界扫描（不读代码，直接打接口，49 个用例）

结果：**1 个真问题，其余全部符合预期**（越界路径一律 404、无信息泄漏、畸形参数 400）。

- **超过 64KB 的请求体返回 500「服务器内部错误」**：`express.json({limit:'64kb'})` 抛的是
  `entity.too.large`，错误处理器只映射了 `entity.parse.failed`，于是落到兜底 500 并在日志里留下一条 ERROR。
  已按 413 `PAYLOAD_TOO_LARGE` 返回（新增用例覆盖）。
- 其余边界符合预期：`limit=0/-1/1e9/1.5` → 400；`offset=1e9` → 200 空页；`q` 500 字 → 400（上限 200）；
  `q` 含正则元字符 → 200（子串匹配，无注入）；`category=nonexistent` → 200 空结果；
  `range=custom&from=2026-13-01` → 400；`from>to` → 200 空结果（现状，已用测试固定）；
  `/api/notes/..%2F..%2Fetc%2Fpasswd`、`%00`、`/api/media/..%2F..%2Fconfig%2Fapp.json/640` → 全部 404。

### 5) 环境与工具的再次校准

- 这台浏览器实测 **~4fps**（500ms 内只跑 2 帧 rAF），`__uiBench` 会因此超时；基于时间的动效测量
  在这里一律不可信。以上所有前端结论都改用 DOM/样式断言取证（行数、请求数、类名、计算样式）。
- 两次"以为坏了、其实是量早了"的假警报：`__uiSettle` 之后 `select` 的焦点环、以及 `settled` 类名，
  都是同一帧内读计算样式导致的；补 100ms 后读数正确。**读计算样式一定要等一次样式重算。**

### 6) 验收（v0.6.1）

- 测试 **102 → 104 个**（新增 413 与越界路径两组 HTTP 用例）；typecheck 通过；构建通过。
- 浏览器断言：模式切换 1 个请求 / 表格 606 行 = 标题一致；表格模式下刷新后仍 267/267 行；
  升序箭头 = 上箭头且 `aria-sort` 正确、Enter 可切换；无封面卡片与下拉都有可见焦点环；
  亮色/暗色对比度**各自零失败**（最低 5.22 / 5.01），无越界、无重叠。

## 应用图标更换（2026-09-28，v0.6.2）

用户提供新图标源图（1254×1254 RGB 位图：绿色圆角方块 + 白色书签带 + 斜向高光），要求替换全站图标。

**做法**：新增 `scripts/build-icons.mjs`（`node scripts/build-icons.mjs <源图.png>`），从源图自动生成四个文件——
此前那三个 PNG 是"某次浏览器截图产出"，没有留痕，现在可复现：

| 文件 | 尺寸 | 用途 | 形态 |
| --- | --- | --- | --- |
| `icon-1024.png` | 1024² | 应用图标母版 | 满幅不透明（裁剪到形状，四角补满边缘色） |
| `apple-touch-icon.png` | 180² | iOS 主屏 | 同上 |
| `icon-96.png` | 96² | 侧栏品牌位（28px 显示） | 圆角透明（形状外 alpha=0，边界抗锯齿） |
| `icon-32.png` | 32² | favicon | 同上 |

不透明版不能留白角：iOS 自己套圆角遮罩，白角会露出来；透明版不能留白底：侧栏是深色玻璃面板，
白方块会像贴纸。`public/icon.svg`（旧「拾」字玻璃图标）随之删除，git 历史里可取回。

**过程中修掉的三个坑**（都在这台机器上实测出来的）：
1. 源图带一层很淡的**中性投影**，"非白即形状"的判据会把阴影当形状 → 左侧取到阴影的浅灰像素，
   补角补出一圈白。改用**彩度判据**（绿色才算法形状）定轮廓，投影被排除在裁剪之外。
2. 补色射线的参考像素只要求"落在该行的形状区间内"，会**打到中间那块白色书签**上 → 角补成白色。
   改为必须命中彩色像素（绿色边框）。
3. 取源像素时漏了行偏移 `minY`（`refY * stride` 而不是 `(minY+refY) * stride`），取到的是上方
   111 行的图像（背景白）→ 上半部分补角永远是白的。同一处 alpha 边界带也漏了，一并修掉。

**验收**（读文件真实像素，不靠肉眼）：
`icon-1024.png` 四角 `#a8f7b4`（角弧上的浅绿）、上中 `#7ceba2` → 左中 `#49d785` → 右中 `#2ec07c`
→ 下中 `#2fa67c`（斜向高光的渐变方向正确）、中心 `#f0fdf4`（白色书签）；
`icon-32/96.png` 四角 `alpha=0`、边缘内侧 alpha=255、中心为书签白。
浏览器里把实际加载到的图绘到 canvas 取像素复核：角 `a=0`、上中 `#62e894`、中心 `#effdf3`，
三个 favicon 链接全部 200 `image/png`。

## 工具栏与内容的分界（2026-09-28，v0.6.3）

用户三轮反馈才收敛，最终形态是「5px 空隙 + 1px 分界线 + 12px 渐隐投影」：

1. "筛选行下面完全没有间隔，让人很难受" → 我先加留白（头部下内边距 26px、结果区 8px，静止 34px）。
2. 被否："间距又搞得太大了…我只需要一条边缘有质感的线，下面带点阴影，让人感觉是两层空间。"
   → 改为「线 + 投影」，但把间距收到 12px 且**误解了位置**（我以为说的是线下方，其实说的是线上方）。
3. 澄清："我说的是这个筛选器和阴影线之间的空隙" → 线上方留空隙；我先给 3px，用户改为 **5px**。

**最终实现**（`src/styles/app.css`）：
- `.main-header { padding: ... 5px }` —— 筛选行到分界线的空隙（线上方 5px 干净面板底色）
- `.main-header::after` —— 挂在头部块下缘、撑满面板宽度：`border-top: 1px solid var(--edge-line)`
  ＋ `background: linear-gradient(to bottom, var(--edge-shadow), transparent)`、高 12px
- `.results { padding-top: 12px }` —— 正好容纳投影的渐隐带，内容不被压住
- `pointer-events: none`（实测 `elementFromPoint` 仍命中卡片）；`z-index: 3` 高于表格粘性表头的 2

过程中删掉的两处自作主张：① 曾加过 1px "上缘受光"亮边（`--edge-rim`），它占掉用户指定的空隙，
且暗色下与分界线连成 2px 亮带 → 删除；② 曾把线下方间距改成 2px 让内容紧贴（误解需求）→ 还原 12px。

**实测几何（截图逐像素剖面，暗色 x=300）**：
`y257..260` 纯面板底色（= 5px 空隙）→ `y261` 分界线（+7）→ `y262..272` 投影由 −10 渐隐到 0 →
`y273` 起为卡片内容。亮色同构（分界线为 −11 的暗线）。DOM 实测 `筛选行→线 = 5px`、`线→内容 = 12px`
（636×520 与 760×560 一致，筛选行换行时同值）。
线条与投影强度各是一个 token（`--edge-line` / `--edge-shadow`），调风格只改一处。

## AI 通道能力探测（2026-09-28，**未改动产品代码**）

背景：用户问「AI 除了分类能不能做总结，还要能对需要的视频做文稿转录、对需要的图片做 OCR」，
并担心"不换 DeepSeek 是不是就做不了"。本轮只做实测与计划（方案见 `plan.md` §18），未写产品代码；
探测已固化为可复跑脚本 `scripts/probe-ai.mjs`（`npm run probe:ai`）。

**方法**：全部使用脚本自己合成的素材——1 秒 440Hz 正弦 WAV、纯矩形代码画的 96×96 大写 "L" PNG、
浏览器 canvas 生成的 webp——**不上传任何 vault 素材**；媒体可达性只取远程视频前 1KB。

**结果**（`npm run probe:ai` = 4/4 通过；追加 `--image public/icon-96.png` 时 5/5）：

| 探测项 | 结果 |
| --- | --- |
| `GET /models` | 200，9 个：`mimo-v2.5` / `-asr` / `-pro` / `-tts`(×3) / `mimo-v2.6-flash` / `-pro` / `-pro-ultraspeed` |
| 视觉 `chat/completions` + `image_url`（合成 PNG，图中 "L"） | 200，回答「L」，usage 含 `image_tokens: 9` |
| 视觉 + 真实 webp（canvas 合成，图中 "A7"） | 200，回答「A7」→ **webp 直接被接受，不需要图片解码器** |
| ASR（`mimo-v2.5-asr` + `input_audio`，合成正弦音） | 200，返回「嗯。」（合成音无语义，读数无意义，只证明通道通） |
| `POST /audio/transcriptions`（OpenAI 形态，对照项） | 404——该网关没有这条路由 |

**两条形态结论**（照 OpenAI 习惯写必踩，已同步写进 `plan.md` 与脚本输出与注释）：
1. ASR 必须走 `/chat/completions` + `model: mimo-v2.5-asr` + **只含** `input_audio` 的 content；
   带文字部分报 400，网关原话 *"ASR request must not include text parts; text prompt is injected by the gateway"*。
2. 视觉走通用 `mimo-v2.6-flash`（模型列表里没有 VL 专用 id），`image_url` 用 data URI；实测直接吃 webp。

**媒体可达性（决定转录的工作量分布）**：小红书 606 篇里 405 篇带视频，**全部是远程
`http://sns-bak-v1.xhscdn.com/...mp4`，本地 0 个**；抽检该 URL：HEAD 200、分段请求 206、
`Content-Type: video/mp4`、**不需要 Referer 或 UA**、0.11s 响应（腾讯 COS）→ 备份域名仍可用。
本地音频更适合先做：274 篇 flomo 里 **112 篇引用 `.m4a`**（`flomo/attachments` 110 个 / 201.6 MB）。

**未验证（留给实施时第一步试掉）**：ASR 接受哪些容器格式——m4a 或 mp4 的音频轨能否直接用；
若只吃 wav 就需要转码（`ffmpeg-static`，镜像会加几十 MB）。

## 人工标注层·标星（2026-09-28，v0.7.0）

`plan.md` §18.1 的第一个功能（用户要求"一次只做一个功能，做完先验证再提交"）。这一轮同时把
人工标注层的**存储与冲突处理**这套地基立起来，后面"状态""备注"就是往里加字段。

**设计要点**：
- 新增 `server/services/annotations.ts` + `runtime/data/annotations.json`（`JsonStore`），
  与 `overrides.json` 同级：**绝不进 `library-index.json`**（那份索引会随 `PARSE_VERSION` 整体重建）。
- 一个文件、一条 revision，字段级浅合并；清空用显式值（`star: false`）而不是 `undefined`，
  这样"没提这个字段"和"清掉它"能区分开。
- **幂等**：重复标星不刷新 `starredAt`，且无实质变化时 `applyAnnotationPatch` 原样返回 `prev`，
  服务层据此**不写盘、不递增 revision**——否则连点两下星标就会把 revision 抬高，
  让另一个正在编辑备注的客户端莫名撞 409。
- 星标不带 `expectedRevision`（单字段覆盖是安全的）；备注/状态将来带，冲突走 409。
- 列表 `query()` 新增 `starred` 过滤，与其它条件叠加；`CollectionInfo.starred` 供侧栏计数。

**测试：104 → 124（新增 20 条）**，`tests/annotations.test.ts`（19 条）+ `tests/http.test.ts`（1 条）。
覆盖：补丁的字段级合并与幂等、读时净化（非法 `status` 只丢该字段、空壳条目返回 null）、
落盘与新实例读回、revision 冲突与非法状态、**主文件损坏后从备份恢复**、
`starred` 查询与侧栏计数、**索引被删掉重建后标星仍在**、**刷新后标星仍在**、
不存在的笔记 404、非小红书库也能标星（分类仍不能改，原约束未动）、
源文件消失后标注不丢（列表口径不变）、HTTP 层 409/400/404 与 `starred=bogus` 400。

**证伪（本项目的老规矩：新测试必须在旧代码上失败）**：把 `server/services/library.ts` 与
`server/routes/api.ts` 回退到 HEAD 版本后重跑，**9 条失败**——
8 条集成用例报 `Cannot read properties of undefined (reading 'starred')` / `svc.setStar is not a function`，
HTTP 用例报路由不存在；恢复新代码后 124 条全绿。说明这些用例真的在测新行为，而不是"看起来在测"。

**浏览器实测（Playwright，DOM 断言，不看帧率）**：

| 检查 | 结果 |
| --- | --- |
| 首屏 120 张卡片都带星标按钮 | `.card-media .btn-star` = 120（小红书卡片都有封面） |
| 点星标不打开详情 | 点击后 `.detail-overlay` = 0（事件就地截断） |
| 点击后状态 | `aria-pressed=true`、`.starred`、`aria-label` 变"取消标星"、侧栏计数 0→1 |
| **整页重载后仍在** | 重载后 `.btn-star.starred` 仍在、侧栏计数 1（证明落的是服务端而不是本地状态） |
| 侧栏「标星」入口 | 列表 1 篇、标题"标星"、范围"1 篇"、入口高亮、筛选行开关已按下 |
| 在标星视图里取消标星 | 立即移出列表（0 张）+ 空状态文案"还没有标星的笔记" + 计数归 0 |
| 日记库（无封面卡片） | 60 张卡片全部落在 `.card-meta .btn-star`（作者行右端），点击同样不打开详情 |
| 详情弹层星标 | 显示当前状态（与卡片一致），点击后 `aria-pressed` 翻转、计数同步 |
| 键盘 | 聚焦星标按 Enter：状态翻转、**不打开详情**（嵌套按钮的 keydown 冒泡已截断）、焦点留在按钮上 |
| 回归：列表模式 | 606 行表格正常渲染，切回瀑布流 60 张卡片 |
| 回归：详情分类选择器 | 打开正常、7 个选项、当前分类"生活"正确勾选 |
| 回归：点「刷新收藏库」 | 刷新完成（新增 1 篇）后标星仍在（计数 1） |

**只读边界**：改动前后各跑一次 `node scripts/source-hash.mjs`，
`--check` 结果 `total 4222 / added 0 / removed 0 / changed 0`——标星、刷新都没碰 vault。

**已知缺口（下一轮补）**：表格（列表）模式没有星标列，只能在卡片或详情里标星。
本轮刻意不加（保持"一次一个功能"的步子），但用户若常在表格模式里整理，就该把它排到前面。

**落点**：`server/services/annotations.ts`（新）、`server/services/library.ts`、`server/routes/api.ts`、
`shared/types.ts`、`src/components/{NoteCard,Masonry,Sidebar,Toolbar,DetailDialog,Icons}.tsx`、
`src/App.tsx`、`src/api/client.ts`、`src/styles/{app,tokens}.css`、`tests/{annotations.test.ts,http.test.ts}`。

## 人工标注层·归档（2026-09-28，v0.7.1 → v0.7.3）

`plan.md` §18.1 的第二个功能。**最终只剩一个概念：归档**——在用 ↔ 已归档，随时可以取回。

### 两轮用户反馈（这一节最值得留的东西）

1. **v0.7.1 我把它设计成了跨系统待办**：「标记 → 去小红书 App 取消 → 导出工具删掉 .md → 记录显示已完成」。
   用户否掉："**完全不用去小红书那边做任何操作，那样太复杂了，需要来好几个回合。我的意思是直接在我们
   本地的管理里面，通过这个中转站进行取消和存档就可以了。否则你这件事情不是把事情搞复杂了吗？**"
2. **v0.7.3 我又留了"过期 / 取消收藏"两个理由**，用户再次指出这是多余的：
   "**我不是很理解'已过期'和'已取消收藏'的区别。既然'已取消收藏'不会影响小红书，那其实就不需要有这个
   东西存在；只要有'归档'就可以了。其实'归档'和'取消收藏'对我来说是一回事，都是'现在对我来说没有用了'。
   你这边又多搞了一个，我就有点困惑。**"

两条教训：**不要替用户设计他不需要的跨系统流程**；**同一个意思不要给两个名字**。
第二轮的信号是"你这边又多搞了一个"——他数的是**概念个数**，多一个概念就是多一层要理解的东西。

### 最终设计

- `status` 单字段两值：`在用`（默认，不落字段）/ `已归档`。详情面板里就是一个开关按钮（「归档」↔「取回」），
  侧栏「归档」入口的计数就是归档篇数。
- **默认视图只显示"在用"**，所以**所有计数都要跟着变**（分类 / 未分类 / 标星 / 标签 / 侧栏），
  统一走 `inWorkSet()`（源文件可用且状态在用）；`CollectionInfo` 为 `total`（文件还在）/ `active` / `archived`。
  否则归档一篇之后列表少一条而侧栏数字不动，界面自相矛盾。
- 归档视图带 `includeMissing`：**标注是用户自己的记录，不该因为源文件被删就跟着消失**（与"待办完成"无关）。
- **旧值兼容**：v0.7.1 写过的 `expired` / `uncollected` 在读盘时映射成 `archived`，用户标过的不丢。

### 测试与证伪

- 测试总数 **134**（删掉了"归档细分"那条已无意义的用例，新增"旧值映射"一条）。
- 覆盖：默认视图只用工作集、计数与列表同口径、标签计数与缓存键、归档后源文件消失仍能在归档视图看到、
  取回、归档与星标互不影响（字段级合并）、revision 冲突与 404、非小红书库也能归档、
  HTTP 层归档补丁与 `status=` 参数校验（旧的 `expired` / `uncollected` 现在应被拒）。
- **证伪**：把 `annotations.ts` / `library.ts` / `api.ts` 回退到三值版（v0.7.2）后重跑，**12 条失败**
  （`未知的状态: archived` × 多条，以及 HTTP 里旧值应当 400 却拿到 200）；恢复后 134 条全绿。
- **写测试时抓到的真 bug**：`tagCounts` 的缓存键只有 `indexRevision`，而归档不动索引 revision →
  归档一篇后标签计数会一直返回旧数字（只差 1，界面上看着还挺合理）。缓存键补上 `annotationRevision`。

### 浏览器实测（DOM 断言，全程避开用户自己标星的那一条）

| 检查 | 结果 |
| --- | --- |
| 详情里的归档开关 | 一个按钮，默认文案「归档」，带说明性 title |
| 点归档 | toast「已归档」+ 撤销按钮；按钮变成「取回」并出现一行「已归档：只影响拾藏，不删源文件，随时可以取回」 |
| 计数联动 | 小红书收藏 606→**605**、归档 0→**1**、标题范围「605 篇」 |
| 列表联动 | 该卡片立即从列表消失，关掉详情后列表里没有它 |
| 归档视图 | 标题「归档」、范围「1 篇」、入口高亮、卡片带「已归档」标签 |
| 取回 | 从归档打开详情时按钮显示「取回」→ 点后立即离开归档，空状态「归档里还没有笔记」，计数回到 0 / 606 |
| 撤销按钮 | 归档后点撤销 → 该条**重新出现在列表里**，归档计数归 0 |
| 不碰用户数据 | 用户自己标的那条星在整轮测试后仍在那张卡上（标星计数 1） |
| 回归 | 列表模式 606 行、标签目录 891 个、详情分类选择器正常 |

**只读边界**：改动前后 `node scripts/source-hash.mjs --check` 结果 `added 0 / removed 0 / changed 0`。

**已知缺口**：列表（表格）模式既没有星标列也没有归档列，只能在卡片或详情里改；
**批量归档**还没做——用户要在本站批量清理时一条条点会很难受，**优先级已上升**。

**落点**：`server/services/{annotations,library}.ts`、`server/routes/api.ts`、`shared/types.ts`、
`src/components/{NoteCard,Sidebar,Toolbar,DetailDialog,Icons}.tsx`、`src/App.tsx`、`src/api/client.ts`、
`src/styles/app.css`、`tests/{annotations,http}.test.ts`。
