# 拾藏 Shícáng — 个人收藏库（Soft Glass 风格）

[GitHub 仓库](https://github.com/zaxchou/shicang)（版本管理）。把 Obsidian 库中的小红书收藏（Markdown + 本地图片 + 远程视频）变成一个可以 24 小时常驻访问的深色网页收藏库：浏览、搜索、按分类与时间筛选、阅读详情、播放视频、手动刷新新增内容、调整分类。**Obsidian 库只读**；所有展示端数据保存在本项目目录内。

![首页（亮色）](docs/screenshots/softglass-light-masonry.png)

深色主题与列表模式：`docs/screenshots/softglass-dark-masonry.png`、`softglass-light-table.png`、`softglass-dark-detail.png`

## 收藏库（三个来源）

拾藏管理三类内容，侧栏「收藏库」一键切换，每库独立分类、独立搜索与标签：

| 收藏库 | 来源（Obsidian） | 内容 | 展示 |
| --- | --- | --- | --- |
| 小红书收藏 | `RedNote/Bookmarks` | 598 篇小红书帖子收藏 | 瀑布流 + 列表 |
| 我的宝贝 | `我的收藏品` | 336 件个人藏品（有封面、价格、购买时间、朝代/作者/工艺等字段） | 瀑布流 + **列表（数据表，字段自动成列、可排序）** |
| 日记 | `flomo` | 272 条 flomo 闪念/日记（标题=日期+摘要，主题来自标签） | 瀑布流 + 列表 |

## 功能

- **收藏流浏览**：按发布时间从新到旧的无框瀑布流（缩略图 + 标题 + 作者 + 分类标签）；多图数量角标、视频标记。
- **分类导航**：小红书收藏 6 大类（书画 269 / AI 工具 105 / 设计与创作 65 / 生活 69 / 学习语言 49 / 数码硬件 41）；我的宝贝按「收藏分类」派生 8 类（茶器/拓片/书法/篆刻/文房/玉石/中国画/杂件）；日记按主题（画画/书法/日记…）。
- **列表（表格）模式**：每个收藏库可切换瀑布流 / 列表；表格列按数据自动生成——我的宝贝显示价格、购买时间、作者品牌、朝代、书风、装裱等（点击表头排序），小红书收藏显示作者/分类/两种时间/标签，日记显示日期/主题/摘要。
- **标签目录**：侧栏「标签」进入全部标签页（872 个标签按热度排列，可搜索），点标签直达对应内容，可与搜索、时间筛选叠加。
- **搜索与筛选**：标题/正文/作者/标签全文搜索（多词 AND），时间范围（最近 7 天 / 30 天 / 自定义）、时间类型（发布时间 / 同步时间）、排序独立可配。
- **详情阅读**：居中弹层展示完整图文与视频；远程视频不可用时给出提示与原文入口；可在详情中修改主类（即时落盘，刷新不丢失）。
- **亮色 / 深色 / 跟随系统**：侧栏底部三档切换，跟随系统时实时响应系统外观变化，选择持久保存。
- **动效**：弹层开合、卡片入场、悬停缩放、图片淡入等克制过渡；尊重系统「减弱动态效果」设置。
- **手动刷新 + 自动分类**：点击「刷新收藏库」增量读取 Obsidian 中新增/变更的笔记（只解析新文件，秒级完成），并按沉淀的三层分类规则自动归类；规则未命中时可选调用 AI（MiMo/DeepSeek 等 OpenAI 兼容接口）兜底，人工在网页里改过的分类永远优先。不写入源目录。
- **质感（Soft Glass）**：三层表面语法（浮起 / 平面 / 凹陷）+ 柔和光影代替描边，近白面板压在淡彩背景上，缓慢漂移的环境光透过玻璃；`backdrop-filter` 只用于三块大玻璃，滚动 + 指针交互实测 0 掉帧（详见 `docs/design-language.md`）。

## 快速开始（Windows 开发预览）

```powershell
# 1. 首次安装（需要 Node.js ≥ 22）
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# 2. 启动（双击 start.cmd 亦可）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

浏览器打开 http://127.0.0.1:4317 。开发数据写入 `.local\data`，与生产隔离。

## 生产部署（群晖 Container Manager / Docker，已于 2026-09-27 实际部署验证）

目标形态：NAS（192.168.31.246）上以 Docker 常驻单实例，全家用浏览器访问 `http://192.168.31.246:4317`，电脑与 Obsidian 关闭不影响服务。**已部署并验证**：容器重启后分类与索引保留；NAS 路径与端口已核实（见 `deploy/.env.example` 注释）。

### 已核实的 NAS 环境参数

- v0.4.0 起 `SOURCE_ROOT` 指向 **vault 根**（`/volume2/Media/BaiduNetdiskWorkspace/mynote/mynote`），容器挂载到 `/source`，一次挂载覆盖三个收藏库。

- DSM 7.3.1，x86_64；docker 位于 `/usr/local/bin/`（SSH 非登录 shell 需手动加 PATH），docker 需要 root 权限（sudo）。
- 项目与源库都在共享盘：项目 `/volume2/Media/BaiduNetdiskWorkspace/myagent-work/zcode/MyInfobase`，源 `/volume2/Media/BaiduNetdiskWorkspace/mynote/mynote/RedNote`；Windows 的 Z: 直连该共享，**文件改动即时同步**，无需上传。
- 共享目录属主 uid=1026（zaxchou）/ gid=100（users），容器以该身份运行。

### 首次部署（已完成，留作记录）

1. NAS 上创建 `deploy/production/`：放入 `compose.yaml`（模板在 `deploy/compose.yaml`）与 `.env`（按 `.env.example` 填真实路径）。
2. 创建运行时目录 `runtime/data`、`runtime/backups`。
3. 打包发布：Windows 上 `powershell -File scripts\release.ps1 -Version <v>`（Dockerfile 会复制进发布包根）。
4. 构建并启动（NAS 上需 root）：
   ```sh
   sudo sh -c 'export PATH=/usr/local/bin:$PATH
   docker build -t myinfobase:<版本> <项目>/releases/<版本>
   docker compose -f <项目>/deploy/production/compose.yaml --env-file <项目>/deploy/production/.env up -d'
   ```
5. 首次启动自动全量扫描（598 篇）并从 `data-seed/categories-seed.json` 导入首批分类（仅未初始化的库导入，之后不再重复）。

### 日常更新（改完代码 → 上线，约 2 分钟）

```powershell
# Windows：构建 + 打包新版本
npm run build; powershell -File scripts\release.ps1 -Version <新版本>
# SSH 助手（scripts/nas-deploy.mjs，凭据走环境变量）一键更新：
$env:NAS_HOST='192.168.31.246'; $env:NAS_USER='zaxchou'; $env:NAS_PASS='<密码>'
node scripts\nas-deploy.mjs sudo-sh "sh /volume2/Media/BaiduNetdiskWorkspace/myagent-work/zcode/MyInfobase/deploy/nas-update.sh <新版本>"
```
`nas-update.sh` 会：构建新镜像 → 更新 `.env` 版本标签 → 重建容器 → 健康检查并校验版本一致。

### 回滚

```sh
sudo sh deploy/nas-rollback.sh <旧版本号>   # 镜像仍在本地，秒级切回
```

### 数据与备份

- 生产数据：`runtime/data/`（`overrides.json` 是人工分类，**不可重建**，请纳入 NAS 定期备份；`library-index.json` 可随时重建）。服务自动保留最近 5 份备份于 `runtime/backups/`。
- 源目录以只读方式挂载（`:ro`），应用无写入路径。
- 更新仅重建容器，`runtime/` 不受影响；清理旧版本只允许作用于 `releases/` 与 `runtime/backups/`。

## 刷新规则

- 首次启动自动全量扫描；之后仅在你点击「刷新收藏库」时增量扫描（按 mtime + size 判断变更），新增笔记默认进入**未分类**。
- 重复刷新不会产生重复条目，也不会覆盖人工分类。源文件消失时标记为「暂不可用」，不删除记录与分类。
- 同步时间 ≠ 收藏时间：页面明示「发布 / 同步」两种时间，按发布时间排序，无效日期排在末尾。

## 目录结构

```text
server/            Node.js + Express 服务端（reader 解析 / services 索引与分类 / routes API 与媒体）
src/               React + Vite 前端（双面板、瀑布流、详情弹层）
shared/            前后端共享类型与时间工具
config/app.json    内容源、端口、时区（环境变量优先级更高）
data-seed/         首批分类 seed（仅在未初始化的库导入）
docs/              分类体系说明、验收记录、截图、设计参考
deploy/            Dockerfile、compose 模板、NAS 更新/回滚脚本
scripts/           安装/启动/发布/扫描 CLI
.local/            开发数据（不进生产）；runtime/ 生产数据
releases/          版本化发布包
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 页面显示「无法连接收藏库服务」 | 服务未启动或端口不对；`curl http://127.0.0.1:<端口>/api/health` 检查 |
| 首页为空 | 点击「刷新收藏库」；仍为空检查 `SOURCE_ROOT` 是否指向 RedNote 目录（其下应有 `Bookmarks/` 与 `Media/`） |
| 图片不显示 | 多为媒体路径或挂载问题；确认 `Media/` 与笔记同源挂载，浏览器 DevTools 看 `/api/media/...` 响应 |
| 远程视频无法播放 | 平台防盗链或网络策略所致，详情页有提示与原文入口；本地图片不受影响 |
| 分类保存失败 | 多标签页并发冲突（409）时刷新页面重试即可；数据目录不可写时服务会拒绝写入并提示 |
| 分类数据异常 | 查看 `runtime/backups/` 最近备份；服务启动时会自动从最近可用备份恢复并记录诊断 |

## 开发

```bash
npm run typecheck   # 前后端类型检查
npm test            # vitest：解析/路径/时间/分类优先级/幂等刷新等 43 个用例
npm run build       # 构建服务端 + 前端到 dist/
npm run dev:server  # 服务端热重载（开发）
npm run dev:web     # Vite 前端开发服务器（代理 /api 到 4317）
```

约定：源库（`Z:\...\mynote\mynote`）只读；所有写入收口在项目 `storage` 模块；分类、索引等数据通过 `DATA_DIR` 定位。分类体系与边界见 `docs/category-taxonomy.md`，设计语言见 `docs/design-language.md`，验收记录见 `docs/verification.md`。

### 改样式前先量一量

界面观感与帧耗都靠数字验收，不要凭感觉调。项目自带三个探针（不参与打包）：

```bash
cp scripts/probe-client.js dist/web/_probe.js      # 注入浏览器
# 控制台：await (0,eval)(await (await fetch('/_probe.js')).text())
#   __uiAudit()                      合成色 / 明度台阶 / WCAG 对比度（4 视图 × 2 主题应为零失败）
#   __uiBench(150,{mode:'both'})     滚动+指针帧耗（over32ms 必须为 0）
#   __uiLayout()                     越界与重叠检查

node scripts/pngview.cjs <png> 100 32              # 截图 → 亮度字符视图（看构图）
node scripts/scanline.cjs <png> <y> <x0> <x1> 2    # 明度扫描线（验证阴影/玻璃亮边）
```

`src/styles/app.css` 末尾的「性能预算」注释记录了每条硬性约束的实测数字（例如瀑布流条目的
`will-change: transform`：360 张卡片 23ms → 8ms/帧），改动前请先复测。
