'use strict';

/* ---------- 通用工具函数 ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 标签条按钮串（题库、缺陷统计共用）。list 是 [键, 文字] 数组；attr 默认 data-tab。
 * 键和文字都过 esc —— 它们进的是属性和 HTML。 */
/* ---------- 极简 Markdown 渲染（日志预览用） ----------
 * 🔴 安全要点：文本是**用户从网页/聊天里粘进来的**，必须当不可信输入。
 *    所以是「先 esc 转义、再按白名单加标签」，而不是「先加标签、再过滤」。
 *    链接只放行 http/https —— 挡掉 javascript: / data: 这类伪协议。
 *
 * 支持：围栏代码块 · 行内代码 · 标题 #~###### · 粗体/斜体/删除线 · 链接 ·
 *       无序/有序列表 · 引用 · 分隔线 · 管道表格
 * 不支持的一律原样显示（宁可看到原始符号，也不要瞎猜着渲染）。
 *
 * 用**逐行状态机**而不是一串 replace：replace 会互相污染，
 * 代码块里的 `*` 被斜体规则吃掉是这类实现的经典 bug。 */
function mdToHtml(src) {
  const lines = String(src == null ? '' : src).split('\n');
  const out = [];
  let para = [];      // 当前段落的行
  let list = null;    // 'ul' | 'ol' | null
  let quote = [];     // 当前引用的行

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const flushQuote = () => {
    if (quote.length) { out.push('<blockquote>' + quote.map(mdInline).join('<br>') + '</blockquote>'); quote = []; }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    /* 围栏代码块：```lang ... ``` —— 内容整段 esc，不做任何行内解析 */
    const fence = /^\s*```+\s*([^\s`]*)\s*$/.exec(ln);
    if (fence) {
      flushAll();
      const lang = (fence[1] || '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push('<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '')
        + '><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    if (!ln.trim()) { flushAll(); continue; }                       // 空行 = 段落结束

    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) {                       // 标题
      flushAll();
      const lv = m[1].length;
      out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>');
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln)) {               // 分隔线
      flushAll();
      out.push('<hr>');
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(ln))) {                           // 引用（连续行合并）
      flushPara(); flushList();
      quote.push(m[1]);
      continue;
    }

    /* 管道表格：第一行是表头，第二行必须是含 - 的分隔行 */
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length
      && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
      flushAll();
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      i--;
      out.push('<table class="md-table"><thead><tr>'
        + head.map(c => '<th>' + mdInline(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    if ((m = /^\s*[-*+]\s+(.*)$/.exec(ln))) {                       // 无序列表
      flushPara(); flushQuote();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + mdInline(m[1]) + '</li>');
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(ln))) {                     // 有序列表
      flushPara(); flushQuote();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + mdInline(m[1]) + '</li>');
      continue;
    }

    flushList(); flushQuote();
    para.push(ln);
  }
  flushAll();
  return out.join('');
}

/* 行内语法。esc 之后再替换；行内代码先摘出来用占位符保护，
 * 免得 `a*b*c` 里面的 * 被斜体规则吃掉。 */
function mdInline(s) {
  const codes = [];
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  t = t.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0000C(\d+)\u0000/g, (m, n) => '<code class="md-ic">' + codes[+n] + '</code>');
  return t;
}

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
