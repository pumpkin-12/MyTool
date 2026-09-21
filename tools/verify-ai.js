/* AI 底座（AiCore + ai.rs）验证。
 *
 * 两层覆盖：
 *   · AiCore 是纯逻辑（TESTABLE 段），抽进 vm 真跑 —— 分段容错、统计口径、
 *     截断策略、请求体形状，这些"可判定的规则"全在这里钉死。
 *   · Rust 侧不能编译（按项目约定由用户手动 cargo build），所以做**文本级静态断言**：
 *     命令是否注册、AiConfigView 里有没有 api_key、Cargo.toml 的 TLS 选型对不对。
 *
 * 用法: node tools/verify-ai.js      报告: .workbuddy/_ai.txt
 * ⚠️ 改了断言数必须同步改下面的 expected。 */
'use strict';

const H = require('./_harness');

const html = H.readFrontend();
const R = H.makeReport({ name: 'ai', expected: 93 });
const { log, ok } = R;
const vm = H.vm;

const B = String.fromCharCode(96);            // 反引号（避免在源码里出现三连反引号）
const FENCE = B + B + B;

/* ---------------- [0] 抽取与自包含性 ---------------- */
log('');
log('================= [0] 抽取 AiCore =================');

const src = H.extractByMarker(html, 'AiCore');
ok(!!src && src.length > 800, 'AiCore 段取出成功（标记存在且非空）');

const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/\bAppStore\b/.test(codeOnly), '不引用 AppStore（否则抽进 vm 会 ReferenceError）');
ok(!/\bdocument\b/.test(codeOnly), '不引用 document');
ok(!/\bwindow\b/.test(codeOnly), '不引用 window');
ok(!/\besc\s*\(/.test(codeOnly), '不引用全局 esc');

/* AiCore 必须能被 index.html 的 script 清单带到（顺序错了 extractByMarker 会直接崩，
 * 但这里再显式断言一次，把"顺序"这条约定写死在测试里） */
const idxUi = html.indexOf('js/ui.js');
const idxAi = html.indexOf('js/ai.js');
const idxTools = html.indexOf('js/tools.js');
ok(idxAi > 0 && idxAi > idxUi && idxAi < idxTools,
  'ai.js 在 script 清单里，且位于 ui.js 之后、tools.js 之前');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nglobalThis.__A = AiCore;', sandbox);
const A = sandbox.__A;
ok(!!A && typeof A.splitSections === 'function' && typeof A.chunkLogs === 'function',
  'AiCore 取出成功且暴露预期 API');

/* ---------------- 固定样本 ---------------- */
const LOGS = [
  { date: '2026-09-01', text: 'PLC 调试', mood: 5, tags: ['开发'], remarks: [{ id: 'r', text: '查手册' }] },
  { date: '2026-09-03', text: '周会', mood: 2, tags: ['会议'] },
  { date: '2026-09-03', text: '改了一版', mood: 4, tags: ['开发'] },
  { date: '2026-09-08', text: '写 SOP', mood: 0, tags: [] },
  { date: '', text: '随手记', mood: 0, tags: [] }
];

/* ---------------- [1] splitSections 容错 ---------------- */
log('');
log('================= [1] splitSections（【】容错分段） =================');

ok(A.SECTIONS.length === 4, '四个固定小标题');
ok(A.SECTIONS.join('|') === '润色后的周报|本周成果|待办 / 下周计划|状态点评', '小标题名字与顺序固定');
ok(/不要改成 Markdown 标题/.test(A.SYSTEM_PROMPT), 'system prompt 明确禁止改标题格式');
ok(/不得编造/.test(A.SYSTEM_PROMPT), 'system prompt 明确禁止编造');

const good = '【润色后的周报】\n本周做了 A。\n\n【本周成果】\n- 甲\n- 乙\n\n'
  + '【待办 / 下周计划】\n- 丙\n\n【状态点评】\n状态不错。';
const r1 = A.splitSections(good);
ok(r1.ok === true && r1.missing.length === 0, '标准四段 → ok=true 且无缺失');
ok(r1.parts['润色后的周报'] === '本周做了 A。', '正文归属正确');
ok(r1.parts['本周成果'] === '- 甲\n- 乙', '多行正文原样保留');
ok(r1.pre === '', '没有前言时 pre 为空');

const r2 = A.splitSections('【润色后的周报】\n只有这段。');
ok(r2.ok === false && r2.missing.length === 3, '只给一段 → ok=false 且 missing=3');
ok(r2.missing.indexOf('状态点评') >= 0, 'missing 里能点名缺了哪段');

/* 未识别的头要把正文并入**上一段**，不能丢 */
const r3 = A.splitSections('好的，以下是周报：\n\n【润色后的周报】\n正文甲\n\n'
  + '【随便什么】\n这段该并进上一段\n\n【本周成果】\n- 甲');
ok(r3.pre === '好的，以下是周报：', '头之前的前言单独留在 pre（不混进正文）');
ok(r3.parts['润色后的周报'] === '正文甲\n这段该并进上一段', '🔴 未识别的头，正文并入上一段而不是丢掉');
ok(r3.parts['本周成果'] === '- 甲', '后续已知段不受影响');

/* 围栏剥壳。⚠️ 这一样本只给 1 段，所以 ok 必然是 false ——
 * ok 反映的是"四段齐不齐"，不是"剥壳成没成功"。 */
const fenced = FENCE + '\n【润色后的周报】\n甲\n' + FENCE;
const r4 = A.splitSections(fenced);
ok(r4.parts['润色后的周报'] === '甲', '整段被围栏包住 → 先剥一层再切段');
ok(r4.raw === fenced, 'raw 保留的是**带围栏的原文**（不是剥过的）');

const r5 = A.splitSections('【 润色后的周报 】\n甲\n\n【本周成果】\n- 乙\n\n'
  + '【待办/下周计划】\n- 丙\n\n【状态点评：】\n丁');
ok(r5.ok === true, '标题含全角空格 / 缺空格 / 多余冒号也能归一化匹配');

const r6 = A.splitSections('【状态点评】\n点评\n\n【本周成果】\n- 甲\n\n'
  + '【润色后的周报】\n正文\n\n【待办 / 下周计划】\n- 乙');
ok(r6.ok && r6.parts['状态点评'] === '点评' && r6.parts['润色后的周报'] === '正文',
  '四段顺序颠倒也能按名字正确归位（不是按顺序硬切）');

const r7 = A.splitSections('我今天很累，没写周报。');
ok(r7.ok === false && r7.missing.length === 4, '完全不符合 → ok=false 且四段全缺');
ok(r7.raw === '我今天很累，没写周报。', '不符合时 raw 完整保留（功能不报废）');
ok(A.splitSections('').ok === false, '空输入不崩');
ok(A.splitSections(null).ok === false, 'null 输入不崩');

/* ---------------- [2] 统计 / 截断 / prompt / 请求体 ---------------- */
log('');
log('================= [2] weeklyStats · chunkLogs · prompt · 请求体 =================');

const st = A.weeklyStats(LOGS);
ok(st.count === 5, 'weeklyStats 总篇数');
ok(st.rated === 3 && st.unrated === 2, '有评分 3 篇 / 未评 2 篇');
ok(st.avg === 3.67, '平均效率 = (5+2+4)/3 = 3.67');
ok(st.max === 5 && st.min === 2, '最高 / 最低');
ok(st.days === 3, '有日期的天数 = 3（无日期那条不算）');
ok(A.weeklyStats([]).avg === null, '无数据时 avg 为 null');
ok(A.weeklyStats([]).max === null, '无数据时 max 为 null');

ok(A.fmtWeekday('2026-09-01') === '周二', 'fmtWeekday 正常');
ok(A.fmtWeekday('2026-02-31') === '' && A.fmtWeekday('') === '', 'fmtWeekday 非法日期返回空串');

const ch = A.chunkLogs(LOGS, 60);
ok(ch.truncated === true && ch.items.length >= 1, '超出额度时截断且**至少保留 1 篇**');
ok(ch.items[0].date === '2026-09-08', '截断保留的是**最新**的一条');
ok(ch.omitted === LOGS.length - ch.items.length, 'omitted 数正确');
const chAll = A.chunkLogs(LOGS, 99999);
ok(chAll.truncated === false && chAll.items.length === LOGS.length, '额度够时不截断');
ok(chAll.items[chAll.items.length - 1].date === '', '无日期的排在最后（"待归置"）');

const up = A.buildUserPrompt(LOGS, '2026-09-01', '2026-09-08');
ok(up.indexOf('2026-09-01 ~ 2026-09-08') >= 0, 'user prompt 含日期范围');
ok(/共 5 篇（有评分 3 篇，未评 2 篇）/.test(up), 'user prompt 含篇数口径');
ok(up.indexOf('平均效率 3.67') >= 0, 'user prompt 含平均效率');
ok(up.indexOf('周二') >= 0 && up.indexOf('效率 5/5') >= 0, 'user prompt 含逐条的星期与效率');
ok(up.indexOf('[开发]') >= 0, 'user prompt 含标签');
ok(up.indexOf('备注：- 查手册') >= 0, 'user prompt 含备注');
ok(up.indexOf('未评效率') >= 0 && up.indexOf('效率 0/5') < 0,
  '未评写成「未评效率」而不是"效率 0/5"（0 会被模型当成分数）');
ok(up.indexOf('未填日期') >= 0, '无日期的条目标成「未填日期」');

const body = A.buildRequestBody('m1', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 0.5);
ok(body.model === 'm1' && body.temperature === 0.5, '请求体带 model / temperature');
ok(body.messages.length === 2, '请求体带 system + user 两条消息');
ok(JSON.stringify(A.buildRequestBody('m', [{ role: 'u', content: 'c', extra: 1 }], 0.1).messages)
  === '[{"role":"u","content":"c"}]', '消息里多余字段被剥掉（不给模型塞无关内容）');
ok(A.buildRequestBody('m', [], null).temperature === 0.7, 'temperature 缺省 0.7');
ok(!/api_?key|sk-|Bearer|token/i.test(JSON.stringify(body)),
  '🔴 请求体里不含任何 key 字样（Key 只由 Rust 侧放进请求头）');

/* ---------------- [3] ai.rs 静态断言 ---------------- */
log('');
log('================= [3] ai.rs（不能编译，做文本级断言） =================');

const ai = H.readRel('src-tauri/src/ai.rs');
ok(ai.length > 2000, 'ai.rs 存在且非空');
ok(/#\[tauri::command\]\s*\npub fn ai_config_set/.test(ai), '定义了 ai_config_set');
ok(/#\[tauri::command\]\s*\npub fn ai_config_get/.test(ai), '定义了 ai_config_get');
ok(/#\[tauri::command\]\s*\npub async fn ai_chat/.test(ai), '定义了 ai_chat（async）');

/* 🔴 最关键的一条：给前端看的视图结构体里不能有 api_key 字段 */
const view = /pub struct AiConfigView \{([\s\S]*?)\}/.exec(ai);
ok(!!view, '能定位到 AiConfigView 结构体');
ok(view && !/api_key/.test(view[1]), '🔴 AiConfigView 结构体**不含 api_key 字段**');
ok(view && /has_key/.test(view[1]) && /key_tail/.test(view[1]),
  'AiConfigView 只回 has_key + key_tail');

ok(/crate::DATA_DIR/.test(ai), '用 crate::DATA_DIR 定位（不另写死路径）');
ok(/SECRET_FILE: &str = "secret.json"/.test(ai), 'Key 落 secret.json');
ok(/CFG_FILE: &str = "config.json"/.test(ai), '配置落 config.json');
ok(/trim_end_matches\('\/'\)/.test(ai), 'endpoint 归一化会去尾部斜杠');
ok(/ends_with\("\/chat\/completions"\)/.test(ai), '已带 /chat/completions 就不重复拼');
ok(/401 =>/.test(ai) && /429 =>/.test(ai), '错误分类含 401 / 429');
ok(/is_timeout\(\)/.test(ai) && /is_connect\(\)/.test(ai), '错误分类含超时 / 连不上');
ok(/TIMEOUT_SECS: u64 = 60/.test(ai), '超时 60 秒');
ok(/不做流式/.test(ai), '注释里写明了第一档不做流式');
ok(!/format!\([^)]*\{key\}/.test(ai.replace(/Bearer \{key\}/g, '')),
  '🔴 错误串里没有把 key 拼进去');

/* ---------------- [4] lib.rs ---------------- */
log('');
log('================= [4] lib.rs 接线 =================');

const lib = H.readRel('src-tauri/src/lib.rs');
ok(/^mod ai;/m.test(lib), '声明了 mod ai');
ok(/pub\(crate\) const DATA_DIR/.test(lib), 'DATA_DIR 改成 pub(crate)（给 ai 模块用）');
ok(/ai::ai_config_set/.test(lib) && /ai::ai_config_get/.test(lib) && /ai::ai_chat/.test(lib),
  '三条命令都注册进了 generate_handler');

/* ---------------- [5] Cargo.toml 的 TLS 选型 ---------------- */
log('');
log('================= [5] Cargo.toml（TLS 选型是这条的成败关键） =================');

/* ⚠️ 先剥注释行再判断 —— 否则我自己写的说明文字里就有 "rustls" 这个词，
 * 会被当成 feature 命中（这个坑我踩过一次）。 */
const cargoRaw = H.readRel('src-tauri/Cargo.toml');
const cargo = cargoRaw.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
const req = /^reqwest = \{([\s\S]*?)\]/m.exec(cargo);
ok(!!req, 'Cargo.toml 声明了 reqwest');
const feats = req ? req[1] : '';
ok(/default-features = false/.test(feats), '关掉了 default features');
ok(/"json"/.test(feats), '勾选了 json');
ok(/"native-tls"/.test(feats), '勾选了 native-tls（Windows 走 schannel，不需要 C 工具链）');
ok(!/rustls/.test(feats), '🔴 features 里没有 rustls（reqwest 0.13 的 default-tls 就是它，会拉 aws-lc-rs）');
ok(!/default-tls/.test(feats), '🔴 没有勾 default-tls（它就是 rustls 的别名）');

/* ---------------- [6] 前端接线 ---------------- */
log('');
log('================= [6] 前端接线 =================');

const aiSrc = H.readRel('web/js/ai.js');
const ilSrc = H.readRel('web/js/tools/internlog.js');
ok(/async function aiCall\(/.test(aiSrc), 'ai.js 提供 aiCall');
ok(/async function aiConfigDialog\(/.test(aiSrc), 'ai.js 提供 aiConfigDialog');
ok(/function aiResultOverlay\(/.test(aiSrc), 'ai.js 提供 aiResultOverlay');
ok(/type: 'password'/.test(aiSrc), '配置弹层用 type:password 收 Key');
ok(/invoke\('ai_chat'/.test(aiSrc), 'aiCall 调的是 ai_chat 命令');
ok(/apiKey: r\.apiKey \? String\(r\.apiKey\) : null/.test(aiSrc),
  'Key 留空 → 传 null（不改动现有 Key）');
ok(/<button class="btn btn-sm il-rp-ai">AI 润色成周报<\/button>/.test(ilSrc),
  'internlog 周报面板里有「AI 润色成周报」按钮');
ok(/aiCall\(AiCore\.SYSTEM_PROMPT, user/.test(ilSrc), '入口用的是 AiCore.SYSTEM_PROMPT');
ok(/AiCore\.chunkLogs\(all, 12000\)/.test(ilSrc), '入口做了 12000 字符的上下文控制');
ok(/AppStore\.get\('ai:notice', false\)/.test(ilSrc),
  '首次使用会弹隐私确认（记 ai:notice，之后不再打扰）');
ok(/btn\.disabled = true/.test(ilSrc) && /生成中…/.test(ilSrc),
  '生成期间按钮置灰（而不是再开一个遮罩）');
/* 项目约定：不用 window.prompt / window.confirm（桌面端是 no-op） */
ok(!/window\.confirm\(|window\.prompt\(/.test(aiSrc + ilSrc),
  '没有使用 window.confirm / window.prompt');

log('');
R.finish();
