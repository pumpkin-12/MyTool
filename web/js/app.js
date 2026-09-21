'use strict';

/* ============================================================
 * 主题切换（浅色 / 深色）
 * 偏好存于 AppStore；未手动设置时跟随系统
 * ============================================================ */
const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let themePref = AppStore.get('theme', null);
const THEME_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2"/><path d="M12 19.3v2.2"/><path d="M2.5 12h2.2"/><path d="M19.3 12h2.2"/><path d="M5.3 5.3l1.6 1.6"/><path d="M17.1 17.1l1.6 1.6"/><path d="M18.7 5.3l-1.6 1.6"/><path d="M6.9 17.1l-1.6 1.6"/></svg>';
const THEME_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.3 8.3 0 0 1 9.5 4 8.3 8.3 0 1 0 20 14.5z"/></svg>';

function isDarkNow() {
  return themePref === 'dark' || (themePref === null && !!(themeMedia && themeMedia.matches));
}
function applyTheme() {
  const dark = isDarkNow();
  document.documentElement.classList.toggle('dark', dark);
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.innerHTML = dark ? THEME_SUN : THEME_MOON;
    btn.title = dark ? '切换到浅色' : '切换到深色';
  }
}
(function initTheme() {
  const btn = document.createElement('button');
  btn.id = 'themeBtn';
  btn.setAttribute('aria-label', '切换主题');
  document.body.appendChild(btn);
  btn.addEventListener('click', () => {
    themePref = isDarkNow() ? 'light' : 'dark';
    AppStore.set('theme', themePref);
    applyTheme();
  });
  if (themeMedia && themeMedia.addEventListener) {
    themeMedia.addEventListener('change', applyTheme);
  }
  applyTheme();
})();

/* ============================================================
 * 路由与渲染
 * ============================================================ */
let cleanup = null;
const app = document.getElementById('app');

function renderHome() {
  const order = AppStore.get('home:order', null);
  const tools = [...registry].filter(isEnabled).sort((a, b) => {
    const ia = order ? order.indexOf(a.id) : -1;
    const ib = order ? order.indexOf(b.id) : -1;
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });
  app.innerHTML = `
    <header class="hero">
      <h1>个人工具箱</h1>
      <p>本地优先 · ${AppStore.isNative ? '数据保存在本地文件' : '数据保存在浏览器里'} · 可随时迁移为桌面应用</p>
    </header>
    <div class="grid">
      ${tools.map(t => `
        <a class="card" href="#tool/${t.id}" data-id="${t.id}" draggable="true">
          <div class="card-icon" style="background:${t.color}1a;color:${t.color};">${t.icon}</div>
          <div class="card-name">${t.name}</div>
          <div class="card-desc">${t.desc}</div>
        </a>`).join('')}
    </div>
    ${tools.length > 1 ? '<p class="grid-hint">拖动卡片可调整顺序，位置自动保存</p>' : ''}
    <div class="data-bar">
      <button class="btn btn-sm" id="dataExport">导出全部数据</button>
      <button class="btn btn-sm" id="dataImport">导入全部数据</button>
      <button class="btn btn-sm" id="openSysinfo">系统状态</button>
      <span class="hint">浏览器版搬到桌面版、或换机器时，用前两个按钮整体搬家</span>
    </div>`;
  const grid = app.querySelector('.grid');
  let dragEl = null;
  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    dragEl = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (err) {}
  });
  grid.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragEl) return;
    const card = e.target.closest('.card');
    if (!card || card === dragEl) return;
    const rect = card.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
    const ry = (e.clientY - rect.top) / Math.max(rect.height, 1) - 0.5;
    let after;
    if (Math.abs(ry) > Math.abs(rx)) after = ry > 0;
    else after = rx > 0;
    grid.insertBefore(dragEl, after ? card.nextSibling : card);
  });
  grid.addEventListener('dragend', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
    AppStore.set('home:order', [...grid.querySelectorAll('.card')].map(c => c.dataset.id));
  });

  /* ---------- 系统状态入口 ---------- */
  document.getElementById('openSysinfo').addEventListener('click', openSysinfo);

  /* ---------- 全量数据导出 / 导入 ---------- */
  /* 每次都重建 input 节点：旧的连同它的监听一起丢掉，
   * 避免首页来回切换时监听器叠加。 */
  const staleInput = document.getElementById('dataFile');
  if (staleInput) staleInput.remove();
  const dFile = document.createElement('input');
  dFile.type = 'file';
  dFile.id = 'dataFile';
  dFile.accept = '.json,application/json';
  dFile.style.display = 'none';
  document.body.appendChild(dFile);

  document.getElementById('dataExport').addEventListener('click', async () => {
    const keys = AppStore.exportAll();
    const n = Object.keys(keys).length;
    if (!n) { showToast('还没有任何数据可导出'); return; }
    const payload = {
      app: 'toolbox',
      type: 'full',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: n,
      keys: keys
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    if (await saveBlob(blob, '工具箱全部数据-' + todayKey() + '.json')) {
      showToast('已导出 ' + n + ' 项数据');
    }
  });

  document.getElementById('dataImport').addEventListener('click', () => dFile.click());  dFile.addEventListener('change', () => {
    const f = dFile.files && dFile.files[0];
    dFile.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { showToast('导入失败：文件无法解析'); return; }
      const keys = (data && data.type === 'full' && data.keys && typeof data.keys === 'object') ? data.keys : null;
      if (!keys) { showToast('格式不对：这不是「全部数据」导出的备份'); return; }
      const n = AppStore.importAll(keys);
      await AppStore.flush();          // 等写盘落定再重绘，否则可能读到旧值
      showToast('已导入 ' + n + ' 项数据');
      render();
    };
    reader.readAsText(f);
  });
}

function renderTool(tool) {
  app.innerHTML = `
    <header class="topbar">
      <a class="back" href="#home">← 返回</a>
      <div class="tool-title">${tool.name}</div>
    </header>
    <main class="tool-body${['sketch', 'mermaid', 'defect'].indexOf(tool.id) >= 0 ? ' wide' : ''}" id="toolRoot"></main>`;
  const root = document.getElementById('toolRoot');
  cleanup = tool.mount(root) || null;
}

function render() {
  if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
  // 离开首页时把系统状态面板一并收掉，否则它的轮询定时器会在别的页面继续跑
  if (__sysCleanup) { try { __sysCleanup(); } catch (e) {} }
  document.title = '个人工具箱';
  const m = (location.hash || '#home').match(/^#tool\/([\w-]+)/);
  if (m) {
    const tool = registry.find(t => t.id === m[1] && isEnabled(t));
    if (tool) {
      document.title = tool.name + ' · 个人工具箱';
      renderTool(tool);
      return;
    }
  }
  renderHome();
}

window.addEventListener('hashchange', render);
/* 等存储层就绪再渲染（桌面端为异步读文件）；3 秒超时兜底，避免后端异常导致白屏 */
Promise.race([
  AppStore.ready,
  new Promise(function (r) { setTimeout(r, 3000); })
]).then(render);
