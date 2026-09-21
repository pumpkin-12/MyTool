// 验证前端源码里的 DefectCore（缺陷统计的领域逻辑），读法见 _harness 的 readFrontend。
// DefectCore 段按约定自包含（不碰 AppStore / document / esc），所以能整段抽进 vm 跑。
// 用法: node tools/verify-defect.js
// 报告: stdout + .workbuddy/_defect.txt
const H = require('./_harness');

const html = H.readFrontend();
const R = H.makeReport({ name: 'defect', expected: 210 });
const { log, ok } = R;
const vm = H.vm;

/* ---------------- [0] 抽取 ---------------- */
log('[0] 抽取 DefectCore');
const src = H.extractByMarker(html, 'DefectCore');
ok(/^const DefectCore = \(function \(\)/m.test(src), '抽到 DefectCore 段（TESTABLE 标记）');
log('  DefectCore 源码长度 = ' + src.length);

/* 自包含：注释里提到 AppStore 是说明文字，先剥注释再查真引用 */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ok(!/\bAppStore\b/.test(codeOnly), '不引用 AppStore（否则抽进 vm 会 ReferenceError）');
ok(!/\bdocument\b/.test(codeOnly) && !/\bwindow\b/.test(codeOnly), '不引用 document/window');
ok(!/\besc\s*\(/.test(codeOnly), '不引用页面的 esc()');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nglobalThis.__DC = DefectCore;', sandbox);
const DC = sandbox.__DC;
ok(!!DC && typeof DC.groupCount === 'function' && typeof DC.trend === 'function', 'DefectCore 取出成功');

const mk = o => Object.assign({
  id: 0, no: '', title: '', module: '', severity: 'normal', status: 'new',
  foundAt: '', fixedAt: '', desc: '', note: ''
}, o);

/* ---------------- [1] 常量与判定 ---------------- */
log('[1] 常量与判定');
ok(DC.SEVERITIES.map(s => s.key).join(',') === 'fatal,major,normal,minor', '严重程度四档且顺序固定');
ok(DC.SEVERITIES.map(s => s.label).join(',') === '致命,严重,一般,轻微', '严重程度中文标签');
ok(DC.STATUSES.length === 6 && DC.STATUSES[0].label === '新建' && DC.STATUSES[5].label === '拒绝',
   '状态六档，首新建尾拒绝');
ok(DC.DONE.join(',') === 'closed,rejected', '结案只认关闭与拒绝');
ok(DC.sevLabel('fatal') === '致命' && DC.sevLabel('normal') === '一般', 'sevLabel 映射');
ok(DC.statusLabel('verified') === '已验证' && DC.statusLabel('submitted') === '已提交', 'statusLabel 映射');
ok(DC.sevLabel('weird') === 'weird', '认不出的程度原样回显，不吞成空串', DC.sevLabel('weird'));
ok(DC.sevLabel('') === '', '空程度回显空串');
ok(DC.isKnownSev('minor') && !DC.isKnownSev('weird') && !DC.isKnownSev(''), 'isKnownSev');
ok(DC.isKnownStatus('submitted') && !DC.isKnownStatus('done'), 'isKnownStatus');
ok(DC.isOpen({ status: 'new' }) === true && DC.isOpen({ status: 'fixed' }) === true, '新建/已修复都算未关闭');
ok(DC.isOpen({ status: 'closed' }) === false && DC.isOpen({ status: 'rejected' }) === false,
   '关闭与拒绝算结案');
ok(DC.isOpen({ status: 'weird' }) === true, '认不出的状态算未关闭（宁可多算积压）');
ok(DC.isOpen(null) === false, '空值不算未关闭');

/* ---------------- [2] 日期 ---------------- */
log('[2] 日期：本地零点与合法性');
ok(DC.dayKey(new Date(2026, 8, 5)) === '2026-09-05', 'dayKey 补零成两位数', DC.dayKey(new Date(2026, 8, 5)));
ok(DC.parseDay('2026-09-20').getFullYear() === 2026 && DC.parseDay('2026-09-20').getDate() === 20,
   'parseDay 返回本地 Date');
ok(DC.parseDay('2026-01-01').getMonth() === 0, '一月不会被当成 0 月（不上 UTC 船）');
ok(DC.parseDay('2026-02-31') === null, '2月31日非法（Date 会顺延成 3-03，必须回头核对）');
ok(DC.parseDay('2026-13-01') === null, '13 月非法');
ok(DC.parseDay('2026-9-1') === null && DC.parseDay('20260901') === null, '格式必须 YYYY-MM-DD');
ok(DC.parseDay(null) === null && DC.parseDay(20260901) === null && DC.parseDay('') === null,
   '非字符串/空串返回 null');
ok(DC.addDays('2026-01-31', 1) === '2026-02-01', '跨月进位');
ok(DC.addDays('2026-03-01', -1) === '2026-02-28', '2026 非闰年，3-1 前一天是 2-28');
ok(DC.addDays('2026-09-20', 0) === '2026-09-20', '加 0 天回自身');
ok(DC.addDays('bad', 1) === '', '非法起点返回空串（不能退化成"今天"）');
ok(DC.diffDays('2026-08-31', '2026-09-02') === 2, '跨月天数差');
ok(DC.diffDays('2026-09-02', '2026-09-02') === 0, '同一天差 0');
ok(DC.diffDays('2026-09-02', '2026-08-31') === -2, '反向为负');
ok(DC.diffDays('', '2026-09-02') === null && DC.diffDays('2026-09-02', 'bad') === null,
   '任一日期非法返回 null（与 0 的语义不同）');
ok(DC.weekStart('2026-09-20') === '2026-09-14', '周日归属本周（周一是周首）');
ok(DC.weekStart('2026-09-14') === '2026-09-14', '周一回自身');
ok(DC.weekStart('2026-09-12') === '2026-09-07', '周六归属上周一');
ok(DC.weekStart('nope') === '', '非法日期返回空串');
ok(DC.monthKey('2026-09-20') === '2026-09' && DC.monthKey('bad') === '' && DC.monthKey('') === '',
   'monthKey 取年月 / 非法为空');

/* ---------------- [3] groupCount ---------------- */
log('[3] groupCount：固定档位不丢数据');
const SEV_FX = [
  mk({ severity: 'fatal' }), mk({ severity: 'normal' }), mk({ severity: 'normal' }),
  mk({ severity: 'weird' }), mk({})
];
let g = DC.groupCount(SEV_FX, 'severity');
ok(g.length === 5, '四档 + 认不出的一个「未知」桶', g.length);
ok(g.map(x => x.count).join(',') === '1,0,3,0,1',
   '零值档位保留（某天没记录也不能少一档）；缺 severity 按默认「一般」算', g.map(x => x.count).join(','));
ok(g[4].key === 'unknown' && g[4].label === '未知', '未知桶落在末尾');
ok(g.reduce((a, x) => a + x.count, 0) === SEV_FX.length, '计数总和 == 记录数（数据不许静默少掉）');
ok(g[0].label === '致命' && g[2].label === '一般', '桶沿用固定标签');
ok(DC.groupCount([], 'severity').length === 4, '空数据只输出固定四档');
ok(DC.groupCount([], 'severity').every(x => x.count === 0), '空数据全为 0');
ok(DC.groupCount(null, 'severity').length === 4, 'items 非数组不炸');
ok(DC.groupCount([mk({ status: 'closed' }), mk({ status: 'rejected' })], 'status')
   .filter(x => x.count).map(x => x.key).join(',') === 'closed,rejected', '状态维度按固定顺序输出');
const MOD_FX = [
  mk({ module: ' 引擎 ' }), mk({ module: '引擎' }), mk({ module: '网络' }),
  mk({ module: '' }), mk({ module: '   ' }), mk({})
];
ok(DC.groupCount(MOD_FX, 'module').map(x => x.key + ':' + x.count).join(',') === '引擎:2,网络:1',
   '模块忽略空值并 trim，按数量降序', JSON.stringify(DC.groupCount(MOD_FX, 'module')));
ok(DC.groupCount([mk({ module: 'B' }), mk({ module: 'A' })], 'module')
   .map(x => x.key).join(',') === 'A,B', '数量相同时按名称升序');
ok(DC.groupCount([], 'module').length === 0, '模块维度无数据时是空数组（不硬造档位）');

/* ---------------- [4] filterItems ---------------- */
log('[4] filterItems：筛选');
const FIL_FX = [
  mk({ id: 1, module: '引擎', severity: 'fatal', status: 'new', foundAt: '2026-09-10' }),
  mk({ id: 2, module: '引擎', severity: 'minor', status: 'closed', foundAt: '2026-09-20' }),
  mk({ id: 3, module: '网络', severity: 'fatal', status: 'new', foundAt: '' }),
  mk({ id: 4, module: '', severity: 'normal', status: 'fixed', foundAt: '2026-09-15' })
];
const idsOf = a => a.map(x => x.id).join(',');
ok(idsOf(DC.filterItems(FIL_FX, {})) === '1,2,3,4', '空条件全通过');
ok(idsOf(DC.filterItems(FIL_FX, null)) === '1,2,3,4', 'prefs 为空对象/ null 都不炸');
ok(idsOf(DC.filterItems(FIL_FX, { module: '引擎' })) === '1,2', '按模块筛');
ok(idsOf(DC.filterItems(FIL_FX, { severity: 'fatal' })) === '1,3', '按程度筛');
ok(idsOf(DC.filterItems(FIL_FX, { status: 'new' })) === '1,3', '按状态筛');
ok(idsOf(DC.filterItems(FIL_FX, { from: '2026-09-15' })) === '2,4', '起始日期（含当天）');
ok(idsOf(DC.filterItems(FIL_FX, { to: '2026-09-15' })) === '1,4', '截止日期（含当天）');
ok(idsOf(DC.filterItems(FIL_FX, { from: '2026-09-01', to: '2026-09-30' })) === '1,2,4', '日期区间');
ok(idsOf(DC.filterItems(FIL_FX, { from: '2026-09-21' })) === '', '区间外全部排除');
ok(idsOf(DC.filterItems(FIL_FX, { module: '引擎', status: 'new' })) === '1', '多条件取交集');
ok(idsOf(DC.filterItems(FIL_FX, { from: '2026-01-01' })) === '1,2,4',
   '设了日期范围时，没填发现日期的记录被排除（放进来会让"本周新增"对不上）');

/* ---------------- [5] sortItems ---------------- */
log('[5] sortItems：排序');
const SORT_FX = [
  mk({ id: 1, foundAt: '2026-09-01', no: '20260901-01' }),
  mk({ id: 2, foundAt: '2026-09-02', no: '20260902-01' }),
  mk({ id: 3, foundAt: '2026-09-02', no: '20260902-02' }),
  mk({ id: 4, foundAt: '', no: '20260903-01' }),
  mk({ id: 5, foundAt: '', no: '20260903-02' })
];
ok(idsOf(DC.sortItems(SORT_FX)) === '3,2,1,5,4', '日期倒序 → 同日编号倒序 → 无日期垫底',
   idsOf(DC.sortItems(SORT_FX)));
ok(idsOf(SORT_FX) === '1,2,3,4,5', '不改传入数组（原数组顺序没被动过）');
ok(DC.sortItems([]).length === 0 && DC.sortItems(null).length === 0, '空/非法输入返回空数组');

/* ---------------- [6] avgFixDays ---------------- */
log('[6] avgFixDays：只算算得出来的');
const FIX_FX = [
  mk({ foundAt: '2026-09-01', fixedAt: '2026-09-03' }),
  mk({ foundAt: '2026-09-10', fixedAt: '' }),
  mk({ foundAt: '', fixedAt: '2026-09-11' }),
  mk({ foundAt: '2026-09-05', fixedAt: '2026-09-04' }),
  mk({ foundAt: '2026-09-01', fixedAt: '2026-09-02' })
];
let avg = DC.avgFixDays(FIX_FX);
ok(avg.count === 2, '只统计两个日期都合法且修复不早于发现的记录', avg.count);
ok(avg.days === 1.5, '平均天数保留一位小数（(2+1)/2）', avg.days);
ok(DC.avgFixDays([]).count === 0 && DC.avgFixDays([]).days === null,
   '无样本时 days = null（界面显示「—」，不是 0）');
const sameDay = DC.avgFixDays([mk({ foundAt: '2026-09-01', fixedAt: '2026-09-01' })]);
ok(sameDay.count === 1 && sameDay.days === 0, '当天修完算 0 天且计入样本（0 与 null 不同）');
ok(DC.avgFixDays([
  mk({ foundAt: '2026-09-01', fixedAt: '2026-09-02' }),
  mk({ foundAt: '2026-09-03', fixedAt: '2026-09-04' }),
  mk({ foundAt: '2026-09-05', fixedAt: '2026-09-07' })
]).days === 1.3, '4/3 天 → 1.3（一位小数四舍五入）');

/* ---------------- [7] summary ---------------- */
log('[7] summary：汇总卡片');
const SUM_FX = [
  mk({ id: 1, status: 'new', foundAt: '2026-09-20', fixedAt: '' }),
  mk({ id: 2, status: 'fixed', foundAt: '2026-09-15', fixedAt: '2026-09-17' }),
  mk({ id: 3, status: 'closed', foundAt: '2026-09-10', fixedAt: '2026-09-14' }),
  mk({ id: 4, status: 'rejected', foundAt: '2026-09-01', fixedAt: '' }),
  mk({ id: 5, status: 'verified', foundAt: '2026-09-19', fixedAt: '2026-09-20' }),
  mk({ id: 6, status: 'closed', foundAt: '2026-09-21', fixedAt: '' })
];
const s = DC.summary(SUM_FX, '2026-09-20');
ok(s.total === 6, '总数', s.total);
ok(s.open === 3, '未关闭 = 总数 - 关闭 - 拒绝（已修复/已验证仍算未关闭）', s.open);
ok(s.weekNew === 3, '本周新增：周一起算，且发现日期晚于今天的不算', s.weekNew);
ok(s.fixedCount === 3, '已修复数 = 能算出修复天数的记录数', s.fixedCount);
ok(s.avgFixDays === 2.3, '平均修复 7/3 → 2.3', s.avgFixDays);
ok(s.rejectRate === 16.7, '被拒率 1/6 → 16.7%', s.rejectRate);
const s0 = DC.summary([], '2026-09-20');
ok(s0.total === 0 && s0.open === 0 && s0.weekNew === 0 && s0.rejectRate === 0 && s0.avgFixDays === null,
   '空数据全零且平均为 null', JSON.stringify(s0));
ok(DC.summary([mk({ id: 9, foundAt: '2026-09-21', status: 'new' })], '2026-09-21').weekNew === 1,
   '当天发现的算本周');
ok(DC.summary(null, '2026-09-20').total === 0, 'items 非数组不炸');

/* ---------------- [8] trend ---------------- */
log('[8] trend：固定长度分桶');
const TR_FX = [
  mk({ id: 1, foundAt: '2026-09-02', fixedAt: '', status: 'new' }),
  mk({ id: 2, foundAt: '2026-09-16', fixedAt: '2026-09-19', status: 'fixed' }),
  mk({ id: 3, foundAt: '2026-08-01', fixedAt: '2026-09-18', status: 'closed' })
];
let t = DC.trend(TR_FX, { by: 'week', buckets: 3, end: '2026-09-20' });
ok(t.length === 3, '按周返回指定桶数', t.length);
ok(t.map(x => x.key).join(',') === '2026-08-31,2026-09-07,2026-09-14', '桶键升序，末尾是最新一周',
   t.map(x => x.key).join(','));
ok(t.map(x => x.opened).join(',') === '1,0,1', 'opened 按 foundAt 归周（区间外的丢弃）', t.map(x => x.opened).join(','));
ok(t.map(x => x.closed).join(',') === '0,0,2', 'closed 按 fixedAt 归周', t.map(x => x.closed).join(','));
ok(t[2].label === '9/14' && t[0].label === '8/31', '周标签 M/D', t[0].label + ' / ' + t[2].label);
ok(DC.trend([], { by: 'week', buckets: 5, end: '2026-09-20' }).length === 5,
   '没有数据也补齐 5 个空桶（柱子不能少一根）');
ok(DC.trend([], { by: 'week', buckets: 5, end: '2026-09-20' }).every(x => x.opened === 0 && x.closed === 0),
   '空桶计数为 0');
ok(DC.trend([], { end: '2026-09-20' }).length === 8, 'by 缺省按周，默认 8 桶');
ok(DC.trend(TR_FX, { by: 'week', buckets: -3, end: '2026-09-20' }).length === 1,
   'buckets 为负时夹紧到 1 桶（不返回空数组）');
const MT = [
  mk({ id: 1, foundAt: '2025-12-20', fixedAt: '2026-01-05', status: 'closed' }),
  mk({ id: 2, foundAt: '2026-03-02', fixedAt: '', status: 'new' })
];
const mt = DC.trend(MT, { by: 'month', buckets: 4, end: '2026-03-15' });
ok(mt.map(x => x.key).join(',') === '2025-12,2026-01,2026-02,2026-03', '按月跨年回退正确（1 月倒推是去年 12 月）',
   mt.map(x => x.key).join(','));
ok(mt.map(x => x.opened).join(',') === '1,0,0,1', '按月 opened 归月');
ok(mt.map(x => x.closed).join(',') === '0,1,0,0', '按月 closed 归月（跨年那条落在 2026-01）');
ok(mt.map(x => x.label).join(',') === '12月,1月,2月,3月', '月标签 N月', mt.map(x => x.label).join(','));

/* ---------------- [9] nextNo / newDefect / moduleNames ---------------- */
log('[9] nextNo / newDefect / moduleNames');
ok(DC.nextNo([], '2026-09-20') === '20260920-01', '当天没有记录从 01 起');
ok(DC.nextNo([mk({ no: '20260920-03' }), mk({ no: '20260920-01' })], '2026-09-20') === '20260920-04',
   '取当天已有最大序号 +1');
ok(DC.nextNo([mk({ no: '20260919-09' })], '2026-09-20') === '20260920-01', '别的日期的编号不参与');
ok(DC.nextNo([mk({ no: '20260920-ab' })], '2026-09-20') === '20260920-01', '序号非数字视为没编号');
ok(DC.nextNo([mk({ no: '' }), mk({})], '2026-09-20') === '20260920-01', '空编号不炸');
ok(DC.nextNo([], 'bad') === '' && DC.nextNo([], '') === '', '今天非法时返回空串');
const nd = DC.newDefect([mk({ no: '20260920-02' })], '2026-09-20', 'x1');
ok(nd.id === 'x1' && nd.no === '20260920-03', '新记录带调用方给的 id 与自动编号');
ok(nd.severity === 'normal' && nd.status === 'new', '默认程度一般、状态新建');
ok(nd.foundAt === '2026-09-20' && nd.fixedAt === '', '默认发现日期是今天，修复日期留空');
ok(nd.title === '' && nd.module === '' && nd.desc === '' && nd.note === '', '其余字段为空串');
ok(typeof nd.ts === 'number' && nd.ts > 0, '带时间戳');
const nd2 = DC.newDefect([], 'bad', 'x2');
ok(nd2.foundAt === '' && nd2.no === '', '今天非法时日期与编号都留空（不写坏数据）');
ok(DC.moduleNames([mk({ module: ' 网络 ' }), mk({ module: '引擎' }), mk({ module: '网络' }),
                   mk({ module: '' }), mk({}), mk({ module: '   ' })]).join(',') === '引擎,网络',
   '模块名去重、trim、忽略空值并排序');
ok(DC.moduleNames(null).length === 0, 'moduleNames 非数组不炸');

/* ---------------- [10] summaryText ---------------- */
log('[10] summaryText：可复制的文本摘要');
const txt = DC.summaryText(SUM_FX, '2026-09-20');
ok(txt.split('\n')[0] === '【缺陷统计】截止 2026-09-20', '首行带截止日期', txt.split('\n')[0]);
ok(txt.indexOf('总数 6') >= 0 && txt.indexOf('未关闭 3') >= 0 && txt.indexOf('本周新增 3') >= 0,
   '一行带总数/未关闭/本周新增');
ok(txt.indexOf('平均修复 2.3 天') >= 0 && txt.indexOf('被拒率 16.7%') >= 0, '带平均修复与被拒率');
ok(txt.indexOf('按严重程度：') >= 0, '带严重程度分布');
ok(txt.indexOf('未关闭 3 条：') >= 0, '带未关闭条目分布');
const txt0 = DC.summaryText([], '2026-09-20');
ok(txt0.split('\n').length === 2, '无数据时只有两行（不输出空的分布行）', JSON.stringify(txt0));
ok(txt0.indexOf('平均修复 —') >= 0, '无样本时平均修复显示「—」而不是 0 天', txt0);
const txtRej = DC.summaryText([
  mk({ status: 'rejected', severity: 'minor', foundAt: '2026-09-01' }),
  mk({ status: 'closed', severity: 'minor', foundAt: '2026-09-01' })
], '2026-09-20');
ok(txtRej.indexOf('未关闭 0') > 0, '全部结案时未关闭显示 0', txtRej);
ok(txtRej.indexOf('未关闭 0 条') < 0, 'all 结案时不输出「未关闭 N 条」分布行');
ok(txtRej.split('\n').length === 3, '全部结案时是 头两行 + 严重程度一行', JSON.stringify(txtRej));

/* ---------------- [11] 集成：工具已挂进工具箱 ---------------- */
log('[11] 集成：ENABLED_TOOLS 与 registerTool');
ok(/const ENABLED_TOOLS = \[[^\]]*'defect'[^\]]*\]/.test(html), 'ENABLED_TOOLS 里有 defect');
const toolStart = html.indexOf("id: 'defect'");
const themeIdx = html.indexOf('主题切换（浅色 / 深色）');
const toolSrc = (toolStart > 0 && themeIdx > toolStart) ? html.slice(toolStart, themeIdx) : '';
ok(!!toolSrc, '定位缺陷板块的 registerTool 段');
ok(toolSrc.indexOf("name: '缺陷统计'") > 0, '板块名「缺陷统计」');
ok(toolSrc.indexOf("'defect:items'") > 0 && toolSrc.indexOf("'defect:prefs'") > 0,
   '存储键是 defect:items / defect:prefs（不与其他板块撞）');
ok(/return \(\) => \{\s*clearTimeout\(saveTimer\);/.test(toolSrc), 'mount 返回清理函数（防抖定时器会被清掉）');
ok(/\besc\(/.test(toolSrc), '渲染时对用户输入做转义（缺陷标题会进 innerHTML）');
ok(!/\bprompt\s*\(/.test(toolSrc) && !/\bconfirm\s*\(/.test(toolSrc), '没有 prompt/confirm（项目约定禁用）');
ok(/data\.type === 'defect'/.test(toolSrc), '导入备份校验文件类型标记');
ok(/tab !== 'stats'\) tab = 'list'/.test(toolSrc), 'tab 值非法时回落记录页（不留空白面板）');

/* ---------------- [12] Excel 式表格排版 ---------------- */
log('[12] 记录页：Excel 式网格表');
ok(toolSrc.indexOf('<table class="df-table">') > 0, '记录页是表格而非卡片');
ok(toolSrc.indexOf('<colgroup>') > 0 && toolSrc.indexOf('<thead>') > 0, '有 colgroup 定列宽、有 thead 表头');
ok(/<tbody class="df-list">/.test(toolSrc), '表体是 .df-list（refreshList 的重绘目标）');
ok(/class="df-scroll"/.test(toolSrc), '表格包在横滚容器里（列多不撑宽整页）');
ok(/\.df-table th \{ position: sticky/.test(html), '表头吸顶（sticky）');
ok(/colspan="' \+ COLS\.length \+ '"/.test(toolSrc), '空状态 colspan 跟着列数走（加列不会错位）');
ok(/tr\[data-sev="fatal"\] td:first-child \{ box-shadow/.test(html), '行首色条标出严重程度');
ok(/clickedRow\) selectRow\(/.test(toolSrc), '点行内任何地方都选中该行（含点单元格留白）');
ok(/e\.key !== 'Enter'/.test(toolSrc) && /nextElementSibling/.test(toolSrc), 'Enter 往下走一格');
ok(/TEXTAREA/.test(toolSrc.slice(toolSrc.indexOf("e.key !== 'Enter'"), toolSrc.indexOf("e.key !== 'Enter'") + 160)),
   '多行描述里 Enter 保持换行，不被导航吞掉');
ok(/indexOf\(tool\.id\) >= 0 \? ' wide'/.test(html) && /'sketch', 'mermaid', 'defect'/.test(html),
   '缺陷页走 .wide（表格需要宽度）');
ok(html.indexOf('df-card') < 0, '旧的卡片样式与标记已清干净', String(html.indexOf('df-card')));

/* ---------------- [13] 删除可撤销 ---------------- */
log('[13] 删除可撤销：单槽放回 + Ctrl+Z');
ok(DC.insertAt([1, 2, 3], 9, 1).join(',') === '1,9,2,3', 'insertAt 插回原下标处');
ok(DC.insertAt([1, 2, 3], 9, 99).join(',') === '1,2,3,9', '下标超出末尾时夹紧到末尾（不能插出空洞）');
ok(DC.insertAt([1, 2], 9, -5).join(',') === '9,1,2', '负下标夹紧到开头');
ok(DC.insertAt([1, 2], 9, 'x').join(',') === '9,1,2', '非法下标当 0 处理，不炸');
const insOrig = [1, 2];
DC.insertAt(insOrig, 9, 0);
ok(insOrig.join(',') === '1,2', '不改传入数组（items 不能被就地改动）');
ok(DC.insertAt(null, 9, 0).length === 1, '非数组输入不炸（塞回一条也算数）');

ok(/let lastDeleted = null;/.test(toolSrc), '单槽撤销状态就一个变量，不是整段编辑历史');
ok(/lastDeleted = \{ item: d, index: items\.indexOf\(d\) \};/.test(toolSrc),
   '删除时先记住记录与它删除前的下标（splice 之后就算不出来了）');
ok(/label: '撤销'/.test(toolSrc) && /fn: undoDelete/.test(toolSrc), '删除后弹的 toast 上带「撤销」动作');
ok(/items = DefectCore\.insertAt\(items, lastDeleted\.item, lastDeleted\.index\);/.test(toolSrc),
   '撤销走 DefectCore.insertAt 放回原位（判定逻辑在被测段里）');
/* 只看 undoDelete 的函数体：声明处那句 `let lastDeleted = null;` 不能算数 */
const undoBody = (toolSrc.match(/function undoDelete\(\) \{[\s\S]*?\n    \}/) || [''])[0];
ok(/lastDeleted = null;/.test(undoBody),
   '撤销后清空槽位：同一条不能被撤销两次（Ctrl+Z 连按不该复制出行）');
ok(/document\.addEventListener\('keydown', onUndoKey\);/.test(toolSrc),
   'Ctrl+Z 挂在 document 上（点完删除按钮焦点掉回 body，挂面板内收不到）');
ok(/document\.removeEventListener\('keydown', onUndoKey\);/.test(toolSrc),
   '切走工具时摘掉 Ctrl+Z 监听（别的板块有自己的撤销）');
ok(/tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/.test(toolSrc),
   '焦点在输入框里时不抢 Ctrl+Z（那里是浏览器原生文本撤销）');
ok(/\(e\.ctrlKey \|\| e\.metaKey\)/.test(toolSrc), 'Ctrl / Cmd 都认（Mac 也得能用）');

ok(/function showToast\(msg, action\)/.test(html), 'showToast 支持动作按钮参数');
ok(/t\.textContent = msg;/.test(html), '每次 toast 先清掉上一次的按钮（否则旧按钮留在新消息上）');
ok(/#toast\.has-act \{ pointer-events: auto/.test(html), '带按钮的 toast 才放开点击（平时整条不吃点击）');
ok(/classList\.remove\('show'\), 6000\)/.test(html), '有按钮时停留 6 秒（1.6 秒来不及点「撤销」）');

/* ---------------- [14] Excel 互操作：表头契约与日期归一 ---------------- */
log('[14] Excel 互操作：HEADERS / normDay / labelToKey');
ok(DC.HEADERS.join(',') === '编号,标题,严重程度,状态,模块,发现,修复,备注,描述与复现步骤',
   '表头是粘贴/导入/导出三处共用的契约', DC.HEADERS.join(','));
ok(DC.HEADERS.indexOf('时长') < 0, '「时长」不参与互操作（它是算出来的，导回去会被当成一列数据）');
ok(DC.labelToKey(DC.SEVERITIES, '严重') === 'major' && DC.labelToKey(DC.SEVERITIES, 'fatal') === 'fatal'
   && DC.labelToKey(DC.SEVERITIES, 'FATAL') === 'fatal', '程度认中文标签也认英文键（大小写不敏感）');
ok(DC.labelToKey(DC.STATUSES, '已修复') === 'fixed' && DC.labelToKey(DC.STATUSES, 'closed') === 'closed',
   '状态同样两套写法都认');
ok(DC.labelToKey(DC.STATUSES, '已关闭') === 'closed' && DC.labelToKey(DC.STATUSES, '已拒绝') === 'rejected',
   '手打的「已关闭/已拒绝」也认（措辞不同不该把结案算成未关闭）');
ok(DC.labelToKey(DC.STATUSES, '已处理') === '' && DC.labelToKey(DC.STATUSES, '已搞定') === '',
   '去「已」只对着真标签试一次，猜不出的照样给空串');
ok(DC.labelToKey(DC.SEVERITIES, 'P0') === '' && DC.labelToKey(DC.STATUSES, '') === '',
   '认不出给空串（由调用方决定兜底值，不在这里静默猜）');

ok(DC.normDay('2026-09-05') === '2026-09-05', '标准写法原样通过');
ok(DC.normDay('2026/9/5') === '2026-09-05' && DC.normDay('2026.9.5') === '2026-09-05'
   && DC.normDay('2026年9月5日') === '2026-09-05', 'Excel 里手打的斜杠/点/中文日期都能认');
ok(DC.normDay('20260905') === '2026-09-05', '紧凑八位数字认');
ok(DC.normDay('45900') === '2025-08-31' && DC.normDay('99999') === '',
   '序列号复制成文本（"常规"格式）也认；超出合理范围的不猜', DC.normDay('45900'));
ok(DC.normDay(45292) === '2024-01-01' && DC.normDay(45900) === '2025-08-31',
   'Excel 日期序列号认（1900 闰年 bug 要按 1899-12-30 起算）',
   DC.normDay(45292) + ' / ' + DC.normDay(45900));
ok(DC.normDay(new Date(2026, 8, 5)) === '2026-09-05', 'cellDates 模式下直接给的 Date 认（本地日，不上 UTC 船）');
ok(DC.normDay('2026-02-31') === '' && DC.normDay('2026-13-01') === '' && DC.normDay('2026/9') === '',
   '非法日期给空串（绝不退化成今天）', DC.normDay('2026-02-31'));
ok(DC.normDay('') === '' && DC.normDay(null) === '' && DC.normDay(undefined) === ''
   && DC.normDay('待定') === '' && DC.normDay(12) === '', '空值/文字/离谱数字都给空串');

/* ---------------- [15] TSV 解析 ---------------- */
log('[15] parseTSV：Excel 复制的那一块');
ok(DC.parseTSV('a\tb\nc\td').map(r => r.join('|')).join(' / ') === 'a|b / c|d', '按行按列切');
ok(DC.parseTSV('a\tb\r\nc\td\r\n').length === 2, 'CRLF 与末尾空行都不算数据');
ok(DC.parseTSV('a\tb\n\n\n').length === 1, '末尾连续空行全去掉');
ok(DC.parseTSV('').length === 0 && DC.parseTSV(null).length === 0, '空文本给空数组');
ok(DC.parseTSV('"多行\n描述"\t严重').length === 1 && DC.parseTSV('"多行\n描述"\t严重')[0][0] === '多行\n描述',
   '引号里的换行算同一个字段（不能把多行描述切成两行）');
ok(DC.parseTSV('"他说""这里有问题"""\tb')[0][0] === '他说"这里有问题"', '双写引号还原成一个引号');
ok(DC.parseTSV('a\t"b\tc"\td')[0].join('|') === 'a|b\tc|d', '引号里的制表符不切列');
ok(DC.parseTSV('尺寸 3" 的管子\tx')[0].length === 2, '字段中间冒出的引号不算引用开始（只在字段开头才认）');
ok(DC.parseTSV('a\tb\nc').length === 2 && DC.parseTSV('a\tb\nc')[1].join('|') === 'c', '末行没有换行也要收进来');

/* ---------------- [16] parseTable：二维表入库 ---------------- */
log('[16] parseTable：按表头认列 / 兜底与计数');
const T1 = DC.parseTable(DC.parseTSV(
  '编号\t标题\t严重程度\t状态\t模块\t发现\t修复\t备注\t描述与复现步骤\n' +
  '20260920-01\t登录超时\t严重\t已提交\t账号\t2026/9/18\t\t偶发\t先点登录再刷新\n' +
  '20260920-02\t导出空白\t致命\t新建\t导出\t2026-09-19\t2026-09-19\t\t'), '2026-09-20');
ok(T1.items.length === 2 && T1.skipped === 0 && T1.errors.length === 0,
   '两行干净数据：全收，零跳过零报错', JSON.stringify(T1.errors));
ok(T1.items[0].severity === 'major' && T1.items[1].severity === 'fatal', '程度标签转成键');
ok(T1.items[0].status === 'submitted' && T1.items[1].status === 'new', '状态标签转成键');
ok(T1.items[0].foundAt === '2026-09-18' && T1.items[0].fixedAt === '',
   '日期归一，空修复日期保持空（不是今天）');
ok(T1.items[1].fixedAt === '2026-09-19', '修复日期同样归一');
ok(T1.items[0].title === '登录超时' && T1.items[0].module === '账号' && T1.items[0].note === '偶发',
   '标题/模块/备注都落到对位字段');
ok(T1.items[0].id === '' && T1.items[0].ts === 0, 'id 与 ts 留给调用方补（Core 不造 id）');

const T2 = DC.parseTable(DC.parseTSV(
  '20260920-03\t没有表头的一行\t一般\t新建\t网络\t2026/9/20\t\t\t说明'), '2026-09-20');
ok(T2.items.length === 1 && T2.items[0].title === '没有表头的一行' && T2.items[0].module === '网络',
   '没有表头行时按固定列序认（表头是可选的）');

const T3 = DC.parseTable(DC.parseTSV(
  '编号\t标题\t严重程度\t状态\t发现\n' +
  '\t\t\t\t\n' +
  '20260920-99\t\t\t\t\n' +
  '20260920-98\t有标题\tP0\t处理中\t2026/13/1'), '2026-09-20');
ok(T3.items.length === 1, '整行空白、以及只有编号没内容的行都跳过，只有真内容才入库', String(T3.items.length));
ok(T3.skipped === 2, '跳过数如实上报', String(T3.skipped));
ok(T3.errors.length === 3, '程度/状态/日期三处认不出各记一条', JSON.stringify(T3.errors));
ok(T3.errors[0].indexOf('P0') > 0 && T3.errors[1].indexOf('处理中') > 0 && T3.errors[2].indexOf('2026/13/1') > 0,
   '报错里带上原值和行号，他才知道回去改哪一格', JSON.stringify(T3.errors));
ok(T3.items[0].severity === 'normal' && T3.items[0].status === 'new',
   '认不出的值落回默认（不丢行，也不写坏数据）');
ok(T3.items[0].foundAt === '2026-09-20', '发现日期认不出时按今天（和新建一条的行为一致）');

const T4 = DC.parseTable([], '2026-09-20');
ok(T4.items.length === 0 && T4.skipped === 0 && T4.errors.length === 0, '空表不炸');
ok(DC.parseTable(null, '2026-09-20').items.length === 0, 'null 不炸');
const T5 = DC.parseTable([['标题', '描述与复现步骤'], ['来自 xlsx 的行', '']], '2026-09-20');
ok(T5.items.length === 1 && T5.items[0].title === '来自 xlsx 的行',
   'xlsx 读出来的二维数组走同一条路（粘贴与导入共用一个解析）');

/* ---------------- [17] toRows 与界面接线 ---------------- */
log('[17] toRows：导出用的二维表');
const RT = DC.toRows([
  mk({ no: '20260920-01', title: '标题甲', severity: 'fatal', status: 'fixed', module: '引擎',
       foundAt: '2026-09-18', fixedAt: '2026-09-19', note: '备注甲', desc: '描述甲' })
]);
ok(RT.length === 2 && RT[0].join(',') === DC.HEADERS.join(','), '第一行就是 HEADERS（导出/导入同一套列名）');
ok(RT[1].join(',') === '20260920-01,标题甲,致命,已修复,引擎,2026-09-18,2026-09-19,备注甲,描述甲',
   '导出写中文标签（在 Excel 里给人看的是这个）', RT[1].join(','));
ok(DC.toRows([]).length === 1, '没有记录时只导出表头');
ok(DC.toRows(null).length === 1 && DC.toRows([null]).length === 1, '空值不炸');
ok(DC.parseTable(DC.toRows([mk({ no: 'x1', title: '往返', severity: 'minor', status: 'closed',
   module: '网络', foundAt: '2026-09-01', fixedAt: '2026-09-02', note: 'n', desc: 'd' })]), '2026-09-20')
   .items[0].severity === 'minor', '导出再导入是同一个值（往返不丢档）');

ok(/class="btn df-paste"/.test(toolSrc) && /class="btn df-xlsx"/.test(toolSrc), '工具栏有「从 Excel 粘贴」与「导出 Excel」');
ok(/accept="\.json,\.xlsx,\.xls,application\/json"/.test(toolSrc), '导入框同时收备份 JSON 与 Excel');
ok(/\/\\\.xlsx\?\$\/i\.test\(f\.name/.test(toolSrc), '按扩展名分流：xlsx 走表格导入，其余走 JSON 备份');
ok(/function importXlsx\(file\)/.test(toolSrc) && /sheet_to_json/.test(toolSrc), 'xlsx 导入读第一张表');
ok(/loadXlsx\(\)\.then\(XLSX => \{/.test(toolSrc), '导出 Excel 复用共用的懒加载 loadXlsx');
ok(/function loadXlsx\(\) \{/.test(html) && (html.match(/function loadXlsx\(\) \{/g) || []).length === 1,
   'loadXlsx 只有一个定义（题库与缺陷共用，不是各写一份）');
ok(/DefectCore\.parseTable\(rows, todayKey\(\)\)/.test(toolSrc), '粘贴与导入都汇到 DefectCore.parseTable');
ok(/function appendParsed\(parsed, srcName\)/.test(toolSrc) && /askConfirm\(/.test(toolSrc),
   '入库逻辑只有一处，认不出的取值弹出来说清楚（不静默兜底）');

R.finish();
