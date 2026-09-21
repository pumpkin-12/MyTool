/* 一条命令跑完全部回归。README 里只文档化这一条 —— 文档漂移面从 5 条缩成 1 条。
 *
 * 退出码：0 = 全通过；1 = 有脚本失败或断言数对不上；被跳过的真机脚本不算失败。
 *
 * 两类脚本：
 *   node tools/verify-*.js  —— 用 vm 抽前端源码（index.html + js/*.js）的被测段跑，任何环境都能跑
 *   bash tools/verify-*.sh  —— 真机浏览器（agent-browser + 本地 http.server），
 *                              缺依赖时脚本自己 exit 2，这里记为 SKIP 而非失败
 *
 * 用法: node tools/verify-all.js          # 全部
 *       node tools/verify-all.js --js     # 只跑无依赖的 node 脚本（CI 用）
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const NODE_SCRIPTS = [
  'verify-appstore.js',
  'verify-store-semantics.js',
  'verify-quizcore.js',
  'verify-defect.js',
  'verify-internlog-core.js',
  'verify-mermaid-release.js',
  'verify-sysinfo.js',
];
const BROWSER_SCRIPTS = [
  'verify-sketch-core.sh',
  'verify-internlog-heat.sh',
  'verify-internlog-images.sh',
  'verify-internlog-md.sh',
  'verify-csp.sh',
];

/* 真机脚本约定用 exit 2 表示「环境缺依赖」，不是测试失败。 */
const SKIP_EXIT = 2;

const jsOnly = process.argv.includes('--js');
const jobs = jsOnly ? NODE_SCRIPTS : NODE_SCRIPTS.concat(BROWSER_SCRIPTS);

// 输出必须原样透传：每个脚本自己会打印逐条 PASS/FAIL 和汇总行。
// 用 inherit 而不是先捕获再打印，这样中途崩掉也能立刻在终端上看到位置。
const results = [];
for (const script of jobs) {
  const isJs = script.endsWith('.js');
  const cmd = isJs ? process.execPath : 'bash';
  const args = isJs ? [path.join(__dirname, script)] : [path.join(__dirname, script)];

  console.log('\n' + '─'.repeat(64));
  console.log('▶ ' + script);
  console.log('─'.repeat(64));

  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

  let verdict;
  if (r.error) {
    // bash 不存在（例如纯 PowerShell 环境）会走到这里
    verdict = 'SKIP';
    console.log('  无法启动 ' + cmd + '：' + r.error.message);
  } else if (r.status === 0) verdict = 'PASS';
  else if (!isJs && r.status === SKIP_EXIT) { verdict = 'SKIP'; console.log('  （缺真机浏览器依赖，已跳过）'); }
  else verdict = 'FAIL';

  results.push({ script, verdict, status: r.status });
}

const failed = results.filter(r => r.verdict === 'FAIL');
const skipped = results.filter(r => r.verdict === 'SKIP');
const passed = results.filter(r => r.verdict === 'PASS');

console.log('\n' + '='.repeat(64));
console.log('verify-all 汇总');
console.log('='.repeat(64));
for (const r of results) {
  console.log('  ' + r.verdict.padEnd(5) + '  ' + r.script +
    (r.verdict === 'FAIL' ? '   (退出码 ' + r.status + ')' : ''));
}
console.log('  ' + '-'.repeat(50));
console.log('  通过 ' + passed.length + ' / 失败 ' + failed.length + ' / 跳过 ' + skipped.length);
if (skipped.length) {
  console.log('  ⚠️ 跳过的是真机浏览器脚本。画板（sketch）没有任何 node 侧覆盖，');
  console.log('     它的 23 项断言全靠 bash tools/verify-sketch-core.sh —— 改动画板后必须本机补跑。');
}
console.log('='.repeat(64));

process.exitCode = failed.length ? 1 : 0;
