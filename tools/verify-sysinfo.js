// 专项验证：系统状态模块（第一档）
//
// 分两块：
//   A. Rust 侧 —— 静态检查 lib.rs + Cargo.toml 的落点是否正确
//      （Rust 没有可嵌入 JS 的运行环境，这里只能查结构；真值靠 cargo check + 真机）
//   B. 前端侧 —— 把系统状态面板相关的函数抽出来，在极简 DOM 里真跑一遍，
//      重点断言「定时器纪律」三条：dispose 清定时器 / visibilitychange 解绑 / alive 阻断回调
//
// 用法: node tools/verify-sysinfo.js
// 退出码 0 = 全通过；结果写入 .workbuddy/_sys.txt

const fs = require('fs');
const vm = require('vm');

const ROOT = 'D:/Ai-file/MyTool';
const html = fs.readFileSync(ROOT + '/web/index.html', 'utf8');
const rs = fs.readFileSync(ROOT + '/src-tauri/src/lib.rs', 'utf8');
const toml = fs.readFileSync(ROOT + '/src-tauri/Cargo.toml', 'utf8');

let pass = 0, fail = 0;
const log = [];
function ok(cond, label, extra) {
  if (cond) { pass++; log.push('  PASS  ' + label); }
  else { fail++; log.push('  FAIL  ' + label + (extra ? '  << ' + extra : '')); }
}
function section(s) { log.push(''); log.push(s); }

/* ==========================================================================
 * A. Rust 侧静态检查
 * ======================================================================== */

section('[A1] Cargo.toml：windows-sys 依赖声明');

ok(/\[target\.'cfg\(windows\)'\.dependencies\]/.test(toml),
   '用 cfg(windows) 限定平台（不影响将来可能的跨平台构建）');
ok(/windows-sys\s*=\s*\{\s*version\s*=\s*"0\.61"/.test(toml),
   'windows-sys 版本 0.61（与 Cargo.lock 中已有的一致，不引入新下载）');
['Win32_Foundation', 'Win32_Storage_FileSystem', 'Win32_System_ProcessStatus',
 'Win32_System_SystemInformation', 'Win32_System_Threading'].forEach(f => {
  ok(toml.indexOf('"' + f + '"') >= 0, '勾选 feature ' + f);
});

section('[A2] lib.rs：三条新命令已注册');

ok(/fn sysinfo\(/.test(rs), 'sysinfo 函数已定义');
ok(/fn dir_usage\(/.test(rs), 'dir_usage 函数已定义');
ok(/fn store_stats\(/.test(rs), 'store_stats 函数已定义');
ok(/generate_handler!\[[\s\S]*?sysinfo[\s\S]*?\]/.test(rs), 'sysinfo 已进 invoke_handler');
ok(/generate_handler!\[[\s\S]*?dir_usage[\s\S]*?\]/.test(rs), 'dir_usage 已进 invoke_handler');
ok(/generate_handler!\[[\s\S]*?store_stats[\s\S]*?\]/.test(rs), 'store_stats 已进 invoke_handler');
ok(/\.manage\(CpuSample::default\(\)\)/.test(rs), 'CpuSample state 已 manage');

section('[A3] lib.rs：CPU 采样的正确性（易错点）');

ok(/Mutex<Option<\(u64, u64, u64\)>>/.test(rs),
   'CpuSample 保存 (idle, kernel, user) 三元组');
ok(/let \(pi, pk, pu\) = prev\?;/.test(rs), '首次采样返回 None（无基准）');
// 关键：kernel 已包含 idle，总时间只能是 (kernel-pk)+(user-pu)
ok(/cur\.1\.saturating_sub\(pk\)\s*\+\s*cur\.2\.saturating_sub\(pu\)/.test(rs),
   '总时间 = (kernel去差)+(user去差)，没有重复加 idle');
ok(!/d_total\s*=\s*d_idle\s*\+/.test(rs), '未把 idle 重复计入总时间（反例检查）');
ok(/\.clamp\(0\.0, 100\.0\)/.test(rs), '结果被 clamp 到 [0,100]');

section('[A4] lib.rs：只读边界（不该出现的写操作）');

[
  ['EmptyWorkingSet', '裁剪工作集（只是把内存挪到页文件，自欺欺人）'],
  ['InitiateShutdown', '关机/重启'],
  ['TerminateProcess', '结束进程'],
  ['SHEmptyRecycleBin', '清空回收站'],
  ['ExitWindowsEx', '注销/关机'],
  ['SetSystemPowerState', '改电源状态'],
  ['RegSetValue', '写注册表']
].forEach(([fn, why]) => {
  ok(rs.indexOf(fn) < 0, '未调用 ' + fn + '（' + why + '）');
});
ok(/RegOpenKeyExW/.test(rs) && /RegQueryValueExW/.test(rs), '只用了注册表读（RegOpen/RegQuery）');
ok(rs.indexOf('RegCloseKey') > 0, 'RegCloseKey 有配对关闭（不泄漏句柄）');

section('[A5] lib.rs：健壮性');

ok(/if !root\.exists\(\)/.test(rs), 'dir_usage 对不存在的路径返回 0 而非报错');
ok(/let mut stack = vec!\[root\];/.test(rs), 'dir_usage 用显式栈迭代（深目录不会爆栈）');
ok(/continue; \/\/ 无权限的子目录直接跳过/.test(rs), 'dir_usage 跳过无权限子目录');
ok(/async fn dir_usage/.test(rs), 'dir_usage 是 async（扫描耗时不阻塞主线程）');
ok(/saturating_add/.test(rs), '字节累加用 saturating_add（防溢出）');

section('[A6] 前端：面板入口与销毁钩子');

ok(/id="openSysinfo"/.test(html), '首页 data-bar 有「系统状态」按钮');
ok(/openSysinfo\)/.test(html), '按钮已绑定点击事件');
ok(/let __sysCleanup = null;/.test(html), '__sysCleanup 模块级变量已声明');
ok(/if \(__sysCleanup\) \{ try \{ __sysCleanup\(\); \} catch \(e\) \{\} \}/.test(html),
   'render()（路由切换）里会收掉面板 —— 否则切走时定时器还在跑');

/* ==========================================================================
 * B. 前端面板：抽函数 + 极简 DOM 真跑
 * ======================================================================== */

section('[B1] 抽面板代码段');

// 从 fmtBytes 到 reportText 结束，这一整段都是面板自足代码
const segStart = html.indexOf('/* ---------- 系统状态面板 ----------');
const segEnd = html.indexOf('/* ---------- 应用内对话框 ----------');
let seg = '';
if (segStart < 0 || segEnd < 0 || segEnd <= segStart) {
  ok(false, '定位系统状态面板代码段', 'start=' + segStart + ' end=' + segEnd);
} else {
  seg = html.slice(segStart, segEnd);
  ok(seg.length > 3000, '成功抽出面板代码段（' + seg.length + ' 字符）');
  ok(/function openSysinfo\(/.test(seg), '包含 openSysinfo');
  ok(/function fmtBytes\(/.test(seg), '包含 fmtBytes');
  ok(/function reportText\(/.test(seg), '包含 reportText');
}

section('[B2] 纯函数正确性（不需要 DOM）');

// 用 vm 单独跑 fmtBytes / fmtDuration / reportText 这类无副作用函数
const pureCtx = { console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error };
pureCtx.globalThis = pureCtx;
vm.createContext(pureCtx);
try {
  const fnStart = seg.indexOf('function fmtBytes');
  const fnEnd = seg.indexOf('/* 纯 CSS 条');
  vm.runInContext(seg.slice(fnStart, fnEnd), pureCtx, { filename: 'pure.js' });

  ok(pureCtx.fmtBytes(0) === '0 B', 'fmtBytes(0) = 0 B');
  ok(pureCtx.fmtBytes(512) === '512 B', 'fmtBytes(512) = 512 B', pureCtx.fmtBytes(512));
  ok(pureCtx.fmtBytes(1024) === '1.0 KB', 'fmtBytes(1024) = 1.0 KB', pureCtx.fmtBytes(1024));
  ok(/1\.0 MB/.test(pureCtx.fmtBytes(1024 * 1024)), 'fmtBytes(1MB) 含 1.0 MB', pureCtx.fmtBytes(1048576));
  ok(/1\.0 GB/.test(pureCtx.fmtBytes(1073741824)), 'fmtBytes(1GB) 含 1.0 GB', pureCtx.fmtBytes(1073741824));
  // 大数取整（>=100 不显示小数），小数（<100）保留一位
  ok(pureCtx.fmtBytes(200 * 1073741824) === '200 GB',
     'fmtBytes(200GB) 取整（不显示小数）', pureCtx.fmtBytes(200 * 1073741824));
  ok(pureCtx.fmtBytes(42.6 * 1073741824) === '42.6 GB',
     'fmtBytes(42.6GB) 保留一位小数', pureCtx.fmtBytes(42.6 * 1073741824));
  ok(pureCtx.fmtBytes(null) === '0 B', 'fmtBytes(null) 不炸，返回 0 B');
  ok(pureCtx.fmtBytes(undefined) === '0 B', 'fmtBytes(undefined) 不炸，返回 0 B');

  ok(pureCtx.fmtDuration(0) === '0 分 0 秒', 'fmtDuration(0)', pureCtx.fmtDuration(0));
  ok(/2 小时 3 分/.test(pureCtx.fmtDuration((2 * 3600 + 3 * 60) * 1000)),
     'fmtDuration 小时级', pureCtx.fmtDuration(7380000));
  ok(/3 天 4 小时/.test(pureCtx.fmtDuration((3 * 86400 + 4 * 3600) * 1000)),
     'fmtDuration 天级', pureCtx.fmtDuration(273600000));
} catch (e) {
  ok(false, '纯函数可执行', e.message);
}

section('[B3] 面板挂载 + 定时器纪律（关键）');

// 造一个够用的 DOM
const timers = new Map();
let timerSeq = 0;
const listeners = { visibilitychange: [] };
const createdEls = [];

function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    _html: '', _text: '', value: '', parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text || ''; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    querySelector(sel) { return this._q && this._q[sel] ? this._q[sel] : null; },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() { if (this._onclick) this._onclick(); }, remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    _q: {}, _onclick: null
  };
  createdEls.push(el);
  return el;
}

const documentMock = {
  documentElement: { classList: { contains() { return false; }, add() {}, remove() {} } },
  head: mkEl('head'),
  body: mkEl('body'),
  hidden: false,
  createElement(tag) { return mkEl(tag); },
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener(t, fn) { const a = listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById(id) { return createdEls.find(e => e._id === id) || null; }
};

let invokeCalls = [];
const sandbox = {
  console, document: documentMock,
  window: {
    __TAURI__: {
      core: {
        invoke(cmd, args) {
          invokeCalls.push({ cmd: cmd, args: args });
          if (cmd === 'store_stats') {
            return Promise.resolve(JSON.stringify({
              items: [
                { name: 'store.json', bytes: 185000, exists: true },
                { name: 'store.json.1', bytes: 160000, exists: true },
                { name: 'store.json.2', bytes: 0, exists: false }
              ],
              total: 185000, dir: 'D:\\Ai-file\\MyTool\\data'
            }));
          }
          if (cmd === 'sysinfo') {
            return Promise.resolve(JSON.stringify({
              pid: 1234, version: '0.1.0',
              proc_working: 28700000, proc_private: 7600000,
              mem_total: 16000000000, mem_avail: 4000000000, mem_percent: 75,
              cpu_cores: 8, cpu_arch: 9, cpu_brand: 'Test CPU', cpu_percent: 8.5,
              uptime_ms: 273600000,
              disk_root: 'D:\\', disk_total: 207000000000, disk_free: 42600000000
            }));
          }
          if (cmd === 'dir_usage') return Promise.resolve(JSON.stringify({ bytes: 970000, files: 14, exists: true }));
          return Promise.resolve('{}');
        }
      }
    }
  },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
  setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn: fn, ms: ms, repeat: false }); return id; },
  clearTimeout(id) { timers.delete(id); },
  setInterval(fn, ms) { const id = ++timerSeq; timers.set(id, { fn: fn, ms: ms, repeat: true }); return id; },
  clearInterval(id) { timers.delete(id); },
  requestAnimationFrame(fn) { return 1; }, cancelAnimationFrame() {},
  Blob: function (parts) { this.size = (parts && parts[0] ? String(parts[0]).length : 0); },
  URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  FileReader: function () {},
  navigator: { userAgent: 'node', clipboard: null },
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set
};
sandbox.globalThis = sandbox;
sandbox.window.document = documentMock;
sandbox.window.localStorage = sandbox.localStorage;

// 面板依赖的外部：uiOverlay / uiCloseModal / esc / showToast / AppStore / saveBlob / todayKey
let overlayCard = null;
let closedCount = 0;
sandbox.esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
sandbox.showToast = () => {};
sandbox.todayKey = () => '2026-09-14';
sandbox.saveBlob = () => Promise.resolve(true);
sandbox.AppStore = {
  exportAll() {
    return {
      'toolbox:quiz:questions': { a: 'x'.repeat(1000) },
      'toolbox:quiz:records': { b: 'y'.repeat(100) },
      'toolbox:internlog:items': { c: 'z'.repeat(10) }
    };
  }
};
sandbox.uiOverlay = function (inner) {
  const box = mkEl('div');
  const card = mkEl('div');
  card.innerHTML = inner;
  // 面板里用 querySelector('#id') 取子节点，这里给几个已知 id 造替身
  ['#sysStamp', '#sysBody', '#sysClose', '#sysCopy', '#sysDirUsage'].forEach(sel => {
    const id = sel.slice(1);
    const el = mkEl('div');
    el._id = id;
    card._q[sel] = el;
    createdEls.push(el);
  });
  box.appendChild(card);
  documentMock.body.appendChild(box);
  overlayCard = card;
  return { box: box, card: card };
};
sandbox.uiCloseModal = function () { closedCount++; };

try {
  vm.createContext(sandbox);
  vm.runInContext(seg, sandbox, { filename: 'syspanel.js' });
  ok(typeof sandbox.openSysinfo === 'function', '面板模块可执行，openSysinfo 已定义');
} catch (e) {
  ok(false, '面板模块可执行', e.message);
}

/* 面板把清理函数挂在模块级 `let __sysCleanup` 上。
 * vm 里顶层 `let` 不会落到 sandbox 对象上（只有 function 声明和 var 会），
 * 所以这里在同一段源码后再跑一小段，把闭合的取值/检查能力暴露出来。
 * 用 `typeof` 而非直接读，是为了避免「尚未声明」时的 ReferenceError。 */
try {
  vm.runInContext([
    'globalThis.__probeCleanup = function () { return typeof __sysCleanup === "function"; };',
    'globalThis.__callCleanup  = function () { if (typeof __sysCleanup === "function") __sysCleanup(); };',
    'globalThis.__cleanupIsNull = function () { return __sysCleanup === null; };'
  ].join('\n'), sandbox, { filename: 'probe.js' });
} catch (e) {
  ok(false, '注入 probe 失败', e.message);
}

// 挂载面板，检查定时器
if (typeof sandbox.openSysinfo === 'function') {
  const timersBefore = timers.size;
  const listenersBefore = (listeners.visibilitychange || []).length;

  let opened = true;
  try { sandbox.openSysinfo(); } catch (e) { opened = false; ok(false, 'openSysinfo 可执行', e.message); }

  if (opened) {
    // start() 会 setInterval 一个 3 秒轮询
    const intervals = [...timers.values()].filter(t => t.repeat);
    ok(intervals.length === 1, '打开面板后有且仅有 1 个轮询定时器（' + intervals.length + '）');
    if (intervals.length) {
      ok(intervals[0].ms === 3000, '轮询间隔为 3000ms（3 秒是舒适区：1 秒抖动、10 秒迟钝）',
         String(intervals[0].ms));
    }
    ok(timers.size === timersBefore + 1, '没有多余的定时器被创建');
    ok((listeners.visibilitychange || []).length === listenersBefore + 1,
       '注册了 1 个 visibilitychange 监听');
    ok(sandbox.__probeCleanup(), '打开后 __sysCleanup 已注册（可被关闭路径调用）');

    // ---- 关闭：三条纪律逐一验证 ----
    section('[B4] 关闭后：定时器 / 监听器 / DOM 引用全部释放');

    sandbox.__callCleanup();   // 模拟点「关闭」或点遮罩

    const intervalsAfter = [...timers.values()].filter(t => t.repeat);
    ok(intervalsAfter.length === 0, '关闭后轮询定时器已清除（剩 ' + intervalsAfter.length + '）');
    ok((listeners.visibilitychange || []).length === listenersBefore,
       '关闭后 visibilitychange 监听已解绑');
    ok(closedCount >= 1, '关闭时调用了 uiCloseModal');
    ok(sandbox.__cleanupIsNull(), '关闭后 __sysCleanup 置空（可重入）');

    // ---- 重入：连开 5 次只应剩 1 个定时器 ----
    section('[B5] 反复开关 10 次：不叠加定时器 / 不泄漏监听');

    for (let i = 0; i < 10; i++) {
      sandbox.openSysinfo();
      sandbox.__callCleanup();
    }
    const leaked = [...timers.values()].filter(t => t.repeat).length;
    ok(leaked === 0, '10 次开关后无遗留定时器（' + leaked + '）');
    ok((listeners.visibilitychange || []).length === listenersBefore,
       '10 次开关后 visibilitychange 监听数回到基线（' + (listeners.visibilitychange || []).length + '）');

    // 中途不关就重开：旧的必须先被收掉，不能出现两个轮询
    sandbox.openSysinfo();
    sandbox.openSysinfo();
    const doubleOpen = [...timers.values()].filter(t => t.repeat).length;
    ok(doubleOpen === 1, '未关就重开时，旧面板先被收掉，只剩 1 个轮询（' + doubleOpen + '）');
    sandbox.__callCleanup();

    // ---- 可见性切换：暂停 / 恢复 ----
    section('[B6] 页面切到后台时暂停轮询，切回来恢复');

    sandbox.openSysinfo();
    const onVis = (listeners.visibilitychange || [])[listeners.visibilitychange.length - 1];
    ok(typeof onVis === 'function', '取到 visibilitychange 回调');

    // 切到后台
    documentMock.hidden = true;
    onVis();
    ok([...timers.values()].filter(t => t.repeat).length === 0, '页面隐藏后轮询已暂停');

    // 切回前台
    documentMock.hidden = false;
    onVis();
    ok([...timers.values()].filter(t => t.repeat).length === 1, '页面恢复后轮询已重启');

    // 后台时不该还在跑
    documentMock.hidden = true;
    onVis();
    onVis();   // 重复调用不应造成状态错乱
    ok([...timers.values()].filter(t => t.repeat).length === 0, '重复触发隐藏事件依然保持暂停');

    documentMock.hidden = false;
    sandbox.__callCleanup();

    // ---- 数据渲染 ----
    section('[B7] 渲染：数值与边界');

    const s = {
      pid: 1234, version: '0.1.0',
      proc_working: 28700000, proc_private: 7600000,
      mem_total: 16000000000, mem_avail: 4000000000, mem_percent: 75,
      mem_installed: 17179869184,   // 16 GiB 条装 > 15.7 GB 可见 → 有硬件保留
      cpu_cores: 8, cpu_arch: 9, cpu_brand: 'Test CPU', cpu_percent: 8.5,
      uptime_ms: 273600000,
      disk_root: 'D:\\', disk_total: 207000000000, disk_free: 42600000000
    };
    const archive = { items: [{ name: 'store.json', bytes: 185000, exists: true }], total: 185000, dir: 'D:\\Ai-file\\MyTool\\data' };

    let htmlOut = '';
    try { htmlOut = sandbox.renderSysinfo(s, archive); ok(true, 'renderSysinfo 可执行'); }
    catch (e) { ok(false, 'renderSysinfo 可执行', e.message); }

    ok(htmlOut.indexOf('Test CPU') >= 0, '渲染出 CPU 型号名');
    ok(htmlOut.indexOf('8 核') >= 0, '渲染出核数');
    ok(htmlOut.indexOf('8.5 %') >= 0, '渲染出系统 CPU 百分比');
    ok(htmlOut.indexOf('硬件保留') >= 0, '条装内存 > 可见内存时显示「硬件保留」');
    ok(htmlOut.indexOf('D:\\') >= 0, '渲染出盘符');

    // CPU 首次采样（-1）必须显示"测量中"，不能画一个假的 0%
    const first = sandbox.renderSysinfo(Object.assign({}, s, { cpu_percent: -1 }), archive);
    ok(first.indexOf('测量中') >= 0, 'CPU 首次采样（-1）显示「测量中」而非 0%');
    ok(first.indexOf('0.0 %') < 0, 'CPU 首次采样时不出现 0.0 %（反例检查）');

    // 字段缺失不能炸
    let sparseOk = true;
    try { sandbox.renderSysinfo({ version: '0.1.0' }, null); }
    catch (e) { sparseOk = false; }
    ok(sparseOk, '字段大面积缺失时 renderSysinfo 不抛异常');

    // 文本报告
    const txt = sandbox.reportText(s, archive);
    ok(/=== 个人工具箱/.test(txt), 'reportText 有标题行');
    ok(txt.indexOf('Test CPU') >= 0, 'reportText 含 CPU 型号');
    ok(/\[应用\]/.test(txt) && /\[系统\]/.test(txt) && /\[磁盘\]/.test(txt) && /\[存档\]/.test(txt),
       'reportText 四个分组齐全');
  }
}

log.push('');
log.push('  结果: ' + pass + ' 通过 / ' + fail + ' 失败');
fs.writeFileSync(ROOT + '/.workbuddy/_sys.txt', log.join('\n'), 'utf8');
process.exit(fail ? 1 : 0);
