# 设计语言：Soft Glass（v0.5.0 定版；v0.6.0 起继续沿用）

面向本项目的落地说明。通用方法已固化为 skill：`soft-glass-ui`
（`~/.agents/skills/soft-glass-ui/`，含探针脚本与 token 模板）。

## 一句话

**透明层级（Glassmorphism）负责"面板浮在背景之上"，柔和光影（Soft UI）负责组件级的高低起伏，
层次不用描边表达。** 高级感来自减法：删装饰、加留白、把差值的精度交给数字。

## 三层表面

任何控件先归类到三种表面之一，再套对应的背景 + 阴影。

| 表面 | 相对主面板 | 背景 token | 阴影 | 本项目用在 |
|---|---|---|---|---|
| 浮起 | 亮 ≈ 0.023（暗）/ 0.064（亮） | `--surface-raised` | `--elev-2 + --inset-top` | 刷新按钮、视角切换选中项、侧栏选中项、标签块、圆形图标按钮、头像底、分类胶囊 |
| 平面 | 0 | `--surface` | 无 | 卡片上的分类标签、详情页标签、表格内标签 |
| 凹陷 | 暗 0.010 / 0.124 | `--surface-sunken` | `--trough` | 搜索框、视角切换凹槽、主题切换凹槽 |
| 浅凹陷 | 暗 0.010 / 0.078 | `--surface-sunken-2` | `--inset-top` | 表格容器、详情字段网格 |

实测的合成色（`__uiAudit()`）：

| | 亮色 | 暗色 |
|---|---|---|
| 页面 | `#edeff4` | `#090a0e` |
| 主面板 | `#f7f8fa`（明度差 0.073） | `#1f202b`（明度差 0.012） |
| 浮起 | `#ffffff` | `#353740` |
| 凹陷 | `#e8e8ed` | `#0f1015` |
| 细线 `--hairline` | `rgba(24,32,60,.08)` | `rgba(255,255,255,.075)` |
| 玻璃外缘 `--glass-edge` | `rgba(255,255,255,.85)` | `rgba(255,255,255,.085)` |

`--glass-edge` 与 `--hairline` 必须分开：前者是玻璃切面受光的白边（两主题都偏白），
后者是内容分隔线（**必须跟主题走**）。混用会让亮色主题的表格行线消失。

## 玻璃预算

`backdrop-filter` 只允许出现在 **3 处**：`.sidebar`、`.main`、`.detail-panel`
（弹层遮罩 `.detail-overlay` 另算一层模糊，打开弹层时全页共 4 个）。
模糊半径 18px，不带 `saturate`。

被删掉的地方（都曾存在）：表格 `th`、`pill-select`、`tag-chip`（最多 273 个）、
`load-more button`、`card-media-badge`（每张卡片一个，最多 360 个）。

## 光影配方

```css
--elev-1: 0 1px 2px rgba(...)                                /* 微：头像、小胶囊 */
--elev-2: 0 2px 5px rgba(...), 0 10px 22px -10px rgba(...)   /* 悬起：按钮、选中项 */
--elev-3: 0 30px 68px -30px rgba(...), 0 3px 12px rgba(...)  /* 面板、弹层、菜单 */
--inset-top: inset 0 1px 0 rgba(255,255,255,.075)            /* 上缘受光 = 厚度 */
--trough: inset 0 1px 3px rgba(0,0,0,.45), inset 0 -1px 0 rgba(255,255,255,.045)
--card-shadow: 0 16px 36px -20px rgba(0,0,0,.85)             /* 卡片悬停 */
```

每档都是"近距离小阴影 + 远距离大扩散"的组合。`--inset-top` 是性价比最高的一行：
1px 上缘提亮就让平面有厚度，成本为零。亮色主题的投影用带蓝的深色（`rgba(32,42,78,…)`），
纯黑投影在浅底上会发脏。

## 背景

两层 `body` 伪元素，**不使用 `filter: blur()`**——直接画 `radial-gradient(..., transparent 70%)`，
渐变自身的衰减就是柔的；再配 88s / 62s 的极慢 `translate3d` 漂移（纯合成，几乎零成本）。
这就是"玻璃后面有东西在缓慢移动"的来源。

亮色洗色 `rgba(...,.26~.34)`，暗色 `rgba(...,.13~.26)`，集中在四角。

## 动效

只用 `transform` / `opacity`。卡片入场 stagger 26ms/张、封顶 420ms；
悬停图片放大 1.035、480ms、`cubic-bezier(.22,1,.36,1)`；
弹层进出 `translateY(10~16px) + scale(.965~.975)`，180–300ms；全部尊重 `prefers-reduced-motion`。

## 性能纪律（改样式前必读）

写在 `src/styles/app.css` 文件末尾，附实测数字。摘要：

1. `backdrop-filter` ≤ 3 处
2. 背景层禁止 `filter: blur()`
3. 禁止 `background-attachment: fixed`（曾用于指针跟随高光，实测 8.7 → 32.8ms/帧）
4. 全屏动画只允许 `transform` / `opacity`
5. 瀑布流条目**必须** `will-change: transform`（360 张实测 23 → 8ms/帧），
   因为卡片处在带 `backdrop-filter` 的 `.main` 里；改这条之前先跑 `__uiBench`

## 验收工具

项目自带探针（`scripts/probe-client.js`，注入页面后使用）：

```bash
npm run build:web && cp scripts/probe-client.js dist/web/_probe.js
# 浏览器控制台：
#   await (0,eval)(await (await fetch('/_probe.js')).text())
#   __uiAudit()   合成色 / 明度台阶 / WCAG 对比度
#   __uiBench(150,{mode:'both'})   滚动+指针的帧耗
#   __uiLayout()  越界与重叠检查
```

配套两个离线看图工具（看不了截图时把画面变成数字）：

```bash
node scripts/pngview.cjs docs/screenshots/softglass-light-masonry.png 100 32   # 亮度字符视图
node scripts/scanline.cjs docs/screenshots/softglass-light-masonry.png 620 200 300 2 240 250 258 270  # 明度扫描线
```

验收门：4 视图 × 2 主题零对比度失败、无越界无重叠、`mode:'both'` 掉帧数为 0、p50 ≤ 10ms。

## 手机适配（v0.18.0，Agent 推断，待用户确认）

断点 ≤900px 走手机/窄屏布局（横屏手机 844px 也落在这一档），>900px 保持原桌面双栏。

- **导航**：侧栏变成从左滑入的抽屉（`.sidebar.mobile-open`，宽 `min(320px, 100%-32px)`），
  遮罩点击、Esc、关闭按钮都能收起；收起后焦点回到汉堡按钮。收藏库/分类/来源/标签/设置全部保留。
- **主区（v0.18.1 起两行头）**：第一行=汉堡 + 标题/范围计数 + 右侧图标式视图切换；
  第二行=搜索（占满剩余宽）+ 结果数 + 筛选按钮（生效项数用金色徽标）。筛选面板默认折叠，
  展开只在面板内增加高度。顶部常驻高度目标 ≤110px（390×844 实测 108px）。
  头部**不做内部滚动**（`overflow: clip`；`overflow: auto` 会被 12px 分界投影撑出一根常驻滚动条）；
  内容上滑累计 >32px 时整条收起（负 margin + 淡出），上滑 >8px 或回到顶部露出；
  头部内有焦点或筛选面板展开时不收起。
- **瀑布流**：≤900px 时 600px 以上三列、300–600 两列、300 以下单列；卡片封面限高
  `min(360px, 44svh)`，保证标题与来源在首屏可见。仍按实测高度落位（v0.17.4 的稳定性不变）。
- **详情**：全屏 `100dvh`，头部作者行 + 操作行两排，关闭固定在右上；正文最多 640px 宽、16px 内边距；
  备注移入正文滚动区；OCR/转写、分类菜单、元数据与标签都能换行或局部滚动；Markdown 表格横向滚动。
- **触控与输入**：可点控件 ≥44px，输入框字号 ≥16px（避免 iOS 聚焦缩放），选中复选框的可点区域为 44×44。
- **滚动责任**：文档级滚动永久禁用（v0.17.5），主内容区是唯一主滚动区；抽屉、详情、表格各处只在自己的
  边界内滚动。安全区域 `env(safe-area-inset-*)` 与 `100dvh` 都已处理，`prefers-reduced-motion` 下不播放入场。
