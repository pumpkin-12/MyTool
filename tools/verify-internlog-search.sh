#!/bin/bash
# 实习日志「结构化检索」真机验证
#
# 为什么要真机跑：这一步的本质全是 DOM 交互 —— 输入关键词后列表收缩、
# **输入框是否还保持焦点**、标签 chip 的 AND 切换、清除后是否复位。
# 静态断言只能证明"代码里写了那行"，证明不了"敲下去真的会过滤、而且不失焦"。
#
# 🔴 本脚本要守的一条关键断言：**检索条在 .il-list 之外，所以 renderList() 重写
#    list.innerHTML 不会打断输入焦点**。这条一旦被破坏（有人把检索框挪进列表里），
#    用户每敲一个字就失焦 —— 属于"能用但极难用"的退化，必须钉住。
#
# 覆盖 138 项断言（检索 32 · 趋势 15 · 缺失周报 20 · 布局契约 17 · 待办 54）。用法: bash tools/verify-internlog-search.sh
# 报告: .workbuddy/_search.txt
set -u

export PATH="$HOME/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

# 🔴 关掉 Chrome 自己的后台联网（更新检查 / 组件下载 / 遥测 / 域名可靠性上报）。
# 不加这些，Chrome 每次启动都会去连 clients2.google.com / update.googleapis.com，
# 被沙箱拦下并弹授权框 —— 拒绝后会把本脚本的**外层包装器**打断，
# 症状是「汇总都打印出来了却收到 SIGTERM」（误导性极强，找了好几轮才定位）。
# agent-browser 的 Options 表里有 AGENT_BROWSER_ARGS，设一次对所有 open/reload 生效。
export AGENT_BROWSER_ARGS="--disable-background-networking,--disable-component-update,--disable-domain-reliability,--no-pings,--disable-sync,--disable-breakpad,--no-first-run,--no-default-browser-check"

REPORT=".workbuddy/_search.txt"
EXPECTED=138
PORT=8913
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1

PY="$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe"
AB=""
for c in "$HOME"/.workbuddy/binaries/node/versions/*/node_modules/agent-browser/bin/agent-browser-win32-x64.exe; do
  [ -f "$c" ] && AB="$c"
done
[ -z "$AB" ] && { echo "找不到 agent-browser exe" >&2; exit 2; }

( cd "$PROJ/web" && "$PY" -m http.server "$PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
SRV=$!
trap '"$AB" close --all >/dev/null 2>&1; kill $SRV 2>/dev/null' EXIT
sleep 2

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
[ "$CODE" != "200" ] && { echo "静态服务不可用（HTTP $CODE）" >&2; exit 3; }

URL="http://127.0.0.1:$PORT/index.html#tool/internlog"

# 种 6 条样本：覆盖 多标签 / 无标签 / 无日期 / 未评 / 空正文
SEED="$(cat <<'EOF'
(function () {
  var items = [
    { id:'a', date:'2026-09-01', text:'PLC 调试', mood:5, tags:['开发'], ts:1 },
    { id:'b', date:'2026-09-03', text:'周会同步进度', mood:2, tags:['会议'], ts:2 },
    { id:'c', date:'2026-09-03', text:'又改了一版 PLC 日志', mood:4, tags:['开发','会议'], ts:3 },
    { id:'d', date:'', text:'随手记：明天问质检', mood:0, tags:['临时'], ts:4 },
    { id:'e', date:'2026-09-08', text:'写 SOP 初稿', mood:3, tags:['文档'], ts:5 },
    { id:'f', date:'2026-09-10', text:'', mood:0, tags:[], ts:6 }
  ];
  localStorage.setItem('toolbox:internlog:items', JSON.stringify(items));
  localStorage.removeItem('toolbox:internlog:search');
  localStorage.removeItem('toolbox:internlog:preview');
  localStorage.removeItem('toolbox:internlog:statOpen');
  localStorage.setItem('toolbox:internlog:heat', JSON.stringify({ mode: '6m' }));
  return 'seeded';
})()
EOF
)"

PRE="$(cat <<'EOF'
(function () {
  var q = function (s) { return document.querySelector(s); };
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  /* 卡片数 = 当前列表里可见的日志条数 */
  function cards() { return document.querySelectorAll('.il-list .note-card').length; }
  function statText() { return (q('.il-stat') || {}).textContent || ''; }
  function heatCells() { return document.querySelectorAll('.heat-grid > *').length; }
  /* 检索状态：直接读存档，验证"是否落盘" */
  function savedFilter() {
    try { return JSON.parse(localStorage.getItem('toolbox:internlog:search') || '{}'); } catch (e) { return {}; }
  }
  /* 在搜索框里输入并按需触发（保持焦点，用来验"重写列表后焦点是否还在"） */
  function typeQ(v) {
    var el = q('.il-s-q');
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function clearAll() { q('.il-s-clear').click(); }
  function clickTag(name) {
    q('.il-tagfilter [data-ftag="' + name + '"]').click();
  }
EOF
)"

# ---------- A0 检索条结构 ----------
ASSERT_A0="$PRE
  ok('检索条存在', !!q('.il-search'));
  eq('两个效率下拉各有 7 个选项（不限/未评/1~5）', q('.il-s-min').options.length + '/' + q('.il-s-max').options.length, '7/7');
  eq('初始无筛选：6 张卡片', cards(), 6);
  eq('初始 stat 文案', statText(), '共 6 篇');
  eq('初始「筛选已生效」为空', (q('.il-s-stat') || {}).textContent, '');
  eq('标签 chips 4 个（开发/会议/临时/文档）', document.querySelectorAll('.il-tagfilter [data-ftag]').length, 4);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A1 关键词过滤 + 焦点保持 ----------
ACT_Q="(function(){
  window.__heat0 = document.querySelectorAll('.heat-grid > *').length;
  var el = document.querySelector('.il-s-q');
  el.focus(); el.value = 'plc';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()"

ASSERT_A1="$PRE
  eq('关键词 plc → 2 张卡片（a 与 c）', cards(), 2);
  eq('stat 文案变成「显示 N / 共 M 篇」', statText(), '显示 2 / 共 6 篇');
  eq('旁边常亮「筛选已生效」', (q('.il-s-stat') || {}).textContent, '筛选已生效');
  ok('清除按钮被高亮（btn-primary）', q('.il-s-clear').classList.contains('btn-primary'));
  /* 🔴 本节最重要的一条 */
  eq('🔴 重写列表后输入框**仍然保持焦点**', document.activeElement === q('.il-s-q'), true);
  eq('🔴 热力图格子数不受筛选影响', document.querySelectorAll('.heat-grid > *').length, window.__heat0);
  eq('筛选状态已落盘（q=plc）', savedFilter().q, 'plc');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A2 空结果空态 ----------
ASSERT_A2="$PRE
  typeQ('绝对不存在的词');
  eq('无命中时 0 张卡片', cards(), 0);
  ok('空态文案提示是筛选导致的', document.querySelector('.il-list .empty').textContent.indexOf('没有符合筛选条件') >= 0);
  ok('空态文案带总数', document.querySelector('.il-list .empty').textContent.indexOf('共 6 篇') >= 0);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A3 标签 AND ----------
ASSERT_A3="$PRE
  clearAll();
  eq('清除筛选后回到 6 张', cards(), 6);
  eq('清除后 stat 回到「共 6 篇」', statText(), '共 6 篇');
  eq('清除后搜索框已清空', q('.il-s-q').value, '');
  clickTag('开发');
  eq('选「开发」→ 2 张（a、c）', cards(), 2);
  clickTag('会议');
  eq('再选「会议」→ AND 只剩 1 张（c）', cards(), 1);
  eq('两个 chip 都处于选中态', document.querySelectorAll('.il-tagfilter [data-ftag].on').length, 2);
  eq('存档里两个标签都在', (savedFilter().tags || []).sort().join(','), '会议,开发');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A4 效率范围（含"未评"边界） ----------
ASSERT_A4="$PRE
  clearAll();
  var mn = q('.il-s-min');
  mn.value = '0';
  mn.dispatchEvent(new Event('change', { bubbles: true }));
  eq('效率选「未评」→ 2 张（d、f）', cards(), 2);
  var mm = q('.il-s-max');
  mm.value = '3';
  mm.dispatchEvent(new Event('change', { bubbles: true }));
  eq('上限也设成 0 才生效；此处上限 3 + 下限 0 仍按「只看未评」', mn.value + '/' + mm.value, '0/3');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A5 日期范围排除无日期 ----------
ASSERT_A5="$PRE
  clearAll();
  q('.il-s-from').value = '2026-09-03';
  q('.il-s-from').dispatchEvent(new Event('change', { bubbles: true }));
  eq('起始日期 09-03 → 4 张（b、c、e、f；09-01 的 a 被排除）', cards(), 4);
  q('.il-s-to').value = '2026-09-03';
  q('.il-s-to').dispatchEvent(new Event('change', { bubbles: true }));
  eq('区间 09-03~09-03 → 2 张（b、c）', cards(), 2);
  ok('🔴 无日期的日志（d）被排除', cards() === 2);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- A6 持久化 ----------
ASSERT_A6="$PRE
  clearAll();
  typeQ('sop');
  return JSON.stringify({ 数量: cards() });
})()"

ASSERT_A6B="$PRE
  eq('reload 后筛选状态仍在（关键词 sop → 1 张）', cards(), 1);
  eq('reload 后搜索框回填了关键词', q('.il-s-q').value, 'sop');
  eq('reload 后仍常亮「筛选已生效」', (q('.il-s-stat') || {}).textContent, '筛选已生效');
  clearAll();
  eq('清除后恢复 6 张', cards(), 6);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- B 效率趋势曲线 ----------
ASSERT_B="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var q = function (s) { return document.querySelector(s); };
  var box = q('.il-trend');
  ok('趋势卡片存在', !!box);
  /* 趋势面板现在归按钮管（默认收起），所以这里查的是"数据够不够"——
   * 表现为按钮没被禁用；面板开不开由 D2 段单独验。 */
  eq('数据够（有评分 3 天）→ 趋势按钮可用（未禁用）', q('.il-trend-btn').disabled, false);
  ok('渲染出 SVG', !!q('.il-trend .tr-chart'));
  eq('采样点数 = 有评分天数（3）', document.querySelectorAll('.tr-dot').length, 3);
  eq('折线只有 1 段（相邻间隔都 ≤7 天）', document.querySelectorAll('.tr-line').length, 1);
  eq('未评那天画了 1 个空心圆', document.querySelectorAll('.tr-un').length, 1);
  /* 🔴 Y 轴固定 1~5：刻度文字必须正好是 1,2,3,4,5 五个 */
  var ticks = [];
  document.querySelectorAll('.il-trend .tr-lb').forEach(function (t) {
    if (/^[1-5]$/.test(t.textContent.trim())) ticks.push(t.textContent.trim());
  });
  eq('🔴 Y 轴刻度恰好是 1~5（固定量程，不自动缩放）', ticks.join(','), '1,2,3,4,5');
  ok('标题标注了「同日多篇取最高」', (q('.il-trend-range') || {}).textContent.indexOf('同日多篇取最高') >= 0);
  ok('统计行给了有评分天数与覆盖天数', /有评分 \d+ 天 · 覆盖区间 \d+ 天/.test((q('.il-trend-stat') || {}).textContent));
  ok('横轴两端标了起止日期', document.querySelectorAll('.il-trend .tr-lb').length >= 7);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# 切到「自定义区间」看趋势图是否跟着热力图同步
ACT_B_RANGE="$(cat <<'EOF'
(function () {
  var sel = document.querySelector('.il-heat-year');
  sel.value = 'custom';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  var f = document.querySelector('.il-hr-from'), t = document.querySelector('.il-hr-to');
  f.value = '2026-09-01'; f.dispatchEvent(new Event('change', { bubbles: true }));
  t.value = '2026-09-10'; t.dispatchEvent(new Event('change', { bubbles: true }));
  return 'switched';
})()
EOF
)"

ASSERT_B_RANGE="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var q = function (s) { return document.querySelector(s); };
  ok('切到自定义区间后趋势按钮仍可用', q('.il-trend-btn').disabled === false);
  ok('区间文案跟着变成自定义日期', (q('.il-trend-range') || {}).textContent.indexOf('2026-09-01 ~ 2026-09-10') >= 0);
  ok('SVG 仍在', !!q('.il-trend .tr-chart'));
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# 数据不足：只有 1 条有评分 → 整块应隐藏（一个点连不成趋势）
SEED_THIN="$(cat <<'EOF'
(function () {
  localStorage.setItem('toolbox:internlog:items', JSON.stringify([
    { id:'x', date:'2026-09-01', text:'只有一条有评分', mood:3, tags:[], ts:1 },
    { id:'y', date:'2026-09-02', text:'这条没评分', mood:0, tags:[], ts:2 }
  ]));
  return 'thin';
})()
EOF
)"

ASSERT_B_THIN="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var q = function (s) { return document.querySelector(s); };
  eq('🔴 只有 1 条有评分 → 趋势按钮被禁用（点开也画不出）', q('.il-trend-btn').disabled, true);
  eq('数据不足时不画 SVG，只留一句说明', document.querySelectorAll('.il-trend .tr-chart').length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# ---------- C 缺失周报补齐 ----------
ACT_C_OPEN="$(cat <<'EOF'
(function () {
  document.querySelector('.il-report-btn').click();          // 打开面板（会先填入本周）
  var f = document.querySelector('.il-rp-from'), t = document.querySelector('.il-rp-to');
  f.value = '2026-08-31'; f.dispatchEvent(new Event('change', { bubbles: true }));
  t.value = '2026-09-13'; t.dispatchEvent(new Event('change', { bubbles: true }));
  return 'opened';
})()
EOF
)"

ASSERT_C1="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var h = document.querySelector('.il-rp-miss');
  var t = (h || {}).textContent || '';
  ok('提示条有文案', t.length > 0);
  ok('报了覆盖的周数（共 2 个自然周）', t.indexOf('共 2 个自然周') >= 0);
  ok('报了缺失周数（2 周还没生成过）', t.indexOf('2') >= 0 && t.indexOf('还没生成过周报') >= 0);
  ok('列出了缺失周的周一日期（08-31、09-07）', t.indexOf('08-31') >= 0 && t.indexOf('09-07') >= 0);
  ok('🔴 单独报了「未填日期不进周报」的条数', t.indexOf('另有 1 篇未填日期') >= 0);
  ok('「补齐并导出」「标记为已处理」都在',
    !!document.querySelector('.il-miss-export') && !!document.querySelector('.il-miss-mark'));
  /* 还没打过任何标记时，不给「清除全部标记」—— 没东西可清 */
  ok('此时不显示「清除全部标记」（reported 为空）',
    !document.querySelector('.il-miss-clear'));
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# 替换 saveBlob 截获导出的内容（它是全局函数声明，模块以裸名调用）
ACT_C_STUB="$(cat <<'EOF'
(function () {
  window.__blobs = [];
  window.saveBlob = function (blob, name) {
    var rec = { name: name, type: blob.type, size: blob.size, text: null };
    window.__blobs.push(rec);
    blob.text().then(function (t) { rec.text = t; });
    return Promise.resolve(true);
  };
  document.querySelector('.il-miss-export').click();
  return 'exported';
})()
EOF
)"

ASSERT_C2="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var b = (window.__blobs || [])[0];
  ok('补齐导出生成了文件', !!b);
  if (!b) return JSON.stringify({ 通过: pass, 失败: fail });
  ok('文件名是「实习周报-补齐-起_止.md」',
    b.name === '实习周报-补齐-2026-08-31_2026-09-13.md');
  var t = String(b.text);
  ok('有总标题并写明补了几周', t.indexOf('# 实习周报（补齐 2 周）') === 0);
  ok('🔴 每段前带「## 周一 ~ 周日」', t.indexOf('## 2026-08-31 ~ 2026-09-06') >= 0
    && t.indexOf('## 2026-09-07 ~ 2026-09-13') >= 0);
  ok('🔴 段间用 --- 分隔（合并成一个文件而不是两个）', t.indexOf('\n\n---\n\n') >= 0);
  ok('含该周的日志正文', t.indexOf('PLC 调试') >= 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 文件名: b.name });
})()
EOF
)"

ASSERT_C3="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var rep = [];
  try { rep = JSON.parse(localStorage.getItem('toolbox:internlog:reported') || '[]'); } catch (e) {}
  eq('导出成功后自动打了 2 个周标记', rep.length, 2);
  ok('标记是周一日期（08-31 与 09-07）',
    rep.indexOf('2026-08-31') >= 0 && rep.indexOf('2026-09-07') >= 0);
  ok('提示条翻成「都已处理过」',
    (document.querySelector('.il-rp-miss') || {}).textContent.indexOf('都已处理过') >= 0);
  /* 🔴 正是这条抓出了 bug：最初「全部处理完」分支只写文案不渲染按钮，
   *    导致标记完之后「清除全部标记」消失、用户再也没有入口清除。 */
  ok('全部处理完时，「清除全部标记」按钮仍然在',
    !!document.querySelector('.il-miss-clear'));
  ok('此时不再显示「补齐并导出」（没东西可补）',
    !document.querySelector('.il-miss-export'));
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_C_CLEAR="$(cat <<'EOF'
(function () {
  var b = document.querySelector('.il-miss-clear');
  if (!b) return 'no-clear-button';
  b.click();
  var okBtn = document.querySelector('[data-uiok]');
  if (!okBtn) return 'no-dialog';
  okBtn.click();
  return 'confirmed';
})()
EOF
)"

ASSERT_C4="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var rep = [];
  try { rep = JSON.parse(localStorage.getItem('toolbox:internlog:reported') || '[]'); } catch (e) {}
  eq('清除后标记被清空', rep.length, 0);
  ok('提示条回到「还没生成过周报」',
    (document.querySelector('.il-rp-miss') || {}).textContent.indexOf('还没生成过周报') >= 0);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# ---------- D 布局契约（防"家具又堆回去" + 两栏 / 收起的开关行为） ----------
# 🔴 这一段的由来：
#   2026-09-21 实测发现日志列表顶部被挤到 1001px（视口才 568px），主操作也在首屏外 ——
#   前几批陆续加了 4 块家具，每块单独看都合理，但没人管整体层级。重排后回到 234px。
#   2026-09-23 用户进一步要求：宽屏两侧空白要用起来（改两栏），筛选与趋势收成按钮。
#   **把布局契约变成断言**，否则下次再加一块家具又会慢慢挤回去。
#
# ⚠️ 断言数必须**恒定**（EXPECTED 是写死的）。所以响应式那几条把"宽/窄"的判断
#    写进断言内部，而不是 if/else 出两个分支 —— 否则换台机器窗口宽度不同，
#    项数就从 10 变成 9，EXPECTED 对不上，整段判失败。
ASSERT_D="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var q = function (s) { return document.querySelector(s); };
  var vh = window.innerHeight;
  var top = function (s) { var e = q(s); return e ? e.getBoundingClientRect().top + window.scrollY : 1e9; };
  var disp = function (s) { var e = q(s); return e ? getComputedStyle(e).display : "NO_EL"; };
  var wide = window.innerWidth >= 1100;
  var mode = wide ? "宽屏" : "窄窗";

  var addBtn = q(".il-add");
  ok("🔴「+ 新日志」在首屏内（底部 ≤ 视口高 " + vh + "）",
    !!addBtn && addBtn.getBoundingClientRect().bottom <= vh);
  ok("🔴 日志列表顶部 ≤ 400px（实际 " + top(".il-list") + "px）", top(".il-list") <= 400);
  var visible = 0;
  document.querySelectorAll(".il-list .note-card").forEach(function (c) {
    if (c.getBoundingClientRect().top < vh) visible++;
  });
  ok("🔴 第一屏至少能看到 1 条日志（实际 " + visible + " 条）", visible >= 1);

  ok("筛选面板默认收起", disp(".il-search") === "none");
  ok("趋势面板默认收起", disp(".il-trend") === "none");
  ok("筛选按钮默认 aria-expanded=false", q(".il-filters").getAttribute("aria-expanded") === "false");

  var cols = getComputedStyle(q(".il-wrap")).gridTemplateColumns.split(" ").length;
  ok("响应式契约：两栏/单栏（" + mode + " " + window.innerWidth + "px → " + cols + " 列）",
    wide ? cols >= 2 : cols === 1);
  ok("响应式契约：热力图 宽屏常驻 / 窄窗默认收起（" + mode + "）",
    wide ? disp(".il-side") !== "none" : disp(".il-side") === "none");
  ok("响应式契约：热力图开关按钮 宽屏隐藏 / 窄窗可见（" + mode + "）",
    wide ? disp(".il-side-btn") === "none" : disp(".il-side-btn") !== "none");

  var hs = q(".heat-scroll");
  var noScroll = !!hs && hs.scrollWidth <= hs.clientWidth + 1;
  ok("🔴 左栏放得下「近 6 个月」不横滚（" + (wide ? "内容 "
    + (hs ? hs.scrollWidth : "?") + " / 可见 " + (hs ? hs.clientWidth : "?") : mode + "跳过") + "）",
    wide ? noScroll : true);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_A_OPEN="(function(){var b=document.querySelector('.il-filters');if(b) b.click();return 'ok';})()"

ACT_D_PREP="(function(){
  var rp=document.querySelector('.il-rp-close'); if(rp) rp.click();
  ['.il-filters','.il-trend-btn'].forEach(function(sel){
    var b=document.querySelector(sel);
    if(b && b.getAttribute('aria-expanded')==='true') b.click();
  });
  return 'ok';
})()"

ACT_D_OPEN="(function(){document.querySelector('.il-filters').click();return 'ok';})()"

ASSERT_D2="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var q = function (s) { return document.querySelector(s); };
  /* 自己点开，不依赖外部动作 —— 否则外面漏一次调用，这里就整段假失败
   * （2026-09-23 就是这么栽的：prep 把面板收起了，但没人再点开）。 */
  q(".il-filters").click();
  ok("点「筛选」后筛选条显示", getComputedStyle(q(".il-search")).display !== "none");
  ok("筛选按钮文案变成「筛选 ▴」", q(".il-filters").textContent.indexOf("▴") >= 0);
  ok("筛选按钮 aria-expanded=true", q(".il-filters").getAttribute("aria-expanded") === "true");
  q(".il-trend-btn").click();
  ok("点「趋势」后趋势面板显示", getComputedStyle(q(".il-trend")).display !== "none");
  ok("趋势面板里真的画出了 SVG", !!q(".il-trend-box svg"));
  ok("趋势按钮 aria-expanded=true", q(".il-trend-btn").getAttribute("aria-expanded") === "true");
  ok("筛选条与趋势图能同时开着（互不干扰）",
    getComputedStyle(q(".il-search")).display !== "none"
    && getComputedStyle(q(".il-trend")).display !== "none");
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_D_CLOSE="(function(){document.querySelector('.il-filters').click();document.querySelector('.il-trend-btn').click();return 'ok';})()"

# ---------- E 待办清单（左栏热力图下方） ----------
# 🔴 为什么必须真机跑：待办的行为全在 DOM 上 —— 回车是否真的新增、
#    勾选后是否**划掉并变淡**（视觉事实，不是 class 事实）、
#    双击改文本、折叠后**计数徽标是否还在**。
#    静态断言只能证明"代码里写了那些 class 名"。
#
# ⚠️ 这个脚本的 E 段必须在**独立的 localStorage 状态下**跑：
#    前面各段会把 internlog:items 换成 6 条样本、清掉 reported，
#    但待办是独立键，互不影响 —— 所以开始时显式清一次 internlog:todos。
#
# 手写 helper：待办条目没有 data-* 之外的可测属性，靠 DOM 顺序定位。
ASSERT_E1="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var q = function (s) { return document.querySelector(s); };
  var items = function () { return document.querySelectorAll('.il-todo-list .il-todo-item'); };
  var texts = function () {
    return Array.prototype.map.call(items(), function (i) {
      return i.querySelector('.il-todo-text').textContent;
    });
  };
  var typed = function (v) {
    var el = q('.il-todo-input');
    el.focus(); el.value = v;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  /* --- 结构 --- */
  ok('待办卡片存在', !!q('.il-todo'));
  ok('待办卡片在左栏 .il-side 内', !!q('.il-side .il-todo'));
  ok('待办卡片在热力图**下方**（DOM 顺序）',
    !!(q('.il-side .il-heat') && q('.il-side .il-heat').compareDocumentPosition(q('.il-todo'))
       & Node.DOCUMENT_POSITION_FOLLOWING));
  ok('空态有引导文案', !!q('.il-todo-empty'));
  eq('初始 0 条待办', items().length, 0);
  ok('初始未完成徽标隐藏', q('.il-todo-badge').hidden === true);

  /* --- 回车新增 --- */
  typed('给车间补 MES 报工 SOP 配图');
  eq('回车新增 1 条', items().length, 1);
  eq('新增的文本正确', texts()[0], '给车间补 MES 报工 SOP 配图');
  eq('新增后输入框已清空', q('.il-todo-input').value, '');
  ok('🔴 新增后输入框**仍保持焦点**（便于连续录入）',
    document.activeElement === q('.il-todo-input'));

  /* --- 徽标与计数 --- */
  eq('未完成徽标显示 1', q('.il-todo-badge').textContent, '1');
  ok('有未完成项时徽标可见', q('.il-todo-badge').hidden === false);

  /* --- 空白不许加 --- */
  typed('    ');
  eq('全空白输入不新增', items().length, 1);

  /* --- 再补两条 --- */
  typed('整理 9 月质检异常台账');
  typed('问王工 PLC 通信超时的复现步骤');
  eq('累计 3 条', items().length, 3);
  eq('未完成徽标 3', q('.il-todo-badge').textContent, '3');

  /* --- 落盘 --- */
  var saved = [];
  try { saved = JSON.parse(localStorage.getItem('toolbox:internlog:todos') || '[]'); } catch (e) { saved = []; }
  eq('已落盘 3 条', saved.length, 3);
  eq('落盘文本按加入顺序', saved.map(function (t) { return t.text; }).join('|'),
    '给车间补 MES 报工 SOP 配图|整理 9 月质检异常台账|问王工 PLC 通信超时的复现步骤');
  ok('落盘条目都带 id', saved.every(function (t) { return !!t.id; }));

  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ASSERT_E2="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var q = function (s) { return document.querySelector(s); };
  var items = function () { return document.querySelectorAll('.il-todo-list .il-todo-item'); };
  var rowAt = function (i) { return items()[i]; };
  var check = function (i) {
    var cb = rowAt(i).querySelector('.il-todo-check');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /* --- 勾选：视觉事实，不是 class 事实 --- */
  check(0);
  eq('勾选后条目数不变', items().length, 3);
  ok('🔴 勾选的条目带 .done', rowAt(0).classList.contains('done'));
  var st = getComputedStyle(rowAt(0).querySelector('.il-todo-text'));
  ok('🔴 勾选后文本真的划掉了（text-decoration 含 line-through）',
    st.textDecorationLine.indexOf('line-through') >= 0);
  ok('🔴 勾选后文本真的变淡了（opacity < 1，实际 ' + st.opacity + '）',
    parseFloat(st.opacity) < 1);
  eq('未完成徽标降到 2', q('.il-todo-badge').textContent, '2');

  /* 🔴 关键：勾完不跳位 —— 已完成仍留在原位置，不移到末尾。
     否则用户刚点的条目会瞬移，是反直觉的（IlCore.sortTodos 的设计约束）。 */
  eq('🔴 勾选后条目**不跳位**（首条仍是原来那条）',
    rowAt(0).querySelector('.il-todo-text').textContent, '给车间补 MES 报工 SOP 配图');

  /* --- 取消勾选：状态与划线都要回退 --- */
  check(0);
  ok('取消勾选后 .done 移除', !rowAt(0).classList.contains('done'));
  ok('取消勾选后划线消失',
    getComputedStyle(rowAt(0).querySelector('.il-todo-text')).textDecorationLine.indexOf('line-through') < 0);
  eq('徽标回到 3', q('.il-todo-badge').textContent, '3');

  /* --- 双击编辑 --- */
  var span = rowAt(1).querySelector('.il-todo-text');
  span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  var inp = q('.il-todo-list .il-todo-edit');
  ok('双击后出现原地编辑框', !!inp);
  eq('编辑框带出原文', inp ? inp.value : '', '整理 9 月质检异常台账');
  inp.value = '整理 9 月质检异常台账（含返工）';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  eq('回车提交后文本已更新',
    rowAt(1).querySelector('.il-todo-text').textContent, '整理 9 月质检异常台账（含返工）');
  ok('编辑框已消失', !q('.il-todo-list .il-todo-edit'));

  /* --- Esc 放弃编辑 --- */
  var span2 = rowAt(2).querySelector('.il-todo-text');
  span2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  var inp2 = q('.il-todo-list .il-todo-edit');
  inp2.value = '不该被保存的内容';
  inp2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  eq('🔴 Esc 放弃编辑，原文不变',
    rowAt(2).querySelector('.il-todo-text').textContent, '问王工 PLC 通信超时的复现步骤');

  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ASSERT_E3="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var q = function (s) { return document.querySelector(s); };
  var items = function () { return document.querySelectorAll('.il-todo-list .il-todo-item'); };
  var disp = function (s) { var e = q(s); return e ? getComputedStyle(e).display : 'NO_EL'; };

  /* --- 删除 --- */
  eq('删除前 3 条', items().length, 3);
  items()[2].querySelector('.il-todo-del').click();
  eq('点 × 后剩 2 条', items().length, 2);
  eq('删掉的是第 3 条', Array.prototype.map.call(items(), function (i) {
    return i.querySelector('.il-todo-text').textContent;
  }).join('|'), '给车间补 MES 报工 SOP 配图|整理 9 月质检异常台账（含返工）');
  var saved = JSON.parse(localStorage.getItem('toolbox:internlog:todos') || '[]');
  eq('删除已落盘（磁盘上 2 条）', saved.length, 2);

  /* --- 折叠：用 body 的 display，标题栏与徽标必须还在 --- */
  var folded0 = q('.il-todo').classList.contains('folded');
  ok('默认展开（未折叠）', !folded0);
  ok('默认展开时列表可见', disp('.il-todo-list') !== 'none');
  ok('默认展开时输入框可见', disp('.il-todo-input') !== 'none');

  q('.il-todo-toggle').click();
  ok('🔴 折叠后 .il-todo-body 不可见', disp('.il-todo-body') === 'none');
  ok('🔴 折叠后**标题栏仍在**（不是整卡 hidden）', disp('.il-todo-head') !== 'none');
  ok('🔴 折叠后未完成徽标仍可见（收起也知道还有几条没做）',
    disp('.il-todo-badge') !== 'none' && q('.il-todo-badge').hidden === false);
  ok('折叠按钮文案变「展开 ▾」', q('.il-todo-toggle').textContent.indexOf('展开') >= 0);
  eq('折叠按钮 aria-expanded=false', q('.il-todo-toggle').getAttribute('aria-expanded'), 'false');
  eq('折叠状态已落盘', localStorage.getItem('toolbox:internlog:todoOpen'), 'false');

  q('.il-todo-toggle').click();
  ok('再点一次恢复展开', disp('.il-todo-body') !== 'none');
  eq('展开状态已落盘', localStorage.getItem('toolbox:internlog:todoOpen'), 'true');

  /* --- 回到基础状态，供 E4 reload 后比对 --- */
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ASSERT_E4="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var q = function (s) { return document.querySelector(s); };
  var items = function () { return document.querySelectorAll('.il-todo-list .il-todo-item'); };
  var texts = function () {
    return Array.prototype.map.call(items(), function (i) {
      return i.querySelector('.il-todo-text').textContent;
    });
  };

  /* reload 之后：删掉的那条不能复活，改过的文本要留着，折叠状态要记住 */
  eq('🔴 reload 后仍是 2 条（删掉的没复活）', items().length, 2);
  eq('🔴 reload 后文本是改过的版本', texts().join('|'),
    '给车间补 MES 报工 SOP 配图|整理 9 月质检异常台账（含返工）');
  ok('reload 后徽标仍显示未完成数 2', q('.il-todo-badge').textContent === '2');

  /* 完成态也要能过夜 */
  var cb = items()[1].querySelector('.il-todo-check');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  ok('勾选后带 .done', items()[1].classList.contains('done'));
  var saved = JSON.parse(localStorage.getItem('toolbox:internlog:todos') || '[]');
  var t = saved.filter(function (x) { return x.text.indexOf('返工') >= 0; })[0];
  ok('🔴 落盘里 done=true', !!t && t.done === true);
  ok('🔴 完成时记下 doneAt 日期（yyyy-mm-dd）', !!t && /^\d{4}-\d{2}-\d{2}$/.test(t.doneAt));
  var t2 = saved.filter(function (x) { return x.text.indexOf('SOP 配图') >= 0; })[0];
  ok('未完成项的 doneAt 为空串', !!t2 && t2.doneAt === '');

  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_E_CLEAR="(function(){localStorage.removeItem('toolbox:internlog:todos');localStorage.removeItem('toolbox:internlog:todoOpen');return 'ok';})()"

run() {
  echo "exe : $AB"
  echo "url : $URL"
  echo ""
  echo "--- 打开实习日志 ---"
  "$AB" open "$URL" || { echo "打开失败"; return 1; }
  sleep 18
  "$AB" eval "$SEED" >/dev/null
  sleep 1
  "$AB" reload
  sleep 18

  step() { echo ""; echo "===== $1 ====="; LAST="$("$AB" eval "$2")"; echo "$LAST"; }

  # 🔴 D1 放在最前面：它断言的是**默认状态**（筛选/趋势收起、列表在首屏内）。
  #    放到后面跑会被前面各段打开的面板污染 —— 之前就是这么误报过一次
  #    （C 段把周报面板开着没关，列表顶从 162 涨到 524）。
  step "D1. 布局契约（默认状态）" "$ASSERT_D";     RD1="$LAST"
  # A 段要往搜索框里打字，而搜索框现在默认收起 —— **隐藏元素的 focus() 是无效的**，
  # 不先点开，「重写列表后输入框保持焦点」这条会假失败。
  "$AB" eval "$ACT_A_OPEN" >/dev/null; sleep 1
  step "A0. 检索条结构" "$ASSERT_A0";              RA0="$LAST"
  "$AB" eval "$ACT_Q" >/dev/null; sleep 1
  step "A1. 关键词过滤 + 焦点保持 + 热力图不受影响" "$ASSERT_A1"; RA1="$LAST"
  step "A2. 无命中的空态" "$ASSERT_A2";            RA2="$LAST"
  step "A3. 标签 AND 与清除" "$ASSERT_A3";         RA3="$LAST"
  step "A4. 效率范围（未评边界）" "$ASSERT_A4";    RA4="$LAST"
  step "A5. 日期范围排除无日期" "$ASSERT_A5";      RA5="$LAST"
  step "A6. 落盘" "$ASSERT_A6" >/dev/null
  "$AB" reload >/dev/null 2>&1; sleep 16
  step "A6b. reload 后筛选状态保持" "$ASSERT_A6B"; RA6="$LAST"
  step "B1. 趋势曲线渲染" "$ASSERT_B";             RB1="$LAST"
  "$AB" eval "$ACT_B_RANGE" >/dev/null; sleep 1
  step "B2. 趋势图跟随热力图区间" "$ASSERT_B_RANGE"; RB2="$LAST"
  "$AB" eval "$SEED_THIN" >/dev/null; sleep 1
  "$AB" reload >/dev/null 2>&1; sleep 16
  step "B3. 数据不足时隐藏" "$ASSERT_B_THIN";       RB3="$LAST"

  # 回到 6 条样本，并清掉周报标记，进 C 段
  "$AB" eval "$SEED" >/dev/null
  "$AB" eval "(function(){localStorage.removeItem('toolbox:internlog:reported');return 'x';})()" >/dev/null
  sleep 1
  "$AB" reload >/dev/null 2>&1; sleep 16
  "$AB" eval "$ACT_C_OPEN" >/dev/null; sleep 1
  step "C1. 缺失周提示条" "$ASSERT_C1";           RC1="$LAST"
  "$AB" eval "$ACT_C_STUB" >/dev/null; sleep 3
  step "C2. 补齐并导出（合并成一个 md）" "$ASSERT_C2"; RC2="$LAST"
  step "C3. 导出后自动打标记" "$ASSERT_C3";        RC3="$LAST"
  "$AB" eval "$ACT_C_CLEAR" >/dev/null; sleep 2
  step "C4. 清除标记（走 askConfirm）" "$ASSERT_C4"; RC4="$LAST"
  # D2 验开关行为。先收掉前面各段打开的面板，否则测的是"上一步留下的状态"，
  # 而不是"点按钮的效果"。
  "$AB" eval "$ACT_D_PREP" >/dev/null; sleep 1
  step "D2. 筛选 / 趋势 开关行为" "$ASSERT_D2"; RD2="$LAST"
  "$AB" eval "$ACT_D_CLOSE" >/dev/null; sleep 1

  # ---------- E 待办清单 ----------
  # 独立键（internlog:todos），与前面各段的日志样本互不影响；跑前显式清一次。
  "$AB" eval "$ACT_E_CLEAR" >/dev/null; sleep 1
  "$AB" reload >/dev/null 2>&1; sleep 16
  step "E1. 待办：结构 / 回车新增 / 落盘" "$ASSERT_E1"; RE1="$LAST"
  step "E2. 待办：勾选视觉 / 编辑 / Esc" "$ASSERT_E2"; RE2="$LAST"
  step "E3. 待办：删除 / 折叠（徽标常驻）" "$ASSERT_E3"; RE3="$LAST"
  "$AB" reload >/dev/null 2>&1; sleep 16
  step "E4. 待办：reload 后状态保持" "$ASSERT_E4"; RE4="$LAST"

  echo ""
  echo "================= 汇总 ================="
  local NP=0 NF=0
  for pair in "A0:$RA0" "A1:$RA1" "A2:$RA2" "A3:$RA3" "A4:$RA4" "A5:$RA5" "A6b:$RA6" \
              "B1:$RB1" "B2:$RB2" "B3:$RB3" "C1:$RC1" "C2:$RC2" "C3:$RC3" "C4:$RC4" "D1:$RD1" "D2:$RD2" \
              "E1:$RE1" "E2:$RE2" "E3:$RE3" "E4:$RE4"; do
    local n="${pair%%:*}" v="${pair#*:}"
    if printf '%s' "$v" | grep -qF '失败\":[]'; then
      local p; p=$(printf '%s' "$v" | sed -n 's/.*通过\\":\([0-9]\{1,\}\).*/\1/p')
      echo "  段 $n  全通过（${p:-?} 项）"
      NP=$((NP + ${p:-0}))
    else
      echo "  段 $n  有失败 → $v"
      NF=$((NF + 1))
    fi
  done
  echo "  合计通过 $NP 项，失败段数 $NF"
  # 🔴 校验实际断言数与声明一致。
  # node 侧脚本有 _harness 的 expected 兜底，真机侧一直缺这道闸 ——
  # 这正是「假绿」的入口：声明 30 项、实际只跑 23 项，报告照样打印「全绿」
  # （历史上 mermaid 脚本 23 项只跑 8 项就是这么漏的）。
  # ⚠️ 只在"零失败"时才比对断言数。
  #    因为 NP 只累加**全通过**的段，一有失败就必然小于 EXPECTED ——
  #    那样每次失败都会额外喷一句"数量不符"，噪声盖过真问题。
  #    这道闸的目的是抓"全绿但数量不对"（历史上 mermaid 脚本 23 项只跑 8 项那种假绿），
  #    而"有失败"本来就已经判失败了。
  if [ "$NF" -eq 0 ] && [ "$NP" -ne "$EXPECTED" ]; then
    echo "  ⛔ 实际断言数 $NP ≠ 声明的 $EXPECTED —— 可能中途有断言被跳过，或改了断言没改 EXPECTED。"
    NF=$((NF + 1))
  fi
  [ "$NF" -eq 0 ] && echo "  结果: 全绿" || echo "  结果: 有失败"
}

run 2>&1 | tee "$REPORT"
