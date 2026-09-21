'use strict';

/* ============================================================
 * 工具 9：画板（无限画布白板）
 * 功能：平移缩放/双指捏合 · 便签 · 画笔 · 直线/箭头/矩形/圆(填充) · 图片
 *      多选(框选/Shift) · 复制粘贴/克隆 · Shift 约束 · 右键菜单 · 对齐参考线
 *      迷你地图 · 撤销重做 · 自动保存 · 导出 PNG/SVG/JSON · 导入 JSON
 * ============================================================ */
registerTool({
  id: 'sketch',
  name: '画板',
  desc: '无限画布白板：便签 · 画笔 · 图形 · 图片 · 连线',
  color: '#534AB7',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.2-4.2L16.8 4.2a2.15 2.15 0 0 1 3 3L8.2 18.8 4 20z"/><path d="M14.8 6.2l3 3"/></svg>',
  mount(el) {
    const PALETTE = ['#1f2328', '#E24B4A', '#EF9F27', '#1D9E75', '#378ADD'];
    const NOTE_COLORS = ['#FFF3B8', '#C9F0C5', '#BFE0FF', '#FFD9E2'];
    const TOOLS = ['select', 'pan', 'pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note'];
    const MIN_K = 0.08, MAX_K = 6, MAX_STEPS = 50;
    const DB = 'sketch:';
    const ACCENT = '#2563eb';
    const GUIDE = '#ec4899';
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const nid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const I = {
      select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 8-6.6 1.4L9.5 19 5 3z"/></svg>',
      pan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M12 2l-2.6 2.6M12 2l2.6 2.6M12 22l-2.6-2.6M12 22l2.6-2.6M2 12l2.6-2.6M2 12l2.6 2.6M22 12l-2.6-2.6M22 12l-2.6 2.6"/></svg>',
      pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.2-4.2L16.8 4.2a2.15 2.15 0 0 1 3 3L8.2 18.8 4 20z"/><path d="M14.8 6.2l3 3"/></svg>',
      line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 19.5l15-15"/></svg>',
      arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5l15-15"/><path d="M11.5 4.5h8v8"/></svg>',
      rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>',
      ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/></svg>',
      text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7V4h14v3M12 4v16M9 20h6"/></svg>',
      note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg>',
      fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 13h16v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor" stroke="none"/></svg>',
      undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5L3 10l5 5"/><path d="M3 10h10a6 6 0 0 1 6 6v3"/></svg>',
      redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5l5 5-5 5"/><path d="M21 10H11a6 6 0 0 0-6 6v3"/></svg>',
      fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
      clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
      export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 19h16"/></svg>'
    };
    const swatches = PALETTE.map(c =>
      '<button class="wb-swatch" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>'
    ).join('');

    el.innerHTML = `
      <div class="wb-wrap">
        <canvas class="wb-canvas"></canvas>
        <div class="wb-toolbar">
          <button class="wb-tbtn" data-tool="select" title="选择 (V)">${I.select}</button>
          <button class="wb-tbtn" data-tool="pan" title="平移 (H · 或按住空格拖拽)">${I.pan}</button>
          <button class="wb-tbtn" data-tool="pen" title="画笔 (P)">${I.pen}</button>
          <button class="wb-tbtn" data-tool="line" title="直线 (L)">${I.line}</button>
          <button class="wb-tbtn" data-tool="arrow" title="箭头 (A)">${I.arrow}</button>
          <button class="wb-tbtn" data-tool="rect" title="矩形 (R)">${I.rect}</button>
          <button class="wb-tbtn" data-tool="ellipse" title="圆 (O)">${I.ellipse}</button>
          <button class="wb-tbtn" data-tool="text" title="文字 (T)">${I.text}</button>
          <button class="wb-tbtn" data-tool="note" title="便签 (N)">${I.note}</button>
          <div class="wb-sep"></div>
          ${swatches}<input type="color" class="wb-color-input" title="描边/文字颜色" value="#1f2328">
          <input type="color" class="wb-fill-input" title="填充色" value="#BFE0FF">
          <button class="wb-tbtn wb-fill-btn" title="填充开/关（选中图形时直接应用）">${I.fill}</button>
          <div class="wb-sep"></div>
          <input type="range" class="wb-size" min="1" max="30" value="3" title="粗细">
          <span class="wb-size-dot"><i></i></span>
          <div class="wb-sep"></div>
          <button class="wb-tbtn wb-undo" title="撤销 (Ctrl+Z)">${I.undo}</button>
          <button class="wb-tbtn wb-redo" title="重做 (Ctrl+Shift+Z)">${I.redo}</button>
          <button class="wb-tbtn wb-fit" title="适应内容">${I.fit}</button>
          <button class="wb-tbtn wb-clear" title="清空画布">${I.clear}</button>
          <button class="wb-tbtn wb-expbtn" title="导出 / 备份">${I.export}</button>
        </div>
        <div class="wb-zoombar">
          <button class="wb-zout" title="缩小">−</button>
          <span class="wb-pct" title="点击恢复 100%">100%</span>
          <button class="wb-zin" title="放大">+</button>
        </div>
        <div class="wb-mini" title="迷你地图：点击 / 拖动可跳转"><canvas></canvas></div>
        <textarea class="wb-editor" spellcheck="false" style="display:none"></textarea>
        <div class="wb-ctx" style="display:none">
          <button data-act="copy">复制<i>Ctrl+C</i></button>
          <button data-act="paste">粘贴<i>Ctrl+V</i></button>
          <div class="wb-ctx-sep"></div>
          <button data-act="front">置顶</button>
          <button data-act="back">置底</button>
          <div class="wb-ctx-sep"></div>
          <button data-act="del" class="danger">删除<i>Del</i></button>
        </div>
        <div class="wb-ctx wb-exp" style="display:none">
          <button data-exp="png">导出 PNG</button>
          <button data-exp="pngcopy">复制 PNG 到剪贴板</button>
          <button data-exp="svg">导出 SVG</button>
          <div class="wb-ctx-sep"></div>
          <button data-exp="json">备份 JSON</button>
          <button data-exp="import">导入 JSON</button>
        </div>
        <input type="file" class="wb-file" accept="application/json,.json" style="display:none">
      </div>
      <div class="wb-foot">
        <span class="hint">框选多选 · Ctrl+C/V · Alt+拖拽克隆 · Shift 画正圆/45°线 · 双击编辑 · 右键菜单 · 图片可拖入/粘贴 · 双指缩放 · 自动保存</span>
      </div>`;

    const wrap = el.querySelector('.wb-wrap');
    const canvas = el.querySelector('.wb-canvas');
    const g = canvas.getContext('2d');
    const miniBox = el.querySelector('.wb-mini');
    const mini = miniBox.querySelector('canvas');
    const mctx = mini.getContext('2d');
    const editor = el.querySelector('.wb-editor');
    const ctxMenu = el.querySelector('.wb-ctx:not(.wb-exp)');
    const expMenu = el.querySelector('.wb-exp');
    const expBtn = el.querySelector('.wb-expbtn');
    const fileInput = el.querySelector('.wb-file');
    const fillInput = el.querySelector('.wb-fill-input');
    const fillBtn = el.querySelector('.wb-fill-btn');
    const pct = el.querySelector('.wb-pct');
    const undoBtn = el.querySelector('.wb-undo');
    const redoBtn = el.querySelector('.wb-redo');
    const colorInput = el.querySelector('.wb-color-input');
    const sizeInput = el.querySelector('.wb-size');
    const sizeDot = el.querySelector('.wb-size-dot i');

    /* ---------- 场景数据 ---------- */
    let shapes = AppStore.get(DB + 'shapes', []);
    let view = AppStore.get(DB + 'view', null) || { x: 24, y: 24, k: 1 };
    let tool = AppStore.get(DB + 'tool', 'select');
    if (TOOLS.indexOf(tool) < 0) tool = 'select';
    let color = AppStore.get(DB + 'color', '#1f2328');
    let fill = AppStore.get(DB + 'fill', null); // 新矩形的默认填充（null=无填充）
    let size = AppStore.get(DB + 'size', 3);
    let selIds = [];         // 选中图形 id 列表（支持多选）
    let marquee = null;      // {x0,y0,x1,y1,add} 框选中
    let clipboard = null;    // 复制的形状快照
    let pasteOffset = 0;     // 连续粘贴的累计偏移
    let pastePend = null;    // Ctrl+V 兜底定时器
    let draft = null;        // 正在拖拽绘制的图形
    let drag = null;         // {mode:'pan'|'marquee'|'move'|'resize'|'endpoint'|'mscale', ...}
    let editingId = null;    // 正在编辑文字的图形 id
    let guideX = null, guideY = null; // 对齐参考线（世界坐标）
    let spaceHeld = false;
    let warned = false;
    let mounted = true;
    const undoStack = [], redoStack = [];
    const pointers = new Map(); // 触屏活动指针（双指捏合用）
    let pinch = null;
    const imgCache = new Map(); // src -> Image

    /* ---------- 坐标变换 ---------- */
    const w2sX = wx => wx * view.k + view.x;
    const w2sY = wy => wy * view.k + view.y;
    const s2wX = sx => (sx - view.x) / view.k;
    const s2wY = sy => (sy - view.y) / view.k;
    function evPos(e) {
      const r = canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    }
    const wPos = p => ({ x: s2wX(p.sx), y: s2wY(p.sy) });
    const centerPt = () => ({ x: canvas.width / dpr / 2, y: canvas.height / dpr / 2 });

    /* ---------- 画布尺寸 ---------- */
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    function resizeCanvas() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      requestRender();
    }

    /* ---------- 包围盒 ---------- */
    function shapeBBox(s) {
      if (s.type === 'pen') {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of s.pts) {
          x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
        }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (s.type === 'line' || s.type === 'arrow') {
        const x0 = Math.min(s.x1, s.x2), y0 = Math.min(s.y1, s.y2);
        return { x: x0, y: y0, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
      }
      if (s.type === 'text') {
        g.save();
        g.font = s.size + 'px system-ui, sans-serif';
        const lines = String(s.text || ' ').split('\n');
        let w = 0;
        for (const ln of lines) w = Math.max(w, g.measureText(ln || ' ').width);
        g.restore();
        return { x: s.x, y: s.y, w: Math.max(w, 12), h: Math.max(lines.length, 1) * s.size * 1.4 };
      }
      return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
    }
    function unionRect(a, b) {
      if (!a) return b;
      if (!b) return a;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    }
    function contentBBox() {
      let u = null;
      for (const s of shapes) u = unionRect(u, shapeBBox(s));
      return u;
    }
    function bboxIntersect(a, b) {
      return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
    }
    const selShapes = () => shapes.filter(s => selIds.includes(s.id));
    function pruneSel() { selIds = selIds.filter(id => shapes.some(s => s.id === id)); }
    function moveShapeBy(s, dx, dy) {
      if (s.type === 'pen') { for (const pt of s.pts) { pt[0] += dx; pt[1] += dy; } }
      else if (s.type === 'line' || s.type === 'arrow') { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
      else { s.x += dx; s.y += dy; }
    }
    const editingShape = () => shapes.find(s => s.id === editingId);
    function noteBg(s) { return s.bg || NOTE_COLORS[s.ci % NOTE_COLORS.length]; }

    /* ---------- 图片资产 ----------
     * 图片不再以 base64 内联进 shapes（一张 2 MB 的图会让存档膨胀十几倍），
     * 而是落盘到 data/assets/<sha1>.<ext>，shapes 里只存资产名。
     * 渲染时把资产名换成 data URL，缓存在 assetUrls 里。
     * 浏览器模式（无 Tauri）没有文件系统，退化为原有的内联 dataURL。 */
    const assetUrls = new Map();      // 资产名 -> dataURL
    const assetPending = new Set();   // 正在取回的资产名，防重复请求

    function assetRefOf(s) { return s.asset || ''; }
    /* 取图片的可用 src：桌面端查缓存，缓存未命中就异步补并触发重绘 */
    function getImg(src) {
      let im = imgCache.get(src);
      if (!im) {
        im = new Image();
        im.onload = () => { if (mounted) requestRender(); };
        im.src = src;
        imgCache.set(src, im);
      }
      return im;
    }
    /* 把资产名解析成 data URL。返回 null 表示还没就绪（渲染时跳过该图）。 */
    function resolveAsset(name) {
      if (!name) return null;
      const cached = assetUrls.get(name);
      if (cached) return cached;
      if (!assetPending.has(name)) {
        assetPending.add(name);
        AppStore.assetGet(name).then(url => {
          assetPending.delete(name);
          if (!url) return;
          assetUrls.set(name, url);
          imgCache.delete(name);       // 清掉可能存在的失败占位，让下次重建
          if (mounted) requestRender();
        }).catch(() => { assetPending.delete(name); });
      }
      return null;
    }
    /* 画板里每个图片形状的绘制源：桌面端用资产缓存，浏览器端用内联 src */
    function imgSrcOf(s) {
      const ref = assetRefOf(s);
      if (ref) return resolveAsset(ref);
      return s.src || null;
    }

    /* ---------- 绘制 ---------- */
    function rr(c, x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
    // 便签文字按宽度逐字符断行（中英文通用）
    function wrapText(c, text, maxW) {
      const out = [];
      for (const raw of String(text).split('\n')) {
        if (!raw) { out.push(''); continue; }
        let cur = '';
        for (const ch of raw) {
          if (cur && c.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch === ' ' ? '' : ch; }
          else cur += ch;
        }
        out.push(cur);
      }
      return out.length ? out : [''];
    }
    // (c, s, k, ox, oy)：屏幕 = 世界 * k + 偏移；供主画布 / 迷你地图 / 导出复用
    function drawShape(c, s, k, ox, oy) {
      const X = wx => wx * k + ox, Y = wy => wy * k + oy;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (s.type === 'pen') {
        c.strokeStyle = s.color;
        c.fillStyle = s.color;
        c.lineWidth = Math.max(0.8, s.size * k);
        const p = s.pts;
        if (p.length === 1) {
          c.beginPath();
          c.arc(X(p[0][0]), Y(p[0][1]), Math.max(0.8, s.size * k) / 2, 0, Math.PI * 2);
          c.fill();
          return;
        }
        c.beginPath();
        c.moveTo(X(p[0][0]), Y(p[0][1]));
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
          c.quadraticCurveTo(X(p[i][0]), Y(p[i][1]), X(mx), Y(my));
        }
        c.lineTo(X(p[p.length - 1][0]), Y(p[p.length - 1][1]));
        c.stroke();
      } else if (s.type === 'line' || s.type === 'arrow') {
        c.strokeStyle = s.color;
        c.lineWidth = Math.max(0.8, s.size * k);
        c.beginPath();
        c.moveTo(X(s.x1), Y(s.y1));
        c.lineTo(X(s.x2), Y(s.y2));
        c.stroke();
        if (s.type === 'arrow') {
          const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
          const hl = Math.max(9, s.size * 3.4) * k;
          c.beginPath();
          c.moveTo(X(s.x2), Y(s.y2));
          c.lineTo(X(s.x2) - hl * Math.cos(ang - 0.42), Y(s.y2) - hl * Math.sin(ang - 0.42));
          c.moveTo(X(s.x2), Y(s.y2));
          c.lineTo(X(s.x2) - hl * Math.cos(ang + 0.42), Y(s.y2) - hl * Math.sin(ang + 0.42));
          c.stroke();
        }
      } else if (s.type === 'rect') {
        c.strokeStyle = s.color;
        c.lineWidth = Math.max(0.8, s.size * k);
        const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
        rr(c, X(x), Y(y), Math.abs(s.w) * k, Math.abs(s.h) * k, 4 * k);
        if (s.fill) { c.fillStyle = s.fill; c.fill(); }
        c.stroke();
      } else if (s.type === 'ellipse') {
        c.strokeStyle = s.color;
        c.lineWidth = Math.max(0.8, s.size * k);
        c.beginPath();
        c.ellipse(X(s.x + s.w / 2), Y(s.y + s.h / 2), Math.abs(s.w) * k / 2, Math.abs(s.h) * k / 2, 0, 0, Math.PI * 2);
        if (s.fill) { c.fillStyle = s.fill; c.fill(); }
        c.stroke();
      } else if (s.type === 'image') {
        /* 资产还没取回来时 imgSrcOf 返回 null —— 跳过这一帧，
         * 取回后会 requestRender 重绘，不会留下空白。 */
        const src = imgSrcOf(s);
        const im = src ? getImg(src) : null;
        if (im && im.complete && im.naturalWidth)
          c.drawImage(im, X(Math.min(s.x, s.x + s.w)), Y(Math.min(s.y, s.y + s.h)), Math.abs(s.w) * k, Math.abs(s.h) * k);
      } else if (s.type === 'text') {
        c.fillStyle = s.color;
        c.font = (s.size * k) + 'px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        c.textBaseline = 'top';
        const lines = String(s.text || '').split('\n');
        for (let i = 0; i < lines.length; i++) c.fillText(lines[i], X(s.x), Y(s.y + i * s.size * 1.4));
      } else if (s.type === 'note') {
        const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
        const w = Math.abs(s.w) * k, h = Math.abs(s.h) * k;
        c.save();
        rr(c, X(x), Y(y), w, h, 6 * k);
        c.fillStyle = noteBg(s);
        c.fill();
        c.strokeStyle = 'rgba(0,0,0,.1)';
        c.lineWidth = 1;
        c.stroke();
        c.clip();
        c.fillStyle = '#4a4534';
        const fs = s.fs || 14;
        c.font = (fs * k) + 'px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        c.textBaseline = 'top';
        const lines = wrapText(c, String(s.text || ''), Math.abs(s.w) - 20);
        const lh = fs * 1.45;
        for (let i = 0; i < lines.length; i++) {
          const ty = y + 10 + i * lh;
          if (ty > y + Math.abs(s.h) - 6) break; // 超高截断（clip 已兜底）
          c.fillText(lines[i], X(x + 10), Y(ty));
        }
        c.restore();
      }
    }
    function drawGrid() {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      let step = 24;
      while (step * view.k < 18) step *= 2;
      while (step * view.k > 64) step /= 2;
      g.fillStyle = '#d3d7dd';
      const wx1 = s2wX(canvas.width / dpr), wy1 = s2wY(canvas.height / dpr);
      for (let wx = Math.floor(s2wX(0) / step) * step; wx <= wx1; wx += step)
        for (let wy = Math.floor(s2wY(0) / step) * step; wy <= wy1; wy += step) {
          g.beginPath();
          g.arc(w2sX(wx), w2sY(wy), 1.1, 0, Math.PI * 2);
          g.fill();
        }
    }
    function cornerHandles(b) {
      return [
        [w2sX(b.x), w2sY(b.y)], [w2sX(b.x + b.w), w2sY(b.y)],
        [w2sX(b.x), w2sY(b.y + b.h)], [w2sX(b.x + b.w), w2sY(b.y + b.h)]
      ];
    }
    function noteDots(s) {
      const b = shapeBBox(s);
      const cx = w2sX(b.x + b.w / 2), cy = w2sY(b.y) - 18;
      return NOTE_COLORS.map((c, i) => ({ c, i, x: cx + (i - (NOTE_COLORS.length - 1) / 2) * 18, y: cy }));
    }
    function drawSelection() {
      if (marquee) {
        const mx = Math.min(marquee.x0, marquee.x1), my = Math.min(marquee.y0, marquee.y1);
        const mw = Math.abs(marquee.x1 - marquee.x0), mh = Math.abs(marquee.y1 - marquee.y0);
        g.fillStyle = 'rgba(37,99,235,.08)';
        g.fillRect(w2sX(mx), w2sY(my), mw * view.k, mh * view.k);
        g.strokeStyle = ACCENT;
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.strokeRect(w2sX(mx), w2sY(my), mw * view.k, mh * view.k);
        g.setLineDash([]);
      }
      const list = selShapes();
      if (!list.length) return;
      if (list.some(s => s.id === editingId)) return; // 编辑中不画手柄
      g.lineWidth = 1;
      g.strokeStyle = ACCENT;
      g.fillStyle = '#ffffff';
      if (list.length > 1) {
        let u = null;
        for (const s of list) u = unionRect(u, shapeBBox(s));
        g.strokeRect(w2sX(u.x) - 3, w2sY(u.y) - 3, u.w * view.k + 6, u.h * view.k + 6);
        for (const [hx, hy] of cornerHandles(u)) {
          g.beginPath();
          g.rect(hx - 4, hy - 4, 8, 8);
          g.fill();
          g.stroke();
        }
        return;
      }
      const s = list[0];
      const b = shapeBBox(s);
      g.strokeRect(w2sX(b.x) - 3, w2sY(b.y) - 3, b.w * view.k + 6, b.h * view.k + 6);
      if (s.type === 'line' || s.type === 'arrow') {
        for (const [ex, ey] of [[s.x1, s.y1], [s.x2, s.y2]]) {
          g.beginPath();
          g.arc(w2sX(ex), w2sY(ey), 5, 0, Math.PI * 2);
          g.fillStyle = '#ffffff';
          g.fill();
          g.strokeStyle = ACCENT;
          g.stroke();
          g.fillStyle = '#ffffff';
        }
      } else {
        for (const [hx, hy] of cornerHandles(b)) {
          g.beginPath();
          g.rect(hx - 4, hy - 4, 8, 8);
          g.fill();
          g.strokeStyle = ACCENT;
          g.stroke();
        }
      }
      if (s.type === 'note') {
        for (const d of noteDots(s)) {
          g.beginPath();
          g.arc(d.x, d.y, 7, 0, Math.PI * 2);
          g.fillStyle = d.c;
          g.fill();
          g.lineWidth = 1.5;
          g.strokeStyle = d.i === s.ci % NOTE_COLORS.length ? ACCENT : 'rgba(0,0,0,.15)';
          g.stroke();
        }
      }
    }
    function drawGuides() {
      if (guideX == null && guideY == null) return;
      const cw = canvas.width / dpr, ch = canvas.height / dpr;
      g.strokeStyle = GUIDE;
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      if (guideX != null) {
        g.beginPath();
        g.moveTo(w2sX(guideX), 0);
        g.lineTo(w2sX(guideX), ch);
        g.stroke();
      }
      if (guideY != null) {
        g.beginPath();
        g.moveTo(0, w2sY(guideY));
        g.lineTo(cw, w2sY(guideY));
        g.stroke();
      }
      g.setLineDash([]);
    }

    /* ---------- 渲染循环 ---------- */
    let renderQueued = false;
    function requestRender() {
      if (renderQueued || !mounted) return;
      renderQueued = true;
      requestAnimationFrame(render);
    }
    function render() {
      renderQueued = false;
      if (!mounted || !canvas.width) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGrid();
      for (const s of shapes) {
        if (s.id === editingId) continue;
        drawShape(g, s, view.k, view.x, view.y);
      }
      if (draft) drawShape(g, draft, view.k, view.x, view.y);
      drawSelection();
      drawGuides();
      renderMini();
      pct.textContent = Math.round(view.k * 100) + '%';
    }
    function renderMini() {
      const W = 160 * 2, H = 100 * 2;
      if (mini.width !== W) { mini.width = W; mini.height = H; }
      const mc = mctx;
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.clearRect(0, 0, W, H);
      const vp = { x: s2wX(0), y: s2wY(0), w: canvas.width / dpr / view.k, h: canvas.height / dpr / view.k };
      const u = unionRect(contentBBox(), vp);
      const pad = 10;
      const k = Math.min((W - pad * 2) / Math.max(u.w, 1), (H - pad * 2) / Math.max(u.h, 1));
      const ox = (W - u.w * k) / 2 - u.x * k, oy = (H - u.h * k) / 2 - u.y * k;
      const MX = wx => wx * k + ox, MY = wy => wy * k + oy;
      for (const s of shapes) {
        const sb = shapeBBox(s);
        if (s.type === 'note') {
          mc.fillStyle = noteBg(s);
          mc.fillRect(MX(sb.x), MY(sb.y), Math.max(2, sb.w * k), Math.max(2, sb.h * k));
        } else if (s.type === 'text') {
          mc.fillStyle = '#9aa1ab';
          mc.fillRect(MX(sb.x), MY(sb.y), Math.max(4, sb.w * k), Math.max(2, sb.h * k));
        } else if (s.type === 'image') {
          mc.fillStyle = '#c8cdd5';
          mc.fillRect(MX(sb.x), MY(sb.y), Math.max(3, sb.w * k), Math.max(2, sb.h * k));
        } else if (s.type === 'pen') {
          mc.strokeStyle = s.color;
          mc.lineWidth = 1.5;
          mc.beginPath();
          const p = s.pts;
          const stepN = Math.max(1, Math.floor(p.length / 24));
          mc.moveTo(MX(p[0][0]), MY(p[0][1]));
          for (let i = stepN; i < p.length; i += stepN) mc.lineTo(MX(p[i][0]), MY(p[i][1]));
          mc.lineTo(MX(p[p.length - 1][0]), MY(p[p.length - 1][1]));
          mc.stroke();
        } else if (s.type === 'line' || s.type === 'arrow') {
          mc.strokeStyle = s.color;
          mc.lineWidth = 1.5;
          mc.beginPath();
          mc.moveTo(MX(s.x1), MY(s.y1));
          mc.lineTo(MX(s.x2), MY(s.y2));
          mc.stroke();
        } else if (s.type === 'ellipse') {
          mc.beginPath();
          mc.ellipse(MX(sb.x + sb.w / 2), MY(sb.y + sb.h / 2), Math.max(1, sb.w * k / 2), Math.max(1, sb.h * k / 2), 0, 0, Math.PI * 2);
          if (s.fill) { mc.fillStyle = s.fill; mc.fill(); }
          mc.strokeStyle = s.color;
          mc.lineWidth = 1.5;
          mc.stroke();
        } else {
          if (s.fill) {
            mc.fillStyle = s.fill;
            mc.fillRect(MX(sb.x), MY(sb.y), Math.max(2, sb.w * k), Math.max(2, sb.h * k));
          }
          mc.strokeStyle = s.color;
          mc.lineWidth = 1.5;
          mc.strokeRect(MX(sb.x), MY(sb.y), Math.max(2, sb.w * k), Math.max(2, sb.h * k));
        }
      }
      mc.strokeStyle = ACCENT;
      mc.lineWidth = 1.5;
      mc.strokeRect(MX(vp.x), MY(vp.y), vp.w * k, vp.h * k);
      mini._map = { k, ox, oy };
    }

    /* ---------- 命中检测 ---------- */
    function distToSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    function hitShape(wx, wy) {
      const pad = 8 / view.k;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        if (s.type === 'pen') {
          const th = pad + s.size / 2;
          let ok = false;
          if (s.pts.length === 1) ok = Math.hypot(wx - s.pts[0][0], wy - s.pts[0][1]) <= th;
          else for (let j = 0; j < s.pts.length - 1; j++) {
            if (distToSeg(wx, wy, s.pts[j][0], s.pts[j][1], s.pts[j + 1][0], s.pts[j + 1][1]) <= th) { ok = true; break; }
          }
          if (ok) return s;
        } else if (s.type === 'line' || s.type === 'arrow') {
          if (distToSeg(wx, wy, s.x1, s.y1, s.x2, s.y2) <= pad + s.size / 2) return s;
        } else {
          const b = shapeBBox(s);
          if (wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad) return s;
        }
      }
      return null;
    }
    function hitHandle(sx, sy) {
      const list = selShapes();
      if (!list.length) return null;
      if (list.length > 1) {
        let u = null;
        for (const s of list) u = unionRect(u, shapeBBox(s));
        const pts = [[u.x, u.y, 'nw'], [u.x + u.w, u.y, 'ne'], [u.x, u.y + u.h, 'sw'], [u.x + u.w, u.y + u.h, 'se']];
        for (const [wx, wy, kind] of pts)
          if (Math.hypot(sx - w2sX(wx), sy - w2sY(wy)) <= 9) return { kind, b: u, multi: true };
        return null;
      }
      const s = list[0];
      if (s.type === 'line' || s.type === 'arrow') {
        if (Math.hypot(sx - w2sX(s.x1), sy - w2sY(s.x1)) <= 9) return { kind: 'p1' };
        if (Math.hypot(sx - w2sX(s.x2), sy - w2sY(s.x2)) <= 9) return { kind: 'p2' };
        return null;
      }
      const b = shapeBBox(s);
      const pts = [[b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'], [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se']];
      for (const [wx, wy, kind] of pts)
        if (Math.hypot(sx - w2sX(wx), sy - w2sY(wy)) <= 9) return { kind, b };
      return null;
    }
    function noteDotHit(sx, sy) {
      if (selIds.length !== 1) return -1;
      const s = shapes.find(x => x.id === selIds[0]);
      if (!s || s.type !== 'note') return -1;
      for (const d of noteDots(s)) if (Math.hypot(sx - d.x, sy - d.y) <= 9) return d.i;
      return -1;
    }

    /* ---------- 撤销 / 重做 / 保存 ---------- */
    function updateBtns() {
      undoBtn.disabled = !undoStack.length;
      redoBtn.disabled = !redoStack.length;
    }
    function pushUndo() {
      undoStack.push(JSON.stringify(shapes));
      if (undoStack.length > MAX_STEPS) undoStack.shift();
      redoStack.length = 0;
      updateBtns();
    }
    function popUndo() { undoStack.pop(); updateBtns(); }
    function undo() {
      if (!undoStack.length || editingId) return;
      redoStack.push(JSON.stringify(shapes));
      shapes = JSON.parse(undoStack.pop());
      pruneSel();
      updateBtns();
      requestRender();
      scheduleSave();
    }
    function redo() {
      if (!redoStack.length || editingId) return;
      undoStack.push(JSON.stringify(shapes));
      shapes = JSON.parse(redoStack.pop());
      pruneSel();
      updateBtns();
      requestRender();
      scheduleSave();
    }
    let saveTimer = null;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!mounted) return;
        AppStore.set(DB + 'shapes', shapes);
        AppStore.set(DB + 'view', view);
        // 等这一批真的落盘再判断，拿到的是本次的结果而不是上一次的。
        // 形状和视图一起等，一次失败只提醒一遍。
        AppStore.flush().then(() => {
          if (!mounted || !AppStore.lastError() || warned) return;
          warned = true;
          showToast('画板内容较大，自动保存失败，请及时导出 PNG / JSON 备份');
        });
      }, 400);
    }

    /* ---------- 视图操作 ---------- */
    function zoomAt(sx, sy, factor) {
      commitEditor();
      const k2 = clamp(view.k * factor, MIN_K, MAX_K);
      if (k2 === view.k) return;
      const wx = s2wX(sx), wy = s2wY(sy);
      view.k = k2;
      view.x = sx - wx * k2;
      view.y = sy - wy * k2;
      requestRender();
      scheduleSave();
    }
    function fitView() {
      commitEditor();
      const cw = canvas.width / dpr, ch = canvas.height / dpr;
      const b = contentBBox();
      if (!b || b.w <= 1 || b.h <= 1) {
        view = { x: cw / 2, y: ch / 2, k: 1 };
      } else {
        const pad = 50;
        const k = clamp(Math.min((cw - pad * 2) / b.w, (ch - pad * 2) / b.h), MIN_K, 1.5);
        view = { k, x: cw / 2 - (b.x + b.w / 2) * k, y: ch / 2 - (b.y + b.h / 2) * k };
      }
      requestRender();
      scheduleSave();
    }
    function centerOn(wx, wy) {
      view.x = canvas.width / dpr / 2 - wx * view.k;
      view.y = canvas.height / dpr / 2 - wy * view.k;
      requestRender();
      scheduleSave();
    }

    /* ---------- 多选 / 复制粘贴 / 层级 ---------- */
    function cloneSel() {
      if (!selIds.length) return;
      const clones = selShapes().map(s => {
        const c = JSON.parse(JSON.stringify(s));
        c.id = nid();
        return c;
      });
      shapes.push(...clones);
      selIds = clones.map(c => c.id);
    }
    function doCopy() {
      const list = selShapes();
      if (!list.length) return;
      clipboard = JSON.parse(JSON.stringify(list));
      pasteOffset = 0;
    }
    function doPaste(atWx, atWy) {
      if (!clipboard || !clipboard.length) return;
      pushUndo();
      const clones = clipboard.map(s => {
        const c = JSON.parse(JSON.stringify(s));
        c.id = nid();
        return c;
      });
      let u = null;
      for (const c of clones) u = unionRect(u, shapeBBox(c));
      let dx, dy;
      if (typeof atWx === 'number') {
        dx = atWx - u.x;
        dy = atWy - u.y;
      } else {
        pasteOffset++;
        const off = 20 / view.k * pasteOffset;
        dx = off; dy = off;
      }
      for (const c of clones) moveShapeBy(c, dx, dy);
      shapes.push(...clones);
      selIds = clones.map(c => c.id);
      if (typeof atWx !== 'number') {
        const cx = w2sX(u.x + u.w / 2), cy = w2sY(u.y + u.h / 2);
        if (cx < 0 || cy < 0 || cx > canvas.width / dpr || cy > canvas.height / dpr)
          centerOn(u.x + u.w / 2, u.y + u.h / 2);
      }
      requestRender();
      scheduleSave();
    }
    function deleteSelected() {
      if (!selIds.length) return;
      pushUndo();
      shapes = shapes.filter(s => !selIds.includes(s.id));
      selIds = [];
      requestRender();
      scheduleSave();
    }
    function bringToFront() {
      if (!selIds.length) return;
      pushUndo();
      const tops = selShapes();
      shapes = shapes.filter(s => !selIds.includes(s.id)).concat(tops);
      requestRender();
      scheduleSave();
    }
    function sendToBack() {
      if (!selIds.length) return;
      pushUndo();
      const bots = selShapes();
      shapes = bots.concat(shapes.filter(s => !selIds.includes(s.id)));
      requestRender();
      scheduleSave();
    }

    /* ---------- 文字编辑浮层 ---------- */
    function openEditor(s, isText) {
      editingId = s.id;
      editor.style.display = 'block';
      editor.value = s.text || '';
      const k = view.k;
      if (isText) {
        editor.style.background = 'transparent';
        editor.style.color = s.color;
        editor.style.fontSize = (s.size * k) + 'px';
        editor.style.lineHeight = (s.size * 1.4 * k) + 'px';
        editor.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        editor.style.padding = '0px';
        editor.style.whiteSpace = 'pre';
      } else {
        editor.style.background = noteBg(s);
        editor.style.color = '#4a4534';
        editor.style.fontSize = ((s.fs || 14) * k) + 'px';
        editor.style.lineHeight = ((s.fs || 14) * 1.45 * k) + 'px';
        editor.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        editor.style.padding = Math.round(10 * k) + 'px';
        editor.style.whiteSpace = 'pre-wrap';
      }
      const bx = isText ? s.x : Math.min(s.x, s.x + s.w);
      const by = isText ? s.y : Math.min(s.y, s.y + s.h);
      editor.style.left = w2sX(bx) + 'px';
      editor.style.top = w2sY(by) + 'px';
      autoEditorSize();
      requestRender();
      editor.focus();
      editor.select();
    }
    function autoEditorSize() {
      const s = editingShape();
      if (!s) return;
      const k = view.k;
      if (s.type === 'note') {
        editor.style.width = (Math.abs(s.w) * k + 20 * k + 6) + 'px';
      } else {
        editor.style.width = '10px';
        editor.style.width = clamp(editor.scrollWidth + 10, 80, 560) + 'px';
      }
      editor.style.height = '0px';
      editor.style.height = Math.max(editor.scrollHeight, 30) + 'px';
    }
    function commitEditor() {
      if (!editingId) return;
      const s = editingShape();
      editingId = null;
      editor.style.display = 'none';
      if (!s) return;
      const val = editor.value.replace(/\s+$/, '');
      if (!val) {
        if (s.type === 'text') {
          shapes.splice(shapes.indexOf(s), 1);
          popUndo();
          selIds = selIds.filter(id => id !== s.id);
        } else {
          s.text = '';
        }
      } else {
        s.text = val;
      }
      requestRender();
      scheduleSave();
    }
    editor.addEventListener('blur', commitEditor);
    editor.addEventListener('input', autoEditorSize);
    editor.addEventListener('keydown', e => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        editor.blur();
      }
      e.stopPropagation();
    });

    /* ---------- 指针交互 ---------- */
    function updateCursor(p) {
      let cur = { select: 'default', pan: 'grab', pen: 'crosshair', line: 'crosshair', arrow: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', text: 'text', note: 'crosshair' }[tool] || 'default';
      if (spaceHeld) cur = 'grab';
      else if (p && tool === 'select' && !drag) {
        if (hitHandle(p.sx, p.sy)) cur = 'nwse-resize';
        else if (hitShape(wPos(p).x, wPos(p).y)) cur = 'move';
      }
      canvas.style.cursor = cur;
    }
    canvas.addEventListener('pointerdown', e => {
      if (e.button === 2) return; // 右键交给 contextmenu
      commitEditor();
      closeCtxMenu();
      closeExpMenu();
      const p = evPos(e);
      if (e.pointerType === 'touch') pointers.set(e.pointerId, p);
      if (pointers.size === 2) { // 双指：取消当前手势，进入捏合
        if (draft) { popUndo(); draft = null; }
        if (drag && drag.mode === 'marquee') marquee = null;
        drag = null;
        guideX = guideY = null;
        const ps = [...pointers.values()];
        pinch = {
          c0: { x: (ps[0].sx + ps[1].sx) / 2, y: (ps[0].sy + ps[1].sy) / 2 },
          d0: Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy) || 1,
          view0: { x: view.x, y: view.y, k: view.k }
        };
        requestRender();
        return;
      }
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      const w = wPos(p);
      if (e.button === 1 || spaceHeld || tool === 'pan') {
        drag = { mode: 'pan', sx: p.sx, sy: p.sy, vx: view.x, vy: view.y };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (tool === 'select') {
        if (selIds.length === 1) {
          const nd = noteDotHit(p.sx, p.sy);
          if (nd >= 0) {
            pushUndo();
            const sn = shapes.find(x => x.id === selIds[0]);
            if (sn) sn.ci = nd;
            requestRender();
            scheduleSave();
            return;
          }
        }
        const hnd = hitHandle(p.sx, p.sy);
        const s = hitShape(w.x, w.y);
        if (hnd) {
          pushUndo();
          if (hnd.kind === 'p1' || hnd.kind === 'p2') {
            drag = { mode: 'endpoint', hnd: hnd.kind };
          } else if (hnd.multi) {
            drag = {
              mode: 'mscale', kind: hnd.kind, b: hnd.b,
              items: selShapes().map(x => ({ live: x, snap: JSON.parse(JSON.stringify(x)) }))
            };
          } else {
            const sel = selShapes()[0];
            drag = {
              mode: 'resize', kind: hnd.kind, b: hnd.b, s: sel,
              s0: { size: sel.size },
              pts0: sel.type === 'pen' ? JSON.parse(JSON.stringify(sel.pts)) : null
            };
          }
        } else if (s) {
          if (e.shiftKey) {
            if (selIds.includes(s.id)) selIds = selIds.filter(id => id !== s.id);
            else selIds.push(s.id);
            requestRender();
            return;
          }
          if (!selIds.includes(s.id)) {
            selIds = [s.id];
            requestRender();
          }
          pushUndo();
          if (e.altKey) cloneSel();
          drag = startMoveDrag(w);
        } else {
          if (!e.shiftKey) selIds = [];
          requestRender();
          marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, add: !!e.shiftKey };
          drag = { mode: 'marquee' };
        }
        return;
      }
      if (tool === 'pen') {
        pushUndo();
        draft = { id: nid(), type: 'pen', color, size, pts: [[w.x, w.y]] };
        requestRender();
        return;
      }
      if (tool === 'line' || tool === 'arrow') {
        pushUndo();
        draft = { id: nid(), type: tool, color, size, x1: w.x, y1: w.y, x2: w.x, y2: w.y };
        requestRender();
        return;
      }
      if (tool === 'rect' || tool === 'ellipse') {
        pushUndo();
        draft = { id: nid(), type: tool, color, size, fill, x: w.x, y: w.y, w: 0, h: 0 };
        requestRender();
        return;
      }
      if (tool === 'text') {
        pushUndo();
        const s = { id: nid(), type: 'text', x: w.x, y: w.y - 10, size: 16, color, text: '' };
        shapes.push(s);
        selIds = [s.id];
        openEditor(s, true);
        return;
      }
      if (tool === 'note') {
        pushUndo();
        const i = AppStore.get(DB + 'nci', 0);
        AppStore.set(DB + 'nci', i + 1);
        const s = { id: nid(), type: 'note', x: w.x - 80, y: w.y - 60, w: 160, h: 120, ci: i, fs: 14, text: '' };
        shapes.push(s);
        selIds = [s.id];
        openEditor(s, false);
        return;
      }
    });
    // 移动用：起点 + 快照 + 吸附线集合（绝对式，从快照重算）
    function startMoveDrag(w) {
      const d = {
        mode: 'move', sx0: w.x, sy0: w.y,
        items: selShapes().map(x => ({ live: x, snap: JSON.parse(JSON.stringify(x)) })),
        linesX: [], linesY: []
      };
      let u = null;
      for (const x of d.items) u = unionRect(u, shapeBBox(x.snap));
      d.bb0 = u || { x: 0, y: 0, w: 0, h: 0 };
      for (const s of shapes) {
        if (selIds.includes(s.id)) continue;
        const b = shapeBBox(s);
        d.linesX.push(b.x, b.x + b.w / 2, b.x + b.w);
        d.linesY.push(b.y, b.y + b.h / 2, b.y + b.h);
      }
      return d;
    }
    canvas.addEventListener('pointermove', e => {
      const p = evPos(e);
      if (e.pointerType === 'touch' && pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch) { // 双指捏合缩放 + 平移
        if (pointers.size >= 2) {
          const ps = [...pointers.values()];
          const c = { x: (ps[0].sx + ps[1].sx) / 2, y: (ps[0].sy + ps[1].sy) / 2 };
          const d = Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy) || 1;
          const k2 = clamp(pinch.view0.k * d / pinch.d0, MIN_K, MAX_K);
          view.k = k2;
          view.x = c.x - (pinch.c0.x - pinch.view0.x) / pinch.view0.k * k2;
          view.y = c.y - (pinch.c0.y - pinch.view0.y) / pinch.view0.k * k2;
          requestRender();
          scheduleSave();
          return;
        }
        pinch = null;
      }
      if (!drag && !draft) { updateCursor(p); return; }
      const w = wPos(p);
      if (drag) {
        if (drag.mode === 'pan') {
          view.x = drag.vx + (p.sx - drag.sx);
          view.y = drag.vy + (p.sy - drag.sy);
          requestRender();
          scheduleSave();
        } else if (drag.mode === 'marquee') {
          drag.moved = true;
          marquee.x1 = w.x;
          marquee.y1 = w.y;
          requestRender();
        } else if (drag.mode === 'move') {
          if (!selIds.length) return;
          drag.moved = true;
          let DX = w.x - drag.sx0, DY = w.y - drag.sy0;
          // 对齐吸附：被拖 bbox 三线 vs 其他图形三线
          const thr = 6 / view.k;
          const bx = drag.bb0.x + DX, by = drag.bb0.y + DY;
          let bestX = null, bestY = null;
          for (const lx of drag.linesX)
            for (const cand of [bx, bx + drag.bb0.w / 2, bx + drag.bb0.w]) {
              const d = lx - cand;
              if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, lx };
            }
          for (const ly of drag.linesY)
            for (const cand of [by, by + drag.bb0.h / 2, by + drag.bb0.h]) {
              const d = ly - cand;
              if (Math.abs(d) <= thr && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, ly };
            }
          if (bestX) { DX += bestX.d; guideX = bestX.lx; } else guideX = null;
          if (bestY) { DY += bestY.d; guideY = bestY.ly; } else guideY = null;
          for (const it of drag.items) {
            const s = it.live, sn = it.snap;
            if (s.type === 'pen') s.pts = sn.pts.map(pp => [pp[0] + DX, pp[1] + DY]);
            else if (s.type === 'line' || s.type === 'arrow') {
              s.x1 = sn.x1 + DX; s.y1 = sn.y1 + DY;
              s.x2 = sn.x2 + DX; s.y2 = sn.y2 + DY;
            } else { s.x = sn.x + DX; s.y = sn.y + DY; }
          }
          requestRender();
          scheduleSave();
        } else if (drag.mode === 'mscale') {
          drag.moved = true;
          scaleGroup(drag, w.x, w.y);
          requestRender();
          scheduleSave();
        } else if (drag.mode === 'resize') {
          drag.moved = true;
          resizeShape(drag, w.x, w.y);
          requestRender();
          scheduleSave();
        } else if (drag.mode === 'endpoint') {
          const s = selShapes()[0];
          if (!s) return;
          drag.moved = true;
          if (drag.hnd === 'p1') { s.x1 = w.x; s.y1 = w.y; }
          else { s.x2 = w.x; s.y2 = w.y; }
          requestRender();
          scheduleSave();
        }
        return;
      }
      if (draft) {
        if (draft.type === 'pen') {
          const pts = draft.pts;
          const lastP = pts[pts.length - 1];
          if (Math.hypot(w.x - lastP[0], w.y - lastP[1]) * view.k >= 2) pts.push([w.x, w.y]);
        } else if (draft.type === 'line' || draft.type === 'arrow') {
          let dx = w.x - draft.x1, dy = w.y - draft.y1;
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            dx = Math.cos(ang) * len;
            dy = Math.sin(ang) * len;
          }
          draft.x2 = draft.x1 + dx;
          draft.y2 = draft.y1 + dy;
        } else {
          let dw = w.x - draft.x, dh = w.y - draft.y;
          if (e.shiftKey) {
            const m = Math.max(Math.abs(dw), Math.abs(dh));
            dw = Math.sign(dw || 1) * m;
            dh = Math.sign(dh || 1) * m;
          }
          draft.w = dw;
          draft.h = dh;
        }
        requestRender();
      }
    });
    function commitDraft() {
      let made = null;
      if (draft.type === 'pen') {
        made = draft;
        shapes.push(made);
      } else if (draft.type === 'line' || draft.type === 'arrow') {
        if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 4 / view.k) {
          made = draft;
          shapes.push(made);
        } else popUndo();
      } else {
        const x = Math.min(draft.x, draft.x + draft.w), y = Math.min(draft.y, draft.y + draft.h);
        const w = Math.abs(draft.w), h = Math.abs(draft.h);
        if (w > 4 / view.k && h > 4 / view.k) {
          made = Object.assign({}, draft, { x, y, w, h });
          shapes.push(made);
        } else popUndo();
      }
      if (made && draft.type !== 'pen') {
        selIds = [made.id];
        setTool('select');
      }
      scheduleSave();
    }
    function resizeShape(d, wx, wy) {
      const s = d.s, b = d.b;
      let ax, ay; // 对角锚点
      if (d.kind === 'se') { ax = b.x; ay = b.y; }
      else if (d.kind === 'nw') { ax = b.x + b.w; ay = b.y + b.h; }
      else if (d.kind === 'ne') { ax = b.x; ay = b.y + b.h; }
      else { ax = b.x + b.w; ay = b.y; }
      if (s.type === 'text') {
        const fx = b.w > 0 ? (wx - b.x) / b.w : 1;
        const fy = b.h > 0 ? (wy - b.y) / b.h : 1;
        s.size = clamp(d.s0.size * clamp((fx + fy) / 2, 0.1, 10), 8, 200);
        return;
      }
      if (s.type === 'pen') {
        const fx = clamp(b.w > 0 ? (wx - ax) / (d.kind === 'se' || d.kind === 'ne' ? b.w : -b.w) : 1, 0.02, 20);
        const fy = clamp(b.h > 0 ? (wy - ay) / (d.kind === 'se' || d.kind === 'sw' ? b.h : -b.h) : 1, 0.02, 20);
        s.pts = d.pts0.map(p => [ax + (p[0] - ax) * fx, ay + (p[1] - ay) * fy]);
        return;
      }
      s.x = Math.min(ax, wx);
      s.y = Math.min(ay, wy);
      s.w = Math.max(12, Math.abs(wx - ax));
      s.h = Math.max(12, Math.abs(wy - ay));
    }
    // 多选整体缩放：从快照重算，避免累积误差
    function scaleGroup(d, wx, wy) {
      const b = d.b;
      let ax, ay;
      if (d.kind === 'se') { ax = b.x; ay = b.y; }
      else if (d.kind === 'nw') { ax = b.x + b.w; ay = b.y + b.h; }
      else if (d.kind === 'ne') { ax = b.x; ay = b.y + b.h; }
      else { ax = b.x + b.w; ay = b.y; }
      const fx = clamp(b.w > 0 ? (wx - ax) / (d.kind === 'se' || d.kind === 'ne' ? b.w : -b.w) : 1, 0.05, 20);
      const fy = clamp(b.h > 0 ? (wy - ay) / (d.kind === 'se' || d.kind === 'sw' ? b.h : -b.h) : 1, 0.05, 20);
      for (const it of d.items) {
        const s = it.live, sn = it.snap;
        if (s.type === 'pen') {
          s.pts = sn.pts.map(p => [ax + (p[0] - ax) * fx, ay + (p[1] - ay) * fy]);
        } else if (s.type === 'line' || s.type === 'arrow') {
          s.x1 = ax + (sn.x1 - ax) * fx; s.y1 = ay + (sn.y1 - ay) * fy;
          s.x2 = ax + (sn.x2 - ax) * fx; s.y2 = ay + (sn.y2 - ay) * fy;
        } else if (s.type === 'text') {
          s.x = ax + (sn.x - ax) * fx;
          s.y = ay + (sn.y - ay) * fy;
          s.size = clamp(sn.size * clamp((fx + fy) / 2, 0.1, 10), 8, 200);
        } else {
          s.x = ax + (sn.x - ax) * fx;
          s.y = ay + (sn.y - ay) * fy;
          s.w = Math.max(12, sn.w * fx);
          s.h = Math.max(12, sn.h * fy);
        }
      }
    }
    const endPointer = e => {
      if (e && e.pointerType === 'touch') pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        requestRender();
        return;
      }
      if (draft) {
        commitDraft();
        draft = null;
      }
      if (drag) {
        if (drag.mode === 'marquee') {
          const m = marquee;
          marquee = null;
          if (m) {
            const rx = Math.min(m.x0, m.x1), ry = Math.min(m.y0, m.y1);
            const rw = Math.abs(m.x1 - m.x0), rh = Math.abs(m.y1 - m.y0);
            if (rw * view.k < 4 && rh * view.k < 4) {
              if (!m.add) selIds = []; // 视为点击空白
            } else {
              const rect = { x: rx, y: ry, w: rw, h: rh };
              const hit = shapes.filter(s => bboxIntersect(shapeBBox(s), rect));
              if (m.add) {
                const ids = new Set(selIds);
                for (const s of hit) ids.add(s.id);
                selIds = Array.from(ids);
              } else {
                selIds = hit.map(s => s.id);
              }
            }
          }
        } else if (drag.mode !== 'pan' && !drag.moved) {
          popUndo();
        }
        drag = null;
      }
      guideX = guideY = null;
      updateCursor();
      requestRender();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    /* 双击编辑 */
    canvas.addEventListener('dblclick', e => {
      const p = evPos(e), w = wPos(p);
      const s = hitShape(w.x, w.y);
      if (s && (s.type === 'text' || s.type === 'note')) {
        selIds = [s.id];
        pushUndo();
        openEditor(s, s.type === 'text');
      }
    });

    /* ---------- 右键菜单 ---------- */
    let ctxW = null; // 右键时鼠标的世界坐标（粘贴定位用）
    function refreshCtxMenu() {
      const has = selIds.length > 0;
      ctxMenu.querySelector('[data-act="copy"]').disabled = !has;
      ctxMenu.querySelector('[data-act="front"]').disabled = !has;
      ctxMenu.querySelector('[data-act="back"]').disabled = !has;
      ctxMenu.querySelector('[data-act="del"]').disabled = !has;
      ctxMenu.querySelector('[data-act="paste"]').disabled = !(clipboard && clipboard.length);
    }
    function openCtxMenu(e) {
      ctxMenu.style.display = 'flex';
      refreshCtxMenu();
      const r = wrap.getBoundingClientRect();
      const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
      ctxMenu.style.left = Math.max(8, Math.min(e.clientX - r.left, r.width - mw - 8)) + 'px';
      ctxMenu.style.top = Math.max(8, Math.min(e.clientY - r.top, r.height - mh - 8)) + 'px';
    }
    function closeCtxMenu() { ctxMenu.style.display = 'none'; }
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (editingId) return;
      commitEditor();
      const p = evPos(e), w = wPos(p);
      ctxW = w;
      const s = hitShape(w.x, w.y);
      if (s && !selIds.includes(s.id)) {
        selIds = [s.id];
        requestRender();
      }
      openCtxMenu(e);
    });
    ctxMenu.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      closeCtxMenu();
      if (act === 'copy') doCopy();
      else if (act === 'paste') doPaste(ctxW ? ctxW.x : undefined, ctxW ? ctxW.y : undefined);
      else if (act === 'front') bringToFront();
      else if (act === 'back') sendToBack();
      else if (act === 'del') deleteSelected();
    });

    /* ---------- 导出菜单（PNG/SVG/JSON） ---------- */
    function openExpMenu() {
      expMenu.style.display = 'flex';
      const r = wrap.getBoundingClientRect();
      const br = expBtn.getBoundingClientRect();
      const mw = expMenu.offsetWidth, mh = expMenu.offsetHeight;
      expMenu.style.left = Math.max(8, Math.min(br.left - r.left, r.width - mw - 8)) + 'px';
      expMenu.style.top = Math.max(8, Math.min(br.bottom - r.top + 6, r.height - mh - 8)) + 'px';
    }
    function closeExpMenu() { expMenu.style.display = 'none'; }
    expBtn.addEventListener('click', () => {
      if (expMenu.style.display === 'none' || !expMenu.style.display) openExpMenu();
      else closeExpMenu();
    });
    expMenu.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.exp;
      closeExpMenu();
      if (act === 'png') exportPNG();
      else if (act === 'pngcopy') copyPNG();
      else if (act === 'svg') exportSVG();
      else if (act === 'json') exportJSON();
      else if (act === 'import') fileInput.click();
    });
    const onDocDown = e => {
      const t = e.target;
      if (!ctxMenu.contains(t)) closeCtxMenu();
      if (!expMenu.contains(t) && t !== expBtn && !expBtn.contains(t)) closeExpMenu();
    };
    document.addEventListener('pointerdown', onDocDown, true);

    /* ---------- 导出实现 ---------- */
    function renderSceneCanvas() {
      const b = contentBBox();
      if (!b) return null;
      const pad = 40, sc = 2;
      const w = Math.min(6000, Math.max(1, Math.round((b.w + pad * 2) * sc)));
      const h = Math.min(6000, Math.max(1, Math.round((b.h + pad * 2) * sc)));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const xg = c.getContext('2d');
      xg.fillStyle = '#ffffff';
      xg.fillRect(0, 0, w, h);
      const kk = Math.min(w / (b.w + pad * 2), h / (b.h + pad * 2));
      xg.setTransform(kk, 0, 0, kk, (pad - b.x) * kk, (pad - b.y) * kk);
      for (const s of shapes) drawShape(xg, s, kk, 0, 0);
      return c;
    }
    async function exportPNG() {
      commitEditor();
      if (!shapes.length) { showToast('画布是空的，先画点什么吧'); return; }
      await ensureAssets();
      const c = renderSceneCanvas();
      if (!c) { showToast('画布是空的，先画点什么吧'); return; }
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      if (!blob) { showToast('导出失败：图像生成失败'); return; }
      if (await saveBlob(blob, '画板-' + todayKey() + '.png')) showToast('已导出 PNG');
    }
    async function copyPNG() {
      commitEditor();
      if (!shapes.length) { showToast('画布是空的，先画点什么吧'); return; }
      await ensureAssets();
      const c = renderSceneCanvas();
      if (!c) { showToast('画布是空的，先画点什么吧'); return; }
      try {
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('PNG 已复制到剪贴板，可直接粘贴');
      } catch (err) {
        showToast('复制失败：当前环境不支持剪贴板图片');
      }
    }
    const N1 = v => Math.round(v * 10) / 10;
    function escXml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function genSVG() {
      const b = contentBBox();
      if (!b) return null;
      const pad = 40;
      const parts = [];
      for (const s of shapes) {
        if (s.type === 'pen') {
          const p = s.pts;
          if (p.length === 1) {
            parts.push(`<circle cx="${N1(p[0][0])}" cy="${N1(p[0][1])}" r="${N1(Math.max(0.8, s.size / 2))}" fill="${s.color}"/>`);
          } else {
            let d = `M ${N1(p[0][0])} ${N1(p[0][1])}`;
            for (let i = 1; i < p.length - 1; i++) {
              const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
              d += ` Q ${N1(p[i][0])} ${N1(p[i][1])} ${N1(mx)} ${N1(my)}`;
            }
            d += ` L ${N1(p[p.length - 1][0])} ${N1(p[p.length - 1][1])}`;
            parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${N1(s.size)}" stroke-linecap="round" stroke-linejoin="round"/>`);
          }
        } else if (s.type === 'line' || s.type === 'arrow') {
          parts.push(`<line x1="${N1(s.x1)}" y1="${N1(s.y1)}" x2="${N1(s.x2)}" y2="${N1(s.y2)}" stroke="${s.color}" stroke-width="${N1(s.size)}" stroke-linecap="round"/>`);
          if (s.type === 'arrow') {
            const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
            const hl = Math.max(9, s.size * 3.4);
            const hx = N1(s.x2), hy = N1(s.y2);
            parts.push(`<path d="M ${hx} ${hy} L ${N1(s.x2 - hl * Math.cos(ang - 0.42))} ${N1(s.y2 - hl * Math.sin(ang - 0.42))} M ${hx} ${hy} L ${N1(s.x2 - hl * Math.cos(ang + 0.42))} ${N1(s.y2 - hl * Math.sin(ang + 0.42))}" fill="none" stroke="${s.color}" stroke-width="${N1(s.size)}" stroke-linecap="round"/>`);
          }
        } else if (s.type === 'rect') {
          const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
          parts.push(`<rect x="${N1(x)}" y="${N1(y)}" width="${N1(Math.abs(s.w))}" height="${N1(Math.abs(s.h))}" rx="4" fill="${s.fill || 'none'}" stroke="${s.color}" stroke-width="${N1(s.size)}"/>`);
        } else if (s.type === 'ellipse') {
          parts.push(`<ellipse cx="${N1(s.x + s.w / 2)}" cy="${N1(s.y + s.h / 2)}" rx="${N1(Math.abs(s.w) / 2)}" ry="${N1(Math.abs(s.h) / 2)}" fill="${s.fill || 'none'}" stroke="${s.color}" stroke-width="${N1(s.size)}"/>`);
        } else if (s.type === 'text') {
          const lines = String(s.text || '').split('\n');
          const tspans = lines.map((ln, i) => `<tspan x="${N1(s.x)}" dy="${i ? N1(s.size * 1.4) : 0}">${escXml(ln)}</tspan>`).join('');
          if (tspans) parts.push(`<text x="${N1(s.x)}" y="${N1(s.y + s.size * 0.85)}" font-family="system-ui, sans-serif" font-size="${N1(s.size)}" fill="${s.color}">${tspans}</text>`);
        } else if (s.type === 'note') {
          const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
          const fs = s.fs || 14;
          parts.push(`<rect x="${N1(x)}" y="${N1(y)}" width="${N1(Math.abs(s.w))}" height="${N1(Math.abs(s.h))}" rx="6" fill="${noteBg(s)}" stroke="rgba(0,0,0,.1)"/>`);
          g.save();
          g.font = fs + 'px system-ui, sans-serif';
          const lines = wrapText(g, String(s.text || ''), Math.abs(s.w) - 20);
          g.restore();
          const tspans = lines.map((ln, i) => `<tspan x="${N1(x + 10)}" dy="${i ? N1(fs * 1.45) : 0}">${escXml(ln)}</tspan>`).join('');
          if (tspans) parts.push(`<text x="${N1(x + 10)}" y="${N1(y + 10 + fs * 0.85)}" font-family="system-ui, sans-serif" font-size="${N1(fs)}" fill="#4a4534">${tspans}</text>`);
        } else if (s.type === 'image') {
          const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
          /* 用已缓存的 dataURL：genSVG 是同步的，不能在这里等 IO。
           * 调用方需先 await ensureAssets() 把资产都取回缓存。 */
          const href = assetRefOf(s) ? (assetUrls.get(assetRefOf(s)) || '') : (s.src || '');
          if (href) {
            parts.push(`<image href="${href}" x="${N1(x)}" y="${N1(y)}" width="${N1(Math.abs(s.w))}" height="${N1(Math.abs(s.h))}" preserveAspectRatio="none"/>`);
          }
        }
      }
      const w = N1(b.w + pad * 2), h = N1(b.h + pad * 2);
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${N1(b.x - pad)} ${N1(b.y - pad)} ${w} ${h}" width="${w}" height="${h}"><rect x="${N1(b.x - pad)}" y="${N1(b.y - pad)}" width="${w}" height="${h}" fill="#ffffff"/>${parts.join('')}</svg>`;
    }
    /* 把所有图片资产预取进缓存。
     * 导出是同步拼字符串（genSVG / 画布重绘），不能在中途等 IO，
     * 所以先集中取一遍。已缓存的直接跳过，不重复读盘。 */
    function ensureAssets() {
      const need = [];
      shapes.forEach(s => {
        if (s.type !== 'image') return;
        const ref = assetRefOf(s);
        if (ref && !assetUrls.has(ref)) need.push(ref);
      });
      if (!need.length) return Promise.resolve();
      return Promise.all(need.map(n =>
        AppStore.assetGet(n).then(url => { if (url) assetUrls.set(n, url); }).catch(() => {})
      ));
    }
    async function exportSVG() {
      commitEditor();
      if (!shapes.length) { showToast('画布是空的，先画点什么吧'); return; }
      await ensureAssets();
      const svg = genSVG();
      if (!svg) { showToast('画布是空的，先画点什么吧'); return; }
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      if (await saveBlob(blob, '画板-' + todayKey() + '.svg')) showToast('已导出 SVG');
    }
    async function exportJSON() {
      commitEditor();
      if (!shapes.length) { showToast('画布是空的，无需备份'); return; }
      const data = {
        app: 'toolbox',
        type: 'sketch',
        version: 1,
        exportedAt: new Date().toISOString(),
        count: shapes.length,
        view: view,
        items: shapes
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      if (await saveBlob(blob, '画板备份-' + todayKey() + '.json')) {
        showToast('已导出 JSON 备份（' + shapes.length + ' 个图形）');
      }
    }
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
          if (!items) throw new Error('bad');
          commitEditor();
          pushUndo();
          shapes = items
            .filter(s => s && s.type && s.id != null)
            .map(s => JSON.parse(JSON.stringify(s)));
          selIds = [];
          if (data && data.view && typeof data.view.k === 'number') view = data.view;
          requestRender();
          scheduleSave();
          showToast('已导入 ' + shapes.length + ' 个图形（可撤销）');
        } catch (err) {
          showToast('导入失败：文件无法解析');
        }
      };
      r.readAsText(f);
    });

    /* ---------- 插入图片（拖入 / 粘贴） ----------
     * 图片落盘为资产文件，shapes 里只存资产名。
     * 只有浏览器模式（无文件系统）才把 dataURL 内联进 shapes。 */
    function insertImageFile(f, at) {
      if (!f || f.type.indexOf('image/') !== 0) return;
      const r = new FileReader();
      r.onload = () => {
        const im = new Image();
        im.onload = () => {
          let src = r.result;
          let w = im.naturalWidth || 300, h = im.naturalHeight || 200;
          const MAXPX = 1600;
          if (Math.max(w, h) > MAXPX) { // 超大图先缩，避免单张就吃掉几十 MB
            const sc = MAXPX / Math.max(w, h);
            const c = document.createElement('canvas');
            c.width = Math.round(w * sc);
            c.height = Math.round(h * sc);
            c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
            src = c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85);
            w = c.width; h = c.height;
          }
          const dispW = Math.min(w, 380 / view.k); // 屏幕上约 380px 宽
          const s = {
            id: nid(), type: 'image',
            x: at.x - dispW / 2, y: at.y - (dispW * h / w) / 2,
            w: dispW, h: dispW * h / w
          };

          /* 桌面端：先把图存成资产文件，成功后才把形状推进去。
           * 反过来的话，一旦存盘失败，画板里会留一个永远显示不出来的空图。 */
          AppStore.assetPut(src).then(name => {
            if (name) {
              s.asset = name;
              assetUrls.set(name, src);   // 立刻可用，不必等下次读回
            } else {
              s.src = src;                // 兜底：退化为内联
            }
            pushUndo();
            shapes.push(s);
            selIds = [s.id];
            setTool('select');
            requestRender();
            scheduleSave();
            showToast('已插入图片');
          }).catch(e => {
            // 落盘失败也不阻断使用：退化为内联，至少这幅图还在
            s.src = src;
            pushUndo();
            shapes.push(s);
            selIds = [s.id];
            setTool('select');
            requestRender();
            scheduleSave();
            showToast('图片已插入，但存为文件失败（已内联，存档会变大）');
          });
        };
        im.src = r.result;
      };
      r.readAsDataURL(f);
    }
    ['dragover', 'drop'].forEach(t => canvas.addEventListener(t, e => e.preventDefault()));
    canvas.addEventListener('drop', e => {
      const f = Array.from(e.dataTransfer.files || []).find(x => x.type.indexOf('image/') === 0);
      if (!f) return;
      commitEditor();
      insertImageFile(f, wPos(evPos(e)));
    });
    function onPaste(e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (editingId) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (const it of items) {
          if (it.type && it.type.indexOf('image/') === 0) {
            e.preventDefault();
            if (pastePend) { clearTimeout(pastePend); pastePend = null; }
            const c = centerPt();
            insertImageFile(it.getAsFile(), { x: s2wX(c.x), y: s2wY(c.y) });
            return;
          }
        }
      }
      if (pastePend) { clearTimeout(pastePend); pastePend = null; doPaste(); }
    }
    window.addEventListener('paste', onPaste);

    /* ---------- 滚轮缩放 ---------- */
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      closeCtxMenu();
      closeExpMenu();
      const p = evPos(e);
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomAt(p.sx, p.sy, factor);
    }, { passive: false });

    /* ---------- 键盘 ---------- */
    function onKey(e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        closeCtxMenu();
        closeExpMenu();
        if (editingId) return;
        selIds = [];
        if (draft) { draft = null; requestRender(); }
        updateCursor();
        return;
      }
      if (editingId) return;
      const km = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (km === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (km === 'y' || (km === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
        if (km === 'c') { doCopy(); return; }
        if (km === 'x') { doCopy(); deleteSelected(); return; }
        if (km === 'v') { // 等 paste 事件判断是否为图片，超时则贴形状
          if (pastePend) clearTimeout(pastePend);
          pastePend = setTimeout(() => { pastePend = null; doPaste(); }, 80);
          return;
        }
        if (km === 'd') { e.preventDefault(); doCopy(); doPaste(); return; }
        return;
      }
      if (e.code === 'Space') {
        if (!spaceHeld) { spaceHeld = true; updateCursor(); }
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
      if (e.altKey) return;
      const map = { v: 'select', h: 'pan', p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', n: 'note' };
      const tl = map[km];
      if (tl) setTool(tl);
    }
    window.addEventListener('keydown', onKey);
    const onKeyUp = e => {
      if (e.code === 'Space') {
        spaceHeld = false;
        if (!drag || drag.mode !== 'pan') updateCursor();
      }
    };
    window.addEventListener('keyup', onKeyUp);

    /* ---------- 迷你地图跳转 ---------- */
    function miniMove(e) {
      const m = mini._map;
      if (!m) return;
      const r = mini.getBoundingClientRect();
      const wx = ((e.clientX - r.left) * 2 - m.ox) / m.k;
      const wy = ((e.clientY - r.top) * 2 - m.oy) / m.k;
      centerOn(wx, wy);
    }
    miniBox.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { miniBox.setPointerCapture(e.pointerId); } catch (err) {}
      miniMove(e);
      const mv = ev => miniMove(ev);
      const up = () => {
        miniBox.removeEventListener('pointermove', mv);
        miniBox.removeEventListener('pointerup', up);
        miniBox.removeEventListener('pointercancel', up);
      };
      miniBox.addEventListener('pointermove', mv);
      miniBox.addEventListener('pointerup', up);
      miniBox.addEventListener('pointercancel', up);
    });

    /* ---------- 工具栏 ---------- */
    function setTool(t) {
      tool = t;
      AppStore.set(DB + 'tool', t);
      refreshUI();
    }
    function refreshUI() {
      el.querySelectorAll('.wb-tbtn[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
      el.querySelectorAll('.wb-swatch').forEach(s => s.classList.toggle('on', s.dataset.color === color));
      if (/^#[0-9a-fA-F]{6}$/.test(color)) colorInput.value = color;
      fillInput.value = fill || '#BFE0FF';
      fillBtn.classList.toggle('on', !!fill);
      sizeInput.value = size;
      const d = Math.max(3, Math.min(16, size));
      sizeDot.style.width = d + 'px';
      sizeDot.style.height = d + 'px';
      updateCursor();
      requestRender();
    }
    el.querySelectorAll('.wb-tbtn[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    // 色板：改默认颜色；若选中图形则直接应用（便签改底色，其余改描边/文字色）
    el.querySelectorAll('.wb-swatch').forEach(s => s.addEventListener('click', () => {
      color = s.dataset.color;
      AppStore.set(DB + 'color', color);
      let changed = false;
      for (const t of selShapes()) {
        if (t.type === 'note') { t.bg = color; changed = true; }
        else { t.color = color; changed = true; }
      }
      if (changed) { requestRender(); scheduleSave(); }
      refreshUI();
    }));
    colorInput.addEventListener('input', () => {
      color = colorInput.value;
      AppStore.set(DB + 'color', color);
      let changed = false;
      for (const t of selShapes()) {
        if (t.type === 'note') { t.bg = color; changed = true; }
        else { t.color = color; changed = true; }
      }
      if (changed) { requestRender(); scheduleSave(); }
      refreshUI();
    });
    fillInput.addEventListener('input', () => {
      fill = fillInput.value;
      AppStore.set(DB + 'fill', fill);
      let changed = false;
      for (const t of selShapes()) {
        if (t.type === 'note') { t.bg = fill; changed = true; }
        else if (t.type === 'rect' || t.type === 'ellipse') { t.fill = fill; changed = true; }
      }
      if (changed) { requestRender(); scheduleSave(); }
      refreshUI();
    });
    fillBtn.addEventListener('click', () => {
      fill = fill ? null : (fillInput.value || '#BFE0FF');
      AppStore.set(DB + 'fill', fill);
      let changed = false;
      for (const t of selShapes()) {
        if (t.type === 'note') { t.bg = null; changed = true; }
        else if (t.type === 'rect' || t.type === 'ellipse') { t.fill = fill; changed = true; }
      }
      if (changed) { requestRender(); scheduleSave(); }
      refreshUI();
    });
    sizeInput.addEventListener('input', () => {
      size = +sizeInput.value;
      AppStore.set(DB + 'size', size);
      refreshUI();
    });
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    el.querySelector('.wb-fit').addEventListener('click', fitView);
    el.querySelector('.wb-clear').addEventListener('click', () => {
      if (!shapes.length) return;
      commitEditor();
      pushUndo();
      shapes = [];
      selIds = [];
      requestRender();
      scheduleSave();
      showToast('已清空（可撤销）');
    });
    el.querySelector('.wb-zin').addEventListener('click', () => { const c = centerPt(); zoomAt(c.x, c.y, 1.25); });
    el.querySelector('.wb-zout').addEventListener('click', () => { const c = centerPt(); zoomAt(c.x, c.y, 0.8); });
    pct.addEventListener('click', () => { const c = centerPt(); zoomAt(c.x, c.y, 1 / view.k); });

    /* ---------- 初始化 ---------- */
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(wrap);
    resizeCanvas();
    refreshUI();
    updateBtns();
    const savedView = AppStore.get(DB + 'view', null);
    if (!savedView && shapes.length) fitView();
    AppStore.set(DB + 'canvas', ''); // 清理旧版像素画布的残留数据
    return () => {
      mounted = false;
      commitEditor();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('paste', onPaste);
      document.removeEventListener('pointerdown', onDocDown, true);
      pointers.clear();
      pinch = null;
      ro.disconnect();
      clearTimeout(saveTimer);
      if (pastePend) { clearTimeout(pastePend); pastePend = null; }
      /* 释放图片缓存：一次进入画板可能加载几十 MB 的位图，
       * 不清理的话会一直挂在 renderer 里（和当初 mermaid 常驻是同一类问题）。 */
      imgCache.clear();
      assetUrls.clear();
      assetPending.clear();
    };
  }
});
