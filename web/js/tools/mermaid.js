'use strict';

/* ===TESTABLE:mermaidModule:begin=== */
/* ============================================================
 * 工具 10：Mermaid 编辑器
 * 左侧源码（行号 + 语法高亮 + 透明 textarea 三层叠加），右侧实时预览。
 * Mermaid 库首次进入时从 CDN 动态加载（方案 A），加载失败可重试；
 * 源码草稿与历史存 AppStore（key: mermaid:*）。
 * ============================================================ */
registerTool({
  id: 'mermaid',
  name: 'Mermaid 编辑器',
  desc: '写代码，实时出流程图',
  color: '#7F77DD',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="7.5" height="6" rx="2"/><rect x="13.5" y="14.5" width="7.5" height="6" rx="2"/><rect x="3" y="14.5" width="7.5" height="6" rx="2"/><path d="M10.5 6.5h3.2a2 2 0 0 1 2 2v6"/><path d="M10.5 17.5h2"/></svg>',
  mount(el) {
    const CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    const LOCAL = 'vendor/mermaid.min.js';   // 桌面端离线加载（UMD）
    const isDesktop = !!(window.__TAURI__ || window.NativeStore);
    const DEBOUNCE = 300;      // 渲染防抖
    const SAVE_GAP = 800;      // 草稿保存防抖
    const BIG_NODES = 500;     // 超过则建议手动模式
    const MAX_HIST = 5;

    const TEMPLATES = [
      { k: '流程图', v: 'graph TD\n  A[开始] --> B{判断条件}\n  B -->|是| C[执行动作]\n  B -->|否| D[结束]\n  C --> D' },
      { k: '时序图', v: 'sequenceDiagram\n  participant U as 用户\n  participant S as 服务端\n  U->>S: 提交请求\n  S-->>U: 返回结果' },
      { k: '类图', v: 'classDiagram\n  class Question {\n    +Long id\n    +String stem\n    +String answer\n    +check()\n  }\n  class QuizService {\n    +random(n)\n  }\n  QuizService --> Question' },
      { k: '状态图', v: 'stateDiagram-v2\n  [*] --> 待办\n  待办 --> 进行中: 开始\n  进行中 --> 已完成: 提交\n  进行中 --> 待办: 打回\n  已完成 --> [*]' },
      { k: '甘特图', v: 'gantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  section 设计\n  需求分析 :a1, 2026-09-01, 5d\n  原型设计 :a2, after a1, 4d\n  section 开发\n  编码实现 :b1, after a2, 12d' },
      { k: 'ER 图', v: 'erDiagram\n  CATEGORY ||--o{ QUESTION : 包含\n  QUESTION ||--o{ OPTION : 选项\n  QUESTION {\n    long id\n    string stem\n    string answer\n  }' }
    ];

    const SAMPLE = 'graph TD\n  A[开始] --> B{判断条件}\n  B -->|是| C[通过]\n  B -->|否| D[驳回]\n  C --> E[结束]\n  D --> E';

    el.innerHTML = `
      <div class="bar">
        <button class="mm-btn mm-tpl">插入模板 ▾</button>
        <button class="mm-btn mm-live on" title="关闭后只在 Ctrl+Enter 时渲染">实时渲染</button>
        <button class="mm-btn mm-fit" title="缩放到适应预览区">适应宽度</button>
        <span class="sp"></span>
        <span class="mm-hist mm-histLoad" title="恢复最近一次自动备份">历史</span>
        <button class="mm-btn mm-clear">清空</button>
        <button class="mm-btn mm-dl">导出 ▾</button>
      </div>
      <div class="mm-split">
        <div class="mm-pane">
          <div class="mm-head">
            <span><b>源码</b></span>
            <span class="mm-stat-src">0 字符</span>
          </div>
          <div class="mm-edit">
            <div class="mm-ln">1</div>
            <div class="mm-hl"><span class="k1">graph</span> TD
  A[开始] --&gt; B{判断条件}
  B --&gt;|是| C[通过]
  B --&gt;|否| D[驳回]
  C --&gt; E[结束]
  D --&gt; E
</div>
            <textarea class="mm-ta" spellcheck="false" wrap="off" placeholder="在这里写 Mermaid 代码，左侧可选模板…"></textarea>
          </div>
        </div>
        <div class="mm-pane">
          <div class="mm-head">
            <span><b>预览</b></span>
            <span class="mm-stat-view">等待加载</span>
          </div>
          <div class="mm-prev"><div class="mm-tip">正在加载 Mermaid 库…<br>桌面端读本地文件，浏览器端首次需联网（约 3MB，之后走缓存）</div></div>
          <div class="mm-foot">
            <span class="mm-dot wait"></span>
            <span class="mm-msg">加载中</span>
            <span class="mm-zoom">
              <button class="mm-zout" title="缩小">−</button>
              <span class="mm-zval">100%</span>
              <button class="mm-zin" title="放大">+</button>
              <button class="mm-zreset" title="恢复 100%">1:1</button>
            </span>
          </div>
        </div>
      </div>
      <p class="hint" style="margin-top:12px;">Ctrl + Enter 立即渲染 · Tab 缩进两格 · 草稿自动保存在本地</p>`;

    const $ = s => el.querySelector(s);
    const ta = $('.mm-ta'), hl = $('.mm-hl'), ln = $('.mm-ln');
    const prev = $('.mm-prev'), msg = $('.mm-msg'), dot = $('.mm-dot');
    const statSrc = $('.mm-stat-src'), statView = $('.mm-stat-view'), zval = $('.mm-zval');

    let lib = null, libErr = null, loading = null;
    let renderSeq = 0, lastGood = '', lastSrc = '';
    let renderTimer = null, saveTimer = null;
    let scale = 1, liveRender = true, nodes = 0, autoManual = false;
    let menuEl = null, disposed = false;
    const liveBtn = $('.mm-live');

    /* ---------- 主题 ---------- */
    function darkNow() {
      try { return document.documentElement.classList.contains('dark'); } catch (e) { return false; }
    }

    /* ---------- 库加载（方案 A：CDN 动态 import，失败可重试） ---------- */
    function initCfg() {
      return {
        startOnLoad: false,
        securityLevel: 'strict',
        theme: darkNow() ? 'dark' : 'default',
        // htmlLabels 关掉时中文标签在部分图形里换行表现更好；strict 下本就不允许 HTML
        htmlLabels: false,
        fontFamily: 'inherit',
        // 出错时不要往页面里插 svg（我们自己渲染错误卡片）
        suppressErrorRendering: true
      };
    }
    /* 加载 Mermaid：本地 vendor 与 CDN 互为回退
     * 桌面端优先本地（离线可用）；浏览器优先 CDN（省一次 404 请求）。
     * 本地是 UMD 版（挂 window.mermaid），CDN 是 ESM 版，取到的对象用法一致。 */
    /* 已注入到 head 的 mermaid <script> 集合。
     * 注意：必须在 appendChild 之前登记，不能等 onload——
     * 否则「加载中就切走」时该 script 无人清理，会永久留在 head 里。 */
    const injectedScripts = new Set();
    function dropInjected(s) {
      if (!s) return;
      injectedScripts.delete(s);
      if (s.parentNode) { try { s.parentNode.removeChild(s); } catch (e) {} }
    }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        const s = document.createElement('script');
        s.src = src;
        s.onload = function () { res(s); };
        s.onerror = function () { rej(new Error('脚本加载失败: ' + src)); };
        injectedScripts.add(s);            // 先登记再插入，保证 dispose 一定找得到它
        document.head.appendChild(s);
        if (disposed) dropInjected(s);     // 极端情况：登记与插入之间就切走了
      });
    }
    function viaLocal() {
      if (window.mermaid) return Promise.resolve(window.mermaid);
      return loadScript(LOCAL).then(function (s) {
        if (disposed) {
          dropInjected(s);
          return Promise.reject(new Error('已离开 Mermaid 页，取消加载'));
        }
        if (!window.mermaid) throw new Error('本地 mermaid 未就绪');
        return window.mermaid;
      });
    }
    function viaCdn() {
      return import(CDN).then(function (mod) { return mod.default || mod; });
    }
    function loadLib() {
      if (lib) return Promise.resolve(lib);
      if (loading) return loading;
      const order = isDesktop ? [viaLocal, viaCdn] : [viaCdn, viaLocal];
      loading = (function tryNext(i, lastErr) {
        if (i >= order.length) return Promise.reject(lastErr || new Error('Mermaid 加载失败'));
        return order[i]().catch(function (e) { return tryNext(i + 1, e); });
      })(0, null).then(mod => {
        // 加载完成时若已离开页面，则不持有引用，让旧闭包连同 Mermaid 实例一起被回收
        if (disposed) { lib = null; return Promise.reject(new Error('已离开 Mermaid 页')); }
        lib = mod;
        lib.initialize(initCfg());
        libErr = null;
        return lib;
      }).catch(e => {
        libErr = e;
        loading = null;
        throw e;
      });
      return loading;
    }

    /* ---------- 语法高亮（轻量自研）
     * 做法：在「原始文本」上一次性切出 token 区间，再统一拼 HTML。
     * 关键：不做多轮 replace——否则后一轮正则会把前一轮生成的
     * class="k1" 里的属性值当成代码再次包裹，HTML 直接损坏。
     * ------------------------------------------------------------ */
    const MM_KEYWORDS = ['graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'stateDiagram', 'gantt', 'erDiagram', 'pie', 'mindmap', 'journey', 'gitGraph', 'timeline', 'quadrantChart', 'requirementDiagram', 'C4Context', 'block-beta', 'sankey-beta', 'xychart-beta'];
    /* 按优先级排列：长符号在前面，否则 --> 会被 -- 先吃掉 */
    const TOKEN_RULES = [
      { re: /%%.*$/, cls: 'k4' },                                            // 注释
      { re: /"[^"\n]*"|'[^'\n]*'/, cls: 'k2' },                              // 引号字符串
      { re: /\[[^\]\n]*\]|\{[^}\n]*\}|\([^)\n]*\)|\|[^|\n]*\|/, cls: 'k3' }, // 节点形状 / 连线标签
      { re: /-\.-&gt;|--&gt;&gt;|==&gt;|--&gt;|-\.-&gt;|\.\.&gt;|&lt;--&gt;|&lt;--|&gt;&gt;|--x|--o|---|:::|--\|/, cls: 'k2' }, // 箭头连线
      { re: /\|\||\{|\}/, cls: 'k2' },                                        // ER 关系符
      { re: /\b(TD|TB|BT|RL|LR)\b/, cls: 'k3' }                              // 方向
    ];

    function hlLine(line) {
      const src = esc(line);
      // 1. 收集所有 token 区间（带优先级，先到先得，不重叠）
      const spans = [];
      const upper = src.length;
      for (const rule of TOKEN_RULES) {
        const re = new RegExp(rule.re.source, 'g');
        let m;
        while ((m = re.exec(src)) !== null) {
          if (m[0] === '') { re.lastIndex++; continue; }
          const s = m.index, e = m.index + m[0].length;
          // 与已占区间冲突则跳过（高优先级规则先占位）
          let clash = false;
          for (const sp of spans) { if (s < sp.e && e > sp.s) { clash = true; break; } }
          if (!clash) spans.push({ s, e, cls: rule.cls });
        }
      }
      // 2. 行首关键字单独处理（需匹配整词）
      const head = src.match(/^(\s*)([A-Za-z][\w-]*)/);
      if (head && MM_KEYWORDS.indexOf(head[2]) >= 0) {
        const s = head[1].length, e = s + head[2].length;
        let clash = false;
        for (const sp of spans) { if (s < sp.e && e > sp.s) { clash = true; break; } }
        if (!clash) spans.push({ s, e, cls: 'k1' });
      }
      if (!spans.length) return src;
      // 3. 按位置排序后一次性拼接
      spans.sort((a, b) => a.s - b.s || a.e - b.e);
      let out = '', pos = 0;
      for (const sp of spans) {
        if (sp.s < pos) continue;
        out += src.slice(pos, sp.s) + '<span class="' + sp.cls + '">' + src.slice(sp.s, sp.e) + '</span>';
        pos = sp.e;
      }
      out += src.slice(pos);
      return out;
    }
    function highlight(src, errLine) {
      const lines = String(src).split('\n');
      let out = '';
      for (let i = 0; i < lines.length; i++) {
        const cls = (errLine && i + 1 === errLine) ? ' class="ln-err"' : '';
        out += '<span' + cls + '>' + (hlLine(lines[i]) || ' ') + '</span>\n';
      }
      return out;
    }
    function paintNumbers(n) {
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      ln.textContent = s;
    }

    /* ---------- 状态栏 ---------- */
    function setStatus(state, text) {
      dot.className = 'mm-dot ' + (state || '');
      msg.textContent = text || '';
    }

    /* ---------- 错误卡片 ---------- */
    function errLineOf(e) {
      const cands = [e && e.hash && e.hash.line, e && e.line, e && e.loc && e.loc.first_line];
      for (const c of cands) { const n = parseInt(c, 10); if (n > 0) return n; }
      const s = (e && (e.str || e.message)) || '';
      const m = String(s).match(/line\s+(\d+)/i);
      return m ? parseInt(m[1], 10) : 0;
    }
    function showError(e, line) {
      const raw = (e && (e.str || e.message)) || String(e);
      const clean = String(raw).split('\n').slice(0, 3).join('\n').slice(0, 300);
      const card =
        '<div class="mm-err">' +
          '<div class="mm-err-t">语法错误' + (line ? ' · 第 ' + line + ' 行' : '') + '</div>' +
          '<div>下面是 Mermaid 报出的信息，修正后会自动重新渲染。</div>' +
          '<pre>' + esc(clean) + '</pre>' +
        '</div>';
      // 保留上一次成功渲染的图：错误卡片显示在图下方，图上加轻微提示样式
      if (lastGood) {
        prev.innerHTML = '<div class="mm-bad-wrap">' + lastGood + card + '</div>';
      } else {
        prev.innerHTML = card;
      }
      statView.textContent = '语法错误';
      setStatus('bad', line ? '第 ' + line + ' 行有误' : '语法有误');
      hl.innerHTML = highlight(lastSrc, line);
      syncScroll();
    }

    /* ---------- 渲染（防抖 + 竞态丢弃） ---------- */
    async function doRender(force) {
      const src = ta.value;
      lastSrc = src;
      if (!src.trim()) {
        prev.innerHTML = '<div class="mm-tip">输入 Mermaid 代码后这里会实时显示图表<br>点上方「插入模板」可以快速开始</div>';
        statView.textContent = '空';
        setStatus('wait', '等待输入');
        lastGood = '';
        nodes = 0;
        return;
      }
      let m;
      try { m = await loadLib(); }
      catch (e) {
        prev.innerHTML =
          '<div class="mm-err">' +
            '<div class="mm-err-t">Mermaid 库加载失败</div>' +
            '<div>本地与 CDN 两种加载方式均失败。请确认 vendor/mermaid.min.js 是否存在，或检查网络后重试。</div>' +
            '<pre>' + esc((e && e.message) || String(e)) + '</pre>' +
          '</div>';
        statView.textContent = '库未就绪';
        setStatus('bad', '加载失败');
        return;
      }
      const seq = ++renderSeq;
      setStatus('wait', '渲染中…');
      try {
        if (m.parse) await m.parse(src);
        const res = await m.render('mm-svg-' + seq, src);
        if (disposed || seq !== renderSeq) return;
        lastGood = res.svg;
        prev.innerHTML = res.svg;
        // 节点数估算：Mermaid 输出的 g.node / .actor 等元素
        nodes = prev.querySelectorAll('g.node, .node, .actor, .cluster, .entityBox, .statediagram-state, .task').length;
        statView.textContent = '已渲染' + (nodes ? ' · ' + nodes + ' 个节点' : '');
        setStatus('ok', nodes ? nodes + ' 个节点' : '渲染成功');
        hl.innerHTML = highlight(src, 0);
        applyScale();
        syncScroll();
        if (nodes > BIG_NODES && liveRender && !autoManual) {
          autoManual = true;
          liveRender = false;
          liveBtn.classList.remove('on');
          showToast('图形较大（' + nodes + ' 个节点），已转为手动渲染');
        }
        scheduleSave(src);
      } catch (e) {
        if (disposed || seq !== renderSeq) return;
        const line = errLineOf(e);
        showError(e, line);
        scheduleSave(src);
      }
      if (force) ta.focus();
    }
    function requestRender(force) {
      clearTimeout(renderTimer);
      if (!liveRender && !force) return;
      renderTimer = setTimeout(() => doRender(force), liveRender ? DEBOUNCE : 0);
    }

    /* ---------- 缩放与滚动同步 ---------- */
    function applyScale() {
      const svg = prev.querySelector('svg');
      if (!svg) return;
      svg.style.transformOrigin = 'top center';
      svg.style.transform = scale === 1 ? '' : 'scale(' + scale + ')';
      svg.style.maxWidth = scale === 1 ? '100%' : 'none';
      zval.textContent = Math.round(scale * 100) + '%';
    }
    function setScale(v) {
      scale = Math.min(4, Math.max(0.25, v));
      applyScale();
    }
    function fitWidth() {
      const svg = prev.querySelector('svg');
      if (!svg) return;
      const box = prev.getBoundingClientRect();
      const w = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width
        ? svg.viewBox.baseVal.width
        : (svg.getBoundingClientRect().width / scale);
      if (!w) return;
      setScale((box.width - 34) / w);
    }
    function syncScroll() {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
      ln.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    }

    /* ---------- 持久化 ---------- */
    function scheduleSave(src) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        AppStore.set('mermaid:doc', src);
        const hist = AppStore.get('mermaid:hist', []);
        hist.unshift({ at: new Date().toISOString(), src: src });
        AppStore.set('mermaid:hist', hist.slice(0, MAX_HIST));
      }, SAVE_GAP);
    }
    function updateSrcStat() {
      const v = ta.value;
      statSrc.textContent = v.length + ' 字符';
    }
    function fmtHistTime(iso) {
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '历史版本';
        const p = n => String(n).padStart(2, '0');
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch (e) { return '历史版本'; }
    }

    /* ---------- 菜单 ---------- */
    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('pointerdown', onDocDown, true); }
    }
    function onDocDown(e) {
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    }
    function openMenu(anchor, items) {
      closeMenu();
      const m = document.createElement('div');
      m.className = 'mm-menu';
      items.forEach(it => {
        if (it.sep) { const s = document.createElement('div'); s.className = 'mm-sep'; m.appendChild(s); return; }
        const b = document.createElement('button');
        b.textContent = it.label;
        b.addEventListener('click', () => { closeMenu(); it.run(); });
        m.appendChild(b);
      });
      document.body.appendChild(m);
      const r = anchor.getBoundingClientRect();
      const mw = m.offsetWidth, mh = m.offsetHeight;
      let left = r.left, top = r.bottom + 6;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
      if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
      m.style.left = Math.max(8, left) + 'px';
      m.style.top = Math.max(8, top) + 'px';
      menuEl = m;
      setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
    }

    /* ---------- 导出 ---------- */
    async function exportSVG() {
      if (!lastGood) { showToast('还没有可导出的图'); return; }
      if (scale !== 1) { const s = scale; setScale(1); setTimeout(() => setScale(s), 0); }
      const blob = new Blob([lastGood], { type: 'image/svg+xml;charset=utf-8' });
      if (await saveBlob(blob, 'mermaid-' + Date.now() + '.svg')) showToast('SVG 已导出');
    }
    function exportPNG(scaleFactor) {
      if (!lastGood) { showToast('还没有可导出的图'); return; }
      try {
        const svgEl = prev.querySelector('svg');
        let w = 0, h = 0;
        if (svgEl) {
          const r = svgEl.getBoundingClientRect();
          w = r.width; h = r.height;
        }
        if (!w || !h) {
          const vb = svgEl && svgEl.viewBox && svgEl.viewBox.baseVal;
          w = (vb && vb.width) || 800; h = (vb && vb.height) || 600;
        }
        const img = new Image();
        const blob = new Blob([lastGood], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        img.onload = () => {
          const k = scaleFactor || 2;
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k));
          c.height = Math.max(1, Math.round(h * k));
          const g = c.getContext('2d');
          g.fillStyle = darkNow() ? '#1f2227' : '#ffffff';
          g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob(async b => {
            if (!b) { showToast('PNG 导出失败，可改用 SVG'); return; }
            if (await saveBlob(b, 'mermaid-' + Date.now() + '.png')) showToast('PNG 已导出');
          }, 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); showToast('PNG 导出失败，可改用 SVG'); };
        img.src = url;
      } catch (e) { showToast('PNG 导出失败，可改用 SVG'); }
    }

    /* ---------- 事件绑定 ---------- */
    ta.addEventListener('input', () => {
      hl.innerHTML = highlight(ta.value, 0);
      paintNumbers(ta.value.split('\n').length);
      syncScroll();
      updateSrcStat();
      requestRender();
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        ta.dispatchEvent(new Event('input'));
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); requestRender(true); }
      if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        clearTimeout(saveTimer);
        AppStore.set('mermaid:doc', ta.value);
        showToast('草稿已保存');
      }
    });

    liveBtn.addEventListener('click', () => {
      liveRender = !liveRender;
      liveBtn.classList.toggle('on', liveRender);
      showToast(liveRender ? '已开启实时渲染' : '已关闭实时渲染（Ctrl+Enter 手动渲染）');
      if (liveRender) requestRender(true);
    });

    $('.mm-tpl').addEventListener('click', e => {
      openMenu(e.currentTarget, TEMPLATES.map(t => ({
        label: t.k,
        run: () => {
          ta.value = t.v;
          ta.dispatchEvent(new Event('input'));
          requestRender(true);
          showToast('已插入' + t.k + '模板');
        }
      })));
    });

    $('.mm-fit').addEventListener('click', fitWidth);
    $('.mm-zin').addEventListener('click', () => setScale(scale * 1.2));
    $('.mm-zout').addEventListener('click', () => setScale(scale / 1.2));
    $('.mm-zreset').addEventListener('click', () => setScale(1));

    $('.mm-clear').addEventListener('click', () => {
      if (!ta.value) return;
      /* 桌面 WebView 里 window.confirm 是 no-op（直接返回 true），必须换成应用内确认框 */
      askConfirm('清空当前源码？此操作可通过「历史」找回上一版。').then(ok => {
        if (!ok) return;
        ta.value = '';
        ta.dispatchEvent(new Event('input'));
        requestRender(true);
      });
    });

    $('.mm-histLoad').addEventListener('click', e => {
      const hist = AppStore.get('mermaid:hist', []);
      if (!hist.length) { showToast('暂无历史版本'); return; }
      openMenu(e.currentTarget, hist.slice(0, MAX_HIST).map((h, i) => ({
        label: (i === 0 ? '最近一次 · ' : '') + fmtHistTime(h.at),
        run: () => {
          ta.value = h.src || '';
          ta.dispatchEvent(new Event('input'));
          requestRender(true);
          showToast('已恢复历史版本');
        }
      })));
    });

    $('.mm-dl').addEventListener('click', e => {
      openMenu(e.currentTarget, [
        { label: '导出 SVG（矢量）', run: exportSVG },
        { label: '导出 PNG（2x）', run: () => exportPNG(2) },
        { sep: true },
        { label: '复制源码', run: () => copyText(ta.value).then(ok => showToast(ok ? '源码已复制' : '复制失败')) }
      ]);
    });

    /* 预览区 Ctrl + 滚轮缩放 */
    prev.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    /* 主题变化时重初始化并重渲染 */
    let lastDark = darkNow();
    const themeWatch = setInterval(() => {
      const d = darkNow();
      if (d === lastDark) return;
      lastDark = d;
      if (!lib) return;
      lib.initialize(initCfg());
      requestRender(true);
    }, 600);

    /* ---------- 初始化 ---------- */
    const saved = AppStore.get('mermaid:doc', null);
    ta.value = (saved === null || saved === undefined) ? SAMPLE : saved;
    hl.innerHTML = highlight(ta.value, 0);
    paintNumbers(ta.value.split('\n').length);
    updateSrcStat();
    syncScroll();

    loadLib().then(() => { if (!disposed) requestRender(true); }).catch(() => {});

    return function () {
      disposed = true;
      renderSeq++;
      clearTimeout(renderTimer);
      clearTimeout(saveTimer);
      clearInterval(themeWatch);
      closeMenu();
      if (lib) { try { lib.initialize({ startOnLoad: false, securityLevel: 'strict' }); } catch (e) {} }
      // 释放 Mermaid：进过一次 Mermaid 页会常驻 60~100 MB，离开时必须清掉，否则直到关应用都占着
      lib = null;
      loading = null;
      libErr = null;
      try { window.mermaid = null; } catch (e) {}
      injectedScripts.forEach(dropInjected);
      injectedScripts.clear();
    };
  }
});
/* ===TESTABLE:mermaidModule:end=== */
