#!/bin/bash
# 实习日志「贡献度热力图」真机验证（浏览器实跑，非静态断言）
#
# 为什么不用 vm 抽源码那套：热力图行为完全依赖 DOM 渲染与事件触发
# （下拉 change、日期框 change、reload 后从存档回填），
# 静态断言只能查"源码里有没有这行字"，查不出"点下去到底画成什么样"。
#
# 覆盖 30 项断言，分三段：
#   A 默认近 6 个月：色阶由 mood（效率）驱动 / 多篇取最大 / mn / m0 / 统计口径
#   B 自定义区间：按周对齐 / 区间外为 lo / 统计只算精确区间 / 存档持久化
#   C 清空区间：退回近 6 个月且存档被纠正
#
# 用法: bash tools/verify-internlog-heat.sh
# 报告: .workbuddy/_heat.txt
set -u

# PATH 必须在最前面修好：本机 Git Bash 缺 coreutils，后面的 dirname/curl 都要用
export PATH="$HOME/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_heat.txt"
PORT=8901
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1

PY="$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe"

# agent-browser 的 exe 位置随 node 版本目录变化，动态找
AB=""
for c in $HOME/.workbuddy/binaries/node/versions/*/node_modules/agent-browser/bin/agent-browser-win32-x64.exe; do
  [ -f "$c" ] && AB="$c"
done
if [ -z "$AB" ]; then
  echo "找不到 agent-browser win32-x64 exe，请先 npm install -g agent-browser" >&2
  exit 2
fi

# 静态服务必须指向 web/ —— 前端源码在这个子目录里。
# 🔴 踩过的坑：从项目根起服务 → /index.html 返回 404 → 浏览器显示 "Error response"
#    → 后面所有断言都拿不到元素，报一堆"MISSING"，看着像功能坏了，其实是服务指错了。
( cd "$PROJ/web" && "$PY" -m http.server "$PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
SRV=$!
trap '"$AB" close --all >/dev/null 2>&1; kill $SRV 2>/dev/null' EXIT
sleep 2

URL="http://127.0.0.1:$PORT/index.html#tool/internlog"
AB_E="$(printf '%s' "$AB")"

# 先确认页面真能 200，否则后面全是假失败
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
if [ "$CODE" != "200" ]; then
  echo "静态服务不可用（HTTP $CODE）—— 检查 $PROJ/web 是否存在、端口 $PORT 是否被占" >&2
  exit 3
fi

# ---------- 测试数据：故意构造能区分「按效率」与「按条数」的样本 ----------
# 0902 有 3 篇但效率只有 1 —— 若色阶改回按条数，它会变成最深的 m3/m4，测试就会失败
SEED="$(cat <<'EOF'
(function () {
  function mk(id, date, mood) { return { id: id, date: date, text: 't-' + id, ts: Date.now(), mood: mood }; }
  var items = [
    mk('a8', '2026-08-31', 5),
    mk('a1', '2026-09-01', 5),
    mk('a2', '2026-09-02', 1), mk('a3', '2026-09-02', 1), mk('a4', '2026-09-02', 1),
    mk('a5', '2026-09-03', 0),
    mk('a6', '2026-09-04', 2), mk('a7', '2026-09-04', 5)
  ];
  localStorage.setItem('toolbox:internlog:items', JSON.stringify(items));
  localStorage.removeItem('toolbox:internlog:heat');
  return 'seeded=' + items.length;
})()
EOF
)"

HEAD="$(cat <<'EOF'
(function () {
  var cells = document.querySelectorAll('.heat-grid i'), byDate = {};
  for (var i = 0; i < cells.length; i++) {
    var t = cells[i].getAttribute('title') || '';
    byDate[t.slice(0, 10)] = { cls: cells[i].className, tip: t };
  }
  var pass = 0, fail = [];
  function eq(l, got, want) { if (got === want) pass++; else fail.push(l + ' 期望[' + want + '] 实际[' + got + ']'); }
  function has(l, hay, needle) { if (String(hay).indexOf(needle) >= 0) pass++; else fail.push(l + ' 应含[' + needle + '] 实际[' + hay + ']'); }
  function cls(d) { return byDate[d] ? byDate[d].cls : 'MISSING'; }
  var stat = (document.querySelector('.il-heat-stat') || {}).textContent || '';
  var range = document.querySelector('.il-heat-range');
  var sel = document.querySelector('.il-heat-year');
  var saved = localStorage.getItem('toolbox:internlog:heat') || '';
  /* 🔴 必须查**计算样式**，不能查 .hidden 属性。
   * 属性只是"意图"，作者样式里的 display 会把它盖掉 ——
   * 2026-09-16 就是这么漏掉一个真 bug：.il-heat-range 设了 hidden=true 却被
   * 自己的 display:flex 覆盖，"只在自定义时显示"变成了"一直显示"，
   * 而断言查 range.hidden 得到 true，给了个假通过。 */
  function disp(el) { return el ? getComputedStyle(el).display : 'NO_EL'; }
EOF
)"

ASSERT_A="$HEAD
  eq('0901 效率5 → m5', cls('2026-09-01'), 'm5');
  eq('0902 三篇但效率1 → m1（按效率不按条数）', cls('2026-09-02'), 'm1');
  eq('0903 写了未评效率 → mn', cls('2026-09-03'), 'mn');
  eq('0904 mood2+mood5 → m5（取最大）', cls('2026-09-04'), 'm5');
  eq('0905 无日志 → m0', cls('2026-09-05'), 'm0');
  eq('0831 效率5 → m5', cls('2026-08-31'), 'm5');
  eq('tooltip 含篇数与效率', byDate['2026-09-02'] ? byDate['2026-09-02'].tip : '', '2026-09-02 · 3 篇 · 效率 1');
  has('统计含 已写 8 篇', stat, '已写 8 篇');
  has('统计含 平均效率 2.9', stat, '平均效率 2.9');
  has('统计含 未评篇数', stat, '1 篇未评');
  eq('区间框 computed display=none（真不可见）', disp(range), 'none');
  eq('下拉为 6m', sel ? sel.value : 'NO_EL', '6m');
  return JSON.stringify({ 通过: pass, 失败: fail, 统计行: stat });
})()"

ASSERT_B="$HEAD
  eq('按周对齐后格子数 = 7', cells.length, 7);
  eq('区间前 0831 → lo', cls('2026-08-31'), 'lo');
  eq('区间后 0906 → lo', cls('2026-09-06'), 'lo');
  eq('区间内 0901 → m5', cls('2026-09-01'), 'm5');
  eq('区间内 0902 → m1', cls('2026-09-02'), 'm1');
  eq('区间内 0903 → mn', cls('2026-09-03'), 'mn');
  eq('区间内 0904 → m5', cls('2026-09-04'), 'm5');
  eq('区间内 0905 → m0', cls('2026-09-05'), 'm0');
  has('统计标签为用户选的精确区间', stat, '2026-09-01 ~ 2026-09-05');
  eq('统计只算区间内（7 篇，不含 0831）', stat.indexOf('已写 7 篇') >= 0, true);
  has('统计含 平均效率 2.5', stat, '平均效率 2.5');
  eq('区间框 computed display≠none（真可见）', disp(range) !== 'none', true);
  has('存档记录 custom', saved, '\"mode\":\"custom\"');
  return JSON.stringify({ 通过: pass, 失败: fail, 统计行: stat });
})()"

ASSERT_C="$HEAD
  eq('清空区间后格子数回到 182（近 6 个月）', cells.length, 182);
  eq('区间框 computed display=none（真不可见）', disp(range), 'none');
  eq('下拉回到 6m', sel ? sel.value : 'NO_EL', '6m');
  eq('存档里的模式被纠正为 6m', saved.indexOf('\"mode\":\"6m\"') >= 0, true);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

ACT_CUSTOM="(function(){var s=document.querySelector('.il-heat-year');s.value='custom';s.dispatchEvent(new Event('change'));return 'ok';})()"
ACT_RANGE="(function(){var f=document.querySelector('.il-hr-from'),t=document.querySelector('.il-hr-to');f.value='2026-09-01';t.value='2026-09-05';t.dispatchEvent(new Event('change'));return 'ok';})()"
ACT_CLEAR="(function(){var f=document.querySelector('.il-hr-from'),t=document.querySelector('.il-hr-to');f.value='';t.value='';t.dispatchEvent(new Event('change'));return 'ok';})()"

run() {
  echo "exe : $AB_E"
  echo "url : $URL"
  echo ""
  echo "--- 打开页面（首次冷启动较慢，约 20s） ---"
  "$AB_E" open "$URL" || { echo "打开失败"; return 1; }
  sleep 18
  echo "--- 注入测试数据（8 条，含 1 条区间外） ---"
  "$AB_E" eval "$SEED"
  sleep 3
  echo "--- reload（验证真的从存档读回来） ---"
  "$AB_E" reload
  sleep 18

  echo ""
  echo "===== A. 默认近 6 个月：色阶是否由效率驱动 ====="
  RA="$("$AB_E" eval "$ASSERT_A")"
  echo "$RA"

  echo ""
  echo "===== B. 自定义区间 2026-09-01 ~ 2026-09-05 ====="
  "$AB_E" eval "$ACT_CUSTOM" >/dev/null; sleep 2
  "$AB_E" eval "$ACT_RANGE"  >/dev/null; sleep 2
  RB="$("$AB_E" eval "$ASSERT_B")"
  echo "$RB"

  echo ""
  echo "===== C. 清空区间 → 退回近 6 个月 ====="
  "$AB_E" eval "$ACT_CLEAR" >/dev/null; sleep 2
  RC="$("$AB_E" eval "$ASSERT_C")"
  echo "$RC"

  echo ""
  echo "================= 汇总 ================="
  NP=0; NF=0
  for pair in "A:$RA" "B:$RB" "C:$RC"; do
    n="${pair%%:*}"; v="${pair#*:}"
    # 🔴 注意：agent-browser 返回的 JSON 外层带引号且内部被转义，
    #    正文里是 `失败\":[]`（反斜杠+引号），不是 `失败":[]`。
    #    用 -F 固定串匹配，别用正则 —— `[]` 在 BRE 里是空字符集，永远匹配不上。
    if printf '%s' "$v" | grep -qF '失败\":[]'; then
      p=$(printf '%s' "$v" | sed -n 's/.*通过\\":\([0-9]\{1,\}\).*/\1/p')
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
