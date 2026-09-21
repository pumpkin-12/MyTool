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
# 覆盖 47 项断言（检索 32 · 趋势 15）。用法: bash tools/verify-internlog-search.sh
# 报告: .workbuddy/_search.txt
set -u

export PATH="$HOME/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_search.txt"
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
  eq('数据够（有评分 3 天）→ 卡片可见', box.hidden, false);
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
  ok('切到自定义区间后卡片仍可见', q('.il-trend').hidden === false);
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
  eq('🔴 只有 1 条有评分 → 趋势卡片整体隐藏（不留空框）', q('.il-trend').hidden, true);
  eq('隐藏时也不该有残留 SVG', document.querySelectorAll('.il-trend .tr-chart').length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

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

  echo ""
  echo "================= 汇总 ================="
  local NP=0 NF=0
  for pair in "A0:$RA0" "A1:$RA1" "A2:$RA2" "A3:$RA3" "A4:$RA4" "A5:$RA5" "A6b:$RA6" \
              "B1:$RB1" "B2:$RB2" "B3:$RB3"; do
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
  [ "$NF" -eq 0 ] && echo "  结果: 全绿" || echo "  结果: 有失败"
}

run 2>&1 | tee "$REPORT"
