/* internlog 领域纯逻辑（IlCore）验证。
 *
 * IlCore 是 internlog 的第一个 TESTABLE 段 —— 在此之前，这个工具的规则全部关在
 * mount() 闭包里，只能靠真机浏览器脚本覆盖。抽出来之后，检索口径、导出台账、
 * 趋势聚合、缺失周判定这些"可判定的规则"由本脚本全覆盖，不用开浏览器。
 *
 * 用法: node tools/verify-internlog-core.js      报告: .workbuddy/_ilcore.txt
 * ⚠️ 改了断言数必须同步改下面的 expected，否则 _harness 会直接判失败（这是设计，防假绿）。 */
'use strict';

const H = require('./_harness');

const html = H.readFrontend();
const R = H.makeReport({ name: 'internlog-core', expected: 108 });
const { log, ok } = R;
const vm = H.vm;

/* ---------------- [0] 抽取与自包含性 ---------------- */
log('');
log('================= [0] 抽取 IlCore =================');

const src = H.extractByMarker(html, 'IlCore');
ok(!!src && src.length > 1000, 'IlCore 段取出成功（标记存在且非空）');

/* 剥掉注释再查真引用 —— 注释里提到 AppStore 不算引用 */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/\bAppStore\b/.test(codeOnly), '不引用 AppStore（否则抽进 vm 会 ReferenceError）');
ok(!/\bdocument\b/.test(codeOnly), '不引用 document');
ok(!/\bwindow\b/.test(codeOnly), '不引用 window');
ok(!/\besc\s*\(/.test(codeOnly), '不引用全局 esc');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nglobalThis.__I = IlCore;', sandbox);
const I = sandbox.__I;
ok(!!I && typeof I.filterLogs === 'function' && typeof I.ledgerRows === 'function',
  'IlCore 取出成功且暴露预期 API');

/* ---------------- 固定样本 ---------------- */
/* 覆盖到所有边界：多标签 / 无标签 / 无日期 / 未评 / 空正文 / 空备注 / 多图 / 同日多篇 */
const LOGS = [
  { id: 'a', date: '2026-09-01', text: 'PLC 调试\n换了个模块', mood: 5, tags: ['开发'],
    remarks: [{ id: 'r1', text: '查了手册' }, { id: 'r2', text: '   ' }], images: ['x1.png', 'x2.png'] },
  { id: 'b', date: '2026-09-03', text: '周会同步进度', mood: 2, tags: ['会议'] },
  { id: 'c', date: '2026-09-03', text: '又改了一版 PLC 日志', mood: 4, tags: ['开发', '会议'],
    remarks: [{ id: 'r3', text: '待复盘' }] },
  { id: 'd', date: '', text: '随手记：明天问质检', mood: 0, tags: ['临时'] },
  { id: 'e', date: '2026-09-08', text: '写 SOP 初稿', mood: 3, tags: ['文档'] },
  { id: 'f', date: '2026-09-10', text: '', mood: 0, tags: [] }
];
const ids = arr => arr.map(l => l.id).join(',');

/* ---------------- [1] 日期工具 ---------------- */
log('');
log('================= [1] 日期工具（本地零点） =================');

ok(I.weekdayOf('2026-09-01') === '周二', 'weekdayOf 2026-09-01 = 周二');
ok(I.weekStartOf('2026-09-03') === '2026-08-31', 'weekStartOf 周四 → 前一个周一');
ok(I.weekStartOf('2026-08-31') === '2026-08-31', 'weekStartOf 周一 → 自身');
ok(I.weekStartOf('2026-09-06') === '2026-08-31', 'weekStartOf 周日 → 本周周一（不是下周一）');
ok(I.parseDay('2026-02-31') === null, '非法日期（2026-02-31）返回 null');
ok(I.parseDay('2026-9-1') === null, '非零填充格式返回 null');
ok(I.addDays('2026-08-31', 7) === '2026-09-07', 'addDays 跨月正确');
ok(I.diffDays('2026-09-01', '2026-09-10') === 9, 'diffDays 正常');
ok(I.diffDays('2026-09-10', '2026-09-01') === -9, 'diffDays 可为负');
ok(I.diffDays('', '2026-09-01') === null, 'diffDays 遇非法日期返回 null（≠0）');
ok(I.moodNum({ mood: 3 }) === 3 && I.moodNum({ mood: 0 }) === 0, 'moodNum 正常值');
ok(I.moodNum({ mood: 9 }) === 0 && I.moodNum({ mood: -1 }) === 0, 'moodNum 越界当未评');
ok(I.moodNum({}) === 0 && I.moodNum(null) === 0, 'moodNum 缺省 / null 当未评');

/* ---------------- [2] 结构化检索 ---------------- */
log('');
log('================= [2] 结构化检索（关键词 / 标签 / 日期 / 效率） =================');

ok(I.filterLogs(LOGS, {}).length === 6, '空条件不过滤');
ok(I.filterLogs(LOGS, null).length === 6, 'f 传 null 不崩且不过滤');
ok(ids(I.filterLogs(LOGS, { q: 'plc' })) === 'a,c', '关键词大小写不敏感，命中正文');
ok(ids(I.filterLogs(LOGS, { q: '手册' })) === 'a', '关键词命中备注文本');
ok(ids(I.filterLogs(LOGS, { q: '会议' })) === 'b,c', '关键词命中标签名');
ok(ids(I.filterLogs(LOGS, { q: '  质检  ' })) === 'd', '关键词去首尾空白');
ok(ids(I.filterLogs(LOGS, { q: '不存在的词' })) === '', '关键词无命中返回空');
ok(ids(I.filterLogs(LOGS, { tags: ['开发'] })) === 'a,c', '单标签过滤');
ok(ids(I.filterLogs(LOGS, { tags: ['开发', '会议'] })) === 'c', '多标签是 AND（同时满足）');
ok(ids(I.filterLogs(LOGS, { tags: [] })) === 'a,b,c,d,e,f', '空标签数组不过滤');
ok(ids(I.filterLogs(LOGS, { from: '2026-09-03' })) === 'b,c,e,f', '日期下限生效');
ok(ids(I.filterLogs(LOGS, { to: '2026-09-03' })) === 'a,b,c', '日期上限生效');
ok(ids(I.filterLogs(LOGS, { from: '2026-09-01', to: '2026-09-30' })) === 'a,b,c,e,f',
  '日期范围内**排除**无日期的日志（与 itemsInRange 同口径）');
ok(ids(I.filterLogs(LOGS, { moodMin: '1', moodMax: '5' })) === 'a,b,c,e',
  '效率数字区间**排除**未评（未评不满足任何数字区间）');
ok(ids(I.filterLogs(LOGS, { moodMin: '0' })) === 'd,f', '任一侧为 0 → 只保留未评');
ok(ids(I.filterLogs(LOGS, { moodMax: '0' })) === 'd,f', '上限为 0 同样按「只看未评」处理');
ok(ids(I.filterLogs(LOGS, { moodMin: '4' })) === 'a,c', '效率下限（a=5、c=4）');
ok(ids(I.filterLogs(LOGS, { moodMax: '3' })) === 'b,e', '效率上限（b=2、e=3）');
ok(ids(I.filterLogs(LOGS, { q: 'plc', tags: ['会议'], moodMin: '1' })) === 'c',
  '多维度组合（关键词 AND 标签 AND 效率）');
ok(I.filterLogs(LOGS, {}).length === 6 && LOGS.length === 6, '过滤不改动入参数组');
ok(I.filterLogs(LOGS, {})[0] === LOGS[0], '返回的是原对象引用（浅过滤，不深拷贝）');
ok(I.filterLogs([null, LOGS[0]], {}).length === 1, '数组中混入 null 被跳过而不是抛错');

/* ---------------- [3] 标签聚合 ---------------- */
log('');
log('================= [3] 标签聚合 =================');

const TG = I.allTags(LOGS);
ok(TG.length === 4, '四个不同标签（开发/会议/临时/文档）');
/* 频次相同时按名称升序：'会议'(U+4F1A) < '开发'(U+5F00) */
ok(TG[0].name === '会议' && TG[0].count === 2, '同频按名称升序，「会议」在「开发」前');
ok(TG[1].name === '开发' && TG[1].count === 2, '「开发」紧随其后，也是 2 次');
ok(TG[2].count === 1 && TG[3].count === 1, '两个 1 次的标签排在后面');
ok(I.allTags([]).length === 0, '空数组返回空');
ok(I.allTags([{}, { tags: [] }]).length === 0, '无 tags 字段不崩');

/* ---------------- [4] xlsx 台账 ---------------- */
log('');
log('================= [4] xlsx 台账（aoa） =================');

const rows = I.ledgerRows(LOGS);
ok(rows.length === 7, '行数 = 日志数 + 1（表头）');
ok(rows[0].length === 8 && rows[0][0] === '序号' && rows[0][7] === '图片数',
  '表头 8 列且首列「序号」、末列「图片数」');
ok(rows[0].join(',') === I.LEDGER_HEAD.join(','), '表头与导出的 LEDGER_HEAD 常量一致');
ok(rows.slice(1).map(r => r[0]).join(',') === '1,2,3,4,5,6', '序号连续 1..6');
ok(rows[1][3] === 5 && rows[2][3] === 2, '已评效率写成数字');
ok(rows[4][3] === '' && rows[6][3] === '', '🔴 未评效率留空串，不写 0');
ok(rows[1][1] === '2026-09-01' && rows[1][2] === '周二', '日期与星期列正确');
ok(rows[4][1] === '' && rows[4][2] === '', '无日期的日志，日期与星期列都留空');
ok(rows[3][4] === '开发、会议', '多标签用「、」连接成**字符串**');
ok(rows[1][4] === '开发' && rows[2][4] === '会议', '单标签也是字符串');
ok(rows[1][6] === '- 查了手册', '备注带「- 」前缀，空备注（全空白）被过滤掉');
ok(rows[3][6] === '- 待复盘', '第二条日志的备注');
ok(rows[1][7] === 2 && rows[2][7] === 0, '图片数列是数字（缺省 0）');
ok(rows[6][5] === '', '空正文写成空串');
ok(JSON.stringify(rows).indexOf('[object') < 0,
  '🔴 aoa 里不含 [object Object]（数组若直接塞进去就会这样）');
ok(I.ledgerRows([]).length === 1, '无日志时只剩表头');

/* ---------------- [5] 效率趋势 ---------------- */
log('');
log('================= [5] 效率趋势 =================');

const tr = I.trendSeries(LOGS, '2026-09-01', '2026-09-10');
ok(tr.days === 10, '覆盖天数含两端 = 10');
ok(tr.rated === 3, '有评分的自然日 = 3（09-01 / 09-03 / 09-08）');
ok(tr.points.filter(p => p.date === '2026-09-03')[0].mood === 4,
  '🔴 同日多篇取**最高**（09-03 有 2 和 4 → 4），与热力图口径一致');
ok(tr.points.filter(p => p.date === '2026-09-03')[0].count === 2, '同日篇数一并带出');
ok(tr.unrated.map(p => p.date).join(',') === '2026-09-10',
  '未评但有日志的日期进 unrated（09-10）而不进 points');
ok(tr.avg === 4, '平均 = (5+4+3)/3 = 4');
ok(I.trendSeries(LOGS, '2026-09-01', '2026-09-10').points.length === 3, '有评分点 3 个');
ok(I.trendSeries(LOGS, '', '').points.length === 0, '非法区间返回空');
ok(I.trendSeries(LOGS, '2026-09-10', '2026-09-01').points.length === 0, '倒置区间返回空');
ok(I.trendSeries(LOGS, '2026-09-09', '2026-09-09').points.length === 0, '单日无不崩');
ok(I.trendSeries([], '2026-09-01', '2026-09-10').avg === null, '无数据时 avg 为 null');

const segs = I.trendSegments([
  { date: '2026-09-01', mood: 1 }, { date: '2026-09-03', mood: 2 },
  { date: '2026-09-30', mood: 3 }
], 7);
ok(segs.length === 2 && segs[0].length === 2 && segs[1].length === 1,
  '🔴 相邻间隔 > 7 天断笔（切成 2 段）');
ok(I.trendSegments([{ date: '2026-09-01', mood: 1 }], 7).length === 1, '单点自成一段');
ok(I.trendSegments([], 7).length === 0, '空点集返回空');

const ma = I.movingAvg([
  { date: '2026-09-01', mood: 2 }, { date: '2026-09-02', mood: 4 },
  { date: '2026-09-03', mood: 3 }
], 7);
ok(ma.length === 2, '🔴 首个点窗口内只有 1 条 → 该点不出（3 个点只出 2 个）');
ok(ma[0].date === '2026-09-02' && ma[0].value === 3, '第二点 = avg(2,4) = 3');
ok(ma[1].date === '2026-09-03' && ma[1].value === 3, '第三点 = avg(2,4,3) = 3');
ok(I.movingAvg([{ date: '2026-09-01', mood: 5 }], 7).length === 0,
  '🔴 窗口内有效记录 < 2 条时不出点（单点构成的平均线是假的）');
ok(I.movingAvg([], 7).length === 0, '空输入返回空');

/* ---------------- [6] 缺失周 ---------------- */
log('');
log('================= [6] 缺失周判定 =================');

/* 日志落在 08-31(周一)~09-06 与 09-07~09-13 两周；today 取 09-21（第三周） */
const wk = I.weeksOf(LOGS, '2026-08-31', '2026-09-13', '2026-09-21', ['2026-08-31']);
ok(wk.length === 2, '区间覆盖 2 个自然周');
ok(wk[0].monday === '2026-08-31' && wk[0].sunday === '2026-09-06', '第一周 周一~周日 正确');
ok(wk[0].count === 3, '第一周有 3 篇（09-01 ×1 + 09-03 ×2）');
ok(wk[1].count === 2, '第二周有 2 篇（09-08 与 09-10）');
ok(wk[0].done === true && wk[1].done === false, 'reported 命中第一周 → done=true');
ok(I.missingWeeks(LOGS, '2026-08-31', '2026-09-13', '2026-09-21', ['2026-08-31'])
  .map(w => w.monday).join(',') === '2026-09-07',
  '🔴 缺失周 = 有日志但 !done 的周（只剩第二周）');
ok(I.missingWeeks(LOGS, '2026-08-31', '2026-09-13', '2026-09-21',
  ['2026-08-31', '2026-09-07']).length === 0, '全部登记过后无缺失');
ok(I.weeksOf(LOGS, '2026-09-14', '2026-09-21', '2026-09-21', []).length === 1
  && I.weeksOf(LOGS, '2026-09-14', '2026-09-21', '2026-09-21', [])
    .every(w => w.monday !== '2026-09-21'),
  '🔴 当前周被排除（只剩 09-14 那一周）');
ok(I.weeksOf(LOGS, '2026-08-31', '2026-09-13', '2026-09-21', [])[0].done === false,
  'reported 为空时全都没登记');
ok(I.weeksOf(LOGS, '2026-09-14', '2026-09-20', '2026-09-21', []).length === 1,
  '非当前周的空周也会列出（由调用方按 count>0 过滤）');
ok(I.weeksOf(LOGS, '', '', '2026-09-21', []).length === 0, '非法区间返回空');
ok(I.weeksOf(LOGS, '2026-08-31', '2026-09-13', '2026-09-21', [])
  .every(w => w.monday >= I.weekStartOf('2026-08-31')), '每周以周一为键');
ok(I.missingWeeks(LOGS, '2026-09-14', '2026-09-20', '2026-09-21', []).length === 0,
  '空周不算缺失（没有日志就没什么可生成）');

/* ---------------- [7] xlsx 台账：真的生成一遍再回读 ----------------
 * 这一段的思路值得记：**vendor 的 xlsx.full.min.js 是 UMD 包，Node 里能直接 require**，
 * 所以"台账到底能不能生成合法的 xlsx"根本不用开浏览器 —— 用与 handler 里完全一样的
 * 五步法生成 → 校验 ZIP 魔数 → 用 XLSX.read 回读 → 逐格比对。
 * 比"查源码里有没有那行代码"强得多，也不占用真机脚本那一轮 4 分钟。 */
log('');
log('================= [7] xlsx 台账：真实生成 + 回读 =================');

let XLSX;
try {
  XLSX = require('../web/vendor/xlsx.full.min.js');
} catch (err) {
  /* 抽不到被测对象就 throw —— 与 extractByMarker 同一策略，不降级成"记条 FAIL 继续跑" */
  throw new Error('vendor/xlsx.full.min.js 加载失败，无法验证台账生成：' + err.message);
}
ok(!!XLSX && typeof XLSX.utils.aoa_to_sheet === 'function', 'vendor xlsx 加载成功且 API 可用');

const ws = XLSX.utils.aoa_to_sheet(I.ledgerRows(LOGS));
ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 6 }, { wch: 10 },
               { wch: 16 }, { wch: 60 }, { wch: 30 }, { wch: 8 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '日志台账');
const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
const buf = Buffer.from(wbout);

ok(buf.length > 1000, '导出的字节数合理（>1 KB）');
ok(buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04,
  '🔴 是合法 xlsx（ZIP 魔数 PK\\x03\\x04）—— 证明写盘格式没错');

const wb2 = XLSX.read(buf, { type: 'buffer' });
ok(wb2.SheetNames[0] === '日志台账', '回读 sheet 名 = 日志台账');
const back = XLSX.utils.sheet_to_json(wb2.Sheets['日志台账'], { header: 1, defval: '' });
ok(back.length === 7, '回读行数 = 7（表头 + 6 篇）');
ok(back[0][0] === '序号' && back[0][7] === '图片数', '回读表头正确');
ok(back[1][3] === 5, '已评效率回读为数字');
ok(String(back[4][3]) === '' && String(back[6][3]) === '',
  '🔴 未评效率回读为空（不是 0）—— 这条只有真跑一遍才验得出');
ok(back[3][4] === '开发、会议', '多标签回读 = 开发、会议');
ok(back[1][6] === '- 查了手册', '备注回读带「- 」前缀');
ok(String(back[4][1]) === '' && String(back[4][2]) === '',
  '无日期那行，日期与星期列回读都为空');
ok(back[1][7] === 2, '图片数列回读 = 2');
ok(JSON.stringify(back).indexOf('[object') < 0,
  '🔴 全表无 [object Object]（数组若直接进 aoa 就会这样）');

log('');
R.finish();
