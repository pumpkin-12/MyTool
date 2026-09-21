'use strict';

/* ---------- 通用工具函数 ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 标签条按钮串（题库、缺陷统计共用）。list 是 [键, 文字] 数组；attr 默认 data-tab。
 * 键和文字都过 esc —— 它们进的是属性和 HTML。 */
function tabButtons(list, active, attr) {
  const a = attr || 'data-tab';
  return list.map(p =>
    '<button class="tab' + (String(active) === String(p[0]) ? ' on' : '') +
    '" ' + a + '="' + esc(p[0]) + '">' + esc(p[1]) + '</button>').join('');
}
/* 统计卡（题库、缺陷统计共用）：k 说明、v 数值 */
function statCard(k, v) {
  return '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}
function fmtNum(n) {
  if (!isFinite(n)) return '-';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e12 || abs < 1e-9) return n.toExponential(4);
  return String(parseFloat(n.toPrecision(10)));
}
function randInt(max) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}
/* ===TESTABLE:hashStr:begin=== */
/* 字符串短哈希（FNV-1a 变体），用于浏览器端的资产键名。
 * 不追求抗碰撞，只求同一个内容稳定得到同一个名字、避免重复存储。 */
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
/* ===TESTABLE:hashStr:end=== */
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}
let toastTimer = null;
function showToast(msg, action) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;   // 顺带清掉上一次的按钮
  clearTimeout(toastTimer);
  if (action && action.label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.onclick = () => {
      clearTimeout(toastTimer);
      t.classList.remove('show');
      if (action.fn) action.fn();
    };
    t.appendChild(b);
    t.classList.add('has-act');
    /* 有按钮可点就得给够反悔时间，1.6 秒太短 */
    toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
  } else {
    t.classList.remove('has-act');
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }
  t.classList.add('show');
}
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 380].forEach(delay => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start(ctx.currentTime + delay);
      o.stop(ctx.currentTime + delay + 0.22);
    });
    setTimeout(() => ctx.close(), 900);
  } catch (e) {}
}

/* ---------- 文件保存（双形态：桌面端原生对话框 / 浏览器下载） ---------- */
/* 桌面端 WebView2 对 <a download> + blob/data URL 的处理不受应用控制，
 * 可能静默丢弃或直接落到系统下载目录，所以桌面端一律走 Rust 的 save_file 命令。 */
function blobToBase64(blob) {
  return blob.arrayBuffer().then(function (ab) {
    const buf = new Uint8Array(ab);
    let s = '';
    const CH = 0x8000;              // 分块拼接，避免 apply 参数过多爆栈
    for (let i = 0; i < buf.length; i += CH) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    }
    return btoa(s);
  });
}
async function saveBlob(blob, name) {
  const T = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  if (T) {
    try {
      const saved = await T.invoke('save_file', {
        fileName: name,
        dataBase64: await blobToBase64(blob)
      });
      if (!saved) { showToast('已取消导出'); return false; }
      showToast('已保存');
      return true;
    } catch (e) {
      showToast('导出失败：' + ((e && e.message) ? e.message : e));
      return false;
    }
  }
  // 浏览器：保持原有行为
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/* xlsx 按需懒加载（题库、缺陷统计共用这一个 loader，失败不缓存、下次还能重试）。
 * 首屏不引 vendor —— 不用 Excel 互操作的人不该为它付出加载时间。 */
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (loadXlsx._p) return loadXlsx._p;
  loadXlsx._p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => window.XLSX ? res(window.XLSX) : rej(new Error('XLSX 未就绪'));
    s.onerror = () => rej(new Error('加载 vendor/xlsx.full.min.js 失败'));
    document.head.appendChild(s);
  }).catch(e => { loadXlsx._p = null; throw e; });
  return loadXlsx._p;
}

/* ===TESTABLE:sysinfoPanel:begin=== */
