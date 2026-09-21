#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CSP 代理测试用的静态服务 —— tools/verify-csp.sh 的配套件（不参与打包）。

为什么需要它：tauri.conf.json 里的 CSP 只有 Tauri 会应用（同时以 <meta http-equiv> 和响应头下发）。
`python -m http.server` 不带任何策略，浏览器里跑的 index.html 等于「没有 CSP」——
那样策略写成什么样都测不出来。本服务把配置里那条策略原样搬过来，并复刻 Tauri 的两处行为，
使「这里跑得通」≈「Tauri 里跑得通」：

  1) 内联脚本哈希：Tauri 构建期会给每个内联 <script> 算 sha256 追加进 script-src
     （tauri-utils html2.rs），行尾按 HTML 规范 CRLF→LF 归一后再算 —— 不归一哈希就对不上，
     后果是整页主脚本被拦、应用白屏。前端拆成 js/*.js 外链之后内联块归零，这条追加逻辑
     仍保留（谁把脚本塞回内联就得再靠它兜），但正常情况下本服务只是原样下发配置。
     style-src 不追加哈希，因为配置里 dangerousDisableAssetCspModification 关掉了它
     （否则 'unsafe-inline' 会被哈希顶掉，mermaid 运行时注入的 <style> 会被拦）。

  2) window.__TAURI__ = {} 桩：让 index.html 的 isDesktop 为真，mermaid 走「桌面端优先读本地 vendor」
     那条分支（CDN 分支在桌面端永远走不到）；同时 __TAURI__.core 不存在，AppStore 仍落 localStorage，
     不会去 invoke 一个不存在的命令。

另外注入两样探针（都以 <script src="/_csp_probe.js"> 外链形式，不受哈希影响）：
  __CSPV      securitypolicyviolation 事件收集器 —— 本测试的核心信号
  __TOASTS    showToast 的参数记录 —— 导出成功/失败靠它判定
  __SELFHASH  浏览器自己算出的内联脚本 sha256 —— 与 CSP 白名单交叉验证。
              前端全外链之后这里应当是空数组，verify-csp.sh 就按「空」来断言。

用法: python _csp_server.py <port> <web_dir> <tauri.conf.json>
"""

import base64
import hashlib
import html
import http.server
import json
import os
import re
import sys

PROBE_JS = r"""
window.__CSPV = [];
document.addEventListener('securitypolicyviolation', function (e) {
  window.__CSPV.push({
    d: String(e.violatedDirective || ''),
    b: String(e.blockedURI || ''),
    s: String(e.sourceFile || '') + ':' + e.lineNumber + ':' + e.columnNumber,
    sample: String(e.sample || '').slice(0, 120)
  });
});
window.__TAURI__ = {};
window.__TOASTS = [];
(function hook() {
  var f = window.showToast;
  if (typeof f === 'function' && !f.__probeHooked) {
    var w = function (m) { try { window.__TOASTS.push(String(m)); } catch (e) {} return f.apply(this, arguments); };
    w.__probeHooked = true;
    window.showToast = w;
    return;
  }
  setTimeout(hook, 30);
})();
window.__SELFHASH = [];
window.addEventListener('load', function () {
  try {
    var texts = [];
    Array.prototype.forEach.call(document.scripts, function (s) {
      if (!s.src && s.textContent.trim()) texts.push(s.textContent);
    });
    Promise.all(texts.map(function (t) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)).then(function (b) {
        var bin = '';
        new Uint8Array(b).forEach(function (x) { bin += String.fromCharCode(x); });
        return 'sha256-' + btoa(bin);
      });
    })).then(function (hs) { window.__SELFHASH = hs; });
  } catch (e) { window.__SELFHASH = ['出错:' + e.message]; }
});
"""

EFFECTIVE_CSP = ''


def lf(text):
    return text.replace('\r\n', '\n').replace('\r', '\n')


def sha_token(text):
    digest = hashlib.sha256(text.encode('utf-8')).digest()
    return "'sha256-" + base64.b64encode(digest).decode('ascii') + "'"


def inline_bodies(doc, tag):
    """取页面里所有真正的内联 <tag> 正文：跳过带 src= 的外链标签，也跳过空正文。

    两道过滤都不能省。外链标签 <script src="js/store.js"></script> 的正文本来就是空的，
    而早期版本是 re.search 只取第一个匹配 —— 分文件之前那个位置是主脚本，
    分文件之后它变成第一个外链标签，于是会拿空串去算哈希、页面脚本全被拦。
    非贪婪配对与浏览器行为一致：正文里再出现 </tag> 时，浏览器也在那里结束标签。
    """
    out = []
    for m in re.finditer(r'<' + tag + r'((?:\s[^>]*)?)>(.*?)</' + tag + r'>', doc, re.S):
        if 'src=' in m.group(1):
            continue
        if m.group(2).strip():
            out.append(m.group(2))
    return out


def add_script_hashes(csp, tokens):
    extra = ' ' + ' '.join(tokens)
    parts = []
    for part in csp.split(';'):
        p = part.strip()
        if p.startswith('script-src'):
            p += extra
        parts.append(p)
    return '; '.join(parts)


class Handler(http.server.SimpleHTTPRequestHandler):
    webdir = '.'
    probe = PROBE_JS

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=Handler.webdir, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s\n' % (fmt % args))

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/_csp_probe.js':
            self._send(200, 'text/javascript; charset=utf-8', self.probe.encode('utf-8'))
            return
        if path in ('/', '/index.html'):
            with open(os.path.join(Handler.webdir, 'index.html'), 'rb') as f:
                raw = f.read().decode('utf-8')
            inject = ('<meta http-equiv="Content-Security-Policy" content="'
                      + html.escape(EFFECTIVE_CSP, quote=True) + '">'
                      + '<script src="/_csp_probe.js"></script>')
            out = raw.replace('<head>', '<head>' + inject, 1).encode('utf-8')
            self._send(200, 'text/html; charset=utf-8', out)
            return
        super().do_GET()

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if ctype.startswith('text/html'):
            self.send_header('Content-Security-Policy', EFFECTIVE_CSP)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)


def main():
    global EFFECTIVE_CSP
    port = int(sys.argv[1])
    Handler.webdir = sys.argv[2]
    conf_path = sys.argv[3]

    with open(conf_path, encoding='utf-8') as f:
        conf = json.load(f)
    csp = conf.get('app', {}).get('security', {}).get('csp')
    if not csp:
        raise SystemExit('tauri.conf.json 里 csp 为空 —— 本测试的前提是「配置里真有一条策略」')

    with open(os.path.join(Handler.webdir, 'index.html'), 'rb') as f:
        doc = f.read().decode('utf-8')
    bodies = inline_bodies(doc, 'script')
    sys.stderr.write('配置策略   : %s\n' % csp)
    if not bodies:
        # 前端全外链时的正常分支：没有内联块可哈希，原样下发即可。
        # 早先这里直接 raise，拆文件之后等于把整套 CSP 回归锁死在门外。
        EFFECTIVE_CSP = csp
        sys.stderr.write('内联脚本   : 0 段（js/*.js 全外链），script-src 无需追加哈希\n')
    else:
        tokens = [sha_token(lf(b)) for b in bodies]
        EFFECTIVE_CSP = add_script_hashes(csp, tokens)
        sys.stderr.write('内联脚本哈希: %d 段 → %s\n' % (len(tokens), ' '.join(tokens)))
    sys.stderr.write('实际下发   : %s\n' % EFFECTIVE_CSP)

    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler) as httpd:
        httpd.serve_forever()


if __name__ == '__main__':
    main()
