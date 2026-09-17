#!/bin/bash
# draw.io 跳转功能验证（真机浏览器）
#
# ⚠️ 这个脚本只能验证**前端契约**（卡片在不在、按钮通不通、提示对不对、路径存不存）。
#    真正的「启动 draw.io 进程」必须装好插件重编后在桌面端验 —— 浏览器里
#    window.__TAURI__ 不存在，走的必然是不支持分支。**不要把这脚本全绿当成功能已验完。**
#
# 覆盖 13 项断言
# 用法: bash tools/verify-drawio-jump.sh
# 报告: .workbuddy/_drawio.txt
set -u

export PATH="/c/Users/DELL/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_drawio.txt"
PORT=8905
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1

PY="/c/Users/DELL/.workbuddy/binaries/python/versions/3.13.12/python.exe"
AB=""
for c in /c/Users/DELL/.workbuddy/binaries/node/versions/*/node_modules/agent-browser/bin/agent-browser-win32-x64.exe; do
  [ -f "$c" ] && AB="$c"
done
[ -z "$AB" ] && { echo "找不到 agent-browser exe" >&2; exit 2; }

( cd "$PROJ/web" && "$PY" -m http.server "$PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
SRV=$!
trap '"$AB" close --all >/dev/null 2>&1; kill $SRV 2>/dev/null' EXIT
sleep 2

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
[ "$CODE" != "200" ] && { echo "静态服务不可用（HTTP $CODE）" >&2; exit 3; }

BASE="http://127.0.0.1:$PORT/index.html"

ASSERT_HOME="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var cards = document.querySelectorAll('.grid .card');
  eq('首页卡片数 = 5', cards.length, 5);
  eq('存在 draw.io 卡片', !!document.querySelector('.card[data-id="drawio"]'), true);
  eq('卡片名显示 draw.io', document.querySelector('.card[data-id="drawio"] .card-name').textContent, 'draw.io');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ASSERT_PANEL="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function has(l, hay, n) { if (String(hay).indexOf(n) >= 0) pass++; else fail.push(l + ' 应含[' + n + '] 实际[' + hay + ']'); }
  eq('有路径输入框', !!document.querySelector('.dr-path'), true);
  eq('有「打开 draw.io」按钮', !!document.querySelector('.dr-open'), true);
  eq('有「自动检测路径」按钮', !!document.querySelector('.dr-detect'), true);
  eq('有「保存路径」按钮', !!document.querySelector('.dr-save'), true);
  // 说明里必须讲清为什么不内嵌 —— 否则将来自己都会忘了这个决定
  has('说明含「无法 iframe」', document.body.textContent, '无法 iframe');
  eq('初始状态提示未设路径', document.querySelector('.dr-stat').textContent.indexOf('还没设置路径') >= 0, true);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# 存路径 → 重新打开页面 → 看是否读回（证明真的落盘了，不是只改了 DOM）
ACT_SAVE="$(cat <<'EOF'
(function () {
  var i = document.querySelector('.dr-path');
  i.value = 'D:\\draw.io\\draw.io.exe';
  document.querySelector('.dr-save').click();
  return 'saved';
})()
EOF
)"

ASSERT_PERSIST="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var raw = localStorage.getItem('toolbox:drawio:path');
  eq('存档里写入了路径', !!raw, true);
  // 必须 JSON.parse 再比：localStorage 里存的是 JSON 文本，
  // 反斜杠是转义过的，直接跟 JS 字面量比会多算一层
  var val = '';
  try { val = JSON.parse(raw); } catch (e) {}
  eq('存档内容正确（解析后）', val, 'D:\\draw.io\\draw.io.exe');
  eq('输入框已回填', document.querySelector('.dr-path').value, 'D:\\draw.io\\draw.io.exe');
  eq('状态栏显示当前路径', document.querySelector('.dr-stat').textContent.indexOf('D:\\draw.io\\draw.io.exe') >= 0, true);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_OPEN="(function(){document.querySelector('.dr-open').click();return 'clicked';})()"

ASSERT_TOAST_DESKTOP="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function has(l, hay, n) { if (String(hay).indexOf(n) >= 0) pass++; else fail.push(l + ' 应含[' + n + '] 实际[' + hay + ']'); }
  var t = document.getElementById('toast');
  var txt = t ? t.textContent : '';
  // 浏览器里没有 __TAURI__，必须给出明确提示而不是静默失败
  has('提示「只有桌面端」', txt, '只有桌面端');
  return JSON.stringify({ 通过: pass, 失败: fail, toast: txt });
})()
EOF
)"

# 画板：导出菜单里的入口 + 点击后的提示
ASSERT_MENU="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var b = document.querySelector('[data-exp="drawio"]');
  eq('导出菜单里有「用 draw.io 编辑」', !!b, true);
  eq('按钮文案正确', b ? b.textContent.trim() : '', '用 draw.io 编辑');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_MENU="(function(){var b=document.querySelector('[data-exp=\"drawio\"]');b.click();return 'clicked';})()"

run() {
  echo "exe : $AB"
  echo ""
  echo "--- 1. 首页 ---"
  "$AB" open "$BASE#home" || { echo "打开失败"; return 1; }
  sleep 18
  # 清掉上一次可能留下的路径，从干净状态开始
  "$AB" eval "(function(){localStorage.removeItem('toolbox:drawio:path');return 'cleared';})()" >/dev/null
  "$AB" eval "(function(){localStorage.setItem('toolbox:sketch:shapes',JSON.stringify([{id:'r1',type:'rect',x:0,y:0,w:160,h:80,color:'#1f2328',size:3,text:'测试'}]));return 'seeded';})()" >/dev/null
  sleep 1
  "$AB" reload
  sleep 18
  RA="$("$AB" eval "$ASSERT_HOME")"
  echo "$RA"

  echo ""
  echo "--- 2. draw.io 工具面板 ---"
  "$AB" open "$BASE#tool/drawio" >/dev/null 2>&1
  sleep 14
  RB="$("$AB" eval "$ASSERT_PANEL")"
  echo "$RB"

  echo ""
  echo "--- 3. 保存路径并重载验证持久化 ---"
  "$AB" eval "$ACT_SAVE" >/dev/null
  sleep 3
  "$AB" reload
  sleep 14
  RC="$("$AB" eval "$ASSERT_PERSIST")"
  echo "$RC"

  echo ""
  echo "--- 4. 浏览器环境下点「打开 draw.io」的提示 ---"
  "$AB" eval "$ACT_OPEN" >/dev/null
  sleep 2
  RD="$("$AB" eval "$ASSERT_TOAST_DESKTOP")"
  echo "$RD"

  echo ""
  echo "--- 5. 画板导出菜单入口 ---"
  "$AB" open "$BASE#tool/sketch" >/dev/null 2>&1
  sleep 14
  RE="$("$AB" eval "$ASSERT_MENU")"
  echo "$RE"

  echo ""
  echo "--- 6. 点「用 draw.io 编辑」（浏览器环境） ---"
  "$AB" eval "$ACT_MENU" >/dev/null
  sleep 2
  RF="$("$AB" eval "$ASSERT_TOAST_DESKTOP")"
  echo "$RF"

  echo ""
  echo "================= 汇总 ================="
  NP=0; NF=0
  for pair in "1:$RA" "2:$RB" "3:$RC" "4:$RD" "5:$RE" "6:$RF"; do
    n="${pair%%:*}"; v="${pair#*:}"
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
  [ "$NF" -eq 0 ] && echo "  结果: 全绿（仅前端契约；进程启动需桌面端验证）" || echo "  结果: 有失败"
}

run 2>&1 | tee "$REPORT"
