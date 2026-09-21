#!/bin/bash
# 实习日志「配图」真机验证（浏览器实跑）
#
# 覆盖 14 项断言：
#   ① 「+ 图片」按钮存在
#   ② 粘贴（Ctrl+V）能加图：数据模型 + 缩略图 + src 回填
#   ③ 缩略图 src 是 data URL（证明确实从资产读回来了，不是空白）
#   ④ 周报文本带上 [附图 N 张]
#   ⑤ 移除单张图：数据模型 + DOM 同步清掉
#   ⑥ 🔴 移除后**资产文件仍在**（设计如此：内容哈希去重，不能删文件）
#
# 用法: bash tools/verify-internlog-images.sh
# 报告: .workbuddy/_img.txt
set -u

export PATH="$HOME/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_img.txt"
PORT=8903
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1

PY="$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe"
AB=""
for c in $HOME/.workbuddy/binaries/node/versions/*/node_modules/agent-browser/bin/agent-browser-win32-x64.exe; do
  [ -f "$c" ] && AB="$c"
done
[ -z "$AB" ] && { echo "找不到 agent-browser exe" >&2; exit 2; }

( cd "$PROJ/web" && "$PY" -m http.server "$PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
SRV=$!
trap '"$AB" close --all >/dev/null 2>&1; kill $SRV 2>/dev/null' EXIT
sleep 2

URL="http://127.0.0.1:$PORT/index.html#tool/internlog"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
[ "$CODE" != "200" ] && { echo "静态服务不可用（HTTP $CODE）" >&2; exit 3; }

SEED="$(cat <<'EOF'
(function () {
  var items = [{ id: 'p1', date: '2026-09-16', text: '配图验证用日志', ts: Date.now(), mood: 4 }];
  localStorage.setItem('toolbox:internlog:items', JSON.stringify(items));
  localStorage.removeItem('toolbox:internlog:heat');
  // 清掉可能残留的资产键
  Object.keys(localStorage).forEach(function (k) {
    if (k.indexOf('toolbox:asset:') === 0) localStorage.removeItem(k);
  });
  return 'seeded';
})()
EOF
)"

# 在页面里现造一张 40x30 的 PNG，再模拟 Ctrl+V 粘到卡片上。
# 用 canvas 现生成而不是硬编码 base64 —— 保证是真正合法的 PNG。
PASTE="$(cat <<'EOF'
(function () {
  var c = document.createElement('canvas');
  c.width = 40; c.height = 30;
  var g = c.getContext('2d');
  g.fillStyle = '#2563eb'; g.fillRect(0, 0, 40, 30);
  g.fillStyle = '#ffffff'; g.fillRect(8, 6, 24, 18);
  var durl = c.toDataURL('image/png');
  var bin = atob(durl.split(',')[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  var file = new File([arr], 'shot.png', { type: 'image/png' });
  var dt = new DataTransfer();
  dt.items.add(file);
  var ta = document.querySelector('.note-card textarea');
  if (!ta) return 'NO_TEXTAREA';
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return 'pasted bytes=' + bin.length;
})()
EOF
)"

ASSERT_ADDED="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, got, want) { if (got === want) pass++; else fail.push(l + ' 期望[' + want + '] 实际[' + got + ']'); }
  var logs = JSON.parse(localStorage.getItem('toolbox:internlog:items') || '[]');
  var imgs = (logs[0] && logs[0].images) || [];
  var thumbs = document.querySelectorAll('.il-imgs .il-img');
  var src = thumbs[0] ? (thumbs[0].getAttribute('src') || '') : '';
  var assetKeys = Object.keys(localStorage).filter(function (k) { return k.indexOf('toolbox:asset:') === 0; });
  eq('有「+ 图片」按钮', document.querySelectorAll('.il-imgadd').length, 1);
  eq('数据模型 images 长度', imgs.length, 1);
  eq('资产名形如 inline-<hash>.png', /^inline-[0-9a-f]+\.png$/.test(imgs[0] || ''), true);
  eq('缩略图数量', thumbs.length, 1);
  eq('缩略图 src 已回填为 data URL', src.indexOf('data:image/png;base64,') === 0, true);
  eq('磁盘上有 1 个资产', assetKeys.length, 1);
  eq('有删除小按钮', document.querySelectorAll('.il-img-del').length, 1);
  return JSON.stringify({ 通过: pass, 失败: fail, 资产名: imgs[0] || '', src前30: src.slice(0, 30) });
})()
EOF
)"

ASSERT_REPORT="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, got, want) { if (got === want) pass++; else fail.push(l + ' 期望[' + want + '] 实际[' + got + ']'); }
  var out = document.querySelector('.il-rp-out');
  var v = out ? out.value : '';
  eq('周报文本非空', v.length > 0, true);
  eq('周报含 [附图 1 张]', v.indexOf('[附图 1 张]') >= 0, true);
  eq('周报含日志正文', v.indexOf('配图验证用日志') >= 0, true);
  return JSON.stringify({ 通过: pass, 失败: fail, 周报: v.slice(0, 120) });
})()
EOF
)"

ASSERT_REMOVED="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, got, want) { if (got === want) pass++; else fail.push(l + ' 期望[' + want + '] 实际[' + got + ']'); }
  var logs = JSON.parse(localStorage.getItem('toolbox:internlog:items') || '[]');
  var imgs = (logs[0] && logs[0].images) || [];
  var assetKeys = Object.keys(localStorage).filter(function (k) { return k.indexOf('toolbox:asset:') === 0; });
  eq('数据模型 images 已清空', imgs.length, 0);
  eq('缩略图已从 DOM 移除', document.querySelectorAll('.il-imgs .il-img').length, 0);
  eq('删除按钮也没了', document.querySelectorAll('.il-img-del').length, 0);
  // 🔴 关键：资产**必须还在**。按内容哈希去重，同一张图可能被别的日志/画板共用，
  //    删文件会误伤 —— 这是有意的设计选择，不是漏回收。
  eq('资产文件仍在（有意不回收）', assetKeys.length, 1);
  eq('卡片仍在，未误删整篇日志', document.querySelectorAll('.note-card').length, 1);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_REPORT="$(cat <<'EOF'
(function () {
  var box = document.querySelector('.il-report');
  if (box && box.hidden) box.hidden = false;
  var f = document.querySelector('.il-rp-from'), t = document.querySelector('.il-rp-to');
  f.value = '2026-09-16'; t.value = '2026-09-16';
  document.querySelector('.il-rp-gen').click();
  return 'gen';
})()
EOF
)"

ACT_DEL="(function(){var b=document.querySelector('.il-img-del');if(!b)return 'NO_BTN';b.click();return 'clicked';})()"

run() {
  echo "exe : $AB"
  echo "url : $URL"
  echo ""
  echo "--- 打开页面 ---"
  "$AB" open "$URL" || { echo "打开失败"; return 1; }
  sleep 18
  echo "--- 注入测试数据 ---"
  "$AB" eval "$SEED"
  sleep 3
  "$AB" reload
  sleep 18

  echo ""
  echo "===== 1. 粘贴加图 ====="
  "$AB" eval "$PASTE"
  sleep 4
  RA="$("$AB" eval "$ASSERT_ADDED")"
  echo "$RA"

  echo ""
  echo "===== 2. 周报带 [附图 N 张] ====="
  "$AB" eval "$ACT_REPORT" >/dev/null; sleep 2
  RB="$("$AB" eval "$ASSERT_REPORT")"
  echo "$RB"

  echo ""
  echo "===== 3. 移除单张图 ====="
  "$AB" eval "$ACT_DEL" >/dev/null; sleep 2
  RC="$("$AB" eval "$ASSERT_REMOVED")"
  echo "$RC"

  echo ""
  echo "================= 汇总 ================="
  NP=0; NF=0
  for pair in "1:$RA" "2:$RB" "3:$RC"; do
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
  [ "$NF" -eq 0 ] && echo "  结果: 全绿" || echo "  结果: 有失败"
}

run 2>&1 | tee "$REPORT"
