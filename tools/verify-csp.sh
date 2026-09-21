#!/bin/bash
# CSP 收紧后的真机回归 —— 真机浏览器 + 与 tauri.conf.json 完全同源的策略
#
# 为什么必须真机跑：CSP 是浏览器（桌面端是 WebView2）执行的东西，node 侧无论怎么抽代码
# 都验不出「策略到底放行了什么」。这里用 tools/_csp_server.py 把配置里那条策略原样下发
# （含 Tauri 构建期会给内联脚本追加的 sha256），再用 agent-browser 实跑四条路径，
# 判据统一是「securitypolicyviolation 一条都没触发，且功能仍然正常」。
#
# 覆盖 46 项断言。用法: bash tools/verify-csp.sh
# 报告: .workbuddy/_csp.txt   服务日志: .workbuddy/_csp_server.log
#
# 🔴 改 CSP、换前端依赖、动导出实现之后都要重跑这个脚本，三条最容易踩的：
#    img-src 少了 blob:            → mermaid 的 PNG 导出静默变成「导出失败，可改用 SVG」
#                                    （它把 SVG 转成 blob URL 再当图片画，见 exportPNG）
#    style-src 少了 'unsafe-inline' → mermaid 运行时注入进 SVG 的 <style> 被拦，图还在但全是默认黑
#    script-src 只剩 'self'          → 前端现在是 11 个 js/*.js 外链脚本，少一条 <script src>
#                                    或写错路径，对应板块就静默消失（A 段用「5 张工具卡 + 各模块
#                                    全局符号齐全」两条断言兜住）。拆文件之前这里写的是「内联脚本
#                                    sha256 少一个就白屏」—— 页面已无内联脚本，那条约束随之作废。
set -u

export PATH="/c/Users/DELL/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_csp.txt"
SLOG=".workbuddy/_csp_server.log"
PORT=8910
EXPECTED=46
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1

PY="/c/Users/DELL/.workbuddy/binaries/python/versions/3.13.12/python.exe"
[ -x "$PY" ] || { echo "找不到 python：$PY" >&2; exit 2; }
AB=""
for c in /c/Users/DELL/.workbuddy/binaries/node/versions/*/node_modules/agent-browser/bin/agent-browser-win32-x64.exe; do
  [ -f "$c" ] && AB="$c"
done
[ -z "$AB" ] && { echo "找不到 agent-browser exe" >&2; exit 2; }

mkdir -p .workbuddy
PYTHONIOENCODING=utf-8 "$PY" "$PROJ/tools/_csp_server.py" "$PORT" "$PROJ/web" "$PROJ/src-tauri/tauri.conf.json" >"$SLOG" 2>&1 &
SRV=$!
trap '"$AB" close --all >/dev/null 2>&1; kill $SRV 2>/dev/null' EXIT
sleep 2

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
if [ "$CODE" != "200" ]; then
  echo "CSP 代理服务没起来（HTTP $CODE）。服务日志：" >&2
  cat "$SLOG" >&2
  echo "（若日志说「csp 为空」，说明 tauri.conf.json 里 csp 又变回 null 了 —— 那本测试没有可测的策略）" >&2
  exit 3
fi

BASE="http://127.0.0.1:$PORT/index.html"

# 每段断言共用的前置：helper + 三个探针的读取口
PRE="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c, d) { if (c) pass++; else fail.push(l + (d === undefined ? '' : ' → ' + d)); }
  function Q(s) { return document.querySelector(s); }
  function csp() { var m = Q('meta[http-equiv="Content-Security-Policy"]'); return m ? m.content : ''; }
  function vio(d) {
    return (window.__CSPV || []).filter(function (v) { return !d || v.d.indexOf(d) >= 0; });
  }
  function toasts() { return window.__TOASTS || []; }
EOF
)"

# ---------- A. 策略落地与启动（首页） ----------
ASSERT_A="$PRE
  ok('违规收集器已就绪', Array.isArray(window.__CSPV));
  ok('toast 记录器已就绪', Array.isArray(window.__TOASTS));
  var c = csp();
  ok('页面拿到了 CSP（不再是 null 策略）', c.length > 20, c.slice(0, 50));
  ok('object-src 已收紧为 none', /object-src 'none'/.test(c));
  ok('base-uri 已收紧为 self', /base-uri 'self'/.test(c));
  ok('form-action 已收紧为 none', /form-action 'none'/.test(c));
  ok('connect-src 放行 ipc 通道（桌面端 IPC 依赖）',
     /connect-src[^;]*ipc:/.test(c) && /connect-src[^;]*http:\/\/ipc\.localhost/.test(c));
  ok('img-src 放行 data:', /img-src[^;]*data:/.test(c));
  ok('img-src 放行 blob:', /img-src[^;]*blob:/.test(c));
  var ss = (c.match(/script-src([^;]*)/) || ['', ''])[1];
  ok('script-src 不含 unsafe-inline（本次收紧的核心）', ss.indexOf(\"'unsafe-inline'\") < 0, ss.trim());
  // 前端拆成 js/*.js 外链之后页面里没有任何内联脚本，Tauri 也就没有哈希可追加。
  // 反过来讲：这里若冒出 sha256 令牌，说明有人把脚本塞回了内联 —— 那条路要重新走哈希托管，得显眼。
  ok('没有内联脚本，script-src 里也不该有为内联准备的 sha256 令牌', /'sha256-/.test(ss) === false, ss.trim());
  var sh = window.__SELFHASH || [];
  ok('浏览器自算的内联脚本哈希为空（页面确实没内联脚本）', sh.length === 0, sh.join(' '));
  var inlineN = 0, crossN = 0;
  Array.prototype.forEach.call(document.scripts, function (s) {
    if (!s.src) { inlineN++; return; }
    // HTMLScriptElement 上没有 .origin，得自己解析绝对 URL —— 直接取会恒为 undefined，检查就空转了
    var u = new URL(s.src, location.href);
    if (u.origin !== location.origin) crossN++;
  });
  ok('所有 <script> 都是同源外链（无内联、无跨源）', inlineN === 0 && crossN === 0,
     '内联 ' + inlineN + ' / 跨源 ' + crossN);
  ok('外链主脚本确实执行了（showToast 已定义）', typeof window.showToast === 'function');
  ok('分文件的各模块都执行到位（store/util/tools/app 的全局符号齐全）',
     typeof AppStore !== 'undefined' && typeof tabButtons === 'function'
     && typeof registerTool === 'function' && typeof render === 'function');
  var cards = document.querySelectorAll('.card').length;
  ok('首页渲染出 5 张工具卡（每份 tools/*.js 都完成了 registerTool）', cards >= 5, String(cards) + ' 张');
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 策略: c });
})()"

# ---------- B. mermaid：本地 vendor 在严格 script-src 下加载并渲染 ----------
ASSERT_B="$PRE
  var m = Q('.mm-msg');
  ok('mermaid 编辑器已挂载', !!m);
  ok('已脱离加载中状态', !!m && m.textContent !== '加载中', m ? m.textContent : 'NO_EL');
  ok('本地 vendor 的 mermaid 已执行（window.mermaid 存在）', !!window.mermaid);
  var svg = Q('.mm-prev svg');
  ok('预览区渲染出 svg', !!svg);
  var marks = svg ? svg.querySelectorAll('.node rect, .node polygon, .node circle, .node ellipse') : [];
  ok('图表里有节点图形', marks.length > 0, String(marks.length));
  var styled = 0;
  Array.prototype.forEach.call(marks, function (r) {
    var f = getComputedStyle(r).fill;
    if (f && f !== 'rgb(0, 0, 0)' && f !== 'rgba(0, 0, 0, 0)') styled++;
  });
  ok('mermaid 运行时注入的 style 生效（节点填充非默认黑）', styled > 0, styled + '/' + marks.length);
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 违规: vio() });
})()"

# ---------- C. mermaid PNG 导出（走 blob: 图片那条路） ----------
ACT_MMEXP="$PRE
  var b = Q('.mm-dl');
  ok('找到导出按钮', !!b);
  if (b) b.click();
  var items = document.querySelectorAll('.mm-menu button');
  ok('导出菜单弹出', items.length > 0, String(items.length));
  var hit = null;
  Array.prototype.forEach.call(items, function (x) { if (!hit && /PNG/.test(x.textContent)) hit = x; });
  ok('菜单里有 PNG 项', !!hit);
  if (hit) hit.click();
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

ASSERT_C="$PRE
  var t = toasts().join(' | ');
  ok('mermaid PNG 导出成功（无失败提示）', /PNG 已导出/.test(t) && !/失败/.test(t), t || '(没有任何 toast)');
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, toasts: toasts() });
})()"

# ---------- D. 画板：绘制 ----------
ASSERT_D="$PRE
  var CV = Q('.wb-canvas');
  ok('画板 canvas 已挂载', !!CV && CV.getBoundingClientRect().width > 100);
  var raw = localStorage.getItem('toolbox:sketch:shapes');
  var n = 0; try { n = JSON.parse(raw || '[]').length; } catch (e) {}
  eq('存档里读到 2 个种子图形', n, 2);
  var ctx = CV.getContext('2d');
  var d = ctx.getImageData(0, 0, CV.width, CV.height).data;
  var ink = 0;
  for (var i = 0; i < d.length; i += 16) {
    if (d[i + 3] > 20 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) ink++;
  }
  ok('canvas 上有非背景像素（真的画出来了）', ink > 20, String(ink));
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 非背景像素: ink });
})()"

ACT_DRAW="$PRE
  var CV = Q('.wb-canvas');
  var R = CV.getBoundingClientRect();
  var v = {}; try { v = JSON.parse(localStorage.getItem('toolbox:sketch:view')) || {}; } catch (e) {}
  var k = v.k || 1, vx = v.x == null ? 24 : v.x, vy = v.y == null ? 24 : v.y;
  function ptr(type, wx, wy) {
    var ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: R.left + wx * k + vx, clientY: R.top + wy * k + vy
    });
    CV.dispatchEvent(ev);
  }
  var tb = Q('.wb-tbtn[data-tool=\"rect\"]');
  ok('找到矩形工具', !!tb);
  if (tb) tb.click();
  ptr('pointerdown', 120, 300);
  ptr('pointermove', 260, 400);
  ptr('pointerup', 260, 400);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

ASSERT_D2="$PRE
  var raw = localStorage.getItem('toolbox:sketch:shapes');
  var a = []; try { a = JSON.parse(raw || '[]'); } catch (e) {}
  eq('拖拽后图形数 2 → 3', a.length, 3);
  var last = a[a.length - 1];
  eq('新图形类型是 rect', last ? last.type : '(无)', 'rect');
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 新图形: last });
})()"

# ---------- E. 图片原语与画板导出 ----------
# data:/blob: 两条都是导出与配图的底层依赖，单独测比只测「导出按钮能点」更容易定位问题：
# 真被 CSP 拦了的话，这里的失败信息会直接指出是哪个 scheme 没放行。
ACT_IMGS="$PRE
  window.__IMGOK = { data: 'pending', blob: 'pending' };
  var svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><rect width=\"40\" height=\"40\" fill=\"#ff0000\"/></svg>';
  var i1 = new Image();
  i1.onload = function () { window.__IMGOK.data = 'ok'; };
  i1.onerror = function () { window.__IMGOK.data = 'error'; };
  i1.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  var u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  var i2 = new Image();
  i2.onload = function () { window.__IMGOK.blob = 'ok'; };
  i2.onerror = function () { window.__IMGOK.blob = 'error'; };
  i2.src = u;
  return 'kicked';
})()"

ASSERT_E="$PRE
  var g = window.__IMGOK || {};
  eq('data: 图片在 img-src 下可加载', g.data, 'ok');
  eq('blob: 图片在 img-src 下可加载', g.blob, 'ok');
  var b = Q('.wb-expbtn');
  ok('找到画板导出按钮', !!b);
  if (b) b.click();
  var png = Q('.wb-exp button[data-exp=\"png\"]');
  ok('导出菜单里有 PNG 项', !!png);
  if (png) png.click();
  return JSON.stringify({ 通过: pass, 失败: fail });
})()"

ASSERT_E2="$PRE
  var t = toasts().join(' | ');
  ok('画板 PNG 导出成功（无失败提示）', /已导出 PNG/.test(t) && !/失败/.test(t), t || '(没有任何 toast)');
  eq('此刻违规数', vio().length, 0);
  return JSON.stringify({ 通过: pass, 失败: fail, toasts: toasts() });
})()"

# ---------- F. 总账 ----------
ASSERT_F="$PRE
  var all = vio();
  eq('全程 securitypolicyviolation 总数', all.length, 0);
  ok('style-src 零违规（mermaid 运行时样式那条最脆弱的路）', vio('style').length === 0);
  // 自动保存的告警 toast 会污染上面的「无失败提示」判断，这里显式记一笔便于排查
  ok('没有出现画板自动保存失败告警', !/自动保存失败/.test(toasts().join(' | ')));
  return JSON.stringify({ 通过: pass, 失败: fail, 违规明细: all, toasts: toasts() });
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
  echo "url : $BASE"
  echo ""
  echo "===== 实际下发的策略 ====="
  "$PY" -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['app']['security']['csp'])" "$PROJ/src-tauri/tauri.conf.json"
  echo "（上面这条是配置；页面里若还有内联 <script>，Tauri / _csp_server.py 会给 script-src 追加它们的 sha256）"

  R=""; LAST=""
  step() {  # step <标签> <js表达式> —— 断言段：必须返回 {通过,失败} 信封，计入断言总数
    local label="$1"; shift
    echo ""
    echo "===== $label ====="
    local out; out="$("$AB" eval "$1")"
    echo "$out"
    LAST="$out"
  }
  act() {   # act <标签> <js表达式> —— 动作段：只制造状态，不计入断言数（结果由紧随其后的断言段检查）
    local label="$1"; shift
    echo ""
    echo "===== $label（动作段，不计入断言数） ====="
    "$AB" eval "$1"
    echo ""
  }

  echo ""
  echo "--- 打开首页 ---"
  "$AB" open "$BASE" || { echo "打开失败"; return 1; }
  sleep 18
  step "A. 策略落地与启动" "$ASSERT_A"; RA="$LAST"

  echo ""
  echo "--- 打开 mermaid ---"
  "$AB" open "$BASE#tool/mermaid" >/dev/null; sleep 16
  step "B. mermaid 渲染（本地 vendor + 严格 script-src）" "$ASSERT_B"; RB="$LAST"
  step "C1. 点导出 PNG" "$ACT_MMEXP"; RC1="$LAST"
  sleep 4
  step "C2. 导出结果" "$ASSERT_C"; RC2="$LAST"

  echo ""
  echo "--- 打开画板 ---"
  "$AB" open "$BASE#tool/sketch" >/dev/null; sleep 16
  "$AB" eval "$SEED" >/dev/null
  "$AB" reload; sleep 16
  step "D1. 种子渲染" "$ASSERT_D"; RD1="$LAST"
  step "D2. 拖拽新建" "$ACT_DRAW"; RD2="$LAST"
  sleep 1.5
  step "D3. 拖拽结果" "$ASSERT_D2"; RD3="$LAST"
  act "E1. 触发 data:/blob: 图片加载与画板导出" "$ACT_IMGS"
  sleep 2.5
  step "E2. 图片原语结果 + 画板导出" "$ASSERT_E"; RE2="$LAST"
  sleep 4
  step "E3. 画板导出结果" "$ASSERT_E2"; RE3="$LAST"
  step "F. 总账" "$ASSERT_F"; RF="$LAST"

  echo ""
  echo "================= 汇总 ================="
  local NP=0 NF=0
  for pair in "A:$RA" "B:$RB" "C1:$RC1" "C2:$RC2" "D1:$RD1" "D2:$RD2" "D3:$RD3" "E2:$RE2" "E3:$RE3" "F:$RF"; do
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
  echo "  合计通过 $NP 项（脚本声明 $EXPECTED 项），失败段数 $NF"
  if [ "$NF" -ne 0 ]; then
    echo "  结果: 有失败"
    return 1
  fi
  if [ "$NP" -ne "$EXPECTED" ]; then
    echo "  ⛔ 断言总数与声明不符 —— 可能有整段没跑起来（假绿）。"
    echo "  结果: 有失败"
    return 1
  fi
  echo "  结果: 全绿"
  return 0
}

run 2>&1 | tee "$REPORT"
exit "${PIPESTATUS[0]}"
