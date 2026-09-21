'use strict';

/* ============================================================
 * 工具 10：缺陷统计
 * 记录缺陷并按严重程度 / 状态 / 模块 / 时间出统计。
 * 单人自用：不设处理人 / 提交人字段，也不做可配工作流。
 * Excel 导入导出留到下一批，本批只有 JSON 备份与可复制的文本摘要。
 * ============================================================ */

/* ===TESTABLE:DefectCore:begin=== */
/* 领域纯逻辑。与 QuizCore 同样的定位：可判定的规则全挤在这里，界面只管画。
 * 本段**不引用页面上的任何东西**（AppStore / document / esc 都不用），
 * 所以 tools/verify-defect.js 能把它整段抽进 vm 跑 —— 这个板块的规则能被 CI 全覆盖。
 * 外部输入只有 today（'YYYY-MM-DD'），由调用方传进来而不是内部取当前时间，
 * 否则「本周新增」这类相对口径在测试里根本钉不住。 */
const DefectCore = (function () {
  /* 严重程度与状态都是**固定顺序、固定档位**：统计必须稳定，
   * 不能因为某天没记录就少一档（零值也要占位）。 */
  const SEVERITIES = [
    { key: 'fatal',  label: '致命' },
    { key: 'major',  label: '严重' },
    { key: 'normal', label: '一般' },
    { key: 'minor',  label: '轻微' }
  ];
  const STATUSES = [
    { key: 'new',       label: '新建' },
    { key: 'submitted', label: '已提交' },
    { key: 'fixed',     label: '已修复' },
    { key: 'verified',  label: '已验证' },
    { key: 'closed',    label: '关闭' },
    { key: 'rejected',  label: '拒绝' }
  ];
  /* 「结案」只有关闭与拒绝。其余（包括认不出的状态）一律算未关闭 ——
   * 宁可多算积压，不能少算。 */
  const DONE = ['closed', 'rejected'];
  const SEV_KEYS = SEVERITIES.map(s => s.key);
  const ST_KEYS = STATUSES.map(s => s.key);
  const UNKNOWN_LABEL = '未知';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function arr(a) { return Array.isArray(a) ? a : []; }
  function labelIn(list, key) {
    for (let i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return key ? String(key) : '';
  }
  const sevLabel = k => labelIn(SEVERITIES, k);
  const statusLabel = k => labelIn(STATUSES, k);
  const isKnownSev = k => SEV_KEYS.indexOf(k) >= 0;
  const isKnownStatus = k => ST_KEYS.indexOf(k) >= 0;
  const isOpen = d => !!d && DONE.indexOf(d.status) < 0;

  /* ---------- 日期：一律按本地零点 ----------
   * 🔴 不能用 new Date('2026-09-01')：那按 UTC 解析，东八区会退回 8-31（internlog 踩过）。 */
  function parseDay(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    const dt = new Date(y, m - 1, d);
    /* 2026-02-31 会被 Date 顺延成 3-03，必须回头核对，否则统计里凭空多出一天 */
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  function dayKey(dt) {
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }
  function addDays(s, n) {
    const dt = parseDay(s);
    if (!dt) return '';
    return dayKey(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n));
  }
  /* b - a 的整天数。任一日期非法返回 null —— null 与 0 语义不同
   * （「算不出来」不能让界面显示成「当天修完」）。 */
  function diffDays(a, b) {
    const da = parseDay(a), db = parseDay(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  /* 所在周的周一（周一为一周之首，与 internlog 热力图对齐） */
  function weekStart(s) {
    const dt = parseDay(s);
    if (!dt) return '';
    const dow = (dt.getDay() + 6) % 7;
    return dayKey(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - dow));
  }
  const monthKey = s => (typeof s === 'string' && /^\d{4}-\d{2}/.test(s)) ? s.slice(0, 7) : '';
  const monthName = k => /^\d{4}-\d{2}$/.test(k) ? (+k.slice(5, 7)) + '月' : k;
  function weekLabel(k) {
    const dt = parseDay(k);
    return dt ? (dt.getMonth() + 1) + '/' + dt.getDate() : k;
  }

  /* ---------- 分组计数 ----------
   * dim: 'severity' | 'status' | 'module'
   * 严重程度/状态固定档位输出（含 0）；module 忽略空值，按数量降序、同数量按名称升序。
   * 认不出的程度/状态不会凭空消失，落进末尾的「未知」桶 —— 数据不许静默少掉。 */
  function groupCount(items, dim) {
    const list = arr(items);
    if (dim === 'module') {
      const map = new Map();
      list.forEach(d => {
        const m = String((d && d.module) || '').trim();
        if (!m) return;
        map.set(m, (map.get(m) || 0) + 1);
      });
      return Array.from(map.keys())
        .sort((a, b) => (map.get(b) - map.get(a)) || (a < b ? -1 : a > b ? 1 : 0))
        .map(k => ({ key: k, label: k, count: map.get(k) }));
    }
    const byStatus = dim === 'status';
    const def = byStatus ? STATUSES : SEVERITIES;
    const field = byStatus ? 'status' : 'severity';
    const known = byStatus ? isKnownStatus : isKnownSev;
    const out = def.map(o => ({ key: o.key, label: o.label, count: 0 }));
    const idx = {};
    def.forEach((o, i) => { idx[o.key] = i; });
    let unknown = 0;
    list.forEach(d => {
      const v = d ? d[field] : '';
      if (known(v)) out[idx[v]].count++;
      else unknown++;
    });
    if (unknown) out.push({ key: 'unknown', label: UNKNOWN_LABEL, count: unknown });
    return out;
  }

  /* ---------- 筛选 ----------
   * prefs: { from, to, module, severity, status }，空串表示不限。
   * from/to 按 foundAt 比字符串即可（YYYY-MM-DD 字典序 = 时间序）。
   * 设了日期范围时，没填发现日期的记录被排除 —— 放在范围里会让"本周新增"对不上。 */
  function filterItems(items, prefs) {
    const p = prefs || {};
    return arr(items).filter(d => {
      if (!d) return false;
      if (p.module && String(d.module || '') !== p.module) return false;
      if (p.severity && d.severity !== p.severity) return false;
      if (p.status && d.status !== p.status) return false;
      if (p.from || p.to) {
        const day = typeof d.foundAt === 'string' ? d.foundAt : '';
        if (!day) return false;
        if (p.from && day < p.from) return false;
        if (p.to && day > p.to) return false;
      }
      return true;
    });
  }

  /* 列表排序：发现日期新的在前；同一天按编号倒序；没填日期的排最后（属于待补的草稿）。
   * 不改传入数组。 */
  function sortItems(items) {
    return arr(items).slice().sort((a, b) => {
      const da = (a && a.foundAt) || '', db = (b && b.foundAt) || '';
      if (!da && !db) return String((b && b.no) || '').localeCompare(String((a && a.no) || ''));
      if (!da) return 1;
      if (!db) return -1;
      if (da !== db) return da < db ? 1 : -1;
      return String((b && b.no) || '').localeCompare(String((a && a.no) || ''));
    });
  }

  /* 撤销删除用：把一条记录放回它原来的位置（下标越界就夹紧到两端），
   * 返回新数组不改传入的。删除后可能又删了别的，下标会偏 —— 所以一定要夹紧。 */
  function insertAt(list, item, index) {
    const out = arr(list).slice();
    const n = Number(index);
    const at = Math.min(Math.max(isFinite(n) ? Math.floor(n) : 0, 0), out.length);
    out.splice(at, 0, item);
    return out;
  }

  /* 平均修复天数：只算「发现 + 修复两个日期都合法、且修复不早于发现」的记录。
   * 返回 { count, days }；count=0 时 days=null（界面显示「—」而不是 0 —— 0 是"当天修完"）。 */
  function avgFixDays(items) {
    let sum = 0, n = 0;
    arr(items).forEach(d => {
      if (!d) return;
      const dd = diffDays(d.foundAt, d.fixedAt);
      if (dd === null || dd < 0) return;
      sum += dd; n++;
    });
    return { count: n, days: n ? Math.round(sum * 10 / n) / 10 : null };
  }

  /* 汇总卡片。today 由调用方给（见文件头说明）。 */
  function summary(items, today) {
    const list = arr(items);
    const ws = weekStart(today);
    const fix = avgFixDays(list);
    const total = list.length;
    let open = 0, weekNew = 0, rejected = 0;
    list.forEach(d => {
      if (!d) return;
      if (isOpen(d)) open++;
      if (d.status === 'rejected') rejected++;
      if (ws && typeof d.foundAt === 'string' && d.foundAt >= ws && (!today || d.foundAt <= today)) weekNew++;
    });
    return {
      total: total, open: open, weekNew: weekNew,
      fixedCount: fix.count, avgFixDays: fix.days,
      rejectRate: total ? Math.round(rejected * 1000 / total) / 10 : 0
    };
  }

  /* 趋势分桶。opts: { by:'week'|'month', buckets:8, end:'YYYY-MM-DD' }
   * 固定返回 buckets 个桶（旧 → 新），空桶也在 —— 柱状图不能因为某周没数据就少一根。
   * opened 按 foundAt 计；closed 按 fixedAt 计（只算"修好了"，
   * 被拒的不进关闭曲线：它没有被修）。 */
  function trend(items, opts) {
    const o = opts || {};
    const by = o.by === 'month' ? 'month' : 'week';
    const n = Math.max(1, o.buckets || 8);
    const keys = [];
    if (by === 'week') {
      let cur = weekStart(o.end);
      for (let i = 0; i < n; i++) { keys.unshift(cur); cur = addDays(cur, -7); }
    } else {
      const mk = monthKey(o.end);
      let y = +mk.slice(0, 4), m = +mk.slice(5, 7) - 1;
      for (let i = 0; i < n; i++) {
        keys.unshift(y + '-' + pad2(m + 1));
        m--; if (m < 0) { m = 11; y--; }
      }
    }
    const idx = {};
    keys.forEach((k, i) => { idx[k] = i; });
    const out = keys.map(k => ({
      key: k, label: by === 'week' ? weekLabel(k) : monthName(k), opened: 0, closed: 0
    }));
    arr(items).forEach(d => {
      if (!d) return;
      const ok = by === 'week' ? weekStart(d.foundAt) : monthKey(d.foundAt);
      if (ok && idx[ok] !== undefined) out[idx[ok]].opened++;
      const ck = by === 'week' ? weekStart(d.fixedAt) : monthKey(d.fixedAt);
      if (ck && idx[ck] !== undefined) out[idx[ck]].closed++;
    });
    return out;
  }

  /* 当天的下一个编号：YYYYMMDD-NN（取当天已有编号的最大序号 +1，当天没有则 01）。
   * 编号允许手改，所以这里只保证"新建时默认不撞号"，不做唯一性校验。 */
  function nextNo(items, today) {
    if (typeof today !== 'string' || !parseDay(today)) return '';
    const pfx = today.replace(/-/g, '') + '-';
    let max = 0;
    arr(items).forEach(d => {
      const no = d && typeof d.no === 'string' ? d.no : '';
      if (no.indexOf(pfx) !== 0) return;
      const rest = no.slice(pfx.length);
      if (/^\d+$/.test(rest)) max = Math.max(max, parseInt(rest, 10) || 0);
    });
    return pfx + pad2(max + 1);
  }

  /* 新建记录的默认值。id 由调用方生成（要能被测试固定住）。 */
  function newDefect(items, today, id) {
    const day = parseDay(today) ? today : '';
    return {
      id: id,
      no: nextNo(items, day),
      title: '', module: '',
      severity: 'normal', status: 'new',
      foundAt: day, fixedAt: '',
      desc: '', note: '', ts: Date.now()
    };
  }

  /* 已用过的模块名（去重 + 排序），给输入联想与筛选下拉用 */
  function moduleNames(items) {
    const set = new Set();
    arr(items).forEach(d => {
      const m = String((d && d.module) || '').trim();
      if (m) set.add(m);
    });
    return Array.from(set).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }

  /* 可复制的文本摘要：给「复制摘要」按钮，也是下一批接进实习周报的那段文本。 */
  function summaryText(items, today) {
    const list = arr(items);
    const s = summary(list, today);
    const lines = ['【缺陷统计】截止 ' + (today || '')];
    lines.push('总数 ' + s.total + ' · 未关闭 ' + s.open + ' · 本周新增 ' + s.weekNew
      + ' · 平均修复 ' + (s.avgFixDays === null ? '—' : s.avgFixDays + ' 天')
      + ' · 被拒率 ' + s.rejectRate + '%');
    const sev = groupCount(list, 'severity').filter(g => g.count);
    if (sev.length) lines.push('按严重程度：' + sev.map(g => g.label + ' ' + g.count).join(' / '));
    const open = list.filter(isOpen);
    if (open.length) {
      lines.push('未关闭 ' + open.length + ' 条：'
        + groupCount(open, 'severity').filter(g => g.count).map(g => g.label + ' ' + g.count).join(' / '));
      const byMod = groupCount(open, 'module').slice(0, 5);
      if (byMod.length) lines.push('集中在：' + byMod.map(g => g.label + '(' + g.count + ')').join('、'));
    }
    return lines.join('\n');
  }

  /* ---------- Excel 互操作 ----------
   * 表头是两端的共同契约：导出 xlsx 用它，粘贴和导入也按它认列。
   * 认不出的列忽略 —— 他在自己的表里加列不该把导入搞坏。 */
  const HEADERS = ['编号', '标题', '严重程度', '状态', '模块', '发现', '修复', '备注', '描述与复现步骤'];

  /* 中文标签或英文键（大小写不敏感）都能认，认不出给空串让调用方兜底。
   * 手打的表里「关闭」常被写成「已关闭」—— 去掉开头的「已」再认一次，
   * 不然一条本来已结案的记录会因为措辞被兜底成「新建」，直接算进未关闭。 */
  function labelToKey(list, v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const cand = [s];
    if (s.charAt(0) === '已') cand.push(s.slice(1));
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < cand.length; j++) {
        if (list[i].label === cand[j]) return list[i].key;
        if (String(list[i].key).toLowerCase() === cand[j].toLowerCase()) return list[i].key;
      }
    }
    return '';
  }

  /* Excel 里日期的写法五花八门：2026-09-05 / 2026/9/5 / 2026.9.5 / 20260905 /
   * 序列号 45900（xlsx 读出来常常是它），还有 cellDates 模式下直接就是 Date。
   * 统一成 YYYY-MM-DD，认不出给空串（绝不猜成"今天"）。 */
  function normDay(v) {
    /* 跨 realm 的 Date（node 测试里从沙箱外传进来）instanceof 会失败，所以看 toString */
    if (Object.prototype.toString.call(v) === '[object Date]') {
      const d = new Date(v.getTime());
      return isNaN(d.getTime()) ? '' : dayKey(d);
    }
    if (typeof v === 'number' && isFinite(v)) {
      /* 序列号 1 = 1900-01-01，且 Excel 误把 1900 当闰年 → 从 1899-12-30 起算才对齐 */
      if (v < 1000 || v > 80000) return '';
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
      const s = y + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
      return parseDay(s) ? s : '';
    }
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    /* 序列号以"常规"格式复制出来就是一串数字文本，照样当序列号认 */
    if (/^\d{5}$/.test(raw)) return normDay(Number(raw));
    let m = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    if (!m) m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return '';
    const s2 = m[1] + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]) + '-' + (m[3].length < 2 ? '0' + m[3] : m[3]);
    return parseDay(s2) ? s2 : '';   /* 借 parseDay 做 2月31日 这类回头核对 */
  }

  /* Excel 复制出来的整块文本就是 TSV。字段里有换行或制表符时 Excel 会包成 "..."，
   * 内部的双引号写成两个 —— 所以不能按 \n 和 \t 硬切，那样多行描述会被切成好几行。 */
  function parseTSV(text) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (quoted) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += c;
      } else if (c === '"' && !cell) quoted = true;
      else if (c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    row.push(cell);
    rows.push(row);
    /* 末尾的整行空白是 Excel 的常客，不算数据 */
    while (rows.length && rows[rows.length - 1].every(x => !String(x == null ? '' : x).trim())) rows.pop();
    return rows;
  }

  /* 二维表 → 缺陷记录（TSV 粘贴与 xlsx 导入共用这一段）。
   * 首行含表头名 → 按名字认列；否则按 HEADERS 的固定顺序。
   * 返回 { items, skipped, errors }：items 里 id/ts 留空、no 允许为空，由调用方补。
   * 整行空、以及只有编号没有内容的行算"跳过"（Excel 已用区域常带脏行）；
   * 认不出的程度/状态/日期不丢行，落回默认值并记一条 errors 让界面说出来。 */
  function parseTable(rows, today) {
    const list = arr(rows).filter(r => Array.isArray(r));
    const out = [], errors = [];
    let skipped = 0;
    if (!list.length) return { items: out, skipped: skipped, errors: errors };
    const head = list[0].map(c => String(c == null ? '' : c).trim());
    const withHead = HEADERS.some(h => head.indexOf(h) >= 0);
    const colOf = name => withHead ? head.indexOf(name) : HEADERS.indexOf(name);
    for (let i = withHead ? 1 : 0; i < list.length; i++) {
      const row = list[i];
      const raw = name => {
        const c = colOf(name);
        return (c >= 0 && row[c] != null) ? row[c] : '';
      };
      const cellText = name => String(raw(name)).trim();
      if (!row.some(x => String(x == null ? '' : x).trim())) { skipped++; continue; }
      const title = cellText('标题'), desc = cellText('描述与复现步骤');
      if (!title && !desc) { skipped++; continue; }
      const line = i + 1;
      const sevRaw = cellText('严重程度');
      let sev = labelToKey(SEVERITIES, sevRaw);
      if (!sev) {
        sev = 'normal';
        if (sevRaw) errors.push('第 ' + line + ' 行：严重程度「' + sevRaw + '」认不出，按「一般」算');
      }
      const stRaw = cellText('状态');
      let st = labelToKey(STATUSES, stRaw);
      if (!st) {
        st = 'new';
        if (stRaw) errors.push('第 ' + line + ' 行：状态「' + stRaw + '」认不出，按「新建」算');
      }
      const fRaw = raw('发现'), xRaw = raw('修复');
      const fDay = String(fRaw).trim() ? normDay(fRaw) : today;
      const xDay = String(xRaw).trim() ? normDay(xRaw) : '';
      if (String(fRaw).trim() && !fDay) errors.push('第 ' + line + ' 行：发现日期「' + cellText('发现') + '」认不出，改填今天');
      if (String(xRaw).trim() && !xDay) errors.push('第 ' + line + ' 行：修复日期「' + cellText('修复') + '」认不出，留空');
      out.push({
        id: '', no: cellText('编号'), title: title, module: cellText('模块'),
        severity: sev, status: st, foundAt: fDay || today, fixedAt: xDay,
        note: cellText('备注'), desc: desc, ts: 0
      });
    }
    return { items: out, skipped: skipped, errors: errors };
  }

  /* 导出的二维表：表头 + 每条一行。不带「时长」（它是算出来的，导回去会被当成一列数据）。 */
  function toRows(items) {
    const rows = [HEADERS.slice()];
    arr(items).forEach(d => {
      if (!d) return;
      rows.push([
        d.no || '', d.title || '', sevLabel(d.severity), statusLabel(d.status),
        d.module || '', d.foundAt || '', d.fixedAt || '', d.note || '', d.desc || ''
      ]);
    });
    return rows;
  }

  return {
    SEVERITIES: SEVERITIES,
    STATUSES: STATUSES,
    DONE: DONE,
    HEADERS: HEADERS,
    sevLabel: sevLabel,
    statusLabel: statusLabel,
    isKnownSev: isKnownSev,
    isKnownStatus: isKnownStatus,
    isOpen: isOpen,
    parseDay: parseDay,
    dayKey: dayKey,
    addDays: addDays,
    diffDays: diffDays,
    weekStart: weekStart,
    monthKey: monthKey,
    groupCount: groupCount,
    filterItems: filterItems,
    sortItems: sortItems,
    insertAt: insertAt,
    avgFixDays: avgFixDays,
    summary: summary,
    trend: trend,
    nextNo: nextNo,
    newDefect: newDefect,
    moduleNames: moduleNames,
    summaryText: summaryText,
    labelToKey: labelToKey,
    normDay: normDay,
    parseTSV: parseTSV,
    parseTable: parseTable,
    toRows: toRows
  };
})();
/* ===TESTABLE:DefectCore:end=== */

registerTool({
  id: 'defect',
  name: '缺陷统计',
  desc: '记录缺陷 · 严重程度/状态/模块统计',
  color: '#A32D2D',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6 2.9 19.4h18.2L12 3.6z"/><path d="M12 9.6v4.4"/><path d="M12 17.1h.01"/></svg>',
  mount(el) {
    let items = AppStore.get('defect:items', []);
    if (!Array.isArray(items)) items = [];
    const savedPrefs = AppStore.get('defect:prefs', null) || {};
    const prefs = {
      from: String(savedPrefs.from || ''),
      to: String(savedPrefs.to || ''),
      module: String(savedPrefs.module || ''),
      severity: String(savedPrefs.severity || ''),
      status: String(savedPrefs.status || '')
    };
    let tab = savedPrefs.tab === 'stats' ? 'stats' : 'list';
    let range = savedPrefs.range === 'month' ? 'month' : 'week';
    let saveTimer = null;
    let selId = '';
    /* 单槽删除撤销：记住最近删掉的那条和它原来的位置。
     * 只有一个槽位是够的 —— 要防的是「误点一下没了」，不是完整编辑历史。 */
    let lastDeleted = null;
    const COLS = [
      { t: '编号', w: 116 }, { t: '标题', w: 280 }, { t: '严重程度', w: 96 },
      { t: '状态', w: 100 }, { t: '模块', w: 120 }, { t: '发现', w: 132 },
      { t: '修复', w: 132 }, { t: '时长', w: 88 }, { t: '备注', w: 150 },
      { t: '描述与复现步骤', w: 260 }, { t: '', w: 56 }
    ];

    /* 批量入库（粘贴 / 导入 Excel 共用）：补 id 与自动编号、跳过编号重复的、追加到记录末尾。
     * 编号是用户看得见的主键，撞号时宁可跳过并说出来，也不要静默造出两条一样的编号。 */
    function appendParsed(parsed, srcName) {
      const today = todayKey();
      const existing = {};
      items.forEach(x => { if (x && x.no) existing[String(x.no)] = 1; });
      const kept = [], dup = [];
      parsed.items.forEach(it => {
        const no = String(it.no || '');
        if (no && existing[no]) { dup.push(no); return; }
        kept.push(it);
      });
      if (!kept.length) {
        showToast(dup.length ? '这些编号都已经有了，没有新增' : '没有读到可新增的数据');
        return;
      }
      const t = Date.now();
      const pending = [];
      kept.forEach((it, i) => {
        it.id = 'df' + t + '-' + i + '-' + Math.floor(Math.random() * 1e4);
        it.ts = t;
        if (!it.no) it.no = DefectCore.nextNo(items.concat(pending), today);
        pending.push(it);
      });
      items = items.concat(pending);
      saveNow();
      render();
      const parts = ['已新增 ' + kept.length + ' 条' + (srcName ? '（' + srcName + '）' : '')];
      if (parsed.skipped) parts.push('跳过 ' + parsed.skipped + ' 行空白');
      if (dup.length) parts.push('跳过 ' + dup.length + ' 条编号重复的');
      showToast(parts.join('，'));
      /* 认不出的值都落回了默认值，不列出来他没法知道哪几条要回头改 */
      if (parsed.errors.length) {
        const more = parsed.errors.length > 20 ? '\n… 还有 ' + (parsed.errors.length - 20) + ' 处' : '';
        askConfirm('有 ' + parsed.errors.length + ' 处取值认不出，已按默认值处理：\n\n'
          + parsed.errors.slice(0, 20).join('\n') + more, '知道了');
      }
    }

    /* 从 Excel 复制的一整块，粘进这个框里一次性录成多条 */
    function openPaste() {
      const o = uiOverlay(
        '<div style="font-weight:500;margin-bottom:6px;">从 Excel 粘贴</div>' +
        '<div class="hint" style="margin-bottom:8px;line-height:1.7;">在 Excel 里选中区域 Ctrl+C，粘到下框里再点「新增」。<br>' +
        '列名认「编号 / 标题 / 严重程度 / 状态 / 模块 / 发现 / 修复 / 备注 / 描述与复现步骤」，带不带表头都行；认不出的列忽略。</div>' +
        '<textarea class="field" data-paste rows="9" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre;" ' +
          'placeholder="20260920-01\t登录超时\t严重\t新建\t账号\t2026/9/20\t\t首次进入偶发">' +
        '</textarea>' + uiBtnRow('新增'));
      const ta = o.card.querySelector('[data-paste]');
      if (ta) ta.focus();
      o.box.addEventListener('click', e => { if (e.target === o.box) uiCloseModal(); });
      o.card.querySelector('[data-uicancel]').addEventListener('click', () => uiCloseModal());
      o.card.querySelector('[data-uiok]').addEventListener('click', () => {
        const text = ta ? ta.value : '';
        uiCloseModal();
        const rows = DefectCore.parseTSV(text);
        if (!rows.length) { showToast('框里还没粘内容'); return; }
        appendParsed(DefectCore.parseTable(rows, todayKey()), '粘贴');
      });
    }

    /* xlsx 导入：读第一张表，交给 DefectCore 认列（和粘贴走同一条入库逻辑） */
    function importXlsx(file) {
      loadXlsx().then(XLSX => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result));
        r.onerror = () => rej(new Error('读取文件失败'));
        r.readAsArrayBuffer(file);
      })).then(buf => {
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) { showToast('表格里没有工作表'); return; }
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) { showToast('表格里没有数据行'); return; }
        appendParsed(DefectCore.parseTable(rows, todayKey()), 'Excel');
      }).catch(err => showToast('导入 Excel 失败：' + ((err && err.message) ? err.message : err)));
    }

    /* 事件只挂在这个常驻容器上，render() 只换它的 innerHTML ——
     * 监听器不会随每次重绘叠加，也不必在每处重绘后重新绑定。 */
    const panel = document.createElement('div');
    el.innerHTML = '';
    el.appendChild(panel);

    const saveNow = () => AppStore.set('defect:items', items);
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };
    const savePrefs = () => AppStore.set('defect:prefs', {
      from: prefs.from, to: prefs.to, module: prefs.module,
      severity: prefs.severity, status: prefs.status, tab: tab, range: range
    });
    const shown = () => DefectCore.sortItems(DefectCore.filterItems(items, prefs));
    const findById = id => items.find(x => String(x.id) === String(id));

    /* 只重绘表体与计数，不动表头与筛选控件 —— 否则改一个下拉框焦点就丢了 */
    function refreshList() {
      const box = panel.querySelector('.df-list');
      if (!box) { render(); return; }
      const rows = shown();
      box.innerHTML = rows.length ? rows.map(rowHtml).join('') : emptyRow();
      const cnt = panel.querySelector('.df-count');
      if (cnt) cnt.textContent = '显示 ' + rows.length + ' / ' + items.length + ' 条';
    }
    const emptyRow = () => '<tr><td class="df-empty" colspan="' + COLS.length + '">' +
      (items.length ? '当前筛选下没有记录' : '还没有缺陷，点「+ 新建缺陷」开始') + '</td></tr>';

    /* 未关闭的显示积压天数；已结案的显示从发现到修复用了几天。 */
    function ageText(d) {
      if (DefectCore.isOpen(d)) {
        const n = DefectCore.diffDays(d.foundAt, todayKey());
        return (n !== null && n > 0) ? '积压 ' + n + ' 天' : '';
      }
      const n2 = DefectCore.diffDays(d.foundAt, d.fixedAt);
      return (n2 !== null && n2 >= 0) ? '历时 ' + n2 + ' 天' : '';
    }

    const sevCls = v => DefectCore.isKnownSev(v) ? ' sev-' + v : '';
    const options = (list, curKey) => list.map(o =>
      '<option value="' + o.key + '"' + (curKey === o.key ? ' selected' : '') + '>' + o.label + '</option>').join('');

    /* 一行一条缺陷，每格直接可改（Excel 那种）。整表只有这一处拼 HTML。 */
    function rowHtml(d) {
      const age = ageText(d);
      return '<tr class="df-tr' + (String(d.id) === selId ? ' on' : '') + '" data-id="' + esc(d.id) +
          '" data-sev="' + esc(d.severity || '') + '">' +
        '<td><input class="cell mono" data-f="no" value="' + esc(d.no || '') + '" title="编号，可手改"></td>' +
        '<td><input class="cell" data-f="title" value="' + esc(d.title || '') + '" placeholder="一句话说清缺陷"></td>' +
        '<td><select class="cell' + sevCls(d.severity) + '" data-f="severity" title="严重程度">' +
          options(DefectCore.SEVERITIES, d.severity) + '</select></td>' +
        '<td><select class="cell" data-f="status" title="状态">' +
          options(DefectCore.STATUSES, d.status) + '</select></td>' +
        '<td><input class="cell" data-f="module" value="' + esc(d.module || '') + '" placeholder="模块" list="dfModules"></td>' +
        '<td><input type="date" class="cell" data-f="foundAt" value="' + esc(d.foundAt || '') + '" title="发现日期"></td>' +
        '<td><input type="date" class="cell" data-f="fixedAt" value="' + esc(d.fixedAt || '') + '" title="修复日期（平均修复天数按它算）"></td>' +
        '<td class="df-age">' + age + '</td>' +
        '<td><input class="cell" data-f="note" value="' + esc(d.note || '') + '" placeholder="备注"></td>' +
        '<td><textarea class="cell" data-f="desc" placeholder="描述与复现步骤…" title="可直接拖动下边缘调高">' + esc(d.desc || '') + '</textarea></td>' +
        '<td class="df-op"><button class="df-del" title="删除这条缺陷">删除</button></td>' +
      '</tr>';
    }

    function barsHtml(rows, color) {
      const max = rows.reduce((a, r) => Math.max(a, r.count), 1);
      return '<div class="df-bars">' + rows.map(r =>
        '<div class="df-brow"><span class="lb" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
        '<span class="tk"><i style="width:' + (r.count * 100 / max).toFixed(1) + '%;background:' + color + '"></i></span>' +
        '<span class="n mono">' + r.count + '</span></div>').join('') + '</div>';
    }
    function stackHtml(rows) {
      const total = rows.reduce((a, r) => a + r.count, 0);
      if (!total) return '<div class="hint">暂无数据</div>';
      return '<div class="df-stack">' + rows.filter(r => r.count).map(r =>
        '<i class="df-c-' + esc(r.key) + '" style="width:' + (r.count * 100 / total).toFixed(2) + '%" title="' + esc(r.label + ' ' + r.count) + '"></i>'
      ).join('') + '</div>';
    }
    function legendHtml(rows) {
      return '<div class="df-legend">' + rows.map(r =>
        '<span><i class="df-c-' + esc(r.key) + '"></i>' + esc(r.label) + ' ' + r.count + '</span>').join('') + '</div>';
    }
    /* 手写 SVG 柱状图：新增 vs 关闭。不引图表库 —— 这点数据量不值得多一个 vendor 文件。 */
    function trendHtml() {
      const by = range, buckets = by === 'month' ? 6 : 8;
      const rows = DefectCore.trend(items, { by: by, buckets: buckets, end: todayKey() });
      const max = rows.reduce((a, r) => Math.max(a, r.opened, r.closed), 1);
      const W = 640, H = 170, L = 30, R = 8, T = 10, B = 24;
      const iw = W - L - R, ih = H - T - B;
      const step = iw / rows.length;
      const bw = Math.max(5, Math.min(16, step / 3.2));
      let g = '';
      for (let i = 0; i <= 3; i++) {
        const y = T + ih - ih * i / 3;
        g += '<line class="gl" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"></line>';
        g += '<text class="lb" x="' + (L - 5) + '" y="' + (y + 3.5) + '" text-anchor="end">' + Math.round(max * i / 3) + '</text>';
      }
      rows.forEach((r, i) => {
        const cx = L + step * i + step / 2;
        const h1 = ih * r.opened / max, h2 = ih * r.closed / max;
        g += '<rect class="b1" x="' + (cx - bw - 1).toFixed(1) + '" y="' + (T + ih - h1).toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h1.toFixed(1) + '" rx="2"><title>' + esc(r.label + ' 新增 ' + r.opened) + '</title></rect>';
        g += '<rect class="b2" x="' + (cx + 1).toFixed(1) + '" y="' + (T + ih - h2).toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h2.toFixed(1) + '" rx="2"><title>' + esc(r.label + ' 关闭 ' + r.closed) + '</title></rect>';
        g += '<text class="lb" x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(r.label) + '</text>';
      });
      return '<svg class="df-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="缺陷趋势">' + g + '</svg>' +
        '<div class="df-legend"><span><i class="df-c-normal"></i>新增</span><span><i class="df-c-ok"></i>关闭</span></div>';
    }

    function viewList() {
      const mods = DefectCore.moduleNames(items);
      const rows = shown();
      return '<div class="bar">' +
          '<button class="btn btn-primary df-add">+ 新建缺陷</button>' +
          '<button class="btn df-paste" title="在 Excel 里复制一块，粘进来一次录多条">从 Excel 粘贴</button>' +
          '<button class="btn df-copy">复制摘要</button>' +
          '<button class="btn df-xlsx">导出 Excel</button>' +
          '<button class="btn df-export">导出备份</button>' +
          '<button class="btn df-import" title="支持 Excel 表格与备份 JSON">导入</button>' +
          '<input type="file" class="df-file" accept=".json,.xlsx,.xls,application/json" hidden>' +
          '<span class="sp df-count">显示 ' + rows.length + ' / ' + items.length + ' 条</span>' +
        '</div>' +
        '<div class="bar">' +
          '<span class="hint">筛选</span>' +
          '<input type="date" class="field" data-pref="from" value="' + esc(prefs.from) + '" title="起始发现日期">' +
          '<span class="hint">至</span>' +
          '<input type="date" class="field" data-pref="to" value="' + esc(prefs.to) + '" title="截止发现日期">' +
          '<select class="field" data-pref="module"><option value="">全部模块</option>' + mods.map(m =>
            '<option value="' + esc(m) + '"' + (prefs.module === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>' +
          '<select class="field" data-pref="severity"><option value="">全部程度</option>' + DefectCore.SEVERITIES.map(s =>
            '<option value="' + s.key + '"' + (prefs.severity === s.key ? ' selected' : '') + '>' + s.label + '</option>').join('') + '</select>' +
          '<select class="field" data-pref="status"><option value="">全部状态</option>' + DefectCore.STATUSES.map(s =>
            '<option value="' + s.key + '"' + (prefs.status === s.key ? ' selected' : '') + '>' + s.label + '</option>').join('') + '</select>' +
          '<button class="btn btn-sm df-reset">清除筛选</button>' +
        '</div>' +
        '<div class="df-scroll"><table class="df-table">' +
          '<colgroup>' + COLS.map(c => '<col style="width:' + c.w + 'px">').join('') + '</colgroup>' +
          '<thead><tr>' + COLS.map(c => '<th>' + c.t + '</th>').join('') + '</tr></thead>' +
          '<tbody class="df-list">' + (rows.length ? rows.map(rowHtml).join('') : emptyRow()) + '</tbody>' +
        '</table></div>' +
        '<datalist id="dfModules">' + mods.map(m => '<option value="' + esc(m) + '"></option>').join('') + '</datalist>';
    }

    function viewStats() {
      const s = DefectCore.summary(items, todayKey());
      let html = '<div class="stats">' +
        statCard('总数', s.total) + statCard('未关闭', s.open) + statCard('本周新增', s.weekNew) +
        statCard('已修复', s.fixedCount) +
        statCard('平均修复', s.avgFixDays === null ? '—' : s.avgFixDays + ' 天') +
        statCard('被拒率', s.rejectRate + '%') +
      '</div>';
      if (!items.length) return html + '<div class="empty">还没有缺陷记录，先到「记录」页加一条</div>';

      const sev = DefectCore.groupCount(items, 'severity');
      html += '<div class="df-sec"><div class="df-sec-t">按严重程度</div>' + stackHtml(sev) + legendHtml(sev) + '</div>';
      html += '<div class="df-sec"><div class="df-sec-t">按状态</div>' +
        barsHtml(DefectCore.groupCount(items, 'status'), 'var(--accent)') + '</div>';
      const mods = DefectCore.groupCount(items, 'module').slice(0, 8);
      html += '<div class="df-sec"><div class="df-sec-t">模块分布 · Top 8</div>' +
        (mods.length ? barsHtml(mods, 'var(--ok)') : '<div class="hint">还没有填模块</div>') + '</div>';
      html += '<div class="df-sec"><div class="df-sec-t">趋势 · 近 ' + (range === 'month' ? '6 个月' : '8 周') + '（新增 / 关闭）</div>' +
        '<div class="bar" style="margin-bottom:8px;">' +
          '<button class="btn btn-sm df-range' + (range === 'week' ? ' btn-primary' : '') + '" data-range="week">按周</button>' +
          '<button class="btn btn-sm df-range' + (range === 'month' ? ' btn-primary' : '') + '" data-range="month">按月</button>' +
        '</div>' + trendHtml() + '</div>';
      html += '<div class="hint">统计基于全部记录，不受「记录」页的筛选影响</div>';
      return html;
    }

    function render() {
      /* 防御：tab 若为未知值，回落记录页，绝不留下空白面板 */
      if (tab !== 'stats') tab = 'list';
      const tabs = tabButtons([['list', '记录'], ['stats', '统计']], tab);
      panel.innerHTML = '<div class="tabs">' + tabs + '</div>' +
        (tab === 'stats' ? viewStats() : viewList());
    }

    function applyField(row, f, v) {
      const d = findById(row.getAttribute('data-id'));
      if (!d) return;
      d[f] = v;
      d.ts = Date.now();
    }

    /* 重绘后按 id + 字段名找回同一个单元格（改状态/日期会让行重排，得把焦点带过去） */
    function cellOf(id, f) {
      const row = Array.from(panel.querySelectorAll('.df-tr'))
        .find(x => x.getAttribute('data-id') === String(id));
      return row ? row.querySelector('[data-f="' + f + '"]') : null;
    }
    function selectRow(id) {
      if (String(id) === selId) return;
      selId = String(id);
      Array.from(panel.querySelectorAll('.df-tr.on')).forEach(x => x.classList.remove('on'));
      const row = Array.from(panel.querySelectorAll('.df-tr'))
        .find(x => x.getAttribute('data-id') === selId);
      if (row) row.classList.add('on');
    }

    /* 放回原来的位置（不是追加到末尾），撤销后行序与删除前一致 */
    function undoDelete() {
      if (!lastDeleted) return;
      items = DefectCore.insertAt(items, lastDeleted.item, lastDeleted.index);
      lastDeleted = null;
      saveNow();
      render();
      showToast('已撤销删除');
    }
    /* Ctrl/Cmd+Z 撤销删除。挂在 document 上是因为点完「删除」按钮焦点就掉回 body 了，
     * 只在面板内监听会收不到；切走工具时在 cleanup 里摘掉。
     * 焦点在输入框里时不抢 —— 那里应该是浏览器原生的文本撤销。 */
    function onUndoKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
      if (!lastDeleted) return;
      e.preventDefault();
      undoDelete();
    }
    document.addEventListener('keydown', onUndoKey);

    /* 选中行跟着焦点走；Enter 往下走一格（Excel 习惯，多行文本里保持换行） */
    panel.addEventListener('focusin', e => {
      const row = e.target.closest ? e.target.closest('.df-tr') : null;
      if (row) selectRow(row.getAttribute('data-id'));
    });
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
      const f = e.target.getAttribute ? e.target.getAttribute('data-f') : null;
      const row = e.target.closest ? e.target.closest('.df-tr') : null;
      if (!f || !row) return;
      const next = row.nextElementSibling;
      const t = next ? next.querySelector('[data-f="' + f + '"]') : null;
      if (!t) return;
      e.preventDefault();
      t.focus();
      if (t.select) t.select();
    });

    panel.addEventListener('click', e => {
      /* 点行内任何地方都选中这一行（Excel 那样），包括点了单元格的留白 */
      const clickedRow = e.target.closest ? e.target.closest('.df-tr') : null;
      if (clickedRow) selectRow(clickedRow.getAttribute('data-id'));
      const tabBtn = e.target.closest('.tab');
      if (tabBtn) {
        const k = tabBtn.getAttribute('data-tab');
        if (k !== tab) { tab = k === 'stats' ? 'stats' : 'list'; savePrefs(); render(); }
        return;
      }
      const rangeBtn = e.target.closest('.df-range');
      if (rangeBtn) {
        const r = rangeBtn.getAttribute('data-range');
        if (r !== range) { range = r === 'month' ? 'month' : 'week'; savePrefs(); render(); }
        return;
      }
      if (e.target.closest('.df-add')) {
        const id = 'df' + Date.now() + Math.floor(Math.random() * 1e4);
        items.push(DefectCore.newDefect(items, todayKey(), id));
        saveNow();
        render();
        const t = panel.querySelector('input[data-f="title"]');
        if (t) t.focus();
        return;
      }
      const del = e.target.closest('.df-del');
      if (del) {
        const row = del.closest('.df-tr');
        const d = row ? findById(row.getAttribute('data-id')) : null;
        if (d) {
          lastDeleted = { item: d, index: items.indexOf(d) };
          items.splice(items.indexOf(d), 1);
          saveNow();
          render();
          showToast('已删除 ' + (d.no || '这条缺陷'), { label: '撤销', fn: undoDelete });
        }
        return;
      }
      if (e.target.closest('.df-paste')) { openPaste(); return; }
      if (e.target.closest('.df-xlsx')) {
        if (!items.length) { showToast('还没有缺陷记录'); return; }
        loadXlsx().then(XLSX => {
          const ws = XLSX.utils.aoa_to_sheet(DefectCore.toRows(DefectCore.sortItems(items)));
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '缺陷记录');
          const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
          return saveBlob(new Blob([out], { type: 'application/octet-stream' }),
            '缺陷记录-' + todayKey() + '.xlsx');
        }).then(done => { if (done) showToast('已导出 ' + items.length + ' 条'); })
          .catch(err => showToast('导出 Excel 失败：' + ((err && err.message) ? err.message : err)));
        return;
      }
      if (e.target.closest('.df-reset')) {
        prefs.from = ''; prefs.to = ''; prefs.module = ''; prefs.severity = ''; prefs.status = '';
        savePrefs();
        render();
        return;
      }
      if (e.target.closest('.df-copy')) {
        if (!items.length) { showToast('还没有缺陷记录'); return; }
        copyText(DefectCore.summaryText(items, todayKey())).then(ok => showToast(ok ? '摘要已复制' : '复制失败'));
        return;
      }
      if (e.target.closest('.df-export')) {
        if (!items.length) { showToast('还没有缺陷记录'); return; }
        const payload = {
          app: 'toolbox', type: 'defect', version: 1,
          exportedAt: new Date().toISOString(), items: items
        };
        saveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
          '缺陷记录-' + todayKey() + '.json').then(done => { if (done) showToast('已导出 ' + items.length + ' 条'); });
        return;
      }
      if (e.target.closest('.df-import')) {
        const f = panel.querySelector('.df-file');
        if (f) f.click();
        return;
      }
    });

    panel.addEventListener('input', e => {
      const row = e.target.closest('.df-tr');
      const f = e.target.getAttribute('data-f');
      if (row && f) { applyField(row, f, e.target.value); saveSoon(); return; }
      const p = e.target.getAttribute('data-pref');
      if (p) { prefs[p] = e.target.value; savePrefs(); refreshList(); }
    });

    panel.addEventListener('change', e => {
      const file = e.target.closest('.df-file');
      if (file) {
        const f = file.files && file.files[0];
        file.value = '';            // 先取出再清，否则 FileList 会被清掉
        if (!f) return;
        if (/\.xlsx?$/i.test(f.name || '')) { importXlsx(f); return; }
        const reader = new FileReader();
        reader.onload = () => {
          let data;
          try { data = JSON.parse(reader.result); }
          catch (err) { showToast('导入失败：文件无法解析'); return; }
          const list = Array.isArray(data) ? data
            : (data && data.type === 'defect' && Array.isArray(data.items)) ? data.items : null;
          if (!list) { showToast('格式不对：这不是「导出备份」生成的文件'); return; }
          const ids = new Set(items.map(x => String(x.id)));
          let added = 0;
          list.forEach(it => {
            if (it && it.id !== undefined && !ids.has(String(it.id))) { items.push(it); ids.add(String(it.id)); added++; }
          });
          saveNow();
          render();
          showToast(added ? '已导入 ' + added + ' 条缺陷' : '备份内容已存在，无新增');
        };
        reader.readAsText(f);
        return;
      }
      const row = e.target.closest('.df-tr');
      const f = e.target.getAttribute('data-f');
      if (row && f) {
        const v = e.target.value;
        applyField(row, f, v);
        /* 严重程度改了要立刻换掉文字配色与行首色条（不重绘整行，保住焦点） */
        if (f === 'severity') {
          e.target.className = 'cell' + sevCls(v);
          row.setAttribute('data-sev', v);
        }
        saveNow();
        /* 状态 / 日期 / 编号会影响排序与「积压 N 天」，改完要重绘表体并把焦点带回来 */
        if (f === 'status' || f === 'foundAt' || f === 'fixedAt' || f === 'no') {
          const id = row.getAttribute('data-id');
          refreshList();
          const again = cellOf(id, f);
          if (again) { again.focus(); if (again.select) again.select(); }
        }
        return;
      }
      const p = e.target.getAttribute('data-pref');
      if (p) { prefs[p] = e.target.value; savePrefs(); refreshList(); }
    });

    render();
    return () => {
      clearTimeout(saveTimer);
      document.removeEventListener('keydown', onUndoKey);
    };
  }
});
