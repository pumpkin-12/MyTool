// 专项验证：mermaid 按需加载 + 离开释放
// 手法：把 js/tools/mermaid.js 的工具模块抽出来（readFrontend 拼好全部前端源码），
//       在一个造好的极简 DOM 里跑，
//       断言「dispose 后 lib / window.mermaid / 注入的 <script> 都被清掉」
// 覆盖：① 改动落点结构 ② 模块可挂载 ③ dispose 释放 ④ 切走再切回 ⑤ 加载中切走
// 用法: node tools/verify-mermaid-release.js
// 退出码 0 = 全通过；结果打到 stdout 并写入 .workbuddy/_mermaid-release.txt
const H = require('./_harness');

const html = H.readFrontend();
const vm = H.vm;
const R = H.makeReport({ name: 'mermaid-release', expected: 24 });
const { ok, section, log } = R;

section('[1] 源码结构检查（改动落点）');
ok(/const injectedScripts = new Set\(\);/.test(html), 'injectedScripts 集合已声明');
ok(/injectedScripts\.add\(s\);\s+\/\/ 先登记再插入/.test(html) || /injectedScripts\.add\(s\);/.test(html),
   'loadScript 里先登记再插入（不等 onload）');
ok(/function dropInjected\(s\)/.test(html), '抽取 dropInjected 辅助函数');
ok(/if \(disposed\) dropInjected\(s\);/.test(html), 'insert 后若已 dispose 立即移除');
ok(/injectedScripts\.forEach\(dropInjected\);/.test(html), 'dispose 里清理全部已注入脚本');
ok(/loading = null;\s*\n\s*libErr = null;/.test(html), 'dispose 里清空 loading/libErr');
ok(/try \{ window\.mermaid = null; \} catch \(e\) \{\}/.test(html), 'dispose 里清掉 window.mermaid');
ok(/if \(disposed\) \{ lib = null; return Promise\.reject/.test(html),
   '加载完成时若已 dispose，不持有 lib 引用');

section('[2] 真机行为模拟（抽模块 + 极简 DOM）');

// 抽 mermaid 工具模块。以下两条坑都是真实踩过的，别改回更"聪明"的写法：
// 🔴 坑一：index.html 是 **CRLF 行尾**，标记串里写 \n 会让 indexOf 返回 -1 →
//    整个 [2]~[6] 段被跳过、连报告都不产出，表现为"跑完了、退出码 0、看着像通过"，
//    实际什么都没验证（这段代码自 2026-09-14 写下起一直没真正跑过，09-15 才发现）。
//    现在由 _harness 读入即归一化成 LF，脚本不必再操心行尾差异。
// 🔴 坑二：**不要用花括号配平找结尾** —— 段内字符串/正则里也有 `{` `}`（CSS 模板、正则量词），
//    纯计数会跑偏甚至扫到文件尾返回 -1。
//    也不要用 `lastIndexOf('工具 10：刷题')` —— 文件里有三处「工具 10：」，
//    取最后一个会把刷题模块整段吞进来（截出 33858 字符，远超真实 35149 → 语法报
//    "Unexpected end of input"）。
//    现在起点终点都由配对的 TESTABLE 标记钉死，标记缺失直接 throw，不再静默跳段。
const seg = H.extractByMarker(html, 'mermaidModule');
ok(true, '抽到 mermaid 模块段（TESTABLE 标记）');
if (seg) {
  ok(seg.length > 1000, 'mermaid 模块体量合理（' + seg.length + ' 字符）');

  // 极简 DOM / 环境
  const created = { scripts: [], head: [] };
  function mkEl(tag) {
    return {
      tagName: tag, style: {}, dataset: {}, children: [],
      _html: '', value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      set textContent(v) { this._text = v; }, get textContent() { return this._text || ''; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (this.tagName === 'head') head.children = this.children; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; if (this.tagName === 'head') head.children = this.children; return c; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return mkEl('div'); },
      querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; },
      focus() {}, blur() {}, click() {}, remove() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
      getContext() { return { clearRect() {}, drawImage() {}, save() {}, restore() {}, scale() {}, translate() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {}, arc() {}, rect() {}, closePath() {}, measureText() { return { width: 10 }; }, fillText() {}, strokeText() {}, setTransform() {}, createLinearGradient() { return { addColorStop() {} }; } }; },
      toDataURL() { return 'data:image/png;base64,'; }
    };
  }

  const head = mkEl('head');
  const document = {
    documentElement: { classList: { contains() { return false; }, add() {}, remove() {} } },
    head: head,
    body: mkEl('body'),
    createElement(tag) { const e = mkEl(tag); if (tag === 'script') created.scripts.push(e); return e; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }
  };

  let registeredTool = null;
  const timers = [];
  const sandbox = {
    console,
    document,
    window: { __TAURI__: { core: { invoke() { return Promise.resolve(); } } } },  // 桌面端：走 viaLocal
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    setTimeout(fn, ms) { timers.push(fn); return timers.length; },
    clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame(fn) { return setTimeout(fn, 0); }, cancelAnimationFrame() {},
    Image: function () { this.onload = null; },
    Blob: function () {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    FileReader: function () {},
    showToast() {},
    registerTool(t) { registeredTool = t; },
    esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
    AppStore: { get(k, d) { return d; }, set() { return true; }, remove() {}, setMany() { return true; } },
    quizCore: {}, QuizCore: {},
    navigator: { userAgent: 'node' },
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set
  };
  sandbox.window.document = document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(seg, sandbox, { filename: 'mermaid-module.js' });
    ok(!!registeredTool, 'registerTool 被调用');
    ok(registeredTool && registeredTool.id === 'mermaid', '工具 id 为 mermaid');
  } catch (e) {
    ok(false, '模块可执行', e.message);
  }

  if (registeredTool) {
    section('[3] mount / dispose 生命周期');
    const root = mkEl('div');
    let dispose = null;
    try {
      dispose = registeredTool.mount(root);
      ok(typeof dispose === 'function', 'mount 返回 dispose 函数');
    } catch (e) { ok(false, 'mount 可执行', e.message); }

    if (typeof dispose === 'function') {
      // mount 后应已注入一个 <script>（viaLocal 路径，因为 window.__TAURI__ 存在）
      ok(created.scripts.length >= 1, '挂载后注入了 mermaid <script>（' + created.scripts.length + ' 个）');
      const s0 = created.scripts[0];
      // 模拟脚本加载成功
      if (s0 && s0.onload) { try { s0.onload(); } catch (e) {} }

      // 交给 Promise 队列
      Promise.resolve().then(() => Promise.resolve()).then(() => {
        section('[4] dispose 后资源释放');
        const before = {
          scriptInHead: head.children.length,
          winMermaid: sandbox.window.mermaid
        };
        try { dispose(); } catch (e) { ok(false, 'dispose 可执行', e.message); }
        const after = {
          scriptInHead: head.children.length,
          winMermaid: sandbox.window.mermaid
        };

        ok(before.scriptInHead >= 1, 'dispose 前 head 里有注入的 script（' + before.scriptInHead + '）');
        ok(after.scriptInHead === 0, 'dispose 后 head 里的 script 被移除（' + after.scriptInHead + '）');
        ok(after.winMermaid === null, 'dispose 后 window.mermaid 被清空');

        // ---- 关键边界：切走后再切回，必须能重新加载 ----
        section('[5] 切走再切回（重新挂载）');
        const root2 = mkEl('div');
        const n1 = created.scripts.length;
        let dispose2 = null;
        try { dispose2 = registeredTool.mount(root2); ok(true, '二次 mount 未抛异常'); }
        catch (e) { ok(false, '二次 mount 未抛异常', e.message); }
        ok(created.scripts.length > n1,
           '二次挂载重新注入了 <script>（新增 ' + (created.scripts.length - n1) + ' 个）');
        ok(typeof dispose2 === 'function', '二次 dispose 可取到');
        if (typeof dispose2 === 'function') { try { dispose2(); ok(true, '二次 dispose 未抛异常'); } catch (e) { ok(false, '二次 dispose 未抛异常', e.message); } }

        // ---- 边界：加载中切走（dispose 早于 onload） ----
        section('[6] 加载中切走（dispose 早于脚本 onload）');
        const root3 = mkEl('div');
        let dispose3 = registeredTool.mount(root3);
        const lastScript = created.scripts[created.scripts.length - 1];
        try { dispose3(); ok(true, '未等 onload 就 dispose，未抛异常'); } catch (e) { ok(false, '未等 onload 就 dispose', e.message); }
        // 此时再触发 onload，应能安全移除且不炸
        if (lastScript && lastScript.onload) {
          try { lastScript.onload(); ok(true, '滞后的 onload 回调安全返回（不抛异常）'); }
          catch (e) { ok(false, '滞后的 onload 回调安全返回', e.message); }
        }
        ok(head.children.length === 0, '加载中切走后 head 保持干净（' + head.children.length + '）');

        finish();
      });
    } else {
      finish();
    }
  } else {
    finish();
  }
}

/* 收尾交给 _harness，三条硬要求都由它兜住：
 *   ① 报告无条件产出（跑完静默无声 = 没人知道有没有验证）
 *   ② 断言总数必须等于 EXPECTED（只跑 15 项和跑满 24 项不能长得一样）
 *   ③ 退出码如实反映（全绿 0 / 有失败或漏跑 1）
 * 历史上这个脚本踩过 ①②：CRLF 匹配失败导致 [2]~[6] 整段被跳过，结果行照旧
 * 打印"23 通过 / 0 失败"——退出码 0、看着全绿，其实只跑了 8 项。
 * 保留函数声明形式（而非 const）：下面三个调用点都在异步回调里，别引入 TDZ 风险。 */
function finish() { R.finish(); }
