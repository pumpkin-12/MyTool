// 验证 web/index.html：
//   1. 所有内联 <script> 块语法正确
//   2. AppStore 在浏览器模式下的 get/set/remove/exportAll/importAll 行为
//   3. AppStore 在 Tauri 模式下的读写、写盘串行化、失败可见
// 用法: node _verify.js <index.html> <报告输出路径>
const fs = require('fs');
const vm = require('vm');

const HTML = process.argv[2];
const REPORT = process.argv[3];
const html = fs.readFileSync(HTML, 'utf8');

const lines = [];
function log(s) { lines.push(s); }

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; log('  PASS  ' + label); }
  else { fail++; log('  FAIL  ' + label + (extra ? '   << ' + extra : '')); }
}

/* ---------------- 1. 语法检查：逐个解析内联 script ---------------- */
log('[1] 内联脚本语法检查');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
let blocks = 0;
while ((m = re.exec(html)) !== null) {
  blocks++;
  try {
    new vm.Script(m[1], { filename: 'inline-block-' + blocks });
    log('  PASS  block#' + blocks + ' 语法正确 (' + m[1].length + ' 字符)');
    pass++;
  } catch (e) {
    log('  FAIL  block#' + blocks + ' -> ' + e.message);
    fail++;
  }
}
ok(blocks >= 1, '找到内联脚本块（数量=' + blocks + '）');

/* ---------------- 抽出 AppStore 源码 ---------------- */
const startMark = 'const AppStore = (function () {';
const start = html.indexOf(startMark);
ok(start >= 0, '定位 AppStore 定义');
const endMark = '\n})();';
const end = html.indexOf(endMark, start);
ok(end >= 0, '定位 AppStore 结束');
const storeSrc = html.slice(start, end + endMark.length);
log('  AppStore 源码长度 = ' + storeSrc.length);

/* ---------------- 2. 浏览器模式 ---------------- */
log('[2] 浏览器模式（localStorage）');
const map = new Map();
const lsKeys = () => Array.from(map.keys());
const ls = {
  get length() { return map.size; },
  key: i => (lsKeys()[i] === undefined ? null : lsKeys()[i]),
  getItem: k => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => { map.set(k, String(v)); },
  removeItem: k => { map.delete(k); },
};

function makeSandbox(extra) {
  const toasts = [];
  const s = {
    console, JSON, Object, Array, String, Number, Boolean, Promise, Date, Math, Error,
    setTimeout, clearTimeout,
    showToast: msg => { toasts.push(msg); },
  };
  s.window = s;
  Object.assign(s, extra || {});
  s.__toasts = toasts;
  return s;
}

const s1 = makeSandbox({ localStorage: ls });
vm.createContext(s1);
vm.runInContext(storeSrc + '\nglobalThis.__AS = AppStore;', s1);
const AS = s1.__AS;

ok(AS.isNative === false, 'isNative 在浏览器下为 false');
AS.set('theme', 'dark');
AS.set('internlog:items', [{ id: 1, text: 'hello' }]);
ok(ls.getItem('toolbox:theme') === '"dark"', 'set 写入带 toolbox: 前缀的键');
ok(AS.get('theme') === 'dark', 'get 读回 theme');
ok(AS.get('missing', 'FB') === 'FB', 'get 缺失键返回 fallback');
ok(JSON.stringify(AS.get('internlog:items')) === '[{"id":1,"text":"hello"}]', 'get 返回结构一致的深拷贝');

let all = AS.exportAll();
ok(Object.keys(all).length === 2, 'exportAll 导出 2 项', JSON.stringify(Object.keys(all)));
ok(all['toolbox:theme'] === 'dark', 'exportAll 保留前缀键名');

AS.importAll({ 'toolbox:mermaid:doc': 'graph TD;', 'toolbox:sketch:shapes': [1, 2] });
ok(ls.getItem('toolbox:mermaid:doc') === '"graph TD;"', 'importAll 原样写回带前缀的键（前缀不会被重复叠加）');
ok(Object.keys(AS.exportAll()).length === 4, 'importAll 后共 4 项');

AS.remove('theme');
ok(AS.get('theme', null) === null, 'remove 删除成功');
ok(Object.keys(AS.exportAll()).length === 3, 'remove 后剩 3 项');

ls.setItem('unrelated', '1');
ok(Object.keys(AS.exportAll()).length === 3, 'exportAll 忽略非 toolbox: 前缀的键');

// setMany：多个 key 合并成一次落盘
const writesBefore = null;
ok(AS.setMany({ 'm1': 1, 'm2': { a: 1 } }) === true, 'setMany 返回 true');
ok(AS.get('m1') === 1 && AS.get('m2').a === 1, 'setMany 逐个 key 可读回');
ok(AS.setMany({}) === true, 'setMany 空对象不报错');
ok(AS.setMany(null) === false, 'setMany 传 null 返回 false');

/* ---------------- 3. Tauri 模式 ---------------- */
log('[3] Tauri 模式（invoke）');
const writes = [];
let failNextWrite = false;
const invoke = (cmd, args) => {
  if (cmd === 'store_read') return Promise.resolve(JSON.stringify({ 'toolbox:theme': 'dark' }));
  if (cmd === 'store_write') {
    writes.push(args.data);
    if (failNextWrite) { failNextWrite = false; return Promise.reject(new Error('disk full')); }
    return Promise.resolve(args.data.length);
  }
  return Promise.reject(new Error('unknown command ' + cmd));
};

const s2 = makeSandbox({ __TAURI__: { core: { invoke } } });
vm.createContext(s2);
vm.runInContext(storeSrc + '\nglobalThis.__AS = AppStore;', s2);
const AN = s2.__AS;

ok(AN.isNative === true, 'isNative 在 Tauri 下为 true');

(async () => {
  await AN.ready;
  ok(AN.get('theme', null) === 'dark', 'ready 后能读到磁盘上的 theme');

  AN.set('a', 1);
  AN.set('b', 2);
  AN.set('c', 3);
  await AN.flush();
  ok(writes.length === 3, '3 次 set 触发 3 次 store_write', 'writes=' + writes.length);

  const parsed = writes.map(w => Object.keys(JSON.parse(w)).sort().join('|'));
  ok(parsed[0] === 'toolbox:a|toolbox:theme',
     '第 1 次写盘快照 = {a, theme}', parsed[0]);
  ok(parsed[1] === 'toolbox:a|toolbox:b|toolbox:theme',
     '第 2 次写盘快照 = {a, b, theme}', parsed[1]);
  ok(parsed[2] === 'toolbox:a|toolbox:b|toolbox:c|toolbox:theme',
     '第 3 次写盘快照 = {a, b, c, theme}', parsed[2]);

  const last = JSON.parse(writes[2]);
  const trio = [last['toolbox:a'], last['toolbox:b'], last['toolbox:c']];
  ok(JSON.stringify(trio) === '[1,2,3]',
     '三次写入互不覆盖（已消除后写覆盖先写的竞态）', JSON.stringify(trio));

  failNextWrite = true;
  const toastsBefore = s2.__toasts.length;
  AN.set('d', 4);
  await AN.flush();
  ok(s2.__toasts.length > toastsBefore, '写盘失败会弹出提示');
  const lastToast = s2.__toasts[s2.__toasts.length - 1] || '';
  ok(/disk full/.test(lastToast), '提示里带真实错误信息', lastToast);
  ok(/disk full/.test(AN.lastError() || ''), 'lastError() 暴露失败原因', AN.lastError());
  ok(AN.set('e', 5) === false, '写盘失败后 set 返回 false（画板大体积告警可生效）');

  AN.set('f', 6);
  await AN.flush();
  ok(AN.set('g', 7) === true, '写盘恢复后 set 重新返回 true');

  const dump = AN.exportAll();
  AN.importAll({ 'toolbox:seq': 'from-import' });
  await AN.flush();
  const newest = JSON.parse(writes[writes.length - 1]);
  ok(newest['toolbox:seq'] === 'from-import', 'importAll 写入原生存档');
  ok(newest['toolbox:theme'] === 'dark', 'importAll 不影响已有键');
  ok(Object.keys(dump).length >= 5, 'exportAll 在原生模式下可用，共 ' + Object.keys(dump).length + ' 项');

  log('');
  log('===== 结果: ' + pass + ' passed, ' + fail + ' failed =====');
  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  process.exitCode = fail ? 1 : 0;
})();
