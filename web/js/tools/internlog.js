'use strict';

/* ===TESTABLE:IlCore:begin=== */
/* internlog 的领域纯逻辑。与 DefectCore / QuizCore 同定位：
 * **不引用 AppStore / document / window / esc**，所以 tools/verify-internlog-core.js
 * 能把整段抽进 vm 跑 —— 检索口径、导出台账、趋势聚合、缺失周判定这些"可判定的规则"
 * 全部由 node 侧覆盖，不用开浏览器。
 * today 由调用方传入，内部绝不取当前时间 —— 否则「当前周不算缺失」这类相对口径钉不住。 */
const IlCore = (function () {
  const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad2(n) { return String(n).padStart(2, '0'); }

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
  function diffDays(a, b) {
    const da = parseDay(a), db = parseDay(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  /* 周一 = 一周起点。与热力图 (getDay()+6)%7 的口径保持一致。 */
  function weekStartOf(s) {
    const dt = parseDay(s);
    if (!dt) return '';
    return dayKey(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7)));
  }
  function weekdayOf(s) {
    const dt = parseDay(s);
    return dt ? WEEKDAY[dt.getDay()] : '';
  }
  /* 效率评分：1~5 的整数；0 / 缺省 / 非法值一律当「未评」 */
  function moodNum(l) {
    const m = Math.round(+((l && l.mood) || 0));
    return (m >= 1 && m <= 5) ? m : 0;
  }

  /* ---------- 结构化检索 ----------
   * f = { q, tags:[], from, to, moodMin, moodMax }，值都是字符串，空串 = 该维度不限。
   * 🔴 规则写死，否则测试钉不住：
   *   · 关键词：对 正文 / 备注文本 / 标签 做**整串子串匹配**（不做分词），大小写不敏感
   *   · 标签：**AND**（同时具备）
   *   · 日期：from/to 任一非空时，**无日期的日志一律排除**（与 itemsInRange 同口径）
   *   · 效率：任一侧为 '0' → 只保留未评；否则按数字区间，且**未评(0) 不满足任何数字区间** */
  function hitsQuery(l, q) {
    if (!q) return true;
    const hay = [l.text || '']
      .concat((l.remarks || []).map(r => (r && r.text) || ''))
      .concat(l.tags || []);
    for (let i = 0; i < hay.length; i++) {
      if (String(hay[i]).toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  }
  function filterLogs(items, f) {
    const o = f || {};
    const q = String(o.q == null ? '' : o.q).trim().toLowerCase();
    const tags = (o.tags || []).slice();
    const from = String(o.from == null ? '' : o.from);
    const to = String(o.to == null ? '' : o.to);
    const mn = String(o.moodMin == null ? '' : o.moodMin);
    const mx = String(o.moodMax == null ? '' : o.moodMax);
    const hasMood = mn !== '' || mx !== '';
    const wantUnrated = mn === '0' || mx === '0';
    return (items || []).filter(l => {
      if (!l) return false;
      if (!hitsQuery(l, q)) return false;
      if (tags.length) {
        const own = l.tags || [];
        for (let i = 0; i < tags.length; i++) if (own.indexOf(tags[i]) < 0) return false;
      }
      if (from || to) {
        if (!l.date) return false;
        if (from && l.date < from) return false;
        if (to && l.date > to) return false;
      }
      if (hasMood) {
        const m = moodNum(l);
        if (wantUnrated) { if (m !== 0) return false; }
        else {
          if (m === 0) return false;
          if (mn && m < +mn) return false;
          if (mx && m > +mx) return false;
        }
      }
      return true;
    });
  }

  /* 全量标签及频次，按频次降序、同频按名称升序（顺序稳定才好写断言） */
  function allTags(items) {
    const cnt = {};
    (items || []).forEach(l => {
      ((l && l.tags) || []).forEach(t => { cnt[t] = (cnt[t] || 0) + 1; });
    });
    return Object.keys(cnt)
      .map(name => ({ name: name, count: cnt[name] }))
      .sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  }

  /* ---------- xlsx 台账 ---------- */
  const LEDGER_HEAD = ['序号', '日期', '星期', '效率(1-5)', '标签', '正文', '备注', '图片数'];
  /* 导出 xlsx 的二维数组（第 0 行是表头）。
   * 🔴 每个单元格必须是**标量**：标签/备注若把数组直接塞进去，
   *    aoa_to_sheet 会写成 [object Object]。
   * 🔴 效率**未评留空串、不写 0** —— 写 0 会被读成"效率 0"，留空才是"没评"。 */
  function ledgerRows(items) {
    const rows = [LEDGER_HEAD.slice()];
    let n = 0;
    (items || []).forEach(l => {
      if (!l) return;
      n++;
      const m = moodNum(l);
      const rs = (l.remarks || [])
        .map(r => String((r && r.text) || '').trim())
        .filter(Boolean);
      rows.push([
        n,
        l.date || '',
        l.date ? weekdayOf(l.date) : '',
        m > 0 ? m : '',
        (l.tags || []).join('、'),
        String(l.text == null ? '' : l.text),
        rs.map(t => '- ' + t).join('\n'),
        (l.images || []).length
      ]);
    });
    return rows;
  }

  /* ---------- 效率趋势 ----------
   * 返回纯数据，SVG 拼接留在 DOM 层（node 侧覆盖口径，真机侧只验"画出 svg 了"）。
   * 🔴 口径必须与热力图一致：**同一天多篇取最高**（renderHeat 用 Math.max），
   *    否则同一个用户在同一天会看到两个不同的"当天效率"。
   * ⚠️ fromKey/toKey 要用热力图那边**用户选的精确端点**，不是按周外扩过的 start/end。 */
  function trendSeries(items, fromKey, toKey) {
    const from = parseDay(fromKey), to = parseDay(toKey);
    if (!from || !to || from > to) return { points: [], unrated: [], days: 0, rated: 0, avg: null };
    const span = Math.round((to - from) / 86400000) + 1;
    if (span > 400) return { points: [], unrated: [], days: 0, rated: 0, avg: null };
    const best = {}, cnt = {};
    (items || []).forEach(l => {
      if (!l || !l.date) return;
      if (l.date < fromKey || l.date > toKey) return;
      cnt[l.date] = (cnt[l.date] || 0) + 1;
      const m = moodNum(l);
      if (m > 0) best[l.date] = Math.max(best[l.date] || 0, m);
    });
    const points = [], unrated = [];
    let sum = 0, rated = 0;
    Object.keys(cnt).sort().forEach(d => {
      const m = best[d] || 0;
      if (m > 0) { points.push({ date: d, mood: m, count: cnt[d] }); sum += m; rated++; }
      else unrated.push({ date: d, count: cnt[d] });
    });
    return {
      points: points, unrated: unrated, days: span, rated: rated,
      avg: rated ? +(sum / rated).toFixed(2) : null
    };
  }
  /* 相邻有评分点间隔 > maxGap 天就断开。
   * 折线跨越大段空档连线，视觉上会暗示"持续下降" —— 这是趋势图最经典的误导。 */
  function trendSegments(points, maxGap) {
    const gap = maxGap == null ? 7 : maxGap;
    const segs = [];
    let cur = [];
    (points || []).forEach(p => {
      if (cur.length) {
        const d = diffDays(cur[cur.length - 1].date, p.date);
        if (d == null || d > gap) { segs.push(cur); cur = []; }
      }
      cur.push(p);
    });
    if (cur.length) segs.push(cur);
    return segs;
  }
  /* 滑动平均：窗口内**只算有评分的记录**（缺失日不进分母）。
   * 按自然日平均会把"一周只写 1 篇"的人拖到接近 0，是误导。
   * 窗口内有效记录 < 2 条时不出点 —— 单点构成的"平均线"是假的。 */
  function movingAvg(points, win) {
    const w = win == null ? 7 : win;
    const ps = points || [];
    const out = [];
    ps.forEach(p => {
      const vals = [];
      ps.forEach(q => {
        const d = diffDays(q.date, p.date);
        if (d != null && d >= 0 && d < w) vals.push(q.mood);
      });
      if (vals.length < 2) return;
      let s = 0;
      vals.forEach(v => { s += v; });
      out.push({ date: p.date, value: +(s / vals.length).toFixed(2) });
    });
    return out;
  }

  /* ---------- 缺失周报 ----------
   * 列出 [fromKey, toKey] 覆盖到的自然周（以周一为键），排除**当前周**：
   * 这周还没过完，不该催。
   * count = 该周范围内已填日期的日志数（只统计落在 fromKey~toKey 段内的）。
   * done = 是否已在 reported 里登记过。 */
  function weeksOf(items, fromKey, toKey, today, reported) {
    const from = parseDay(fromKey), to = parseDay(toKey);
    if (!from || !to) return [];
    const done = {};
    (reported || []).forEach(d => { if (d) done[d] = true; });
    const curWeek = weekStartOf(today);
    const cnt = {};
    (items || []).forEach(l => {
      if (!l || !l.date) return;
      if (l.date < fromKey || l.date > toKey) return;
      const w = weekStartOf(l.date);
      if (w) cnt[w] = (cnt[w] || 0) + 1;
    });
    const out = [];
    let w = weekStartOf(fromKey), guard = 0;
    while (w && w <= toKey && guard++ < 600) {
      if (w !== curWeek) {
        out.push({ monday: w, sunday: addDays(w, 6), count: cnt[w] || 0, done: !!done[w] });
      }
      w = addDays(w, 7);
    }
    return out;
  }
  /* 真正要补的周：有日志、但还没登记过。无日志的空周不需要生成周报。 */
  function missingWeeks(items, fromKey, toKey, today, reported) {
    return weeksOf(items, fromKey, toKey, today, reported)
      .filter(w => w.count > 0 && !w.done);
  }

  return {
    WEEKDAY: WEEKDAY,
    parseDay: parseDay, dayKey: dayKey, addDays: addDays, diffDays: diffDays,
    weekStartOf: weekStartOf, weekdayOf: weekdayOf, moodNum: moodNum,
    filterLogs: filterLogs, hitsQuery: hitsQuery, allTags: allTags,
    LEDGER_HEAD: LEDGER_HEAD, ledgerRows: ledgerRows,
    trendSeries: trendSeries, trendSegments: trendSegments, movingAvg: movingAvg,
    weeksOf: weeksOf, missingWeeks: missingWeeks
  };
})();
/* ===TESTABLE:IlCore:end=== */

/* ============================================================
 * 工具 8：实习日志
 * ============================================================ */
registerTool({
  id: 'internlog',
  name: '实习日志',
  desc: '按日记录，一键导出',
  color: '#3B6D11',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 3.5v3"/><path d="M16 3.5v3"/><path d="M4 10h16"/><path d="M8.5 14.5h7"/><path d="M8.5 17h4"/></svg>',
  mount(el) {
    el.innerHTML = `
      <div class="il-heat">
        <div class="il-heat-head">
          <span class="il-heat-title">贡献度 · 按效率上色</span>
          <span style="display:flex; gap:8px; align-items:center;">
            <select class="field il-heat-year"></select>
            <span class="hint il-heat-stat"></span>
          </span>
        </div>
        <div class="il-heat-range" hidden>
          <input type="date" class="field il-hr-from">
          <span class="hint">至</span>
          <input type="date" class="field il-hr-to">
          <span class="hint">区间按周对齐显示</span>
        </div>
        <div class="heat-scroll">
          <div class="heat-months"></div>
          <div class="heat-rows">
            <div class="heat-days">
              <span style="top:0">周一</span>
              <span style="top:45px">周四</span>
              <span style="top:90px">周日</span>
            </div>
            <div class="heat-grid"></div>
          </div>
          <div class="heat-legend">
            <span>效率 低</span><i class="m1"></i><i class="m2"></i><i class="m3"></i><i class="m4"></i><i class="m5"></i><span>高</span>
            <i class="mn" style="margin-left:10px"></i><span>写了未评</span>
            <i class="m0" style="margin-left:10px"></i><span>没写</span>
          </div>
        </div>
      </div>
      <div class="il-trend" hidden>
        <div class="il-heat-head">
          <span class="il-heat-title">效率趋势 <span class="il-trend-range"></span></span>
          <span class="hint il-trend-stat"></span>
        </div>
        <div class="il-trend-box"></div>
      </div>
      <div class="row">
        <button class="btn btn-primary il-add">+ 新日志</button>
        <button class="btn il-report-btn">生成周报</button>
        <button class="btn il-copy">复制全部</button>
        <button class="btn il-preview">预览</button>
        <button class="btn il-xlsx">导出 Excel</button>
        <button class="btn il-export">导出备份</button>
        <button class="btn il-import">导入</button>
        <input type="file" class="il-file" accept=".json,application/json" hidden>
        <span class="hint il-stat"></span>
      </div>
      <div class="il-search">
        <input class="field il-s-q" placeholder="搜索正文 / 备注 / 标签…">
        <input type="date" class="field il-s-from" title="起始日期（含）">
        <span class="hint">至</span>
        <input type="date" class="field il-s-to" title="结束日期（含）">
        <span class="hint">效率</span>
        <select class="field il-s-min"></select>
        <span class="hint">至</span>
        <select class="field il-s-max"></select>
        <button class="btn btn-sm il-s-clear">清除筛选</button>
        <span class="hint il-s-stat"></span>
      </div>
      <div class="il-tags il-tagfilter"></div>
      <div class="il-report" hidden>
        <div class="il-report-row">
          <input type="date" class="field il-rp-from">
          <span class="hint">至</span>
          <input type="date" class="field il-rp-to">
          <label class="hint" style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" class="il-rp-bytag"> 按标签分组</label>
          <button class="btn btn-sm btn-primary il-rp-gen">生成</button>
          <button class="btn btn-sm il-rp-copy">复制周报</button>
          <button class="btn btn-sm il-rp-md">存 .md</button>
          <button class="btn btn-sm il-rp-html">存 HTML</button>
          <button class="btn btn-sm il-rp-close">收起</button>
        </div>
        <textarea class="field il-rp-out" readonly placeholder="选好日期范围后点「生成」"></textarea>
      </div>
      <div class="il-list"></div>`;
    let logs = AppStore.get('internlog:items', []);
    /* 预览模式：把正文的 textarea 换成 Markdown 渲染结果。
     * 只影响「正文」—— 日期/标签/效率/备注照旧可改，读的时候也能顺手调。 */
    let previewOn = !!AppStore.get('internlog:preview', false);
    /* 结构化检索的筛选条件。空串 = 该维度不限。
     * 状态存进存档（与 internlog:heat / internlog:preview 的习惯一致）——代价是
     * "下次打开看到的是筛选后的列表"，所以界面上必须常亮提示，别让人以为数据丢了。 */
    const EMPTY_FILTER = { q: '', tags: [], from: '', to: '', moodMin: '', moodMax: '' };
    let filter = Object.assign({}, EMPTY_FILTER, AppStore.get('internlog:search', null) || {});
    if (!Array.isArray(filter.tags)) filter.tags = [];
    let tagSig = '';   // 标签集合签名：变了才重建 chips 的 DOM（否则点一下会闪）
    let saveTimer = null;
    const list = el.querySelector('.il-list');
    const stat = el.querySelector('.il-stat');
    const saveNow = () => AppStore.set('internlog:items', logs);

    function sorted() {
      return [...logs].sort((a, b) => {
        if (!a.date && !b.date) return b.ts - a.ts;
        if (!a.date) return -1;
        if (!b.date) return 1;
        return a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts;
      });
    }

    /* ================= 结构化检索 =================
     * 🔴 过滤在**数据层**做（IlCore.filterLogs），不用 DOM 隐藏 ——
     *    后者会和 hydrateImgs() 的图片回填、.note-foot 的状态错位，
     *    也做不出"命中 N 篇"这种统计。
     * 🔴 检索条与标签 chips 都放在 .il-list **之外** —— 这样 renderList() 重写
     *    list.innerHTML 不会打断输入框焦点，关键词可以即时过滤、不需要防抖。
     *    （谁要是把它们挪进列表里，输入一个字就会失焦 —— 千万别挪。）
     * 判定规则全在 IlCore.filterLogs 里，那边有 95 项 node 侧断言兜着。 */
    const sQ = el.querySelector('.il-s-q');
    const sFrom = el.querySelector('.il-s-from');
    const sTo = el.querySelector('.il-s-to');
    const sMin = el.querySelector('.il-s-min');
    const sMax = el.querySelector('.il-s-max');
    const sClear = el.querySelector('.il-s-clear');
    const sStat = el.querySelector('.il-s-stat');
    const tagFilterBox = el.querySelector('.il-tagfilter');

    (function fillMoodSelects() {
      const opts = '<option value="">不限</option><option value="0">未评</option>'
        + [1, 2, 3, 4, 5].map(n => '<option value="' + n + '">' + n + '</option>').join('');
      sMin.innerHTML = opts;
      sMax.innerHTML = opts;
    })();
    (function fillFilterInputs() {
      sQ.value = filter.q;
      sFrom.value = filter.from;
      sTo.value = filter.to;
      sMin.value = filter.moodMin;
      sMax.value = filter.moodMax;
    })();

    const activeFilter = () => !!(filter.q || filter.tags.length || filter.from
      || filter.to || filter.moodMin !== '' || filter.moodMax !== '');
    const visibleLogs = () => IlCore.filterLogs(sorted(), filter);
    const saveFilter = () => AppStore.set('internlog:search', filter);

    /* 标签 chips：候选用**全量** logs（它是筛选入口，不该被筛选条件缩减自己）。
     * 用签名守卫，标签集合没变就只切 .on 类，不重建 DOM。 */
    function syncTagFilter() {
      const tags = IlCore.allTags(logs);
      const sig = tags.map(t => t.name + '\u0001' + t.count).join('\u0002');
      if (sig === tagSig) {
        tagFilterBox.querySelectorAll('[data-ftag]').forEach(b =>
          b.classList.toggle('on', filter.tags.indexOf(b.dataset.ftag) >= 0));
        return;
      }
      tagSig = sig;
      tagFilterBox.innerHTML = tags.length
        ? tags.map(t => '<button class="il-tag' + (filter.tags.indexOf(t.name) >= 0 ? ' on' : '')
            + '" data-ftag="' + esc(t.name) + '" title="点击切换；选多个是「同时满足」">'
            + esc(t.name) + '<em>' + t.count + '</em></button>').join('')
        : '<span class="hint">还没有标签</span>';
    }

    /* 筛选条件变化统一走这里 */
    function applyFilter(mutate) {
      mutate();
      /* 🔴 标签面板指向的那条日志可能已被筛掉，不清状态会"幽灵出现" */
      tagPanelId = null;
      saveFilter();
      renderList();
    }
    sQ.addEventListener('input', () => applyFilter(() => { filter.q = sQ.value; }));
    sFrom.addEventListener('change', () => applyFilter(() => { filter.from = sFrom.value; }));
    sTo.addEventListener('change', () => applyFilter(() => { filter.to = sTo.value; }));
    sMin.addEventListener('change', () => applyFilter(() => { filter.moodMin = sMin.value; }));
    sMax.addEventListener('change', () => applyFilter(() => { filter.moodMax = sMax.value; }));
    sClear.addEventListener('click', () => applyFilter(() => {
      Object.assign(filter, EMPTY_FILTER, { tags: [] });
      sQ.value = ''; sFrom.value = ''; sTo.value = ''; sMin.value = ''; sMax.value = '';
    }));
    tagFilterBox.addEventListener('click', e => {
      const b = e.target.closest('[data-ftag]');
      if (!b) return;
      applyFilter(() => {
        const i = filter.tags.indexOf(b.dataset.ftag);
        if (i >= 0) filter.tags.splice(i, 1); else filter.tags.push(b.dataset.ftag);
      });
    });
    /* ---------- 日志配图 ----------
     * 复用 AppStore 的资产机制，与画板同一套：内容哈希去重、存 data/assets/。
     * ⚠️ 画板那套 assetUrls / imgSrcOf 在 sketch 模块的闭包里，这里拿不到，
     *    必须在 internlog 内自建一份缓存（上次 assetDel 就踩过这个坑）。 */
    const ilAssetUrls = new Map();      // 资产名 -> dataURL
    const ilAssetPending = new Set();   // 正在取回的名字，防重复请求

    /* 把 <img data-asset> 的 src 补上。assetGet 是异步的，
     * 所以渲染时先留空、渲染后再逐张回填 —— 不整页重渲染，避免闪烁与丢焦点。 */
    function hydrateImgs() {
      list.querySelectorAll('img[data-asset]').forEach(img => {
        const name = img.getAttribute('data-asset');
        if (!name) return;
        const cached = ilAssetUrls.get(name);
        if (cached) { if (img.getAttribute('src') !== cached) img.setAttribute('src', cached); return; }
        if (ilAssetPending.has(name)) return;
        ilAssetPending.add(name);
        AppStore.assetGet(name).then(url => {
          ilAssetPending.delete(name);
          if (!url) {
            img.classList.add('il-img-missing');
            img.title = '图片读取失败（文件可能已不在 data/assets/）';
            return;
          }
          ilAssetUrls.set(name, url);
          list.querySelectorAll('img[data-asset="' + name + '"]').forEach(el => el.setAttribute('src', url));
        }).catch(() => { ilAssetPending.delete(name); });
      });
    }

    /* 读文件 → 必要时缩放 → 落成资产文件。成功返回资产名，失败返回 null。 */
    function readImgToAsset(file) {
      return new Promise(resolve => {
        const r = new FileReader();
        r.onerror = () => resolve(null);
        r.onload = () => {
          const im = new Image();
          im.onerror = () => resolve(null);
          im.onload = () => {
            let src = r.result;
            const w = im.naturalWidth || 0, h = im.naturalHeight || 0;
            const MAXPX = 1600;   // 与画板一致：超大图先缩，免得单张就几十 MB
            if (w && h && Math.max(w, h) > MAXPX) {
              const sc = MAXPX / Math.max(w, h);
              const c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(w * sc));
              c.height = Math.max(1, Math.round(h * sc));
              c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
              try { src = c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85); } catch (e) {}
            }
            AppStore.assetPut(src).then(name => {
              if (name) ilAssetUrls.set(name, src);   // 立刻可用，不必等下次读回
              resolve(name || null);
            }).catch(() => resolve(null));
          };
          im.src = r.result;
        };
        r.readAsDataURL(file);
      });
    }

    /* 给某篇日志加图。逐张串行存盘 —— 并发会同时开一堆 canvas 又抢着写盘。 */
    function addImgs(id, fileList) {
      const n = logs.find(x => x.id === id);
      if (!n) return;
      const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type));
      if (!files.length) { showToast('没有可用的图片'); return; }
      let chain = Promise.resolve(), ok = 0;
      files.forEach(f => {
        chain = chain.then(() => readImgToAsset(f)).then(name => {
          if (name) { if (!n.images) n.images = []; n.images.push(name); ok++; }
        });
      });
      chain.then(() => {
        if (!ok) { showToast('图片保存失败'); return; }
        n.ts = Date.now();
        saveNow();
        renderList();
        showToast('已添加 ' + ok + ' 张图片');
      });
    }

    /* 移除单张图：**只解除引用，不删资产文件**。
     * 资产按内容哈希去重，同一张图可能被别的日志或画板共用，删文件会误伤。
     * 代价是 data/assets/ 只增不减（已与用户确认接受）。 */
    function delImg(id, idx) {
      const n = logs.find(x => x.id === id);
      if (!n || !n.images || idx < 0 || idx >= n.images.length) return;
      n.images.splice(idx, 1);
      n.ts = Date.now();
      saveNow();
      renderList();
    }

    /* 点图放大。点遮罩空白处关闭。 */
    function previewImg(src) {
      if (!src) return;
      const o = uiOverlay('<img src="' + src + '" style="max-width:100%;max-height:74vh;border-radius:8px;display:block;margin:0 auto;">'
        + '<div class="hint" style="text-align:center;margin-top:10px;">点空白处关闭</div>');
      o.box.addEventListener('click', e => { if (e.target === o.box) uiCloseModal(); });
    }

    /* 「+ 图片」按钮走系统文件选择；input 复用一个，避免每次渲染都建 DOM */
    const imgFile = document.createElement('input');
    imgFile.type = 'file';
    imgFile.accept = 'image/*';
    imgFile.multiple = true;
    let imgPickId = null;
    imgFile.addEventListener('change', () => {
      const files = Array.from(imgFile.files || []);
      imgFile.value = '';                 // 先取出再清，否则 FileList 会被清掉
      if (imgPickId && files.length) addImgs(imgPickId, files);
      imgPickId = null;
    });

    function renderList() {
      /* 过滤在数据层做；热力图 renderHeat() 继续用**全量** logs ——
       * 它是「贡献度总览」，跟着筛选抖会把跨年视图缩成零星几天。 */
      const all = sorted();
      const vis = activeFilter() ? IlCore.filterLogs(all, filter) : all;
      stat.textContent = all.length
        ? (activeFilter() ? '显示 ' + vis.length + ' / 共 ' + all.length + ' 篇'
                          : '共 ' + all.length + ' 篇')
        : '';
      sStat.textContent = activeFilter() ? '筛选已生效' : '';
      sClear.classList.toggle('btn-primary', activeFilter());
      syncTagFilter();
      list.innerHTML = vis.map(l => {
        const remarks = (l.remarks || []).map(r => `
          <div class="il-remark">
            <span class="dot"></span>
            <input data-id="${l.id}" data-rid="${r.id}" value="${esc(r.text)}" placeholder="补充备注…">
            <button class="il-rdel" data-id="${l.id}" data-rid="${r.id}" title="删除这条备注">删除</button>
          </div>`).join('');
        const selTags = (l.tags || []).map(t =>
          '<button class="il-tag on" data-id="' + l.id + '" data-tag="' + esc(t) + '" title="点击取消">' + esc(t) + '</button>'
        ).join('')
          + '<button class="il-tag il-tag-add" data-id="' + l.id + '" title="添加标签">+ 标签</button>';
        const moodDots = [1, 2, 3, 4, 5].map(i =>
          '<i class="il-mood-dot' + ((l.mood || 0) >= i ? ' on' : '') + '" data-id="' + l.id + '" data-v="' + i + '" title="效率 ' + i + '/5"></i>'
        ).join('');
        const panel = tagPanelId === l.id ? renderTagPanel(l) : '';
        const imgs = (l.images || []).map((n, i) => `
            <span class="il-img-wrap">
              <img class="il-img" data-asset="${esc(n)}" alt="配图 ${i + 1}" title="点击放大">
              <button class="il-img-del" data-id="${l.id}" data-idx="${i}" title="移除这张图">×</button>
            </span>`).join('');
        return `
        <div class="note-card" data-logid="${l.id}">
          <div class="il-head">
            <input type="date" class="field il-date" data-id="${l.id}" value="${l.date}" title="选择日志日期，可留空">
            <div class="il-tags">${selTags}</div>
            <span class="il-mood"><span class="hint">效率</span>${moodDots}</span>
            <button class="todo-del il-del" data-id="${l.id}">删除</button>
          </div>
          ${panel}
          ${previewOn
            ? (l.text && l.text.trim()
              ? '<div class="il-md">' + mdToHtml(l.text) + '</div>'
              : '<div class="il-md il-md-empty">（本条还没写内容）</div>')
            : '<textarea data-id="' + l.id + '" placeholder="今天做了什么、学到什么…">' + esc(l.text) + '</textarea>'}
          <div class="il-imgs">${imgs}</div>
          <div class="il-remarks">${remarks}</div>
          <div class="note-foot">
            <span class="il-foot-btns">
              <button class="il-radd" data-id="${l.id}">+ 备注</button>
              <button class="il-imgadd" data-id="${l.id}" title="也可以直接截图后在本卡片内 Ctrl+V，或把图片拖进来">+ 图片</button>
            </span>
            <span>${new Date(l.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>`;
      }).join('') || (activeFilter()
        ? '<div class="empty">没有符合筛选条件的日志（共 ' + all.length + ' 篇）</div>'
        : '<div class="empty">还没有日志，点「新日志」开始记录（日期可留空稍后选）</div>');
      renderHeat();
      hydrateImgs();
    }
    /* 热力图范围：'6m' | '12m' | '<四位年份>' | 'custom'（自定义区间，用 heatFrom/heatTo） */
    let heatMode = '6m';
    let heatFrom = '';
    let heatTo = '';
    /* 选择记进存档，下次打开保持 */
    (function loadHeatPref() {
      const s = AppStore.get('internlog:heat', null);
      if (s && typeof s === 'object') {
        if (s.mode) heatMode = String(s.mode);
        if (s.from) heatFrom = String(s.from);
        if (s.to) heatTo = String(s.to);
      }
    })();
    function saveHeatPref() {
      AppStore.set('internlog:heat', { mode: heatMode, from: heatFrom, to: heatTo });
    }
    /* YYYY-MM-DD → 本地零点 Date。
     * 🔴 不能用 new Date('2026-09-01')：那按 UTC 解析，东八区会退回 8-31。 */
    function parseYMD(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (isNaN(+d)) return null;
      d.setHours(0, 0, 0, 0);
      return d;
    }
    function calcStreak(counts) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      if (!counts[fmtDate(d)]) d.setDate(d.getDate() - 1);
      let n = 0;
      while (counts[fmtDate(d)]) { n++; d.setDate(d.getDate() - 1); }
      return n;
    }
    /* 区间选择框只在「自定义」模式下露出 */
    function syncHeatRangeUI() {
      const box = el.querySelector('.il-heat-range');
      if (box) box.hidden = heatMode !== 'custom';
      const fi = el.querySelector('.il-hr-from');
      const ti = el.querySelector('.il-hr-to');
      if (fi && fi.value !== heatFrom) fi.value = heatFrom;
      if (ti && ti.value !== heatTo) ti.value = heatTo;
    }
    /* ---------- 效率趋势曲线 ----------
     * 零依赖手写 SVG（照 defect.js:660-685 的路子）。选 SVG 不选 canvas 的理由：
     * **颜色由 CSS 类承担，深浅色主题自动跟随** —— canvas 得取色 + 监听主题重绘 + 处理 DPR。
     *
     * 🔴 三条硬规则（都是"趋势图最经典的误导"）：
     *   1. 横轴按**真实自然日等距**，不按"第几个数据点等距" —— 否则
     *      "半年里只有 3 个点"会被画成三个密集采样，完全看不出稀疏。
     *   2. 相邻有评分点间隔 > 7 天就**断笔**（IlCore.trendSegments）——
     *      跨越大半个月的连线会暗示"持续下降"。
     *   3. Y 轴**固定 1~5，绝不自动缩放** —— 自动缩放会把 3.0→3.2 画成剧烈起伏。
     *
     * 口径与热力图一致：**同一天多篇取最高**（renderHeat 用 Math.max），图上标注出来，
     * 否则同一天在两处会显示成两个不同的效率值。
     * 区间用热力图传进来的 fromKey/toKey（用户选的精确端点），**不是按周外扩过的 start/end**。 */
    function renderTrend(fromKey, toKey, label) {
      const box = el.querySelector('.il-trend');
      const cv = el.querySelector('.il-trend-box');
      const st = el.querySelector('.il-trend-stat');
      if (!box || !cv) return;
      const d = IlCore.trendSeries(logs, fromKey, toKey);
      /* 一个点连不成趋势 —— 数据不够就整块收起来，不留空框 */
      if (d.rated < 2) { box.hidden = true; return; }
      box.hidden = false;
      el.querySelector('.il-trend-range').textContent = '· ' + String(label).trim() + '（同日多篇取最高）';
      st.textContent = '有评分 ' + d.rated + ' 天 · 覆盖区间 ' + d.days + ' 天'
        + (d.avg != null ? ' · 平均 ' + d.avg : '');

      const W = 680, H = 172, L = 26, R = 12, T = 12, B = 30;
      const iw = W - L - R, ih = H - T - B;
      const total = d.days - 1;                       // 端点之间的天数，用于等距换算
      const xOf = key => L + (total <= 0 ? iw / 2 : iw * (IlCore.diffDays(fromKey, key) / total));
      const yOf = m => T + ih * (1 - (m - 1) / 4);    // Y 轴固定 1~5
      let g = '';

      /* 网格 + Y 轴刻度（量程固定，所以 5 条都标出来） */
      [1, 2, 3, 4, 5].forEach(m => {
        const y = yOf(m).toFixed(1);
        g += '<line class="tr-gl" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"></line>';
        g += '<text class="tr-lb" x="' + (L - 5) + '" y="' + (parseFloat(y) + 3.5) + '" text-anchor="end">' + m + '</text>';
      });

      /* 主折线：逐段画，段内才连线（断笔 = 规则 2） */
      IlCore.trendSegments(d.points, 7).forEach(seg => {
        if (seg.length < 2) return;
        const pts = seg.map(p => xOf(p.date).toFixed(1) + ',' + yOf(p.mood).toFixed(1)).join(' ');
        g += '<polyline class="tr-line" points="' + pts + '"></polyline>';
      });
      /* 7 日移动平均：更粗更淡，作背景趋势（窗口内 <2 条不出点，见 IlCore.movingAvg） */
      const ma = IlCore.movingAvg(d.points, 7);
      if (ma.length >= 2) {
        g += '<polyline class="tr-ma" points="'
          + ma.map(p => xOf(p.date).toFixed(1) + ',' + yOf(p.value).toFixed(1)).join(' ') + '"></polyline>';
      }
      /* 采样点（带原生 tooltip） */
      d.points.forEach(p => {
        g += '<circle class="tr-dot" cx="' + xOf(p.date).toFixed(1) + '" cy="' + yOf(p.mood).toFixed(1)
          + '" r="3.2"><title>' + esc(p.date + ' ' + IlCore.weekdayOf(p.date) + ' 效率 ' + p.mood + '/5'
          + (p.count > 1 ? '（当天 ' + p.count + ' 篇，取最高）' : '')) + '</title></circle>';
      });
      /* 「有日志但未评」：空心虚线圆，压在最底下一条线上 ——
       * 语义是"没打分"，不是"效率 1"，所以不能用实心点、也不能画在 Y=1 上。 */
      d.unrated.forEach(p => {
        g += '<circle class="tr-un" cx="' + xOf(p.date).toFixed(1) + '" cy="' + (T + ih + 8) + '" r="3">'
          + '<title>' + esc(p.date + ' 写了 ' + p.count + ' 篇 · 未评效率') + '</title></circle>';
      });
      /* 横轴只标两端 —— 区间可能跨一年，全标会糊成一团 */
      g += '<text class="tr-lb" x="' + L + '" y="' + (H - 6) + '" text-anchor="start">' + esc(fromKey) + '</text>';
      g += '<text class="tr-lb" x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(toKey) + '</text>';

      cv.innerHTML = '<svg class="tr-chart" viewBox="0 0 ' + W + ' ' + H
        + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="效率趋势">' + g + '</svg>'
        + '<div class="tr-legend"><span><i class="tr-c-line"></i>每日效率</span>'
        + '<span><i class="tr-c-ma"></i>7 日平均</span>'
        + (d.unrated.length ? '<span><i class="tr-c-un"></i>有日志未评</span>' : '') + '</div>';
    }
    function renderHeat() {
      /* counts = 当天篇数；moods = 当天**最高**效率（同一天多篇取最大） */
      const counts = {};
      const moods = {};
      logs.forEach(l => {
        if (!l.date) return;
        counts[l.date] = (counts[l.date] || 0) + 1;
        const m = Math.round(+l.mood || 0);
        if (m > 0) moods[l.date] = Math.max(moods[l.date] || 0, m);
      });
      const gridEl = el.querySelector('.heat-grid');
      if (!gridEl) return;
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      let start, end;
      /* 自定义区间的两端：用来把区间外的补齐格画成空白，而不是误显示成「没写」 */
      let lo = null, hi = null;
      if (heatMode === 'custom') {
        const f = parseYMD(heatFrom);
        const t = parseYMD(heatTo);
        if (!f || !t || +f > +t) {
          /* 起止没填全 / 顺序颠倒 → 退回近 6 个月，不至于画不出来。
           * 顺手把纠正后的模式落盘，否则存档里会一直留着一个用不上的 custom。 */
          heatMode = '6m';
          saveHeatPref();
          syncHeatRangeUI();
          return renderHeat();
        }
        lo = f; hi = t;
        const df = (f.getDay() + 6) % 7;
        start = new Date(f);
        start.setDate(start.getDate() - df);
        const dt = (t.getDay() + 6) % 7;
        end = new Date(t);
        end.setDate(end.getDate() + (6 - dt));
      } else if (heatMode === '6m' || heatMode === '12m') {
        const dow = (now.getDay() + 6) % 7;
        start = new Date(now);
        start.setDate(start.getDate() - dow - (heatMode === '6m' ? 25 : 52) * 7);
        end = new Date(now);
        end.setDate(end.getDate() + (6 - dow));
      } else {
        const y = +heatMode;
        const jan1 = new Date(y, 0, 1);
        start = new Date(jan1);
        start.setDate(start.getDate() - (jan1.getDay() + 6) % 7);
        end = new Date(y, 11, 31);
        end.setDate(end.getDate() + (6 - (end.getDay() + 6) % 7));
      }
      const monthsEl = el.querySelector('.heat-months');
      const statEl = el.querySelector('.il-heat-stat');
      let cells = '', months = '';
      const d = new Date(start);
      let col = 0, lastMonth = -1;
      while (d <= end) {
        if ((d.getDay() + 6) % 7 === 0) {
          if (d.getMonth() !== lastMonth) {
            months += '<span style="left:' + (col * 15) + 'px">' + (d.getMonth() + 1) + '月</span>';
            lastMonth = d.getMonth();
          }
          col++;
        }
        const key = fmtDate(d);
        const c = counts[key] || 0;
        const m = moods[key] || 0;
        const future = +d > +now;
        const outside = !!lo && (+d < +lo || +d > +hi);
        /* 优先级：区间外空白 > 未来 > 没写 > 写了未评效率 > 效率 1~5 */
        const cls = outside ? 'lo'
          : future ? 'lf'
            : c === 0 ? 'm0'
              : m > 0 ? 'm' + Math.min(5, m) : 'mn';
        let tip;
        if (outside) tip = ' · 不在区间内';
        else if (future) tip = ' · 还没到';
        else if (c === 0) tip = ' · 没写';
        else tip = ' · ' + c + ' 篇' + (m > 0 ? ' · 效率 ' + m : ' · 未评效率');
        cells += '<i class="' + cls + '"' + (+d === +now ? ' style="box-shadow:0 0 0 1.5px var(--accent)"' : '') + ' title="' + key + tip + '"></i>';
        d.setDate(d.getDate() + 1);
      }
      gridEl.innerHTML = cells;
      monthsEl.innerHTML = months;

      /* 统计只算**可见区间内**的日志。
       * 🔴 自定义模式下要用 lo/hi（用户实际选的起止），不能用 start/end ——
       * 那两个是为对齐周格子向外扩过的，会把区间外的日志也算进来。
       * （旧版这段统计的其实是全部日志，跟「近 6 个月」的文案对不上，顺手修正。） */
      const fromKey = fmtDate(lo || start);
      const toKey = fmtDate(hi || end);
      let n = 0, moodSum = 0, moodCnt = 0, unrated = 0;
      logs.forEach(l => {
        if (!l.date || l.date < fromKey || l.date > toKey) return;
        n++;
        const m = Math.round(+l.mood || 0);
        if (m > 0) { moodSum += m; moodCnt++; } else unrated++;
      });
      const label = heatMode === 'custom'
        ? heatFrom + ' ~ ' + heatTo + ' '
        : /^\d{4}$/.test(heatMode) ? heatMode + ' 年 '
          : '近 ' + (heatMode === '6m' ? 6 : 12) + ' 个月 ';
      let statText = label + '已写 ' + n + ' 篇';
      if (moodCnt) statText += ' · 平均效率 ' + (moodSum / moodCnt).toFixed(1);
      if (unrated) statText += '（' + unrated + ' 篇未评）';
      /* 连续天数只在区间包含今天时才有意义 */
      const streak = calcStreak(counts);
      const nowKey = fmtDate(now);
      if (streak > 0 && nowKey >= fromKey && nowKey <= toKey) statText += ' · 连续 ' + streak + ' 天';
      if (statEl) statEl.textContent = statText;
      syncHeatRangeUI();
      fillYearSelect();
      /* 趋势图复用热力图这一档的区间（fromKey/toKey 是用户选的精确端点，不是外扩过的）。
       * 放在 renderHeat 末尾，这样切「近 6 个月 / 12 个月 / 自定义」时两张图自动同步。 */
      renderTrend(fromKey, toKey, label);
    }
    function fillYearSelect() {
      const sel = el.querySelector('.il-heat-year');
      if (!sel) return;
      const years = [...new Set([new Date().getFullYear()]
        .concat(logs.filter(l => l.date).map(l => +l.date.slice(0, 4))))].sort((a, b) => b - a);
      sel.innerHTML = '<option value="6m">近 6 个月</option><option value="12m">近 12 个月</option>'
        + '<option value="custom">自定义区间</option>'
        + years.map(y => '<option value="' + y + '">' + y + ' 年</option>').join('');
      sel.value = String(heatMode);
      if (sel.value !== String(heatMode)) { heatMode = '6m'; sel.value = '6m'; }
    }
    el.querySelector('.il-heat-year').addEventListener('change', e => {
      heatMode = e.target.value;
      /* 第一次切到自定义：给个合理默认（最近 30 天），省得面对两个空框 */
      if (heatMode === 'custom' && (!heatFrom || !heatTo)) {
        const t = new Date();
        const f = new Date();
        f.setDate(f.getDate() - 29);
        heatFrom = fmtDate(f);
        heatTo = fmtDate(t);
      }
      saveHeatPref();
      renderHeat();
    });
    /* 区间端点改动即时重画；把日期框清空则会退回近 6 个月（见 renderHeat 里的兜底） */
    el.querySelectorAll('.il-hr-from, .il-hr-to').forEach(inp => {
      inp.addEventListener('change', () => {
        const fi = el.querySelector('.il-hr-from');
        const ti = el.querySelector('.il-hr-to');
        heatFrom = (fi && fi.value) || '';
        heatTo = (ti && ti.value) || '';
        saveHeatPref();
        renderHeat();
      });
    });
    const TAG_LIST = ['学习', '开发', '会议', '踩坑', '沟通', '其他'];
    const LOG_TEMPLATE = '【今日完成】\n\n\n【收获与思考】\n\n\n【明日计划】\n';
    let tagPanelId = null;
    function renderTagPanel(l) {
      const freq = {};
      logs.forEach(x => (x.tags || []).forEach(t => { freq[t] = (freq[t] || 0) + 1; }));
      const all = [...new Set(TAG_LIST.concat(Object.keys(freq)))]
        .sort((a, b) => (freq[b] || 0) - (freq[a] || 0));
      const items = all.map(t =>
        '<button class="il-tp-item' + ((l.tags || []).indexOf(t) >= 0 ? ' on' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + (freq[t] ? '<em>' + freq[t] + '</em>' : '') + '</button>'
      ).join('');
      return `
        <div class="il-tp">
          <input class="il-tp-search" placeholder="搜索标签，或输入新名称回车创建">
          <div class="il-tp-list">${items}<button class="il-tp-item il-tp-create" data-tag="" hidden></button></div>
          <div class="il-tp-foot"><span class="hint">点标签选择 / 取消 · 输入新名称回车创建 · Esc 关闭</span><button class="btn btn-sm il-tp-done">完成</button></div>
        </div>`;
    }
    el.querySelector('.il-add').addEventListener('click', () => {
      const nid = 'il' + Date.now() + Math.floor(Math.random() * 1e4);
      logs.push({ id: nid, date: '', text: LOG_TEMPLATE, ts: Date.now() });
      saveNow();
      renderList();
      const ta = list.querySelector('textarea[data-id="' + nid + '"]');
      if (ta) ta.focus();
    });
    el.querySelector('.il-copy').addEventListener('click', async () => {
      if (!logs.length) { showToast('还没有日志'); return; }
      const text = sorted().map(l => {
        const rs = (l.remarks || []).filter(r => r.text.trim());
        const ic = (l.images || []).length;
        return '【' + (l.date || '未填日期') + '】\n' + l.text.trim()
          + (ic ? '\n[附图 ' + ic + ' 张]' : '')
          + (rs.length ? '\n' + rs.map(r => '- ' + r.text.trim()).join('\n') : '');
      }).join('\n\n');
      showToast(await copyText(text) ? '已复制 ' + logs.length + ' 篇日志' : '复制失败');
    });
    /* 预览 / 编辑切换。状态存进存档，下次打开保持。
     * 预览只把「正文」换成渲染结果，其它控件照旧可用。 */
    const pvBtn = el.querySelector('.il-preview');
    function syncPvBtn() {
      pvBtn.classList.toggle('btn-primary', previewOn);
      pvBtn.textContent = previewOn ? '编辑' : '预览';
      pvBtn.title = previewOn
        ? '切回编辑模式'
        : '渲染 Markdown 预览（标题 / 代码块 / 列表 / 表格 / 链接）';
    }
    pvBtn.addEventListener('click', () => {
      previewOn = !previewOn;
      AppStore.set('internlog:preview', previewOn);
      syncPvBtn();
      renderList();
    });
    syncPvBtn();
    /* 粘贴 / 拖入加图，挂在 list 上做事件委托。
     * 粘贴只拦「带图片文件」的情况 —— 纯文本粘贴照常放行，不干扰正常输入。 */
    function imgFilesFrom(dt) {
      const out = [];
      Array.from((dt && dt.files) || []).forEach(f => { if (/^image\//.test(f.type)) out.push(f); });
      return out;
    }
    /* dragover 阶段 dataTransfer.files 往往是空的，只能看 types 里有没有 Files */
    function dtHasFiles(dt) {
      if (!dt) return false;
      const t = dt.types;
      if (!t) return false;
      for (let i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    list.addEventListener('paste', e => {
      const card = e.target.closest('.note-card');
      if (!card) return;
      const files = imgFilesFrom(e.clipboardData);
      if (!files.length) return;           // 纯文本：放行
      e.preventDefault();
      addImgs(card.dataset.logid, files);
    });
    list.addEventListener('dragover', e => {
      if (!e.target.closest('.note-card') || !dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();                  // 不 preventDefault 的话浏览器不会触发 drop
      e.target.closest('.note-card').classList.add('il-drop');
    });
    list.addEventListener('dragleave', e => {
      const card = e.target.closest('.note-card');
      if (card) card.classList.remove('il-drop');
    });
    list.addEventListener('drop', e => {
      const card = e.target.closest('.note-card');
      if (!card) return;
      const files = imgFilesFrom(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      card.classList.remove('il-drop');
      addImgs(card.dataset.logid, files);
    });
    list.addEventListener('keydown', e => {
      const s = e.target.closest('.il-tp-search');
      if (s) {
        if (e.key === 'Escape') { tagPanelId = null; renderList(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = s.value.trim();
          if (!q) return;
          const n = logs.find(x => x.id === tagPanelId);
          if (!n) return;
          if (!n.tags) n.tags = [];
          if (n.tags.indexOf(q) < 0) n.tags.push(q);
          saveNow();
          renderList();
          const s2 = list.querySelector('.il-tp-search');
          if (s2) s2.focus();
        }
        return;
      }
    });
    list.addEventListener('input', e => {
      const s = e.target.closest('.il-tp-search');
      if (s) {
        const q = s.value.trim().toLowerCase();
        const panelEl = s.closest('.il-tp');
        let visible = 0;
        panelEl.querySelectorAll('.il-tp-item:not(.il-tp-create)').forEach(b => {
          const hit = !q || b.dataset.tag.toLowerCase().indexOf(q) >= 0;
          b.hidden = !hit;
          if (hit) visible++;
        });
        const create = panelEl.querySelector('.il-tp-create');
        if (q && visible === 0) {
          create.hidden = false;
          create.dataset.tag = s.value.trim();
          create.textContent = '创建「' + s.value.trim() + '」';
        } else {
          create.hidden = true;
        }
        return;
      }
      const rInput = e.target.closest('.il-remark input');
      if (rInput) {
        const n = logs.find(x => x.id === rInput.dataset.id);
        const rm = n && (n.remarks || []).find(x => x.id === rInput.dataset.rid);
        if (rm) {
          rm.text = rInput.value;
          n.ts = Date.now();
          clearTimeout(saveTimer);
          saveTimer = setTimeout(saveNow, 500);
        }
        return;
      }
      const ta = e.target.closest('textarea');
      if (!ta) return;
      const n = logs.find(x => x.id === ta.dataset.id);
      if (!n) return;
      n.text = ta.value;
      n.ts = Date.now();
      const foot = ta.closest('.note-card').querySelector('.note-foot span');
      if (foot) foot.textContent = '已自动保存';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 500);
    });
    list.addEventListener('change', e => {
      const d = e.target.closest('.il-date');
      if (!d) return;
      const n = logs.find(x => x.id === d.dataset.id);
      if (!n) return;
      n.date = d.value;
      n.ts = Date.now();
      saveNow();
      renderList();
      if (d.value && logs.filter(x => x.date === d.value).length > 1) showToast(d.value + ' 已有其他日志');
    });
    list.addEventListener('click', e => {
      const idel = e.target.closest('.il-img-del');
      if (idel) { delImg(idel.dataset.id, +idel.dataset.idx); return; }
      const imgEl = e.target.closest('.il-img');
      if (imgEl) { previewImg(imgEl.getAttribute('src')); return; }
      const iadd = e.target.closest('.il-imgadd');
      if (iadd) { imgPickId = iadd.dataset.id; imgFile.click(); return; }
      const addBtn = e.target.closest('.il-tag-add');
      if (addBtn) {
        tagPanelId = tagPanelId === addBtn.dataset.id ? null : addBtn.dataset.id;
        renderList();
        if (tagPanelId) {
          const s = list.querySelector('.il-tp-search');
          if (s) s.focus();
        }
        return;
      }
      const tpItem = e.target.closest('.il-tp-item');
      if (tpItem && tpItem.dataset.tag) {
        const n = logs.find(x => x.id === tagPanelId);
        if (n) {
          if (!n.tags) n.tags = [];
          const i = n.tags.indexOf(tpItem.dataset.tag);
          if (i >= 0) n.tags.splice(i, 1); else n.tags.push(tpItem.dataset.tag);
          saveNow();
        }
        renderList();
        return;
      }
      const tpDone = e.target.closest('.il-tp-done');
      if (tpDone) {
        tagPanelId = null;
        renderList();
        return;
      }
      const tag = e.target.closest('.il-tag');
      if (tag) {
        const n = logs.find(x => x.id === tag.dataset.id);
        if (n) {
          if (!n.tags) n.tags = [];
          const i = n.tags.indexOf(tag.dataset.tag);
          if (i >= 0) n.tags.splice(i, 1); else n.tags.push(tag.dataset.tag);
          saveNow();
          renderList();
        }
        return;
      }
      const dot = e.target.closest('.il-mood-dot');
      if (dot) {
        const n = logs.find(x => x.id === dot.dataset.id);
        if (n) {
          const v = +dot.dataset.v;
          n.mood = n.mood === v ? 0 : v;
          n.ts = Date.now();
          saveNow();
          renderList();
        }
        return;
      }
      const radd = e.target.closest('.il-radd');
      if (radd) {
        const n = logs.find(x => x.id === radd.dataset.id);
        if (!n) return;
        if (!n.remarks) n.remarks = [];
        const rid = 'r' + Date.now() + Math.floor(Math.random() * 1e4);
        n.remarks.push({ id: rid, text: '' });
        n.ts = Date.now();
        saveNow();
        renderList();
        const ri = list.querySelector('.il-remark input[data-rid="' + rid + '"]');
        if (ri) ri.focus();
        return;
      }
      const rdel = e.target.closest('.il-rdel');
      if (rdel) {
        const n = logs.find(x => x.id === rdel.dataset.id);
        if (n && n.remarks) {
          n.remarks = n.remarks.filter(x => x.id !== rdel.dataset.rid);
          n.ts = Date.now();
          saveNow();
          renderList();
        }
        return;
      }
      const btn = e.target.closest('.il-del');
      if (!btn) return;
      logs = logs.filter(x => x.id !== btn.dataset.id);
      saveNow();
      renderList();
    });
    function fmtDate(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function genReport(from, to, byTag) {
      const items = itemsInRange(from, to);
      if (!items.length) return '';
      const fmtItem = l => {
        const d = new Date(l.date + 'T00:00:00');
        const rs = (l.remarks || []).filter(r => r.text.trim());
        const mood = l.mood ? '（效率 ' + l.mood + '/5）' : '';
        const ic = (l.images || []).length;
        return l.date + ' ' + WEEKDAY[d.getDay()] + mood + '\n' + l.text.trim()
          + (ic ? '\n[附图 ' + ic + ' 张]' : '')
          + (rs.length ? '\n' + rs.map(r => '- ' + r.text.trim()).join('\n') : '');
      };
      if (!byTag) {
        return '【实习周报】' + from + ' 至 ' + to + '\n\n' + items.map(fmtItem).join('\n\n');
      }
      const groups = groupByTag(items);
      return '【实习周报】' + from + ' 至 ' + to + '（按标签汇总）\n\n'
        + Object.keys(groups).map(g => '◆ ' + g + '\n' + groups[g].map(fmtItem).join('\n\n')).join('\n\n');
    }

    /* ---------- 周报导出（Markdown / HTML） ---------- */
    const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function itemsInRange(from, to) {
      return sorted().filter(l => l.date && l.date >= from && l.date <= to);
    }
    function groupByTag(items) {
      const groups = {};
      items.forEach(l => {
        const g = (l.tags && l.tags[0]) || '未分类';
        (groups[g] = groups[g] || []).push(l);
      });
      return groups;
    }
    /* 取一篇日志的配图，内联成 data URL 的 <img>。
     * 必须内联 —— 否则导出的 HTML 换台机器打开就全是缺图。 */
    async function imgTagsHtml(l) {
      const names = l.images || [];
      if (!names.length) return '';
      const urls = await Promise.all(names.map(n => AppStore.assetGet(n).catch(() => null)));
      const imgs = urls.filter(Boolean).map(u => '<img src="' + u + '">').join('');
      return imgs ? '<div class="imgs">' + imgs + '</div>' : '';
    }
    /* 自包含 HTML 周报。
     *   - 带 MS Office 命名空间，Word 能直接打开
     *   - 正文用 white-space:pre-wrap 原样保留换行 —— **不做 Markdown 渲染**：
     *     导出目标是公文式 Word，用户还要二次排版，"所见即所写"最不容易出错。
     *     Markdown 渲染只用于应用内预览。
     *   - ⚠️ 不生成真 .docx：那要引新依赖；而这份 HTML 正好可以喂给现成的
     *     「HTML → docx」流程，格式控制反而更自由。 */
    async function buildReportHtml(items, from, to, byTag) {
      const fmtItem = async l => {
        const d = new Date(l.date + 'T00:00:00');
        const rs = (l.remarks || []).filter(r => r.text.trim());
        const mood = l.mood ? '（效率 ' + l.mood + '/5）' : '';
        return '<div class="item">'
          + '<div class="d">' + esc(l.date) + ' ' + WEEKDAY[d.getDay()] + '<span class="mood">' + esc(mood) + '</span></div>'
          + '<div class="body">' + esc(l.text.trim()) + '</div>'
          + (rs.length ? '<ul class="rs">' + rs.map(r => '<li>' + esc(r.text.trim()) + '</li>').join('') + '</ul>' : '')
          + await imgTagsHtml(l)
          + '</div>';
      };
      const head = '<h1>实习周报</h1><div class="sub">' + esc(from) + ' 至 ' + esc(to) + '</div>';
      let body;
      if (!byTag) {
        body = (await Promise.all(items.map(fmtItem))).join('');
      } else {
        const groups = groupByTag(items);
        const parts = [];
        for (const g of Object.keys(groups)) {
          parts.push('<h2>' + esc(g) + '</h2>' + (await Promise.all(groups[g].map(fmtItem))).join(''));
        }
        body = parts.join('');
      }
      return '<!DOCTYPE html>\n<html lang="zh-CN" xmlns:o="urn:schemas-microsoft-com:office:office"'
        + ' xmlns:w="urn:schemas-microsoft-com:office:word">\n<head>\n<meta charset="UTF-8">\n'
        + '<title>实习周报 ' + esc(from) + ' 至 ' + esc(to) + '</title>\n<style>\n'
        + '@page { size: A4; margin: 20mm 18mm; }\n'
        + 'body { font-family: "Microsoft YaHei", system-ui, sans-serif; font-size: 11pt; line-height: 1.7; color: #1f2328; }\n'
        + 'h1 { font-size: 16pt; text-align: center; margin: 0 0 4pt; }\n'
        + '.sub { text-align: center; color: #666; font-size: 10pt; margin-bottom: 16pt; }\n'
        + 'h2 { font-size: 13pt; border-bottom: 1px solid #ddd; padding-bottom: 3pt; margin: 18pt 0 8pt; }\n'
        + '.item { margin-bottom: 12pt; }\n'
        + '.item .d { font-weight: 600; }\n'
        + '.item .mood { color: #666; font-size: 10pt; font-weight: normal; }\n'
        + '.item .body { white-space: pre-wrap; margin-top: 3pt; }\n'
        + '.rs { margin: 4pt 0 0; padding-left: 18pt; color: #444; }\n'
        + '.imgs { margin-top: 6pt; }\n'
        + '.imgs img { max-width: 45%; margin: 3pt 6pt 3pt 0; border: 1px solid #ddd; border-radius: 4px; }\n'
        + '.foot { margin-top: 20pt; color: #888; font-size: 9pt; text-align: right; }\n'
        + '</style>\n</head>\n<body>\n'
        + head + body
        + '<div class="foot">共 ' + items.length + ' 篇 · 由「个人工具箱」导出</div>\n'
        + '</body>\n</html>\n';
    }
    const rpBox = el.querySelector('.il-report');
    const rpFrom = el.querySelector('.il-rp-from');
    const rpTo = el.querySelector('.il-rp-to');
    const rpOut = el.querySelector('.il-rp-out');
    el.querySelector('.il-report-btn').addEventListener('click', () => {
      if (rpBox.hidden) {
        const now2 = new Date();
        const dw = (now2.getDay() + 6) % 7;
        const mon = new Date(now2);
        mon.setDate(mon.getDate() - dw);
        rpFrom.value = fmtDate(mon);
        rpTo.value = fmtDate(now2);
        rpOut.value = '';
      }
      rpBox.hidden = !rpBox.hidden;
    });
    el.querySelector('.il-rp-gen').addEventListener('click', () => {
      if (!rpFrom.value || !rpTo.value) { showToast('请选择起止日期'); return; }
      const text = genReport(rpFrom.value, rpTo.value, el.querySelector('.il-rp-bytag').checked);
      rpOut.value = text || '该日期范围内没有已填写日期的日志';
    });
    el.querySelector('.il-rp-copy').addEventListener('click', async () => {
      if (!rpOut.value) { showToast('先点「生成」'); return; }
      showToast(await copyText(rpOut.value) ? '周报已复制' : '复制失败');
    });
    /* 存 .md：面板里那段文本原样落盘，方便再加工 */
    el.querySelector('.il-rp-md').addEventListener('click', async () => {
      if (!rpOut.value) { showToast('先点「生成」'); return; }
      const blob = new Blob([rpOut.value], { type: 'text/markdown;charset=utf-8' });
      if (await saveBlob(blob, '实习周报-' + (rpFrom.value || todayKey()) + '.md')) {
        showToast('已存为 Markdown');
      }
    });
    /* 存 HTML：自包含（配图内联成 data URL），Word 可直接打开。
     * 不依赖「先生成」—— 直接用上面的日期范围，少一步。 */
    el.querySelector('.il-rp-html').addEventListener('click', async () => {
      if (!rpFrom.value || !rpTo.value) { showToast('请选择起止日期'); return; }
      const items = itemsInRange(rpFrom.value, rpTo.value);
      if (!items.length) { showToast('该日期范围内没有已填写日期的日志'); return; }
      const html = await buildReportHtml(items, rpFrom.value, rpTo.value,
        el.querySelector('.il-rp-bytag').checked);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      if (await saveBlob(blob, '实习周报-' + rpFrom.value + '_' + rpTo.value + '.html')) {
        showToast('已存 HTML —— 可直接用 Word 打开');
      }
    });
    el.querySelector('.il-rp-close').addEventListener('click', () => { rpBox.hidden = true; });
    /* 导出 Excel 台账。
     * 数据源用 sorted()（**全部日志**）—— 与 JSON 备份口径一致，不受检索筛选影响。
     * 二维数组由 IlCore.ledgerRows 拼（8 列，标签/备注已 join 成字符串，
     * 效率未评留空串而不是 0），那边有 node 侧断言兜着。 */
    el.querySelector('.il-xlsx').addEventListener('click', () => {
      if (!logs.length) { showToast('还没有日志可导出'); return; }
      const rows = IlCore.ledgerRows(sorted());
      loadXlsx().then(XLSX => {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 6 }, { wch: 10 },
                       { wch: 16 }, { wch: 60 }, { wch: 30 }, { wch: 8 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '日志台账');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const nImg = logs.reduce((a, l) => a + ((l.images || []).length), 0);
        return saveBlob(blob, '实习日志台账-' + fmtDate(new Date()) + '.xlsx').then(ok => {
          if (ok) {
            /* 图片本身不进表格（与 JSON 备份一致）。不说清会以为"图丢了"—— 如实提示 */
            showToast(nImg
              ? '台账已导出 ' + (rows.length - 1) + ' 行（' + nImg + ' 张配图不在表内）'
              : '台账已导出 ' + (rows.length - 1) + ' 行');
          }
        });
      /* 🔴 这个 catch 不能省：loadXlsx() 加载 vendor 失败会 reject，
       *    漏了就是"点了没反应"，用户会以为按钮坏了。 */
      }).catch(e => showToast(e.message));
    });
    el.querySelector('.il-export').addEventListener('click', async () => {
      if (!logs.length) { showToast('还没有日志可导出'); return; }
      const data = { app: 'toolbox', type: 'internlog', exportedAt: new Date().toISOString(), count: logs.length, items: logs };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const name = '实习日志备份-' + fmtDate(new Date()) + '.json';
      /* 备份只含资产名，图本身在 data/assets/ 里。不说清的话，
       * 换机器导入后会以为"图丢了"——如实提示。 */
      const imgN = logs.reduce((a, l) => a + ((l.images || []).length), 0);
      if (await saveBlob(blob, name)) {
        showToast(imgN
          ? '已导出 ' + logs.length + ' 篇日志（' + imgN + ' 张配图不在文件内，换机器导入会缺图）'
          : '已导出 ' + logs.length + ' 篇日志');
      }
    });
    const fileInput = el.querySelector('.il-file');
    el.querySelector('.il-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          const items = Array.isArray(data) ? data
            : (data && data.type === 'internlog' && Array.isArray(data.items)) ? data.items : null;
          if (!items) { showToast('文件格式不正确'); return; }
          const ids = new Set(logs.map(l => l.id));
          let added = 0;
          items.forEach(it => {
            if (it && it.id && !ids.has(it.id)) { logs.push(it); ids.add(it.id); added++; }
          });
          saveNow();
          renderList();
          showToast(added ? '已导入 ' + added + ' 条日志' : '备份内容已存在，无新增');
        } catch (err) { showToast('导入失败：文件无法解析'); }
      };
      reader.readAsText(f);
    });
    renderList();
    return () => clearTimeout(saveTimer);
  }
});
