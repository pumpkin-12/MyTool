'use strict';

/* ---------- 系统状态面板 ----------
 * 纯只读诊断：只展示数字，不做任何清理/结束进程之类的写操作。
 *
 * 定时器纪律（本项目已因 mermaid 常驻内存吃过一次亏）：
 *   1. 定时器必须在关闭时 clear
 *   2. visibilitychange 监听器必须解绑
 *   3. 异步回调里检查 alive，避免关掉后还去写已卸载的 DOM
 * 三条缺一不可。 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtDuration(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分 ' + (s % 60) + ' 秒';
}
/* 纯 CSS 条，不引图表库（零构建约束） */
function bar(pct, color) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:5px;">' +
    '<div style="height:100%;width:' + p.toFixed(1) + '%;background:' + (color || 'var(--accent)') +
    ';transition:width .3s;"></div></div>';
}
function sysRow(label, value, extra) {
  return '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;">' +
    '<span style="color:var(--muted);">' + esc(label) + '</span>' +
    '<span class="mono" style="text-align:right;">' + esc(value) + '</span></div>' +
    (extra || '');
}
function sysSection(title) {
  return '<div style="font-weight:500;margin:16px 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border);">' +
    esc(title) + '</div>';
}

/* 当前打开的系统状态面板的清理函数。同一时刻只允许一个，
 * 再开一次会先把上一个收干净（否则定时器叠加）。 */
let __sysCleanup = null;

function openSysinfo() {
  if (__sysCleanup) { try { __sysCleanup(); } catch (e) {} __sysCleanup = null; }

  const o = uiOverlay(
    '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">' +
      '<div style="font-weight:500;font-size:15px;">系统状态</div>' +
      '<div class="hint" id="sysStamp">读取中…</div>' +
    '</div>' +
    '<div class="hint" style="margin-bottom:8px;">只读诊断，不会修改任何系统设置</div>' +
    '<div id="sysBody">正在采集…</div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
      '<button class="btn btn-sm" id="sysCopy">复制报告</button>' +
      '<button class="btn btn-primary btn-sm" id="sysClose">关闭</button>' +
    '</div>');
  o.card.style.width = 'min(560px, 94vw)';

  const body = o.card.querySelector('#sysBody');
  const stamp = o.card.querySelector('#sysStamp');

  let timer = null, alive = true, latest = null;

  async function refresh() {
    const T = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
    if (!T) {
      // 浏览器版没有原生后端：如实说明，不编造假数据
      if (alive) {
        body.innerHTML = '<div style="padding:12px 0;color:var(--muted);line-height:1.9;">' +
          '浏览器模式下拿不到系统指标（没有原生后端）。<br>' +
          '桌面版（Tauri）里打开这个面板即可看到内存、CPU、磁盘等数据。</div>' +
          sysSection('存档') + archiveHtml();
        stamp.textContent = '';
      }
      return;
    }
    try {
      // 存档统计先拿到，里面的 dir 就是数据目录 —— sysinfo 需要它来定位所在盘
      const archive = await storeStatsSafe(T);
      const raw = await T.invoke('sysinfo', { dataDir: (archive && archive.dir) || '' });
      if (!alive) return;
      __keyStats = (archive && archive.keys) ? archive.keys : null;
      latest = { sys: JSON.parse(raw), archive: archive };
      body.innerHTML = renderSysinfo(latest.sys, latest.archive);
      stamp.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      if (!alive) return;
      body.innerHTML = '<div style="color:var(--err);padding:8px 0;">读取失败：' +
        esc((e && e.message) ? e.message : String(e)) + '</div>';
    }
  }

  function start() { if (!timer && alive) { refresh(); timer = setInterval(refresh, 3000); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // 面板打开时页面可能被切到后台（比如去看任务管理器对照），此时停轮询
  function onVis() { if (document.hidden) stop(); else start(); }
  document.addEventListener('visibilitychange', onVis);

  o.card.querySelector('#sysClose').addEventListener('click', () => {
    if (__sysCleanup) __sysCleanup();
  });
  o.card.querySelector('#sysCopy').addEventListener('click', async () => {
    if (!latest) { showToast('还没采集完'); return; }
    const text = reportText(latest.sys, latest.archive);
    try {
      await navigator.clipboard.writeText(text);
      showToast('报告已复制到剪贴板');
    } catch (e) {
      // 剪贴板权限不可用时退化成文件导出
      await saveBlob(new Blob([text], { type: 'text/plain' }), '系统状态-' + todayKey() + '.txt');
    }
  });
  o.box.addEventListener('click', e => { if (e.target === o.box && __sysCleanup) __sysCleanup(); });

  start();   // 立即拉一次，之后每 3 秒

  __sysCleanup = function () {
    alive = false;
    stop();
    document.removeEventListener('visibilitychange', onVis);
    uiCloseModal();
    __sysCleanup = null;
  };
}

/* 存档明细：优先用磁盘实测（store_keys 按文件内容报原始键名），
 * 拿不到（浏览器端 / 命令失败）再退回前端 exportAll() 估算。 */
let __keyStats = null;   // store_stats 里的 keys 段，供 archiveHtml 复用
function archiveHtml() {
  let rows;
  if (__keyStats && __keyStats.items && __keyStats.items.length) {
    rows = __keyStats.items.map(it => ({ key: it.key, size: it.size }));
  } else {
    const all = AppStore.exportAll() || {};
    rows = Object.keys(all).map(k => {
      let size = 0;
      try { size = new Blob([JSON.stringify(all[k])]).size; } catch (e) { size = 0; }
      return { key: k, size: size };
    });
  }
  rows = rows.slice().sort((a, b) => b.size - a.size);
  const total = rows.reduce((s, r) => s + r.size, 0);
  if (!rows.length) return '<div class="hint">暂无数据</div>';
  const top = rows.slice(0, 6);
  return top.map(r => {
    const pct = total ? (r.size / total * 100) : 0;
    return '<div style="padding:4px 0;">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;">' +
        '<span class="mono" style="color:var(--muted);">' + esc(r.key.replace(/^toolbox:/, '')) + '</span>' +
        '<span class="mono">' + fmtBytes(r.size) + ' · ' + pct.toFixed(0) + '%</span></div>' +
      bar(pct) + '</div>';
  }).join('') +
  (rows.length > top.length ? '<div class="hint" style="margin-top:4px;">其余 ' + (rows.length - top.length) + ' 个键均小于 ' + fmtBytes(top[top.length - 1].size) + '</div>' : '') +
  '<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);font-size:12px;">' +
    '<span style="color:var(--muted);">合计 ' + rows.length + ' 个键</span>' +
    '<span class="mono">' + fmtBytes(total) + '</span></div>';
}

async function storeStatsSafe(T) {
  try { return JSON.parse(await T.invoke('store_stats')); }
  catch (e) { return null; }
}

function renderSysinfo(s, archive) {
  const out = [];
  const T = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;

  // ---- 应用 ----
  out.push(sysSection('应用'));
  out.push(sysRow('版本', 'v' + (s.version || '?')));
  out.push(sysRow('进程号', String(s.pid == null ? '?' : s.pid)));
  if (s.proc_working != null) {
    out.push(sysRow('本进程内存', fmtBytes(s.proc_working) +
      (s.proc_private != null ? '（私有 ' + fmtBytes(s.proc_private) + '）' : '')));
  }
  out.push(sysRow('运行时长', s.uptime_ms != null ? fmtDuration(s.uptime_ms) + '（开机以来）' : '—'));

  // ---- 系统 ----
  out.push(sysSection('系统'));
  if (s.cpu_brand) out.push(sysRow('处理器', s.cpu_brand));
  if (s.cpu_cores != null) {
    out.push(sysRow('逻辑处理器', s.cpu_cores + ' 核' + (ARCH_NAME[s.cpu_arch] ? ' · ' + ARCH_NAME[s.cpu_arch] : '')));
  }
  if (s.cpu_percent != null) {
    // -1 = 首次采样还没基准。不画假的 0%，如实说"测量中"
    out.push(s.cpu_percent < 0
      ? sysRow('系统 CPU', '测量中…')
      : sysRow('系统 CPU', s.cpu_percent.toFixed(1) + ' %',
          bar(s.cpu_percent, s.cpu_percent > 85 ? 'var(--err)' : 'var(--accent)')));
  }
  if (s.mem_total) {
    const used = s.mem_total - (s.mem_avail || 0);
    const pct = s.mem_percent != null ? s.mem_percent : (used / s.mem_total * 100);
    out.push(sysRow('物理内存', fmtBytes(used) + ' / ' + fmtBytes(s.mem_total)));
    out.push(bar(pct, pct > 85 ? 'var(--err)' : 'var(--accent)'));
    out.push(sysRow('内存负载', Number(pct).toFixed(0) + ' %'));
  }
  if (s.mem_installed && s.mem_total && s.mem_installed > s.mem_total) {
    out.push(sysRow('硬件保留', fmtBytes(s.mem_installed - s.mem_total) + '（' + fmtBytes(s.mem_installed) + ' 条装）'));
  }
  if (s.mem_commit) {
    out.push(sysRow('提交内存', fmtBytes(s.mem_commit) +
      (s.mem_commit_limit ? ' / ' + fmtBytes(s.mem_commit_limit) : '')));
  }
  if (s.mem_cache != null) out.push(sysRow('系统缓存', fmtBytes(s.mem_cache)));
  if (s.proc_count != null) {
    out.push(sysRow('进程 / 线程', s.proc_count + ' / ' + (s.thread_count == null ? '?' : s.thread_count) +
      (s.handle_count != null ? '（句柄 ' + s.handle_count + '）' : '')));
  }

  // ---- 磁盘 ----
  out.push(sysSection('磁盘'));
  if (s.disk_total) {
    const used = s.disk_total - s.disk_free;
    const pct = used / s.disk_total * 100;
    out.push(sysRow((s.disk_root || '') + ' 已用', fmtBytes(used) + ' / ' + fmtBytes(s.disk_total)));
    out.push(bar(pct, pct > 90 ? 'var(--err)' : 'var(--accent)'));
    out.push(sysRow('可用', fmtBytes(s.disk_free)));
  }
  out.push('<div id="sysDirUsage" style="color:var(--muted);font-size:12px;padding-top:3px;">数据目录统计中…</div>');

  // ---- 存档 ----
  out.push(sysSection('存档'));
  if (archive && archive.items) {
    out.push(sysRow('数据位置', archive.dir || '—'));
    out.push(sysRow('旧存档 store.json', archive.items.some(i => i.name === 'store.json' && i.exists)
      ? '仍存在（下次写入后归档）' : '已拆分，见下'));
    // 新布局：分键目录 + 图片资产
    if (archive.keys) {
      out.push(sysRow('分键存档 keys/', (archive.keys.count || 0) + ' 个键' +
        (archive.keys.bytes ? ' · ' + fmtBytes(archive.keys.bytes) : '')));
    }
    if (archive.assets) {
      out.push(sysRow('图片资产 assets/', (archive.assets.count || 0) + ' 张' +
        (archive.assets.bytes ? ' · ' + fmtBytes(archive.assets.bytes) : '')));
    }
    if (archive.migrated && archive.migrated.exists) {
      out.push(sysRow('归档旧文件', 'store.json.migrated-bak · ' + fmtBytes(archive.migrated.bytes) +
        '（确认无误后可删）'));
    }
    const backups = archive.items.filter(i => i.name.indexOf('.json.') >= 0 && i.exists);
    out.push(sysRow('轮转备份', backups.length + ' 份' +
      (backups.length ? '（共 ' + fmtBytes(backups.reduce((a, b) => a + b.bytes, 0)) + '）' : '')));
  }
  out.push(archiveHtml());

  // 数据目录 / target 的扫描是异步的：先渲染面板，再回填这一行
  // （target 有几万个文件，扫一遍要几百毫秒到几秒，绝不能塞进 3 秒轮询里）
  if (T && archive && archive.dir) {
    const e1 = document.getElementById('sysDirUsage');
    if (e1) {
      T.invoke('dir_usage', { path: archive.dir }).then(r => {
        const el = document.getElementById('sysDirUsage');
        if (!el) return;
        const d = JSON.parse(r);
        el.textContent = '数据目录实测 ' + fmtBytes(d.bytes) + ' · ' + d.files + ' 个文件';
      }).catch(() => {});
    }
  }

  return out.join('');
}

const ARCH_NAME = { 0: 'x86', 5: 'ARM', 9: 'x64', 12: 'ARM64', 0xFFFF: '未知' };

/* 复制/导出的纯文本报告 */
function reportText(s, archive) {
  const L = [];
  const put = (k, v) => { if (v != null && v !== '') L.push(k + ': ' + v); };
  L.push('=== 个人工具箱 · 系统状态 ===');
  L.push(new Date().toLocaleString('zh-CN'));
  L.push('');
  L.push('[应用]');
  put('版本', 'v' + s.version);
  put('进程号', s.pid);
  put('本进程内存', s.proc_working != null ? fmtBytes(s.proc_working) : null);
  put('本进程私有', s.proc_private != null ? fmtBytes(s.proc_private) : null);
  put('开机时长', s.uptime_ms != null ? fmtDuration(s.uptime_ms) : null);
  L.push('');
  L.push('[系统]');
  put('处理器', s.cpu_brand);
  put('逻辑处理器', s.cpu_cores);
  put('系统 CPU', s.cpu_percent >= 0 ? s.cpu_percent.toFixed(1) + '%' : '测量中');
  put('物理内存', s.mem_total ? (fmtBytes(s.mem_total - s.mem_avail) + ' / ' + fmtBytes(s.mem_total)) : null);
  put('内存负载', s.mem_percent != null ? s.mem_percent + '%' : null);
  put('条装内存', s.mem_installed ? fmtBytes(s.mem_installed) : null);
  put('提交内存', s.mem_commit ? fmtBytes(s.mem_commit) + ' / ' + fmtBytes(s.mem_commit_limit) : null);
  put('系统缓存', s.mem_cache != null ? fmtBytes(s.mem_cache) : null);
  put('进程/线程/句柄', s.proc_count != null ? (s.proc_count + ' / ' + s.thread_count + ' / ' + s.handle_count) : null);
  L.push('');
  L.push('[磁盘]');
  put('盘符', s.disk_root);
  put('总计', s.disk_total ? fmtBytes(s.disk_total) : null);
  put('可用', s.disk_free ? fmtBytes(s.disk_free) : null);
  L.push('');
  L.push('[存档]');
  if (archive && archive.items) {
    put('目录', archive.dir);
    put('旧存档 store.json', archive.items.some(i => i.name === 'store.json' && i.exists) ? '仍存在（下次写入后归档）' : '已拆分');
    if (archive.keys) put('分键存档 keys/', (archive.keys.count || 0) + ' 个键 · ' + fmtBytes(archive.keys.bytes || 0));
    if (archive.assets) put('图片资产 assets/', (archive.assets.count || 0) + ' 张 · ' + fmtBytes(archive.assets.bytes || 0));
    if (archive.migrated && archive.migrated.exists) put('归档旧文件', 'store.json.migrated-bak · ' + fmtBytes(archive.migrated.bytes));
    const backups = archive.items.filter(i => i.name.indexOf('.json.') >= 0 && i.exists);
    put('轮转备份', backups.length + ' 份');
  }
  return L.join('\n');
}
/* ===TESTABLE:sysinfoPanel:end=== */
