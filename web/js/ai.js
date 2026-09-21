'use strict';

/* ============================================================
 * AI 通用底座（第一档）
 *
 * 这里只有三样东西：
 *   · AiCore      —— 纯逻辑（TESTABLE 段），node 侧可全覆盖
 *   · aiCall()    —— 统一调用入口，所有 AI 功能都走它
 *   · 配置弹层 / 结果弹层
 *
 * 🔴 为什么 Key 不在前端：
 *   它由 Rust 侧从 `data/ai/secret.json` 读出来直接放进请求头，
 *   **前端从头到尾拿不到明文**。`ai_config_get` 只回 has_key + 尾 4 位。
 *   而且 `AppStore.exportAll()` 是"把内存里所有键原样搬运"、无任何过滤，
 *   所以 Key 只要不进 AppStore 就永远导不出去（store.js 里还有一道
 *   NEVER_EXPORT 闸门兜底）。
 * ============================================================ */

/* ===TESTABLE:AiCore:begin=== */
/* 与 QuizCore / DefectCore 同定位：**不引用 AppStore / document / window / esc**，
 * 所以 tools/verify-ai.js 能把整段抽进 vm 跑。
 * 当前时间一律由调用方传入（或压根不取），否则"本周"这类相对口径钉不住。 */
const AiCore = (function () {
  /* 四个固定小标题 —— 前端靠它切段，模型靠它组织输出。
   * 🔴 第一档**刻意不用 JSON**：模型多写一句"好的，以下是…"、或把整段包进围栏，
   *    JSON.parse 就崩；而固定小标题是人类和模型都稳定的约定。
   *    真出问题时 raw 原文仍然完整可看，功能不会因为"模型不听话"而报废。 */
  const SECTIONS = ['润色后的周报', '本周成果', '待办 / 下周计划', '状态点评'];

  const SYSTEM_PROMPT = [
    '你是实习周报助手。',
    '只输出下面四个小标题段，不要任何开场白、结尾语或额外说明。',
    '标题必须原样使用【】（不要改成 Markdown 标题、不要加粗、不要包进代码块）：',
    '【润色后的周报】【本周成果】【待办 / 下周计划】【状态点评】',
    '【润色后的周报】写成连贯的书面段落，200~400 字，按工作内容分段；',
    '【本周成果】3~6 条，每条一行、以「- 」开头；',
    '【待办 / 下周计划】3~5 条，每条一行、以「- 」开头；',
    '【状态点评】100 字以内，结合效率评分给出客观评价，不夸张、不喊口号。',
    '不得编造日志里没有的事实；信息不足就直接少写，不要凑字数。'
  ].join('\n');

  function moodOf(l) {
    const m = Math.round(+((l && l.mood) || 0));
    return (m >= 1 && m <= 5) ? m : 0;
  }

  /* 周报素材的统计口径。与热力图/趋势图一致：一篇一个 mood，不做同日合并
   * （这里统计的是"这批日志"的分布，不是"每天"的分布）。 */
  function weeklyStats(items) {
    const list = (items || []).filter(Boolean);
    let rated = 0, unrated = 0, sum = 0, max = 0, min = 0;
    const days = {};
    list.forEach(l => {
      if (l.date) days[l.date] = true;
      const m = moodOf(l);
      if (m) {
        rated++; sum += m;
        if (m > max) max = m;
        if (!min || m < min) min = m;
      } else unrated++;
    });
    return {
      count: list.length,
      rated: rated,
      unrated: unrated,
      avg: rated ? +(sum / rated).toFixed(2) : null,
      max: rated ? max : null,
      min: rated ? min : null,
      days: Object.keys(days).length
    };
  }

  /* 按字符数从**新到旧**累积，超出就把更早的丢掉。
   * 中文大致 1 字 ≈ 0.6~1 token，12000 字接近 8k~12k token，对主流模型安全。
   * 至少保留 1 篇（哪怕它自己就超限）—— 空 prompt 比截断更糟。 */
  function chunkLogs(items, maxChars) {
    const cap = maxChars || 12000;
    const list = (items || []).filter(Boolean).slice().sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;          // 无日期的排最后（它们是"还没归置"的）
      if (!b.date) return -1;
      return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    });
    const kept = [];
    let used = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const len = String(l.text || '').length
        + (l.remarks || []).reduce((a, r) => a + String((r && r.text) || '').length, 0)
        + 40;                          // 日期/星期/效率/标签这些头部的粗略开销
      if (kept.length && used + len > cap) break;
      used += len;
      kept.push(l);
    }
    return {
      items: kept,
      omitted: list.length - kept.length,
      truncated: kept.length < list.length,
      used: used
    };
  }

  function fmtWeekday(dateKey) {
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
    const y = +dateKey.slice(0, 4), m = +dateKey.slice(5, 7), d = +dateKey.slice(8, 10);
    const dt = new Date(y, m - 1, d);
    /* 2026-02-31 会被 Date 顺延，回头核对一下，别让它算出个星期几来 */
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    return wd[dt.getDay()];
  }

  /* 拼 user prompt。信息尽量"自足"：只给模型它自己推不出来的东西
   * （日期、效率、标签），正文原样给。 */
  function buildUserPrompt(items, from, to, stats) {
    const s = stats || weeklyStats(items);
    const head = '日期范围：' + from + ' ~ ' + to + '\n'
      + '共 ' + s.count + ' 篇（有评分 ' + s.rated + ' 篇，未评 ' + s.unrated + ' 篇）'
      + (s.avg != null ? '；平均效率 ' + s.avg + '，最高 ' + s.max + '，最低 ' + s.min : '')
      + '；有记录 ' + s.days + ' 天\n';
    const body = (items || []).filter(Boolean).map(l => {
      const m = moodOf(l);
      const wd = fmtWeekday(l.date);
      const tags = (l.tags || []).length ? ' [' + l.tags.join('][') + ']' : '';
      const rs = (l.remarks || [])
        .map(r => String((r && r.text) || '').trim())
        .filter(Boolean);
      return '--- ' + (l.date || '未填日期') + (wd ? ' ' + wd : '')
        + (m ? ' 效率 ' + m + '/5' : ' 未评效率') + tags + '\n'
        + String(l.text || '').trim()
        + (rs.length ? '\n备注：' + rs.map(t => '- ' + t).join(' ') : '');
    }).join('\n\n');
    return head + '\n' + body;
  }

  /* 把模型输出切成四段。
   * 容错规则（都要有断言钉着）：
   *   · 整段被围栏包了就剥一层
   *   · 未识别的【xxx】头 → 它的正文**并入上一段**，不丢
   *   · 头之前的前言（"好的，以下是…"）留在 pre 里，不塞进正文
   *   · 缺失的已知段留空并计入 missing；ok = missing 为空
   *   · 一个头都没有 → ok=false，但 raw 原样返回 */
  function splitSections(text) {
    const raw = String(text == null ? '' : text);
    let s = raw.trim();
    const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(s);
    if (fence) s = fence[1].trim();

    const norm = t => String(t).replace(/[\s:：]/g, '');
    const targets = SECTIONS.map(norm);
    const parts = {};
    const missing = [];
    const heads = [];
    const re = /【([^】\n]{1,20})】/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      heads.push({ name: m[1], at: m.index, end: m.index + m[0].length });
    }
    if (!heads.length) {
      SECTIONS.forEach(k => { parts[k] = ''; missing.push(k); });
      return { ok: false, parts: parts, missing: missing, pre: '', raw: raw };
    }

    const buckets = {};
    let cur = null;
    heads.forEach((h, i) => {
      const idx = targets.indexOf(norm(h.name));
      const key = idx >= 0 ? SECTIONS[idx] : cur;   // 不认识的头 → 并进上一段
      if (idx >= 0) cur = SECTIONS[idx];
      const body = s.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : s.length).trim();
      if (!key) return;                             // 第一个头就不认识 → 正文先放着，下面靠 pre 兜
      buckets[key] = buckets[key] ? buckets[key] + '\n' + body : body;
    });

    SECTIONS.forEach(k => {
      const v = (buckets[k] || '').trim();
      parts[k] = v;
      if (!v) missing.push(k);
    });
    const pre = s.slice(0, heads[0].at).trim();
    return { ok: missing.length === 0, parts: parts, missing: missing, pre: pre, raw: raw };
  }

  /* 请求体。
   * 🔴 只放 model / messages / temperature 三个字段 —— **绝不含 api_key**。
   *    Key 由 Rust 侧从独立文件读出来放进 Authorization 头，
   *    前端只负责把"要说什么"讲清楚。verify-ai.js 有断言钉这一条。 */
  function buildRequestBody(model, messages, temperature) {
    return {
      model: String(model || ''),
      messages: (messages || []).map(m => ({
        role: String((m && m.role) || ''),
        content: String((m && m.content) || '')
      })),
      temperature: temperature == null ? 0.7 : temperature
    };
  }

  return {
    SECTIONS: SECTIONS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    weeklyStats: weeklyStats,
    chunkLogs: chunkLogs,
    fmtWeekday: fmtWeekday,
    buildUserPrompt: buildUserPrompt,
    splitSections: splitSections,
    buildRequestBody: buildRequestBody
  };
})();
/* ===TESTABLE:AiCore:end=== */

/* 桌面端才有 Rust 后端；浏览器里跑（file:// 直接打开调试）时给个明确提示，
 * 而不是让 invoke 抛个看不懂的错。 */
function aiAvailable() {
  return !!(typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core);
}

/* AI 调用统一入口。第一档只做非流式；
 * 第二档要加流式就在这里分支，调用方一行都不用改。 */
async function aiCall(systemPrompt, userText, opts) {
  const o = opts || {};
  if (!aiAvailable()) {
    showToast('AI 功能需要桌面端（浏览器里没有 Rust 后端）');
    return null;
  }
  try {
    return await window.__TAURI__.core.invoke('ai_chat', {
      messages: [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userText || '') }
      ],
      temperature: o.temperature == null ? 0.7 : o.temperature
    });
  } catch (e) {
    /* Rust 侧已经把 401 / 429 / 超时 / 连不上分好类了，直接透传那句话 */
    showToast(String((e && e.message) || e));
    return null;
  }
}

async function aiConfigGet() {
  if (!aiAvailable()) return null;
  try { return await window.__TAURI__.core.invoke('ai_config_get'); } catch (e) { return null; }
}

/* 配置弹层。用现成的 askForm —— 它把 `type` 直接透传给 <input>（ui.js:63），
 * 所以 type:'password' 开箱可用，不用改 ui.js。
 * 留空 = 不改动现有 Key（Rust 侧 api_key: None 的语义）。 */
async function aiConfigDialog() {
  const cur = (await aiConfigGet()) ||
    { endpoint: '', model: '', has_key: false, key_tail: '' };
  const r = await askForm('AI 配置', [
    { key: 'endpoint', label: '接口地址（OpenAI 兼容）', value: cur.endpoint || '',
      placeholder: 'https://api.deepseek.com/v1' },
    { key: 'model', label: '模型名', value: cur.model || '', placeholder: 'deepseek-chat' },
    { key: 'apiKey',
      label: 'API Key' + (cur.has_key ? '（当前 ****' + (cur.key_tail || '') + '，留空表示不改）' : ''),
      type: 'password', placeholder: 'sk-…' }
  ]);
  if (!r) return false;
  try {
    await window.__TAURI__.core.invoke('ai_config_set', {
      endpoint: String(r.endpoint || '').trim(),
      model: String(r.model || '').trim(),
      apiKey: r.apiKey ? String(r.apiKey) : null
    });
    showToast('AI 配置已保存');
    return true;
  } catch (e) {
    showToast('保存失败：' + String((e && e.message) || e));
    return false;
  }
}

/* 结果弹层。
 * ⚠️ uiOverlay 同一时刻只允许一个遮罩，所以**生成期间不要开遮罩**
 *    （调用方改成把按钮置灰），成功之后再开这个。
 * 🔴 无论如何都把 raw 原文放在「原始输出」可折叠区里 ——
 *    哪怕模型没按小标题输出，用户也能直接用原文。
 * `onFill` 由调用方传（本模块不认识 internlog），不传就不显示「填入周报框」。 */
function aiResultOverlay(reply, onFill) {
  const parsed = AiCore.splitSections(reply && reply.text);
  const used = reply && reply.prompt_tokens
    ? '<div class="hint" style="margin-top:8px">用量：输入 ' + (reply.prompt_tokens || 0)
      + ' / 输出 ' + (reply.completion_tokens || 0) + ' tokens</div>'
    : '';
  const body = AiCore.SECTIONS.map(k => {
    const v = parsed.parts[k];
    return '<div style="margin:10px 0 0"><div style="font-weight:600;margin-bottom:2px">'
      + esc(k) + (v ? '' : ' <span class="hint">（模型没给这一段）</span>') + '</div>'
      + '<div style="white-space:pre-wrap;line-height:1.7">' + esc(v || '') + '</div></div>';
  }).join('');
  const warn = parsed.ok ? ''
    : '<div class="hint" style="color:var(--err);margin-top:8px">⚠ 模型没有完整按四个小标题输出，'
      + '缺失：' + esc(parsed.missing.join('、')) + '。下面「原始输出」里是完整原文。</div>';
  const pre = parsed.pre
    ? '<div class="hint" style="margin-top:6px">模型开头还写了：' + esc(parsed.pre.slice(0, 200)) + '</div>'
    : '';
  const o = uiOverlay(
    '<div style="font-weight:600">AI 周报草稿</div>' + body + warn + pre + used
    + '<details style="margin-top:12px"><summary class="hint" style="cursor:pointer">原始输出 ▾</summary>'
    + '<pre style="white-space:pre-wrap;font-size:12px;max-height:220px;overflow:auto;'
    + 'margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:6px">'
    + esc(parsed.raw) + '</pre></details>'
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<button class="btn btn-primary" data-aicopy>复制</button>'
    + (typeof onFill === 'function' ? '<button class="btn" data-aifill>填入周报框</button>' : '')
    + '<button class="btn" data-uiclose>关闭</button></div>'
  );
  o.card.querySelector('[data-aicopy]').addEventListener('click', async () => {
    showToast(await copyText(parsed.raw) ? '已复制 AI 原文' : '复制失败');
  });
  if (typeof onFill === 'function') {
    o.card.querySelector('[data-aifill]').addEventListener('click', () => {
      /* 填充而不是自动覆盖保存 —— 用户接着用现有的「存 .md / 存 HTML / 复制周报」，
       * 导出链与「缺失周报」标记逻辑全部复用，这里一行导出代码都不用新写。 */
      onFill(parsed.raw);
      uiCloseModal();
    });
  }
  o.card.querySelector('[data-uiclose]').addEventListener('click', uiCloseModal);
  return parsed;
}
