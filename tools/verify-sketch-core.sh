#!/bin/bash
# 画板（sketch）专项测试 —— 真机浏览器
#
# 为什么用浏览器实跑：画板的行为全在 canvas 渲染 + pointer 事件里，
# 静态断言查不出「拖一下到底发生了没有」。这里靠**合成 PointerEvent** 真正驱动它，
# 并用 canvas 像素采样验证「确实画出东西了」——不是只看数据模型。
#
# 覆盖 23 项断言。用法: bash tools/verify-sketch-core.sh
# 报告: .workbuddy/_sketch.txt
#
# 🔴 两个必须遵守的测试纪律（都是踩过才知道的）：
#   1) **「操作」和「读取」要拆成两次 eval，中间留 ≥1.2s** ——
#      画板的存档有 400ms 防抖、视图刷新走 rAF 节流，同一次 eval 里点完立刻读只能拿到旧值。
#   2) **撤销/重做要紧跟在「会改图形数」的操作之后测** ——
#      缩放这类操作也会进撤销栈但不改数量，栈顶错位会让断言"碰巧通过"。
set -u

export PATH="/c/Users/DELL/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_sketch.txt"
PORT=8907
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

URL="http://127.0.0.1:$PORT/index.html#tool/sketch"

# 每段断言都带这段公共前置：合成 pointer 事件 + 读存档 + canvas 像素采样
# 🔴 必须以 (function () { 开头 —— 各段断言结尾是 return + })()，
#    少了这个开头，return 会落在顶层 → 整段报 Illegal return statement。
PRE="$(cat <<'EOF'
(function () {
  var Q = function(s){ return document.querySelector(s); };
  var CV = Q('.wb-canvas');
  var R = CV.getBoundingClientRect();
  function ptr(type, wx, wy, extra) {
    // wx/wy 是**世界坐标**，这里换算成 client 坐标（view 默认 {24,24,1}，从存档读）
    var v = {}; try { v = JSON.parse(localStorage.getItem('toolbox:sketch:view')) || {}; } catch(e) {}
    var k = v.k || 1, vx = v.x == null ? 24 : v.x, vy = v.y == null ? 24 : v.y;
    var sx = wx * k + vx, sy = wy * k + vy;
    var ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: R.left + sx, clientY: R.top + sy
    });
    Object.keys(extra || {}).forEach(function(k2){ ev[k2] = extra[k2]; });
    CV.dispatchEvent(ev);
  }
  function shapes() { try { return JSON.parse(localStorage.getItem('toolbox:sketch:shapes') || '[]'); } catch(e) { return []; } }
  function key(k, mod) {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign(
      { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true }, mod || {})));
  }
  // canvas 上非背景像素数（抽样，步长 4 像素）—— 用来证明"真的画出来了"
  function ink() {
    var ctx = CV.getContext('2d');
    var d = ctx.getImageData(0, 0, CV.width, CV.height).data;
    var n = 0;
    for (var i = 0; i < d.length; i += 16) {
      if (d[i + 3] > 20 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) n++;
    }
    return n;
  }
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  function ge(l, g, w) { if (g >= w) pass++; else fail.push(l + ' 期望≥[' + w + '] 实际[' + g + ']'); }
EOF
)"

# ---------- A. 挂载与静态结构 ----------
ASSERT_A="$PRE
  ok('canvas 有尺寸', CV.getBoundingClientRect().width > 100 && CV.getBoundingClientRect().height > 100);
  eq('工具按钮 9 个', document.querySelectorAll('.wb-tbtn[data-tool]').length, 9);
  var mini = Q('.wb-mini canvas');
  ok('迷你地图 canvas 有尺寸', mini && mini.width > 10 && mini.height > 10);
  var ed = Q('.wb-editor');
  eq('文字编辑器默认不可见', ed ? getComputedStyle(ed).display : 'NO_EL', 'none');
  eq('导出菜单 5 项', document.querySelectorAll('.wb-exp button').length, 5);
  eq('右键菜单 5 项', document.querySelectorAll('.wb-ctx:not(.wb-exp) button').length, 5);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- B. 渲染确实发生（种子图形） ----------
ASSERT_B="$PRE
  var n = shapes().length;
  eq('存档里读到 2 个种子图形', n, 2);
  var inked = ink();
  ge('canvas 上有非背景像素（证明画出来了）', inked, 20);
  return JSON.stringify({ 通过: pass, 失败: fail, 非背景像素: inked });
})()"

# ---------- C. 用矩形工具拖拽新建 ----------
ACT_DRAW="$PRE
  Q('.wb-tbtn[data-tool=\"rect\"]').click();
  var before = shapes().length;
  ptr('pointerdown', 120, 300);
  ptr('pointermove', 260, 400);
  ptr('pointerup', 260, 400);
  return JSON.stringify({ 之前: before, 工具按钮已激活: Q('.wb-tbtn[data-tool=\"rect\"]').classList.contains('on') });
})()"

ASSERT_C="$PRE
  var a = shapes();
  eq('图形数 +1', a.length, 3);
  var last = a[a.length - 1];
  eq('新图形类型是 rect', last ? last.type : '(无)', 'rect');
  ok('新图形尺寸与拖拽距离相符', last && Math.abs(Math.abs(last.w) - 140) < 6 && Math.abs(Math.abs(last.h) - 100) < 6);
  return JSON.stringify({ 通过: pass, 失败: fail, 新图形: last });
})()"

# ---------- D. 选择并拖动 ----------
ACT_DRAG="$PRE
  Q('.wb-tbtn[data-tool=\"select\"]').click();
  ptr('pointerdown', 160, 140);      // 点在种子矩形 r1 (100,100,120x80) 内部
  ptr('pointermove', 210, 190);
  ptr('pointerup', 210, 190);
  return 'dragged';
})()"

ASSERT_D="$PRE
  var a = shapes();
  var r1 = a.filter(function(s){ return s.id === 'r1'; })[0];
  ok('种子图形仍在', !!r1);
  ok('r1 的坐标被拖动了', r1 && (Math.abs(r1.x - 100) > 20 || Math.abs(r1.y - 100) > 20));
  return JSON.stringify({ 通过: pass, 失败: fail, r1: r1 ? { x: Math.round(r1.x), y: Math.round(r1.y) } : null });
})()"

# ---------- E. 缩放 ----------
# ⚠️ 必须拆成「点 → 等 → 读」：view 落盘有 400ms 防抖，pct 文本走 rAF 节流。
#    同一个 eval 里点完立刻读，拿到的是旧值 —— 这不是应用的问题，是测试的问题。
ACT_ZIN="(function(){ document.querySelector('.wb-zin').click(); return 'clicked'; })()"

ASSERT_E="$PRE
  var v = JSON.parse(localStorage.getItem('toolbox:sketch:view')) || {};
  ok('放大后 k 变大', v.k > 1.2);
  var pct = Q('.wb-pct').textContent;
  ok('百分比文本跟着变（不再是 100%）', pct.indexOf('100%') < 0);
  return JSON.stringify({ 通过: pass, 失败: fail, k: v.k, 文本: pct });
})()"

# ---------- F. 撤销 / 重做 ----------
# 同样拆开：每次操作后等防抖落盘（400ms）再读，留 1.2s 余量
ACT_UNDO="(function(){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true})); return 'undo'; })()"
ACT_REDO="(function(){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'y',code:'KeyY',ctrlKey:true,bubbles:true,cancelable:true})); return 'redo'; })()"

ASSERT_F1="$PRE
  var n = shapes().length;
  eq('撤销新建后图形数 3 → 2', n, 2);
  return JSON.stringify({ 通过: pass, 失败: fail, 撤销后: n });
})()"

ASSERT_F2="$PRE
  var n = shapes().length;
  eq('重做后回到 3', n, 3);
  return JSON.stringify({ 通过: pass, 失败: fail, 重做后: n });
})()"

# ---------- G. 复制 / 粘贴 ----------
ACT_COPYPASTE="$PRE
  Q('.wb-tbtn[data-tool=\"select\"]').click();
  ptr('pointerdown', 210, 190);   // 选中刚才拖过的 r1
  ptr('pointerup', 210, 190);
  key('c', { ctrlKey: true });
  key('v', { ctrlKey: true });    // Ctrl+V 有 80ms 判定窗口（先看是不是图片粘贴）
  return 'copied+pasted';
})()"

ASSERT_G="$PRE
  var n = shapes().length;
  eq('粘贴后图形数 +1（3 → 4）', n, 4);
  return JSON.stringify({ 通过: pass, 失败: fail, 数量: n });
})()"

# ---------- H. 键盘快捷键 ----------
ASSERT_H="$PRE
  key('o');
  ok('按 O 切到圆工具', Q('.wb-tbtn[data-tool=\"ellipse\"]').classList.contains('on'));
  key('r');
  ok('按 R 切回矩形工具', Q('.wb-tbtn[data-tool=\"rect\"]').classList.contains('on'));
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

# ---------- I. 清空画布：**刻意没有确认框，靠撤销兜底** ----------
# 实测源码：.wb-clear 直接 pushUndo() + shapes=[]，提示「已清空（可撤销）」。
# 所以这里断言的不是「弹确认框」，而是**真的能撤销回来**。
ACT_CLEAR="(function(){ document.querySelector('.wb-clear').click(); return 'cleared'; })()"
ACT_UNDO2="(function(){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true})); return 'undo'; })()"

ASSERT_I1="$PRE
  var n = shapes().length;
  eq('清空后图形数归零', n, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 数量: n });
})()"

ASSERT_I2="$PRE
  var n = shapes().length;
  eq('撤销后内容回来了（清空可撤销）', n, 4);
  return JSON.stringify({ 通过: pass, 失败: fail, 数量: n });
})()"

# ---------- J. 持久化 ----------
ASSERT_J="$PRE
  var n = shapes().length;
  eq('reload 后图形数保持', n, 4);
  return JSON.stringify({ 通过: pass, 失败: fail, 数量: n });
})()"

SEED="(function(){
  localStorage.setItem('toolbox:sketch:shapes', JSON.stringify([
    { id:'r1', type:'rect', x:100, y:100, w:120, h:80, color:'#1f2328', size:3 },
    { id:'r2', type:'rect', x:300, y:200, w:100, h:60, color:'#1f2328', size:3 }
  ]));
  localStorage.setItem('toolbox:sketch:view', JSON.stringify({ x:24, y:24, k:1 }));
  return 'seeded';
})()"

run() {
  echo "exe : $AB"
  echo "url : $URL"
  echo ""
  echo "--- 打开画板 ---"
  "$AB" open "$URL" || { echo "打开失败"; return 1; }
  sleep 18
  "$AB" eval "$SEED" >/dev/null
  sleep 1
  "$AB" reload
  sleep 18

  R=""
  step() {  # step <标签> <js表达式>
    local label="$1"; shift
    echo ""
    echo "===== $label ====="
    local out; out="$("$AB" eval "$1")"
    echo "$out"
    LAST="$out"
  }

  step "A. 挂载与静态结构" "$ASSERT_A";    RA="$LAST"
  step "B. 渲染确实发生（种子图形）" "$ASSERT_B"; RB="$LAST"

  "$AB" eval "$ACT_DRAW" >/dev/null; sleep 1
  step "C. 用矩形工具拖拽新建" "$ASSERT_C";  RC="$LAST"

  # 撤销/重做紧跟在「新建」之后 —— 此时栈顶就是这次新建。
  # （若放在缩放之后，栈顶变成"缩放"，它不改变图形数，断言会失真。）
  "$AB" eval "$ACT_UNDO" >/dev/null; sleep 1.5
  step "F1. 撤销新建" "$ASSERT_F1";         RF1="$LAST"
  "$AB" eval "$ACT_REDO" >/dev/null; sleep 1.5
  step "F2. 重做" "$ASSERT_F2";             RF2="$LAST"

  "$AB" eval "$ACT_DRAG" >/dev/null; sleep 1
  step "D. 选择并拖动" "$ASSERT_D";         RD="$LAST"

  "$AB" eval "$ACT_ZIN" >/dev/null; sleep 1.5
  step "E. 缩放" "$ASSERT_E";               RE="$LAST"

  "$AB" eval "$ACT_COPYPASTE" >/dev/null; sleep 1.5
  step "G. 复制 / 粘贴" "$ASSERT_G";        RG="$LAST"

  step "H. 键盘快捷键" "$ASSERT_H";         RH="$LAST"

  "$AB" eval "$ACT_CLEAR" >/dev/null; sleep 1.5
  step "I1. 清空画布" "$ASSERT_I1";         RI1="$LAST"
  "$AB" eval "$ACT_UNDO2" >/dev/null; sleep 1.5
  step "I2. 撤销清空" "$ASSERT_I2";         RI2="$LAST"

  "$AB" reload; sleep 16
  step "J. 持久化（reload 后）" "$ASSERT_J"; RJ="$LAST"

  echo ""
  echo "================= 汇总 ================="
  local NP=0 NF=0
  for pair in "A:$RA" "B:$RB" "C:$RC" "D:$RD" "E:$RE" "F1:$RF1" "F2:$RF2" "G:$RG" "H:$RH" "I1:$RI1" "I2:$RI2" "J:$RJ"; do
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
