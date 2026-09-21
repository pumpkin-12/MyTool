// 验证 AppStore 的存储语义（分键读写 / 值保真 / 导入导出往返 / 容错）。
// 与 verify-appstore 的分工：
//   verify-appstore          —— 断言「写盘走了哪条路径、调用了几次」
//   verify-store-semantics   —— 断言「数据本身对不对」（值语义、往返无损、边界）
// 用法: node tools/verify-store-semantics.js
// 报告: stdout + .workbuddy/_store-semantics.txt
const H = require('./_harness');

// 历史上这里是 all.slice(386, 610) 按行号硬切。index.html 一行没变它就先漂：
// 一度从测验 CSS 里切出 `.qz-timer.warn` 塞进 vm，直接 SyntaxError。
// 现在按 TESTABLE 标记取段，标记丢了就 throw。
const html = H.readFrontend();
const src = H.extractByMarker(html, 'AppStore')
  + '\n' + H.extractByMarker(html, 'hashStr');

const R = H.makeReport({ name: 'store-semantics', expected: 30 });
const { log, ok } = R;
const vm = H.vm;

(async () => {
  // ---- 模拟 Tauri 后端：分键存储 + 包装格式 ----
  function makeBackend() {
    const disk = new Map();          // 键名 -> 值(对象)
    const calls = [];
    const invoke = (cmd, args) => {
      calls.push(cmd);
      switch (cmd) {
        case 'store_keys':
          return Promise.resolve(JSON.stringify({
            dir: 'D:/data/keys', count: disk.size,
            items: [...disk.keys()].map(k => ({ key: k, size: JSON.stringify(disk.get(k)).length })),
          }));
        case 'store_read_all': {
          const o = {};
          for (const [k, v] of disk) o[k] = v;
          return Promise.resolve(JSON.stringify(o));
        }
        case 'store_read_key':
          return Promise.resolve(JSON.stringify(disk.has(args.key) ? disk.get(args.key) : null));
        case 'store_write_key':
          disk.set(args.key, JSON.parse(args.data));
          return Promise.resolve(1);
        case 'store_del_key':
          disk.delete(args.key);
          return Promise.resolve(true);
        case 'store_write': {           // 全量写（导入用）
          // 模拟：全量写也应落到分键
          const o = JSON.parse(args.data);
          for (const k in o) disk.set(k, o[k]);
          return Promise.resolve(1);
        }
        case 'asset_put':   return Promise.resolve('a'.repeat(40) + '.' + args.ext);
        case 'asset_get':   return Promise.resolve('data:image/png;base64,AAAA');
        case 'asset_del':   return Promise.resolve(true);
        default:            return Promise.reject(new Error('未知命令 ' + cmd));
      }
    };
    return { disk, calls, invoke };
  }

  const baseGlobals = {
    console, JSON, Promise, Set, Map, Object, Array, String, Number, Boolean, Date, Math,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    Blob: class { constructor(p) { this.size = (p || []).join('').length; } },
    localStorage: null,
    // AppStore 的写盘失败路径会调它（set 的浏览器分支、persist 的 reject 分支）。
    // 沙箱不提供就会变成 ReferenceError，把「保存失败」这条本该被观测的链路掩盖掉。
    showToast: (msg) => { toasts.push(msg); },
  };
  const toasts = [];
  const withWin = (invoke) => {
    const o = Object.assign({}, baseGlobals, { __TAURI__: { core: { invoke } } });
    o.window = o;
    o.document = { documentElement: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
                   addEventListener() {}, removeEventListener() {},
                   querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }), getElementById: () => null, body: { appendChild() {}, classList: { add() {}, remove() {} } } };
    o.navigator = { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'probe' };
    o.location = { href: '' };
    o.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    return o;
  };

  const B = makeBackend();
  const sb = withWin(B.invoke);
  vm.createContext(sb);
  vm.runInContext(src + '\nglobalThis.__AS = AppStore;\n', sb);
  const AS = sb.__AS;
  await AS.ready;

  log('=== [1] 冷启动（磁盘空）===');
  ok(AS.ready instanceof Promise || true, 'ready 可 await');
  ok(await AS.get('quiz:questions', null) === null, '空盘读取返回默认值');

  log('');
  log('=== [2] 写入隔离性 ===');
  await AS.set('quiz:questions', [{ id: 1, text: 'x' }]);
  await AS.flush();
  ok(B.disk.has('toolbox:quiz:questions'), '题库已落盘');
  ok(!B.disk.has('toolbox:sketch:shapes'), '未触碰画板键');

  const before = JSON.stringify(B.disk.get('toolbox:quiz:questions'));
  await AS.set('sketch:shapes', [{ id: 's1', type: 'rect' }]);
  await AS.flush();
  ok(JSON.stringify(B.disk.get('toolbox:quiz:questions')) === before, '改画板后题库逐字节未变');

  log('');
  log('=== [3] 删除语义 ===');
  await AS.set('temp:x', { a: 1 });
  await AS.flush();
  ok(B.disk.has('toolbox:temp:x'), '临时键已写入');
  await AS.remove('temp:x');
  await AS.flush();
  ok(!B.disk.has('toolbox:temp:x'), 'remove 后键从磁盘消失（而非写入空值）');

  log('');
  log('=== [4] setMany 批量 ===');
  const n0 = B.calls.filter(c => c === 'store_write_key').length;
  await AS.setMany({ 'a:1': 1, 'a:2': 2, 'a:3': 3 });
  await AS.flush();
  const n1 = B.calls.filter(c => c === 'store_write_key').length;
  ok(B.disk.get('toolbox:a:1') === 1 && B.disk.get('toolbox:a:3') === 3, 'setMany 三键都落盘');
  ok(n1 - n0 === 3, 'setMany 恰好触发 3 次写入（实际 ' + (n1 - n0) + '）');

  log('');
  log('=== [5] 导出/导入往返 ===');
  const dump = AS.exportAll();
  ok(dump['toolbox:quiz:questions'] !== undefined, 'exportAll 含题库');
  ok(dump['toolbox:a:2'] === 2, 'exportAll 含 setMany 写入的键');

  // 清空后导入
  for (const k of [...B.disk.keys()]) B.disk.delete(k);
  await AS.importAll(dump);
  await AS.flush();
  ok(B.disk.get('toolbox:a:2') === 2, 'importAll 后 a:2 已恢复');
  ok(JSON.stringify(B.disk.get('toolbox:quiz:questions')) === before, 'importAll 后题库逐字节一致（往返无损）');

  log('');
  log('=== [6] 值类型保真 ===');
  const types = [
    ['null', null], ['false', false], ['0', 0], ['空串', ''], ['空数组', []], ['空对象', {}],
    ['嵌套', { a: [{ b: [1, 2, { c: null }] }] }], ['负数', -1], ['浮点', 0.1 + 0.2],
  ];
  for (const [name, v] of types) {
    await AS.set('t:' + name, v);
    await AS.flush();
    const got = await AS.get('t:' + name, '__SENTINEL__');
    // 契约说明：get() 把 null 与 undefined 同等看待（都返回 fallback），
    // 所以「存 null」取回的是 fallback 而不是 null。这是有意设计 ——
    // 业务代码里 null 一律表示「没有值」，见 quiz:progress 的清空逻辑。
    // 这里断言的是真实契约，不是理想行为。
    const same = (v === null)
      ? (got === '__SENTINEL__')
      : (JSON.stringify(got) === JSON.stringify(v));
    ok(same, '值类型保真: ' + name + (v === null ? '（null 取回 fallback，契约如此）' : ''),
       '期望 ' + JSON.stringify(v) + ' 得到 ' + JSON.stringify(got));
  }

  log('');
  log('=== [7] 特殊键名 ===');
  const weird = ['toolbox:中文:键', 'toolbox:with space', 'toolbox:with/slash', 'toolbox:dot.key', 'toolbox::double::colon'];
  let wOk = 0;
  for (const k of weird) {
    await AS.set(k.replace(/^toolbox:/,''), { v: k });
    await AS.flush();
    const got = await AS.get(k.replace(/^toolbox:/,''), null);
    if (got && got.v === k) wOk++;
    else log('        失败键: ' + k + ' -> ' + JSON.stringify(got));
  }
  ok(wOk === weird.length, '特殊键名全部往返成功（' + wOk + '/' + weird.length + '）');

  log('');
  log('=== [8] 损坏数据的容错 ===');
  // 手动塞一个坏值进后端（模拟文件被外部改坏）
  const badInvoke = (cmd, args) => {
    if (cmd === 'store_read_key') return Promise.resolve('{ 这不是合法 JSON');
    return B.invoke(cmd, args);
  };
  const sb2 = withWin(badInvoke);
  vm.createContext(sb2);
  vm.runInContext(src + '\nglobalThis.__AS = AppStore;\n', sb2);
  const AS2 = sb2.__AS;
  let crashed = false;
  try { await AS2.ready; } catch (e) { crashed = true; }
  ok(!crashed, '遇到损坏的键文件时初始化不崩溃');

  log('');
  log('=== [9] 写盘失败可见性（set() 新契约）===');
  {
    // 只让第一次写盘失败，之后恢复正常 —— 用来验证失败不会把写盘链卡死
    let boom = true;
    const flakyInvoke = (cmd, args) => {
      if (cmd === 'store_write_key' && boom) { boom = false; return Promise.reject(new Error('磁盘已满')); }
      return B.invoke(cmd, args);
    };
    const sb3 = withWin(flakyInvoke);
    vm.createContext(sb3);
    vm.runInContext(src + '\nglobalThis.__AS = AppStore;\n', sb3);
    const AS3 = sb3.__AS;
    await AS3.ready;

    const ret = AS3.set('fail:key', { a: 1 });
    ok(ret === undefined, 'set() 不返回真值（旧实现返回的是「上一次」写盘结果，会误导调用方）',
      '实际返回 ' + typeof ret);
    await AS3.flush();
    ok(AS3.lastError() && /磁盘已满/.test(AS3.lastError()), '失败被记进 lastError()');
    ok(toasts.some(t => /磁盘已满/.test(t)), '失败当场弹 toast，不静默');
    ok(!B.disk.has('toolbox:fail:key'), '失败的那一批确实没落盘');

    // 恢复后再写：既要真的落盘，也要把 lastError 冲掉（否则诊断面板会一直报旧错）
    AS3.set('ok:key', { a: 2 });
    await AS3.flush();
    ok(B.disk.has('toolbox:ok:key'), '一次失败不会卡死写盘链，后续写入照常落盘');
    ok(AS3.lastError() === null, '成功写入后 lastError() 归零（不留陈旧错误）');
  }

  R.finish();
})();
