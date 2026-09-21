#!/bin/bash
# 实习日志「Markdown 预览 + 周报导出」真机验证
#
# 覆盖 38 项断言：
#   A 预览开关（6）· B Markdown 渲染（15）· C 状态持久化（3）· D 导出（14）
#
# 两个手法值得注意：
#   1. 渲染断言直接查 DOM 结构（.il-md h1 / .md-code code…），不是查源码里有没有那行字
#   2. 导出靠**替换 window.saveBlob 抓 Blob** —— 它是个全局函数声明，
#      运行时被模块以裸名调用，所以能这样截获；比"看有没有弹下载框"可靠得多
#
# 用法: bash tools/verify-internlog-md.sh     报告: .workbuddy/_ilmd.txt
set -u

export PATH="$HOME/.workbuddy/binaries/PortableGit/versions/1.2.0:/c/Windows/System32:/c/Windows:$PATH"

REPORT=".workbuddy/_ilmd.txt"
PORT=8911
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

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html")"
[ "$CODE" != "200" ] && { echo "静态服务不可用（HTTP $CODE）" >&2; exit 3; }

URL="http://127.0.0.1:$PORT/index.html#tool/internlog"

# 种一条含各种 Markdown 语法的日志 + 一条含 HTML 的（测转义）
SEED="$(cat <<'EOF'
(function () {
  var md = [
    '# 排障记录',
    '',
    '处理了**注塑机**的数据采集，命令是 `plc_read --addr 40001`。',
    '',
    '```js',
    'var a = b*c*d;',
    '```',
    '',
    '- 步骤一',
    '- 步骤二',
    '',
    '> 注意：<b>这里要原样显示</b>'
  ].join('\n');
  var items = [
    { id: 'm1', date: '2026-09-21', text: md, ts: Date.now(), mood: 4, tags: ['MES'] },
    { id: 'm2', date: '2026-09-21', text: '<img src=x onerror=alert(1)> **粗体**', ts: Date.now(), mood: 3 }
  ];
  localStorage.setItem('toolbox:internlog:items', JSON.stringify(items));
  localStorage.removeItem('toolbox:internlog:preview');
  localStorage.setItem('toolbox:internlog:heat', JSON.stringify({ mode: '6m' }));
  return 'seeded';
})()
EOF
)"

# ---------- A. 预览开关 ----------
ASSERT_A="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  var btn = document.querySelector('.il-preview');
  eq('有「预览」按钮', !!btn, true);
  eq('初始文案是「预览」（当前为编辑模式）', btn ? btn.textContent.trim() : '', '预览');
  eq('编辑模式下有 textarea', document.querySelectorAll('.il-list textarea').length, 2);
  eq('编辑模式下没有渲染容器', document.querySelectorAll('.il-md').length, 0);
  btn.click();
  eq('点后按钮文案变「编辑」', btn.textContent.trim(), '编辑');
  eq('点后出现渲染容器且 textarea 消失',
     document.querySelectorAll('.il-md').length + '|' + document.querySelectorAll('.il-list textarea').length,
     '2|0');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# ---------- B. Markdown 渲染 ----------
ASSERT_B="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var card = document.querySelector('.note-card[data-logid="m1"] .il-md');
  ok('找到第一条的渲染容器', !!card);
  if (!card) return JSON.stringify({ 通过: pass, 失败: fail });
  eq('标题渲染为 h1', card.querySelectorAll('h1').length, 1);
  eq('h1 文字正确', card.querySelector('h1').textContent, '排障记录');
  eq('粗体渲染为 strong', card.querySelector('strong') ? card.querySelector('strong').textContent : '', '注塑机');
  eq('行内代码渲染为 code.md-ic', card.querySelector('code.md-ic') ? card.querySelector('code.md-ic').textContent : '', 'plc_read --addr 40001');
  eq('代码块渲染并带语言标记', card.querySelector('pre.md-code') ? card.querySelector('pre.md-code').getAttribute('data-lang') : 'NULL', 'js');
  // 🔴 关键：代码块里的 b*c*d 不能变成 <em>
  var pc = card.querySelector('pre.md-code code');
  eq('代码块内星号未被斜体规则吃掉',
     (pc ? pc.textContent.trim() : 'NULL') + '|' + card.querySelectorAll('pre.md-code em').length,
     'var a = b*c*d;|0');
  eq('列表渲染为 ul>li', card.querySelectorAll('ul li').length, 2);
  eq('引用渲染为 blockquote', card.querySelectorAll('blockquote').length, 1);
  // 引用里的 <b> 必须被转义成文字，不能变成真元素
  eq('引用里的 HTML 被转义', card.querySelectorAll('blockquote b').length, 0);
  var bq = card.querySelector('blockquote');
  eq('引用里能看到转义后的原文', !!bq && bq.textContent.indexOf('<b>这里要原样显示</b>') >= 0, true);
  // 第二条：整条都是 HTML 注入尝试
  var card2 = document.querySelector('.note-card[data-logid="m2"] .il-md');
  ok('找到第二条的渲染容器', !!card2);
  if (!card2) return JSON.stringify({ 通过: pass, 失败: fail });
  eq('第二条里的 img 未被创建', card2.querySelectorAll('img').length, 0);
  eq('第二条能看到转义后的原文', card2.textContent.indexOf('<img src=x onerror=alert(1)>') >= 0, true);
  eq('第二条的粗体仍正常渲染', card2.querySelector('strong') ? card2.querySelector('strong').textContent : 'NULL', '粗体');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# ---------- C. 状态持久化 ----------
ASSERT_C="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  eq('存档里记下了预览状态', localStorage.getItem('toolbox:internlog:preview'), 'true');
  eq('reload 后仍是预览模式', document.querySelectorAll('.il-md').length, 2);
  eq('reload 后按钮仍显示「编辑」', document.querySelector('.il-preview').textContent.trim(), '编辑');
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

# ---------- D. 导出 ----------
# 替换 window.saveBlob 截获导出的 Blob（它是全局函数声明，模块以裸名调用）
ACT_STUB="$(cat <<'EOF'
(function () {
  window.__blobs = [];
  window.saveBlob = function (blob, name) {
    var rec = { name: name, type: blob.type, size: blob.size, text: null };
    window.__blobs.push(rec);
    blob.text().then(function (t) { rec.text = t; });
    return Promise.resolve(true);
  };
  document.querySelector('.il-rp-from').value = '2026-09-21';
  document.querySelector('.il-rp-to').value = '2026-09-21';
  document.querySelector('.il-report-btn').click();
  return 'stubbed';
})()
EOF
)"

ASSERT_D1="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  eq('周报面板有「存 .md」按钮', !!document.querySelector('.il-rp-md'), true);
  eq('周报面板有「存 HTML」按钮', !!document.querySelector('.il-rp-html'), true);
  return JSON.stringify({ 通过: pass, 失败: fail });
})()
EOF
)"

ACT_MD="(function(){document.querySelector('.il-rp-gen').click();document.querySelector('.il-rp-md').click();return 'md';})()"

ASSERT_MD="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var b = (window.__blobs || []).find(function (x) { return /\.md$/.test(x.name); });
  ok('导出了 .md 文件', !!b);
  if (!b) return JSON.stringify({ 通过: pass, 失败: fail, 已捕获: (window.__blobs || []).map(function (x) { return x.name; }).join(',') });
  eq('文件名以 实习周报- 开头', b.name.indexOf('实习周报-') === 0, true);
  ok('内容是周报正文', String(b.text).indexOf('【实习周报】2026-09-21 至 2026-09-21') >= 0);
  ok('含日志正文（含 Markdown 原文，未渲染）', String(b.text).indexOf('# 排障记录') >= 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 文件名: b.name, 大小: b.size });
})()
EOF
)"

ACT_HTML="(function(){document.querySelector('.il-rp-html').click();return 'html';})()"

ASSERT_HTML="$(cat <<'EOF'
(function () {
  var pass = 0, fail = [];
  function eq(l, g, w) { if (g === w) pass++; else fail.push(l + ' 期望[' + w + '] 实际[' + g + ']'); }
  function ok(l, c) { if (c) pass++; else fail.push(l); }
  var b = (window.__blobs || []).find(function (x) { return /\.html$/.test(x.name); });
  ok('导出了 .html 文件', !!b);
  if (!b) return JSON.stringify({ 通过: pass, 失败: fail });
  var t = String(b.text);
  eq('MIME 是 text/html', b.type.indexOf('text/html') === 0, true);
  ok('有 DOCTYPE', t.indexOf('<!DOCTYPE html>') === 0);
  ok('带 Word 用的 MS Office 命名空间', t.indexOf('urn:schemas-microsoft-com:office:word') >= 0);
  ok('带 @page A4 排版', t.indexOf('@page') >= 0 && t.indexOf('A4') >= 0);
  ok('含标题 h1', t.indexOf('<h1>实习周报</h1>') >= 0);
  // 🔴 日志正文里的 <img onerror> 必须被转义，不能原样进 HTML
  ok('日志正文被转义（无活动标签）', t.indexOf('<img src=x onerror=') < 0 && t.indexOf('&lt;img src=x onerror=') >= 0);
  ok('文件尾有统计', t.indexOf('共 2 篇') >= 0);
  return JSON.stringify({ 通过: pass, 失败: fail, 文件名: b.name, 大小: b.size });
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

  step "A. 预览开关" "$ASSERT_A";          RA="$LAST"
  step "B. Markdown 渲染（含 XSS 与代码块保护）" "$ASSERT_B"; RB="$LAST"
  "$AB" reload >/dev/null 2>&1; sleep 16
  step "C. 预览状态持久化" "$ASSERT_C";    RC="$LAST"
  "$AB" eval "$ACT_STUB" >/dev/null; sleep 1
  step "D1. 导出按钮存在" "$ASSERT_D1";    RD1="$LAST"
  "$AB" eval "$ACT_MD" >/dev/null; sleep 2
  step "D2. 导出 .md" "$ASSERT_MD";        RD2="$LAST"
  "$AB" eval "$ACT_HTML" >/dev/null; sleep 3
  step "D3. 导出 HTML" "$ASSERT_HTML";     RD3="$LAST"

  echo ""
  echo "================= 汇总 ================="
  local NP=0 NF=0
  for pair in "A:$RA" "B:$RB" "C:$RC" "D1:$RD1" "D2:$RD2" "D3:$RD3"; do
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
