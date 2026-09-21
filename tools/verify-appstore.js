// 验证前端源码（index.html + js/*.js）：
//   1. 每个外链脚本块语法正确，且页面里不再残留内联脚本
//   2. AppStore 在浏览器模式下的 get/set/remove/exportAll/importAll 行为
//   3. AppStore 在 Tauri 模式下的读写、写盘串行化、失败可见
//   4. lib.rs 里迁移函数的可达性（静态）
// 用法: node tools/verify-appstore.js
// 报告: stdout + .workbuddy/_appstore.txt
const H = require('./_harness');

const html = H.readFrontend();
const vm = H.vm;
const R = H.makeReport({ name: 'appstore', expected: 59 });
const { log, ok } = R;

/* ---------------- 1. 语法检查：逐个解析外链脚本 ---------------- */
/* 分文件之前这里解析的是 index.html 的内联块。现在前端全部走 <script src>，
 * 内联块数量归零，于是两条一起断言：内联必须为 0（否则 Tauri 的 sha256 注入
 * 又要牵扯进来），而外链清单必须完整可解析。
 * 逐文件不各记一条，而是汇总成一条 —— 断言总数不能随「新增一个板块文件」漂。 */
log('[1] 前端脚本语法检查');
/* 只对页面本身扫内联块，不能拿拼好的前端源码扫：
 * js 文件的注释和字符串里出现过字面量 `<script>`（mermaid 注入那段），会被朴素正则配对上。 */
const page = H.readRel('web/index.html');
const inlineRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let inlineBlocks = 0;
while (inlineRe.exec(page) !== null) inlineBlocks++;
ok(inlineBlocks === 0, 'index.html 里没有内联 <script>（前端全部外链，CSP 无需哈希托管）',
   inlineBlocks + ' 块');

const files = H.frontendScripts();
ok(files.length >= 11, '页面挂了 11 个以上前端脚本（js/*.js 一份都没漏）', files.length);
const syntaxFails = [];
for (const f of files) {
  try { new vm.Script(f.src, { filename: f.rel }); }
  catch (e) { syntaxFails.push(f.rel + ' -> ' + e.message); }
}
ok(syntaxFails.length === 0,
   files.length + ' 个前端脚本全部语法可解析', syntaxFails.join(' | '));

/* ---------------- 抽出 AppStore 源码 ---------------- */
/* 按 TESTABLE 标记取段：标记丢了直接 throw，不再退回"记一条 FAIL 继续跑"。
 * 老实现用 indexOf('const AppStore = (function () {') + 第一个 '\n})();'，
 * 一旦有人在 IIFE 之前插入同名片段就会悄悄截错范围。 */
const storeSrc = H.extractByMarker(html, 'AppStore');
ok(/^const AppStore = \(function \(\)/m.test(storeSrc), '抽到 AppStore 段（TESTABLE 标记）');
try { new vm.Script(storeSrc); ok(true, 'AppStore 段可独立解析'); }
catch (e) { ok(false, 'AppStore 段可独立解析', e.message); }
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

/* ---------------- 3. Tauri 模式（分键存储） ---------------- */
log('[3] Tauri 模式（分键存储 store_write_key / store_read_all）');

/* 模拟 Rust 侧的分键目录：键名 -> 值 */
const disk = new Map();
const writeLog = [];      // 每次 invoke 的记录，用于验证「只写变更的键」
let failNextWrite = false;

const invoke = (cmd, args) => {
  if (cmd === 'store_read_all') {
    return Promise.resolve(JSON.stringify(Object.fromEntries(disk)));
  }
  if (cmd === 'store_keys') {
    return Promise.resolve(JSON.stringify({ count: disk.size, total: 0, items: [] }));
  }
  if (cmd === 'store_write_key') {
    writeLog.push({ cmd, key: args.key });
    if (failNextWrite) { failNextWrite = false; return Promise.reject(new Error('disk full')); }
    disk.set(args.key, JSON.parse(args.data));
    return Promise.resolve(args.data.length);
  }
  if (cmd === 'store_del_key') {
    writeLog.push({ cmd, key: args.key });
    disk.delete(args.key);
    return Promise.resolve(true);
  }
  if (cmd === 'store_read') {
    return Promise.resolve('{}');
  }
  if (cmd === 'store_write') {
    writeLog.push({ cmd, key: '(full)' });
    return Promise.resolve(0);
  }
  return Promise.reject(new Error('unknown command ' + cmd));
};

// 预置磁盘上已有的数据，模拟「上次运行留下的存档」
disk.set('toolbox:theme', 'dark');
disk.set('toolbox:quiz:questions', [{ id: 1, text: '旧题' }]);

const s2 = makeSandbox({ __TAURI__: { core: { invoke } } });
vm.createContext(s2);
vm.runInContext(storeSrc + '\nglobalThis.__AS = AppStore;', s2);
const AN = s2.__AS;

ok(AN.isNative === true, 'isNative 在 Tauri 下为 true');

(async () => {
  await AN.ready;
  ok(AN.get('theme', null) === 'dark', 'ready 后能读到磁盘上的 theme');
  ok(AN.get('quiz:questions', null) !== null, 'ready 会合并读回全部分键');

  /* ---- 关键：改一个键只写这一个键 ---- */
  writeLog.length = 0;
  AN.set('a', 1);
  await AN.flush();
  ok(writeLog.length === 1, 'set 一个键只触发一次写盘', 'writes=' + writeLog.length);
  ok(writeLog[0].cmd === 'store_write_key' && writeLog[0].key === 'toolbox:a',
     '走的是 store_write_key，且只写变更的那个键', JSON.stringify(writeLog[0]));
  ok(disk.get('toolbox:theme') === 'dark', '未改动的键在磁盘上原样保留');

  /* ---- 画板改动不再重写题库（本次优化的核心目的） ---- */
  writeLog.length = 0;
  const quizBefore = JSON.stringify(disk.get('toolbox:quiz:questions'));
  AN.set('sketch:shapes', [{ id: 's1', type: 'rect' }]);
  await AN.flush();
  const quizWrites = writeLog.filter(w => w.key === 'toolbox:quiz:questions').length;
  ok(quizWrites === 0, '改画板不会重写题库（题库文件零写入）', 'quiz writes=' + quizWrites);
  ok(writeLog.length === 1 && writeLog[0].key === 'toolbox:sketch:shapes',
     '只写了画板键', JSON.stringify(writeLog.map(w => w.key)));
  ok(JSON.stringify(disk.get('toolbox:quiz:questions')) === quizBefore,
     '题库在磁盘上逐字节未变');

  /* ---- 连续写同一键会合并（dirty 集合去重） ---- */
  writeLog.length = 0;
  AN.set('burst', 1);
  AN.set('burst', 2);
  AN.set('burst', 3);
  await AN.flush();
  ok(writeLog.filter(w => w.key === 'toolbox:burst').length === 1,
     '链式排队时同一键的连续写入合并成一次', 'writes=' + writeLog.length);
  ok(disk.get('toolbox:burst') === 3, '合并后落盘的是最后一个值');

  /* ---- 尚未开始执行的那一批可以继续吸收新键 ----
   * 语义说明：queued 只合并「还没轮到执行」的写入。已经落盘的不会回溯，
   * 所以「先 set 再 await 让第一环跑起来，然后又 set」本来就是两次写 —— 这是对的。 */
  writeLog.length = 0;
  AN.set('burst2', 'a');
  AN.set('burst3', 'x');            // 同一轮同步块里再写一个不同的键
  await AN.flush();
  const b2 = writeLog.filter(w => w.key === 'toolbox:burst2').length;
  const b3 = writeLog.filter(w => w.key === 'toolbox:burst3').length;
  ok(b2 === 1 && b3 === 1, '同一批次里的多个不同键各写一次', 'b2=' + b2 + ' b3=' + b3);
  ok(disk.get('toolbox:burst2') === 'a' && disk.get('toolbox:burst3') === 'x',
     '同批次多键的值都正确落盘');

  /* ---- 已执行的批次不会被后续写入污染 ---- */
  AN.set('bursta', 1);
  await AN.flush();                  // 这一批已确认落盘
  writeLog.length = 0;               // 从这里开始只统计第二批
  AN.set('bursta', 2);
  await AN.flush();
  ok(disk.get('toolbox:bursta') === 2, '第二批落盘覆盖第一批的值');
  ok(writeLog.filter(w => w.key === 'toolbox:bursta').length === 1,
     '第二批只写自己那一次', 'writes=' + writeLog.length);

  /* ---- setMany 只写涉及的键 ---- */
  writeLog.length = 0;
  AN.setMany({ m1: 1, m2: { a: 1 } });
  await AN.flush();
  const mkeys = writeLog.map(w => w.key).sort().join(',');
  ok(mkeys === 'toolbox:m1,toolbox:m2', 'setMany 只写涉及的键', mkeys);

  /* ---- remove 会真的删除磁盘上的键文件 ---- */
  writeLog.length = 0;
  AN.remove('theme');
  await AN.flush();
  ok(!disk.has('toolbox:theme'), 'remove 删掉了磁盘上的键');
  ok(writeLog.some(w => w.cmd === 'store_del_key' && w.key === 'toolbox:theme'),
     'remove 走 store_del_key 而非写入空值', JSON.stringify(writeLog));

  /* ---- 失败可见性 ---- */
  failNextWrite = true;
  const toastsBefore = s2.__toasts.length;
  AN.set('d', 4);
  await AN.flush();
  ok(s2.__toasts.length > toastsBefore, '写盘失败会弹出提示');
  const lastToast = s2.__toasts[s2.__toasts.length - 1] || '';
  ok(/disk full/.test(lastToast), '提示里带真实错误信息', lastToast);
  ok(/disk full/.test(AN.lastError() || ''), 'lastError() 暴露失败原因', AN.lastError());
  /* set() 的返回值契约（2026-09-20 改）：不再返回布尔。
   * 旧实现返回的是 writeOk —— 上一次写盘的结果，异步落盘下必然滞后一拍，
   * 调用方 `if (!AppStore.set(...))` 拿到的是过期判断。画板告警已改成
   * set 之后 await flush() 再读 lastError()，这里跟着改断言。 */
  ok(AN.set('e', 5) === undefined, 'set() 不返回值（旧实现返回「上一次」的写盘结果）');
  await AN.flush();
  ok(AN.lastError() === null, '下一次写盘成功后 lastError() 归零');
  ok(disk.get('toolbox:e') === 5, '一次失败不吞掉后续键，e 照常落盘');

  /* ---- 导入全部数据：走全量，不逐个 set ---- */
  const dump = AN.exportAll();
  ok(dump['toolbox:quiz:questions'] !== undefined, 'exportAll 含磁盘上的题库');

  AN.importAll({ 'toolbox:seq': 'from-import' });
  await AN.flush();
  ok(disk.get('toolbox:seq') === 'from-import', 'importAll 写入原生存档');
  ok(disk.get('toolbox:quiz:questions') !== undefined, 'importAll 不影响已有键');
  ok(Object.keys(dump).length >= 5, 'exportAll 在原生模式下可用，共 ' + Object.keys(dump).length + ' 项');

  /* ---- 图片资产接口 ---- */
  const assetCalls = [];
  const s3 = makeSandbox({
    __TAURI__: {
      core: {
        invoke: (cmd, args) => {
          if (cmd === 'store_read_all') return Promise.resolve('{}');
          if (cmd === 'asset_put') { assetCalls.push(['put', args.ext]); return Promise.resolve('abc123.png'); }
          if (cmd === 'asset_get') { assetCalls.push(['get', args.name]); return Promise.resolve('data:image/png;base64,AAA'); }
          if (cmd === 'asset_del') { assetCalls.push(['del', args.name]); return Promise.resolve(true); }
          return Promise.resolve(null);
        }
      }
    }
  });
  vm.createContext(s3);
  vm.runInContext(storeSrc + '\nglobalThis.__AS = AppStore;', s3);
  const A3 = s3.__AS;
  await A3.ready;

  const putName = await A3.assetPut('data:image/png;base64,QUJD');
  ok(putName === 'abc123.png', 'assetPut 返回资产名', putName);
  ok(assetCalls[0][0] === 'put' && assetCalls[0][1] === 'png',
     'assetPut 正确拆出扩展名（base64 部分不进 ext）', JSON.stringify(assetCalls[0]));

  const gotUrl = await A3.assetGet('abc123.png');
  ok(gotUrl === 'data:image/png;base64,AAA', 'assetGet 取回 data URL', String(gotUrl).slice(0, 30));

  ok(await A3.assetGet('') === null, 'assetGet 空名字返回 null，不炸');
  ok(await A3.assetDel('abc123.png') === true, 'assetDel 返回删除结果');

  // 非 data URL 应被拒绝（防止把普通字符串当图片存）
  let rejected = false;
  try { await A3.assetPut('not-a-data-url'); } catch (e) { rejected = true; }
  ok(rejected, 'assetPut 拒绝非法 data URL');

  // 读取失败时返回 null 而非抛错 —— 渲染路径要能容忍缺图
  const s4 = makeSandbox({ __TAURI__: { core: { invoke: () => Promise.reject(new Error('io')) } } });
  vm.createContext(s4);
  vm.runInContext(storeSrc + '\nglobalThis.__AS = AppStore;', s4);
  const A4 = s4.__AS;
  await A4.ready;
  ok(await A4.assetGet('missing.png') === null, 'assetGet 读不到时返回 null（缺图不阻断渲染）');

  // ===== 迁移可达性（静态检查 Rust 侧） =====
  // 背景：migrate_to_keys() 最初只挂在 store_read 上，但前端启动走的是
  // store_keys + store_read_all，**从不调 store_read** → 迁移永远不会执行，
  // 表现为 data/keys/ 是空目录、老 store.json 里的数据搬不过去。
  // 这类「函数写了但挂在不可达路径上」的 bug 静态断言能抓住。
  log('');
  log('--- [迁移可达性] ---');
  let libSrc = null;
  let libErr = '';
  try { libSrc = H.readLibRs(); } catch (e) { libErr = String(e); }
  if (!libSrc) {
    ok(false, '能读到 src-tauri/src/lib.rs（迁移可达性检查的前提）', libErr);
  } else {
    ok(/fn\s+migrate_to_keys/.test(libSrc), 'lib.rs 里有 migrate_to_keys 定义');

    // 取每个命令函数体，看迁移调用落在哪个函数里
    const fnBody = (name) => {
      const i = libSrc.indexOf('fn ' + name + '(');
      if (i < 0) return '';
      // 从函数起点往后扫，按花括号配平截出函数体
      let d = 0, started = false;
      for (let j = i; j < libSrc.length; j++) {
        if (libSrc[j] === '{') { d++; started = true; }
        else if (libSrc[j] === '}') { d--; if (started && d === 0) return libSrc.slice(i, j + 1); }
      }
      return libSrc.slice(i);
    };

    const inReadAll = /migrate_to_keys\s*\(/.test(fnBody('store_read_all'));
    const inKeys = /migrate_to_keys\s*\(/.test(fnBody('store_keys'));
    ok(inReadAll || inKeys,
      '迁移挂在启动路径上（store_keys 或 store_read_all 至少一个调用它）');

    // 前端启动确实调了这两个之一 —— 与上面的断言配对，防止「迁移改了但这俩也没人调」
    ok(/invoke\(\s*['"]store_read_all['"]/.test(html) || /invoke\(\s*['"]store_keys['"]/.test(html),
      '前端启动确实 invoke 了 store_keys / store_read_all');
  }

  R.finish();
})();
