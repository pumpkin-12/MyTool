/* 各 verify 脚本的共享地基。存在的全部理由是「假绿」：
 *   抽取静默失败 → 少跑一半断言 → 退出码 0 → 看着全绿。
 *   2026-09-15 的 mermaid 脚本（只跑了 8/23 项）、2026-09-16 的 store-semantics
 *   （行号区间漂移到 CSS 上）都栽在这上面。这里把四条防线固化成一次实现：
 *     1. 路径由 __dirname 推导，不写死绝对路径
 *     2. 读入即归一化成 LF（index.html 是真 CRLF，而 CI 上 checkout 可能是 LF）
 *     3. 抽取按成对标记，找不到就 throw，绝不返回空串继续跑
 *     4. finish() 校验断言总数 == 脚本声明的 EXPECTED，不符直接判失败
 * 用法见任一 verify-*.js 的开头。结果同时打 stdout 和写 .workbuddy/_<name>.txt。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, '.workbuddy');

/* 读项目内文件，统一成 LF。
 * 不归一的后果实测过：标记串写 `\n` 而文件是 CRLF → indexOf 返回 -1 →
 * 整段断言被跳过、报告照样打印"全通过"。 */
function readRel(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/* 前端代码分成 index.html + js/*.js 之后，"读前端"必须是读全部。
 * 文件清单只以 index.html 里的 <script src> 为准 —— 这里不再另立一份列表，
 * 否则改了页面忘了改这里，抽取会静默拿到旧代码（正是本文件要根治的假绿形态）。
 *
 * 为什么要拼成一整份而不是逐个文件分别抽：历史断言里有按 indexOf + slice 取段的写法
 * （verify-defect / verify-quizcore），拼接顺序 == 分文件之前的单一内联顺序，
 * 那些写法原样可用，段与段的相对位置也没变。 */
function frontendScripts() {
  const doc = readRel('web/index.html');
  const re = /<script[^>]*\bsrc="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(doc)) !== null) {
    const rel = m[1];
    if (/^(https?:)?\/\//.test(rel)) continue;      // 真正的远端脚本，本地读不到
    out.push({ rel: 'web/' + rel, src: readRel('web/' + rel) });
  }
  return out;
}
function readFrontend() {
  return [readRel('web/index.html')]
    .concat(frontendScripts().map(f => f.src)).join('\n');
}

const readLibRs = () => readRel('src-tauri/src/lib.rs');
const readCargoToml = () => readRel('src-tauri/Cargo.toml');

const MARK_BEGIN = (name) => '/* ===TESTABLE:' + name + ':begin=== */';
const MARK_END = (name) => '/* ===TESTABLE:' + name + ':end=== */';

/* 按成对标记抽出被测段。任何缺失都 throw —— 让脚本崩在终端上，
 * 而不是记一条 FAIL 后继续跑，最后报个"基本通过"。 */
function extractByMarker(html, name) {
  const b = MARK_BEGIN(name), e = MARK_END(name);
  const i = html.indexOf(b);
  if (i < 0) {
    throw new Error('抽取失败：找不到 ' + b +
      '。被测段被删除、改名或移动时，请同步移动标记 —— 禁止改成"跳过"。');
  }
  const j = html.indexOf(e, i);
  if (j < 0) throw new Error('抽取失败：' + b + ' 缺少配对的 ' + e);
  const body = html.slice(i + b.length, j).trim();
  if (!body.length) throw new Error('抽取失败：' + name + ' 标记之间是空的');
  return body;
}

/* 报告器。各脚本沿用原有的 ok/section/log 调用形态，只把样板集中到这里。 */
function makeReport(opts) {
  const name = opts.name;
  const expected = opts.expected;
  const lines = [];
  let pass = 0, fail = 0;

  const log = (s) => { lines.push(s); };
  const section = (s) => { lines.push(''); lines.push(s); };

  function ok(cond, label, extra) {
    if (cond) { pass++; lines.push('  PASS  ' + label); }
    else {
      fail++;
      lines.push('  FAIL  ' + label +
        (extra === undefined || extra === null || extra === '' ? '' : '   << ' + extra));
    }
    return !!cond;
  }

  /* 期望 fn 抛错；msgPart 用于核对抛的是哪一种。不抛即失败。 */
  function throws(fn, label, msgPart) {
    try {
      fn();
      ok(false, label, '没有抛错');
    } catch (e) {
      const m = (e && e.message) ? e.message : String(e);
      ok(!msgPart || m.indexOf(msgPart) >= 0, label, msgPart ? m : undefined);
    }
  }

  function finish() {
    const total = pass + fail;
    let broken = fail;

    if (expected !== undefined && total !== expected) {
      lines.push('');
      lines.push('  ⛔ 断言总数 ' + total + ' ≠ 脚本声明的 ' + expected + ' 项。');
      lines.push('     要么中途有分支被跳过（抽取失败 / 条件短路 / 提前 return），');
      lines.push('     要么新增或删除了断言而没更新 EXPECTED。两种都必须查清楚。');
      lines.push('     这正是历史上两次「假绿」的形态，本次判定为失败。');
      broken = broken || 1;
    }

    lines.push('');
    lines.push('===== ' + name + ': ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' +
      total + ' 项 =====');

    const text = lines.join('\n') + '\n';
    process.stdout.write(text);
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(REPORT_DIR, '_' + name + '.txt'), text, 'utf8');
    } catch (e) {
      /* 报告落盘失败不该盖住测试结论，但也不能静默 —— 至少喊一声 */
      process.stdout.write('（报告文件写入失败: ' + e.message + '）\n');
    }

    const code = broken ? 1 : 0;
    process.exitCode = code;
    /* 脚本里常有未清理的定时器/handle 会让进程挂住；unref 保证正常情况自然退出，
     * 挂住时 200ms 后带着正确的退出码离开。 */
    setTimeout(() => process.exit(code), 200).unref();
  }

  return {
    log, section, ok, throws, finish, lines,
    counts: () => ({ pass, fail }),
  };
}

module.exports = {
  ROOT, readRel, readFrontend, frontendScripts, readLibRs, readCargoToml,
  extractByMarker, makeReport,
  vm, fs, path,
};
