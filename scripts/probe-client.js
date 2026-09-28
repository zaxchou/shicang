/**
 * 浏览器端设计/性能探针（开发与验收用，不参与打包）。
 *
 * 用途：在「看不到画面」或需要客观数据时，把渲染结果量化成数字——
 *   window.__uiAudit()     合成后的表面色、明度台阶、文字对比度（WCAG）
 *   window.__uiBench(n)    滚动 / 指针移动的帧耗时（p50/p90/p99 + 掉帧数）
 *   window.__uiLayout()    关键容器几何：越界、重叠、留白分布
 *   window.__uiSettle(ms)  等过渡/动画跑完（切主题、切筛选之后必须先调）
 *
 * 用法（Windows 本地）：
 *   npm run build:web
 *   copy scripts\probe-client.js dist\web\_probe.js
 *   然后在浏览器里注入：await (0,eval)(await (await fetch('/_probe.js')).text())
 *
 * 坑（2026-09-28 实测）：
 *   1) 切主题后立刻 audit 会量到颜色过渡的中间态，把合格界面判成 3 处对比度不合格。
 *      可靠做法：localStorage.setItem('mb-theme','light'|'dark') 后整页重载再量。
 *   2) 不能用"getAnimations() 里还有没有 running"判断是否稳定：Chromium 会把已结束的
 *      过渡继续列为 running（.card-cat 的 0.2s 过渡 3s 后仍报 running，颜色其实已不变）。
 *      所以 __uiSettle 用"连续两次读数一致"判稳，并且只在同一主题内可信。
 */
(function () {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (fg, bg) => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  /** 自底向上合成背景色；backdrop-filter 的模糊不参与计算，仅作明度台阶参考 */
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) stack.push(c);
    }
    let base = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
  };
  const hex = (c) =>
    '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const dL = (a, b) => +(lum(a) - lum(b)).toFixed(4);
  const q = (s) => document.querySelector(s);

  const SURFACES = {
    page: 'body',
    sidebar: '.sidebar',
    main: '.main',
    navActive: '.nav-item.active',
    searchBox: '.search-box',
    pillSelect: '.pill-select',
    viewToggle: '.view-toggle',
    viewActive: '.view-toggle button.active',
    refreshBtn: '.btn-refresh',
    tagChip: '.tag-chip',
    tableWrap: '.table-wrap',
    cardCat: '.card-cat',
    cardAvatar: '.card-avatar',
    detailPanel: '.detail-panel',
  };
  const TEXTS = {
    title: '.title-text',
    titleCount: '.title-count',
    navActiveLabel: '.nav-item.active .nav-label',
    navIdleLabel: '.nav-item:not(.active) .nav-label',
    navActiveCount: '.nav-item.active .nav-count',
    navSection: '.nav-section',
    sidebarFoot: '.sidebar-foot',
    cardTitle: '.card-title',
    cardAuthor: '.card-author-name',
    cardCat: '.card-cat',
    resultCount: '.filter-result-count span',
    detailTitle: '.detail-title',
    extraLabel: '.extra-label',
    extraValue: '.extra-value',
    thLabel: '.data-table thead th span',
    tdCell: '.data-table td',
    emptyState: '.results-state',
  };

  window.__uiAudit = function () {
    const mainEl = q('.main');
    const pageC = bgOf(document.body);
    const mainC = mainEl ? bgOf(mainEl) : pageC;
    const surfaces = {};
    for (const [k, sel] of Object.entries(SURFACES)) {
      const el = q(sel);
      if (!el) continue;
      const c = bgOf(el);
      surfaces[k] = { hex: hex(c), dL_vs_panel: dL(c, mainC), dL_vs_page: dL(c, pageC) };
    }
    const texts = {};
    for (const [k, sel] of Object.entries(TEXTS)) {
      const el = q(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      const c = ratio(fg, bg);
      texts[k] = {
        color: hex(fg),
        bg: hex(bg),
        px: size,
        contrast: c,
        level: c >= (large ? 3 : 4.5) ? 'AA' : c >= 3 ? 'AA-large-only' : 'FAIL',
      };
    }
    return {
      theme: document.documentElement.dataset.theme,
      pagePlusPanel: { page: hex(pageC), panel: hex(mainC), dL: dL(mainC, pageC) },
      surfaces,
      texts,
      backdropFilterCount: [...document.querySelectorAll('*')].filter((e) => {
        const s = getComputedStyle(e).backdropFilter;
        return s && s !== 'none';
      }).length,
      /** 仅供排查：Chromium 会把已结束的过渡继续列为 running（实测 .card-cat 的 0.2s
       *  过渡在 3s 后仍报 running，而颜色已不再变化），所以不要用它判定"是否稳定"，
       *  判断稳定性请用 __uiSettle 的两次读数比对 */
      pendingTransitions: document.getAnimations().filter((a) => a.playState === 'running').length,
    };
  };

  /**
   * 等界面稳定再读数：连续两次 audit 结果一致才算稳（上限 ms 毫秒）。
   * 不能用"动画列表为空"来等——Chromium 会把已结束的过渡一直列为 running；
   * 也不能只固定 sleep：切主题时 120 张卡片的颜色过渡会持续几百毫秒。
   */
  window.__uiSettle = async function (ms = 4000) {
    const snap = () => {
      const a = window.__uiAudit();
      return JSON.stringify({ t: a.texts, s: a.surfaces, p: a.pagePlusPanel });
    };
    const t0 = Date.now();
    let prev = snap();
    for (;;) {
      await new Promise((r) => setTimeout(r, 140));
      const cur = snap();
      if (cur === prev) return { waitedMs: Date.now() - t0, stable: true };
      prev = cur;
      if (Date.now() - t0 > ms) return { waitedMs: Date.now() - t0, stable: false };
    }
  };

  window.__uiBench = function (frames = 150, opts = {}) {
    const root = opts.root ? q(opts.root) : q('.results');
    if (!root) return Promise.resolve({ error: 'no scroll container' });
    const mode = opts.mode || 'scroll';
    const deltas = [];
    let last = performance.now();
    let n = 0;
    let dir = 1;
    return new Promise((resolve) => {
      function step() {
        const t = performance.now();
        deltas.push(t - last);
        last = t;
        if (mode === 'scroll' || mode === 'both') {
          root.scrollTop += dir * 40;
          if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) dir = -1;
          if (root.scrollTop <= 0) dir = 1;
        }
        if (mode === 'pointer' || mode === 'both') {
          window.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: 300 + ((n * 37) % 900),
              clientY: 160 + ((n * 53) % 600),
              bubbles: true,
            })
          );
        }
        n++;
        if (n < frames) requestAnimationFrame(step);
        else {
          const s = deltas.slice(15).sort((a, b) => a - b);
          const at = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
          resolve({
            mode,
            samples: s.length,
            p50: at(0.5),
            p90: at(0.9),
            p99: at(0.99),
            max: +s[s.length - 1].toFixed(1),
            over32ms: s.filter((d) => d > 32).length,
            cards: document.querySelectorAll('.note-card').length,
          });
        }
      }
      requestAnimationFrame(step);
    });
  };

  window.__uiLayout = function () {
    const box = (sel) => {
      const el = q(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        right: +r.right.toFixed(1),
        bottom: +r.bottom.toFixed(1),
      };
    };
    const overflowing = [...document.querySelectorAll('.main *')]
      .filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible')
      .slice(0, 12)
      .map((e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ')[0]}`);

    // 卡片内元素是否互相重叠（媒体、标题、meta）
    const overlaps = [];
    for (const card of [...document.querySelectorAll('.note-card')].slice(0, 40)) {
      const media = card.querySelector('.card-media');
      const info = card.querySelector('.card-info');
      if (!media || !info) continue;
      const a = media.getBoundingClientRect();
      const b = info.getBoundingClientRect();
      if (a.bottom - b.top > 1) overlaps.push({ id: card.getAttribute('aria-label')?.slice(0, 12), by: +(a.bottom - b.top).toFixed(1) });
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      app: box('.app'),
      sidebar: box('.sidebar'),
      main: box('.main'),
      header: box('.main-header'),
      results: box('.results'),
      searchBox: box('.search-box'),
      viewToggle: box('.view-toggle'),
      firstCard: box('.note-card'),
      overflowing,
      cardOverlaps: overlaps,
      masonryHeight: box('.masonry')?.h ?? null,
    };
  };
})();
