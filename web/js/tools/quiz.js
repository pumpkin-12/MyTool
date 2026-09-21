'use strict';

/* ===TESTABLE:QuizCore:begin=== */
/* ============================================================
 * 工具 10：刷题 —— 领域逻辑（QuizCore）
 *
 * 这一层与界面完全解耦，只做数据进出，不碰 DOM。
 * 移植自 quiz-app 的 Spring Boot 后端（QuizService / QuestionService /
 * StatsService / WrongQuestionService），规则逐条对齐。
 *
 * 刻意保留的两个易漏点：
 *   1. 判断题答案是两个版本的归一化 —— 写入时严格（认不出来就报错），
 *      读取时宽松（认不出来一律当 B）。历史数据里有 对/错/正确/错误/TRUE/F
 *      这些写法，两个版本都要有，否则要么导入报错要么判题全错。
 *   2. 正确率的分母只算「可判题」（choice + truefalse），填空和简答
 *      既不判分也不进分母。
 * ============================================================ */
const QuizCore = (function () {
  const TYPES = ['choice', 'truefalse', 'fill', 'essay'];
  const TYPE_LABEL = { choice: '选择题', truefalse: '判断题', fill: '填空题', essay: '简答题' };
  const MODE_ORDER = ['order', 'random', 'exam', 'custom', 'wrong'];
  const MODE_NAMES = { order: '顺序刷题', random: '随机抽题', exam: '模拟考试', custom: '自定义答题', wrong: '错题重做' };

  /* 只有这两种题型参与判分与正确率统计 */
  function isJudged(type) { return type === 'choice' || type === 'truefalse'; }

  /* 写入时：严格。认不出来直接报错，避免脏数据进库
   * （对应 QuestionService.normalizeTrueFalseAnswer） */
  function normalizeTFStrict(answer) {
    const raw = String(answer == null ? '' : answer).trim();
    if (!raw) throw new Error('判断题答案不能为空');
    const upper = raw.toUpperCase();
    if (upper === 'A' || upper === 'B') return upper;
    if (raw === '对' || raw === '正确' || upper === 'TRUE' || upper === 'T') return 'A';
    if (raw === '错' || raw === '错误' || upper === 'FALSE' || upper === 'F') return 'B';
    throw new Error('不支持的判断题答案：' + raw + '，请用 A（正确）/ B（错误）');
  }

  /* 读取时：宽松。认不出来一律当 B
   * （对应 QuizService.normalizeTrueFalseAnswer） */
  function normalizeTFLoose(answer) {
    if (answer == null) return 'B';
    const raw = String(answer);
    const upper = raw.toUpperCase();
    if (upper === 'A' || upper === 'B') return upper;
    if (raw === '对' || raw === '正确' || upper === 'TRUE' || upper === 'T') return 'A';
    return 'B';
  }

  /* 用于比对的「标准答案」 */
  function answerOf(q) {
    if (!q) return '';
    return q.type === 'truefalse' ? normalizeTFLoose(q.answer) : (q.answer == null ? '' : String(q.answer));
  }

  function sameAnswer(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

  /* 判一道题。selected 为 null（未答）时不算对 */
  function judge(q, selected) {
    const judged = !!q && isJudged(q.type);
    const correct = judged && selected != null && sameAnswer(answerOf(q), selected);
    return {
      judged: judged,
      correct: correct,
      correctAnswer: q ? q.answer : '',
      explanation: q && q.explanation ? q.explanation : ''
    };
  }

  /* 随机洗牌（Fisher-Yates）。用 Math.random，方便测试里替换成确定性序列 */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clampCount(count, size) {
    const want = (count == null || count === '') ? size : parseInt(count, 10);
    const n = isFinite(want) ? want : size;
    return Math.max(1, Math.min(n, size));
  }

  /* 新建 / 编辑题目时清洗字段。校验顺序与 Java 一致：
   * 题目非空 → 答案非空 → 题型合法 → 按题型归一化答案 */
  function normalizeQuestion(input) {
    const text = String(input && input.text != null ? input.text : '').trim();
    if (!text) throw new Error('题目内容不能为空');
    const rawAnswer = String(input && input.answer != null ? input.answer : '').trim();
    if (!rawAnswer) throw new Error('答案不能为空');
    const type = (input && input.type) || 'choice';
    if (TYPES.indexOf(type) < 0) throw new Error('不支持的题型：' + type);

    let answer;
    if (type === 'choice') {
      answer = rawAnswer.toUpperCase();
      /* 不校验的话，Excel 里答案填 E 会静默入库，而这道题永远判不对。
       * 注意要用数组 indexOf 而不是字符串 indexOf —— 后者是子串匹配，'AB' 也能混过去 */
      if (['A', 'B', 'C', 'D'].indexOf(answer) < 0) {
        throw new Error('选择题答案必须是 A / B / C / D，当前是「' + answer + '」');
      }
    }
    else if (type === 'truefalse') answer = normalizeTFStrict(rawAnswer);
    else answer = rawAnswer;

    const s = k => String(input && input[k] != null ? input[k] : '');
    return {
      type: type,
      text: text,
      category: s('category'),
      optionA: s('optionA'),
      optionB: s('optionB'),
      optionC: s('optionC'),
      optionD: s('optionD'),
      answer: answer,
      explanation: s('explanation')
    };
  }

  /* 抽题。返回本次会话的全部参数，调用方负责存进度。
   * 过滤顺序：分类 → 题型（先校验题型合法）→ 按模式选 */
  function startQuiz(opts) {
    const o = opts || {};
    const all = (o.questions || []).slice();
    if (!all.length) throw new Error('题库为空');

    let pool = all;
    if (o.category) {
      pool = pool.filter(q => q.category === o.category);
      if (!pool.length) throw new Error('所选分类下没有题目');
    }
    if (o.types && o.types.length) {
      o.types.forEach(t => { if (TYPES.indexOf(t) < 0) throw new Error('不支持的题型：' + t); });
      pool = pool.filter(q => o.types.indexOf(q.type) >= 0);
      if (!pool.length) throw new Error('所选题型下没有题目');
    }

    const mode = o.mode || 'order';
    let selected;
    let maxTime = null;
    let examCount = null;
    let customRandom = null;

    if (mode === 'exam') {
      selected = shuffle(pool).slice(0, clampCount(o.count, pool.length));
      maxTime = o.maxTime != null ? o.maxTime : null;
    } else if (mode === 'random') {
      selected = shuffle(pool);
    } else if (mode === 'custom') {
      selected = o.random ? shuffle(pool) : pool.slice();
      selected = selected.slice(0, clampCount(o.count, pool.length));
      maxTime = (o.maxTime != null && o.maxTime > 0) ? o.maxTime : null;
      customRandom = !!o.random;
      examCount = o.count != null ? o.count : null;
    } else {
      selected = pool.slice();
    }

    return {
      mode: mode,
      questions: selected,
      maxTime: maxTime,
      examCount: examCount,
      customRandom: customRandom
    };
  }

  /* 交卷计分。分母只算可判题 */
  function grade(questions, answers) {
    const list = questions || [];
    const ans = answers || [];
    const details = [];
    let correctCount = 0;
    let judgedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      const selected = i < ans.length ? ans[i] : null;
      const r = judge(q, selected);
      if (r.judged) judgedCount++;
      if (r.correct) correctCount++;
      details.push({ questionId: q ? q.id : null, selected: selected, correct: r.correct });
    }

    const totalQuestions = list.length;
    const wrongCount = judgedCount - correctCount;
    const score = judgedCount > 0 ? Math.round(correctCount * 100 / judgedCount) : 0;
    return {
      totalQuestions: totalQuestions,
      correctCount: correctCount,
      wrongCount: wrongCount,
      judgedCount: judgedCount,
      score: score,
      details: details
    };
  }

  /* 单题提交后同步错题本：答对移除、答错计数 +1 */
  function applyWrongOnAnswer(wrong, q, correct, nowIso) {
    const list = (wrong || []).map(w => Object.assign({}, w));
    const i = list.findIndex(w => w.questionId === q.id);
    if (correct) {
      if (i >= 0) list.splice(i, 1);
      return { list: list, wrongCount: 0 };
    }
    if (i >= 0) {
      list[i].wrongCount = (list[i].wrongCount || 0) + 1;
      list[i].lastWrongAt = nowIso;
      return { list: list, wrongCount: list[i].wrongCount };
    }
    list.push({ questionId: q.id, wrongCount: 1, lastWrongAt: nowIso });
    return { list: list, wrongCount: 1 };
  }

  /* 交卷时同步错题本：只补录「答错或未答」的可判题，不重复添加、不改已有计数。
   * 这一步很容易漏 —— 漏了的话，考卷里没做的题不会进错题本。
   * 用 Set 记已存在的 id，避免每题都线性扫一遍错题本（题库上千题时是 O(n·m)）。 */
  function syncWrongOnSubmit(wrong, questions, answers, nowIso) {
    const list = (wrong || []).map(w => Object.assign({}, w));
    const known = new Set(list.map(w => w.questionId));
    const ans = answers || [];
    (questions || []).forEach((q, i) => {
      if (!q || !isJudged(q.type)) return;
      const selected = i < ans.length ? ans[i] : null;
      if (selected != null && sameAnswer(answerOf(q), selected)) return;
      if (!known.has(q.id)) {
        known.add(q.id);
        list.push({ questionId: q.id, wrongCount: 1, lastWrongAt: nowIso });
      }
    });
    return list;
  }

  /* 统计汇总。accuracyRate 保留两位小数；历史记录没有 judgedCount 时回退用 totalQuestions */
  function stats(questions, records, wrong) {
    const qs = questions || [];
    const rs = records || [];
    const totalAttempts = rs.length;

    let cumulativeAnswered = 0, cumulativeCorrect = 0, cumulativeJudged = 0, cumulativeTime = 0;
    let scoreSum = 0, bestScore = 0;
    const byMode = {};

    rs.forEach(r => {
      const total = r.totalQuestions || 0;
      cumulativeAnswered += total;
      cumulativeCorrect += r.correctCount || 0;
      cumulativeJudged += (r.judgedCount != null && r.judgedCount > 0) ? r.judgedCount : total;
      cumulativeTime += r.elapsedSeconds || 0;
      const sc = r.score || 0;
      scoreSum += sc;
      if (sc > bestScore) bestScore = sc;
      const m = r.mode || 'order';
      (byMode[m] = byMode[m] || []).push(sc);
    });

    const accuracyRate = cumulativeJudged > 0
      ? Math.round(cumulativeCorrect * 10000 / cumulativeJudged) / 100
      : 0;
    const avgScore = totalAttempts > 0 ? Math.round(scoreSum / totalAttempts) : 0;

    const modeStats = MODE_ORDER.filter(m => byMode[m] && byMode[m].length).map(m => {
      const arr = byMode[m];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { mode: m, modeName: MODE_NAMES[m] || m, count: arr.length, avgScore: Math.round(avg * 10) / 10 };
    });

    return {
      totalQuestions: qs.length,
      wrongCount: (wrong || []).length,
      totalAttempts: totalAttempts,
      cumulativeAnswered: cumulativeAnswered,
      cumulativeCorrect: cumulativeCorrect,
      cumulativeJudged: cumulativeJudged,
      accuracyRate: accuracyRate,
      avgScore: avgScore,
      bestScore: bestScore,
      cumulativeTime: cumulativeTime,
      modeStats: modeStats
    };
  }

  /* 按题型分布，用于答题页顶部的题库概览 */
  function typeDistribution(questions) {
    const map = {};
    (questions || []).forEach(q => { map[q.type] = (map[q.type] || 0) + 1; });
    return TYPES.map(t => ({ type: t, label: TYPE_LABEL[t], count: map[t] || 0 }));
  }

  /* 题库里已有的分类，去重后排序。
   * 用码点排序而不是 localeCompare —— 按拼音排会把「第二章」排在「第一章」前面，
   * 而码点排序对「第N章」这类命名恰好是自然顺序，也和原数据库的 ORDER BY 一致。 */
  function categories(questions) {
    const set = [];
    (questions || []).forEach(q => {
      const c = q.category;
      if (c && set.indexOf(c) < 0) set.push(c);
    });
    return set.sort();
  }

  /* 下一个可用 id（本地没有自增主键，用现有最大值 +1） */
  function nextId(list) {
    let max = 0;
    (list || []).forEach(x => { const n = parseInt(x && x.id, 10); if (isFinite(n) && n > max) max = n; });
    return max + 1;
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? (h + ':' + p(m) + ':' + p(ss)) : (p(m) + ':' + p(ss));
  }

  return {
    TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, MODE_ORDER: MODE_ORDER, MODE_NAMES: MODE_NAMES,
    isJudged: isJudged,
    normalizeTFStrict: normalizeTFStrict,
    normalizeTFLoose: normalizeTFLoose,
    answerOf: answerOf,
    judge: judge,
    shuffle: shuffle,
    normalizeQuestion: normalizeQuestion,
    startQuiz: startQuiz,
    grade: grade,
    applyWrongOnAnswer: applyWrongOnAnswer,
    syncWrongOnSubmit: syncWrongOnSubmit,
    stats: stats,
    typeDistribution: typeDistribution,
    categories: categories,
    nextId: nextId,
    fmtDuration: fmtDuration
  };
})();
/* ===TESTABLE:QuizCore:end=== */

/* ============================================================
 * 工具 10：刷题
 *
 * 四种模式（顺序 / 随机 / 模拟考试 / 自定义）、题型分 Tab 的题库管理、
 * 错题本、答题记录、成绩统计。领域规则全部在上方 QuizCore，这里只管界面。
 *
 * 数据存 AppStore，key 前缀 quiz:*：
 *   quiz:questions  题库
 *   quiz:records    答题记录
 *   quiz:wrong      错题本（带答错次数）
 *   quiz:progress   未完成的答题进度（单份，恢复用）
 * ============================================================ */
registerTool({
  id: 'quiz',
  name: '刷题',
  desc: '题库 · 顺序/随机/模拟/自定义 · 错题本 · Excel 导入',
  color: '#1D9E75',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5h5a1 1 0 0 1 1 1v1.2a1 1 0 0 0 .6.92l1.3.55a2 2 0 0 1 1.1 1.1l.55 1.3a1 1 0 0 0 .92.6h1.2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1.2a1 1 0 0 0-.92.6l-.55 1.3a2 2 0 0 1-1.1 1.1l-1.3.55a1 1 0 0 0-.6.92v1.2a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-1.2a1 1 0 0 0-.6-.92l-1.3-.55a2 2 0 0 1-1.1-1.1l-.55-1.3a1 1 0 0 0-.92-.6H2.8a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1H4a1 1 0 0 0 .92-.6l.55-1.3a2 2 0 0 1 1.1-1.1l1.3-.55a1 1 0 0 0 .6-.92V4.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="12" r="3.2"/></svg>',
  mount(el) {
    /* ---------- 数据 ---------- */
    let questions = AppStore.get('quiz:questions', []);
    let records = AppStore.get('quiz:records', []);
    let wrong = AppStore.get('quiz:wrong', []);
    let progress = AppStore.get('quiz:progress', null);

    function saveData() {
      /* 三个 key 合并成一次写盘，避免把「全量 stringify + 全量写盘」重复三遍 */
      AppStore.setMany({
        'quiz:questions': questions,
        'quiz:records': records,
        'quiz:wrong': wrong
      });
    }
    function nextQid() { return QuizCore.nextId(questions); }
    /* 按 id 建索引，避免循环里反复 questions.find（题库大时是 O(n²)） */
    function qById() { return new Map(questions.map(q => [q.id, q])); }

    /* 从进行中的会话里同步移除已删除的题目。
     * 不做的话：交卷时 syncWrongOnSubmit 会把已删题的 id 写进错题本，
     * 界面上看不到（viewWrong 会过滤），但数据在存档里永久残留。 */
    function removeFromSession(ids) {
      if (!session) return;
      const keep = [], ans = [];
      session.questions.forEach((q, i) => {
        if (!ids.has(q.id)) {
          keep.push(q);
          ans.push(session.answers[i] != null ? session.answers[i] : null);
        }
      });
      session.questions = keep;
      session.answers = ans;
      if (session.currentIndex >= keep.length) session.currentIndex = Math.max(0, keep.length - 1);
    }

    /* ---------- 界面状态 ---------- */
    let tab = 'dash';
    let session = null;      // { mode, questions, answers, currentIndex, elapsed, maxTime, startTime }
    let result = null;       // 最近一次交卷结果 { grade, mode, elapsed }
    let timer = null;
    let bankTab = 'choice', bankCat = '', bankSearch = '';
    let editForm = null;     // { mode:'add'|'edit', id, data }
    let importType = null;
    let fileInput = null;
    let recordOpen = null;

    el.innerHTML = '<div></div>';
    const root = el.firstElementChild;

    function tag(text, cls) { return '<span class="qz-tag' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
    /* 正确/错误题型的答案归一化成 A/B，但界面对外展示用「正确/错误」更直观 */
    function answerLabel(q, ans) { return q.type === 'truefalse' ? (ans === 'A' ? '正确' : '错误') : ans; }
    function typeTag(t) { return tag(QuizCore.TYPE_LABEL[t] || t); }

    function setTab(t) { tab = t; render(); }

    function startTimer() {
      stopTimer();
      if (!session || !session.maxTime) return;
      timer = setInterval(() => {
        session.elapsed = Math.round((Date.now() - session.startTime) / 1000);
        const left = session.maxTime - session.elapsed;
        const el2 = root.querySelector('[data-timer]');
        if (el2) {
          el2.textContent = '剩余 ' + QuizCore.fmtDuration(Math.max(0, left));
          el2.classList.toggle('warn', left <= 60);
        }
        if (left <= 0) { stopTimer(); submitQuiz(); }
      }, 1000);
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    /* ================= 渲染入口 ================= */
    function render() {
      /* 防御：tab 若为未知值（例如误绑定把 tab 设成 undefined），回落仪表盘，绝不留下空白面板 */
      if (['dash', 'quiz', 'bank', 'wrong', 'records', 'stats'].indexOf(tab) < 0) tab = 'dash';
      root.innerHTML =
        '<div class="tabs">' +
          tabButtons([['dash', '仪表盘'], ['quiz', '答题'], ['bank', '题库'],
            ['wrong', '错题本'], ['records', '记录'], ['stats', '统计']], tab) +
        '</div>' +
        '<div data-panel></div>';
      const panel = root.querySelector('[data-panel]');
      if (tab === 'dash') panel.innerHTML = viewDash();
      else if (tab === 'quiz') panel.innerHTML = viewQuiz();
      else if (tab === 'bank') { panel.innerHTML = viewBank(); bindBank(); }
      else if (tab === 'wrong') panel.innerHTML = viewWrong();
      else if (tab === 'records') panel.innerHTML = viewRecords();
      else if (tab === 'stats') panel.innerHTML = viewStats();
      /* 只绑主标签。题库题型按钮同样用了 .tab 做样式，但它们带的是 data-bank-tab；
       * 不限定 [data-tab] 的话点题型会把 tab 设成 undefined → 面板留空（白屏）。 */
      root.querySelectorAll('.tab[data-tab]').forEach(b =>
        b.addEventListener('click', () => setTab(b.dataset.tab)));
      if (tab === 'quiz') bindQuiz();
      if (tab === 'wrong') bindWrong();
      if (tab === 'records') bindRecords();
      if (tab === 'dash') bindDash();
    }

    /* ================= 仪表盘 ================= */
    function viewDash() {
      const s = QuizCore.stats(questions, records, wrong);
      let html =
        '<div class="stats">' +
          statCard('题库总数', s.totalQuestions) +
          statCard('错题数', s.wrongCount) +
          statCard('答题次数', s.totalAttempts) +
          statCard('累计作答', s.cumulativeAnswered) +
          statCard('正确率', s.accuracyRate + '%') +
          statCard('平均分', s.avgScore) +
          statCard('最高分', s.bestScore) +
          statCard('累计用时', QuizCore.fmtDuration(s.cumulativeTime)) +
        '</div>';
      if (s.modeStats.length) {
        html += '<div class="qz-tbl-wrap"><table class="qz-tbl"><thead><tr>' +
          '<th>模式</th><th>次数</th><th>平均分</th></tr></thead><tbody>' +
          s.modeStats.map(m => '<tr><td>' + esc(m.modeName) + '</td><td>' + m.count + '</td><td>' + m.avgScore + '</td></tr>').join('') +
          '</tbody></table></div>';
      }
      const dist = QuizCore.typeDistribution(questions);
      html += '<div class="bar" style="margin-top:16px;">' +
        '<span class="hint">题库分布：</span>' +
        dist.map(d => tag(d.label + ' ' + d.count, d.count ? '' : '')).join(' ') +
        '<span class="sp">共 ' + questions.length + ' 题</span></div>';
      if (progress) {
        html += '<div class="qz-q" style="margin-top:8px;"><div class="bar" style="margin:0;">' +
          '<span>' + tag('有未完成的答题') + '</span>' +
          '<span class="hint">' + esc(QuizCore.MODE_NAMES[progress.mode] || progress.mode) +
          ' · 进度 ' + ((progress.currentIndex || 0) + 1) + '/' + (progress.questionIds || []).length + '</span>' +
          '<button class="btn btn-sm" data-act="resume">继续</button>' +
          '<button class="btn btn-sm" data-act="drop">放弃</button></div></div>';
      }
      return html;
    }
    function bindDash() {
      const r = root.querySelector('[data-act="resume"]');
      if (r) r.addEventListener('click', resumeProgress);
      const d = root.querySelector('[data-act="drop"]');
      if (d) d.addEventListener('click', () => { progress = null; AppStore.set('quiz:progress', null); render(); });
    }

    /* ================= 答题 ================= */
    function viewQuiz() {
      if (result) return viewResult();
      if (!session) return viewModes();
      return viewActive();
    }

    function viewModes() {
      const dist = QuizCore.typeDistribution(questions);
      const modes = [
        ['order', '顺序刷题', '按题库顺序逐题练习'],
        ['random', '随机抽题', '随机抽取全部题目'],
        ['exam', '模拟考试', '限时作答，自动评分'],
        ['custom', '自定义答题', '自定题量、随机、限时、筛选题型']
      ];
      let html = '<div class="bar"><span class="hint">题库分布：</span>' +
        dist.map(d => tag(d.label + ' ' + d.count)).join(' ') +
        '<span class="sp">共 ' + questions.length + ' 题</span></div>';
      html += '<div class="qz-modes">' + modes.map(m =>
        '<div class="qz-mode" data-mode="' + m[0] + '"><div class="t">' + m[1] + '</div><div class="d">' + m[2] + '</div></div>').join('') + '</div>';
      html += '<div class="hint">顺序 / 随机会先让你选分类；模拟考试和自定义答题在点击后填写参数。</div>';
      return html;
    }

    function viewActive() {
      const q = session.questions[session.currentIndex];
      const total = session.questions.length;
      const modeName = QuizCore.MODE_NAMES[session.mode] || session.mode;
      let html = '<div class="bar"><strong>' + esc(modeName) + '</strong>' +
        '<span class="hint">共 ' + total + ' 题</span>';
      if (session.maxTime) html += '<span class="qz-timer" data-timer></span>';
      html += '<span class="sp">' +
        '<button class="btn btn-sm" data-act="save">保存进度</button>' +
        '<button class="btn btn-sm" data-act="exit">退出</button></span></div>';

      let answered = 0, answeredJudged = 0, liveRight = 0;
      for (let i = 0; i < session.questions.length; i++) {
        const a = session.answers[i];
        if (a == null) continue;
        answered++;
        if (!QuizCore.isJudged(session.questions[i].type)) continue;
        answeredJudged++;
        if (QuizCore.judge(session.questions[i], a).correct) liveRight++;
      }
      html += '<div class="bar"><span class="hint">已答 ' + answered + '/' + total +
        '</span><span class="hint">可判题 ' + answeredJudged + '</span>' +
        '<span class="hint">答对 ' + liveRight + '</span></div>';

      html += '<div class="qz-q"><div class="bar" style="margin:0 0 10px;">' +
        '<span class="hint">第 ' + (session.currentIndex + 1) + ' / ' + total + ' 题</span>' +
        typeTag(q.type) + (q.category ? tag(q.category) : '') + '</div>' +
        '<div class="qz-qtext">' + esc(q.text) + '</div>' + optionsHtml(q) + '</div>';

      if (q.type === 'fill' || q.type === 'essay') {
        html += '<textarea class="field" rows="4" data-free placeholder="在此作答（不自动判分）"></textarea>';
      } else if (session.currentIndex === total - 1) {
        html += '<div class="bar"><button class="btn btn-primary" data-act="submit">提交</button></div>';
      }

      html += '<div class="bar" style="margin-top:12px;">' +
        '<button class="btn" data-act="prev"' + (session.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>' +
        (session.currentIndex < total - 1
          ? '<button class="btn btn-primary" data-act="next">下一题</button>'
          : '') +
        (session.currentIndex === total - 1 ? '' :
          (isLastAnswered() ? '<button class="btn btn-primary" data-act="submit">查看结果</button>' : '')) +
        '</div>';
      html += '<div class="qz-grid">' + session.questions.map((qq, i) =>
        '<button class="qz-cell' + (session.answers[i] != null ? ' ans' : '') +
        (i === session.currentIndex ? ' cur' : '') + '" data-cell="' + i + '">' + (i + 1) + '</button>').join('') + '</div>';
      return html;
    }

    function isLastAnswered() {
      const last = session.questions.length - 1;
      return session.currentIndex === last && session.answers[last] != null;
    }

    function optionsHtml(q) {
      if (q.type !== 'choice' && q.type !== 'truefalse') return '';
      const opts = q.type === 'choice'
        ? [['A', q.optionA], ['B', q.optionB], ['C', q.optionC], ['D', q.optionD]]
        : [['A', '正确'], ['B', '错误']];
      const sel = session.answers[session.currentIndex];
      const done = sel != null;
      const res = done ? QuizCore.judge(q, sel) : null;
      return opts.filter(o => o[1] != null && o[1] !== '').map(o => {
        let cls = 'qz-opt';
        if (done) {
          if (o[0] === res.correctAnswer) cls += ' ok';
          else if (o[0] === sel && !res.correct) cls += ' bad';
        } else if (o[0] === sel) cls += ' on';
        return '<div class="' + cls + '" data-opt="' + o[0] + '"><span class="k">' + o[0] + '.</span><span class="v">' +
          esc(o[1]) + '</span></div>';
      }).join('') + (done
        ? '<div class="hint" style="margin-top:8px;">' + (res.correct ? '回答正确' : '回答错误，正确答案 ' + answerLabel(q, res.correctAnswer)) +
          (res.explanation ? '<br>解析：' + esc(res.explanation) : '') + '</div>'
        : '');
    }

    function viewResult() {
      const g = result.grade;
      const modeName = QuizCore.MODE_NAMES[result.mode] || result.mode;
      const byId = qById();
      let html = '<div class="stats">' +
        '<div><div class="k">模式</div><div class="v" style="font-size:16px;">' + esc(modeName) + '</div></div>' +
        '<div><div class="k">得分</div><div class="v">' + g.score + '</div></div>' +
        '<div><div class="k">正确</div><div class="v" style="color:var(--ok);">' + g.correctCount + '</div></div>' +
        '<div><div class="k">错误</div><div class="v" style="color:var(--err);">' + g.wrongCount + '</div></div>' +
        '<div><div class="k">可判题</div><div class="v">' + g.judgedCount + '</div></div>' +
        '<div><div class="k">总题数</div><div class="v">' + g.totalQuestions + '</div></div>' +
        '<div><div class="k">用时</div><div class="v" style="font-size:16px;">' + QuizCore.fmtDuration(result.elapsed) + '</div></div>' +
        '</div>';
      html += '<table class="qz-tbl"><thead><tr><th class="num">#</th><th>题目</th><th>你的答案</th><th>正确答案</th><th>判定</th></tr></thead><tbody>';
      g.details.forEach((d, i) => {
        const q = byId.get(d.questionId);
        html += '<tr><td class="num">' + (i + 1) + '</td><td>' + (q ? esc(q.text) : '<em>已删除</em>') +
          '</td><td>' + (d.selected == null || d.selected === '' ? '<span class="hint">未答</span>' : esc(q ? answerLabel(q, d.selected) : d.selected)) +
          '</td><td>' + (q ? esc(answerLabel(q, q.answer)) : '<em>—</em>') +
          '</td><td>' + (d.correct ? tag('对', 'ok') : tag('错', 'bad')) + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<div class="bar" style="margin-top:14px;">' +
        '<button class="btn" data-act="again">再来一次</button>' +
        '<button class="btn btn-primary" data-act="back">返回模式选择</button></div>';
      return html;
    }

    function bindQuiz() {
      root.querySelectorAll('[data-mode]').forEach(b =>
        b.addEventListener('click', () => onModeClick(b.dataset.mode)));
      root.querySelectorAll('[data-act]').forEach(b => {
        const a = b.dataset.act;
        if (a === 'save') b.addEventListener('click', saveProgress);
        else if (a === 'exit') b.addEventListener('click', exitQuiz);
        else if (a === 'prev') b.addEventListener('click', () => { commitFree(); go(-1); });
        else if (a === 'next') b.addEventListener('click', () => { commitFree(); go(1); });
        else if (a === 'submit') b.addEventListener('click', () => { commitFree(); requestSubmit(); });
        else if (a === 'again') b.addEventListener('click', () => { result = null; render(); });
        else if (a === 'back') b.addEventListener('click', () => { result = null; session = null; render(); });
      });
      root.querySelectorAll('[data-opt]').forEach(o =>
        o.addEventListener('click', () => choose(o.dataset.opt)));
      root.querySelectorAll('[data-cell]').forEach(c =>
        c.addEventListener('click', () => { commitFree(); session.currentIndex = parseInt(c.dataset.cell, 10); render(); }));
      const free = root.querySelector('[data-free]');
      if (free) {
        free.value = session.answers[session.currentIndex] || '';
        free.addEventListener('input', () => { session.answers[session.currentIndex] = free.value; });
        free.addEventListener('blur', commitFree);
      }
      if (session && session.maxTime) startTimer();
    }

    function commitFree() { /* 自由作答的内容在 input 时已写回，这里仅占位以统一入口 */ }

    /* 模式入口。原来用 window.prompt，桌面 WebView 里 prompt 未实现会直接返回 null，
     * 表现为「点了没反应」；现在统一走应用内表单框。 */
    async function onModeClick(mode) {
      const cats = QuizCore.categories(questions);
      if (!questions.length) { showToast('题库是空的，先去「题库」导入题目'); return; }
      const catOptions = [{ value: '', label: '全部分类' }].concat(cats.map(c => ({ value: c, label: c })));

      if (mode === 'order' || mode === 'random') {
        const v = await askForm(QuizCore.MODE_NAMES[mode], [
          { key: 'category', label: '分类筛选', type: 'select', options: catOptions, value: '' }
        ]);
        if (!v) return;
        begin({ mode: mode, category: v.category || '' });

      } else if (mode === 'exam') {
        const v = await askForm('模拟考试', [
          { key: 'count', label: '作答题数（1-' + questions.length + '）', type: 'number',
            value: String(Math.min(20, questions.length)) },
          { key: 'minutes', label: '限时（分钟，0 = 不限时）', type: 'number', value: '30' }
        ]);
        if (!v) return;
        begin({
          mode: 'exam',
          count: parseInt(v.count, 10),
          maxTime: Math.round(parseFloat(v.minutes || '0') * 60)
        });

      } else if (mode === 'custom') {
        const v = await askForm('自定义答题', [
          { key: 'category', label: '分类筛选', type: 'select', options: catOptions, value: '' },
          { key: 'types', label: '题型（不勾 = 全部题型）', type: 'checks',
            options: QuizCore.TYPES.map(t => ({ value: t, label: QuizCore.TYPE_LABEL[t] })),
            value: ['choice', 'truefalse'] },
          { key: 'count', label: '题量', type: 'number', value: '10' },
          { key: 'random', label: '随机打乱', type: 'select',
            options: [{ value: 'y', label: '是' }, { value: 'n', label: '否' }], value: 'y' },
          { key: 'minutes', label: '限时（分钟，0 = 不限时）', type: 'number', value: '0' }
        ]);
        if (!v) return;
        begin({
          mode: 'custom',
          category: v.category || '',
          types: v.types || [],
          count: parseInt(v.count, 10),
          random: v.random !== 'n',
          maxTime: Math.round(parseFloat(v.minutes || '0') * 60)
        });
      }
    }

    function begin(opts) {
      try {
        const r = QuizCore.startQuiz(Object.assign({ questions: questions }, opts));
        session = {
          mode: r.mode,
          questions: r.questions,
          answers: new Array(r.questions.length).fill(null),
          currentIndex: 0,
          elapsed: 0,
          maxTime: r.maxTime,
          startTime: Date.now()
        };
        result = null;
        tab = 'quiz';
        render();
      } catch (e) { showToast(e.message); }
    }

    function choose(opt) {
      const q = session.questions[session.currentIndex];
      if (!QuizCore.isJudged(q.type)) return;
      if (session.answers[session.currentIndex] != null) return;   // 已作答，锁定
      session.answers[session.currentIndex] = opt;
      const res = QuizCore.judge(q, opt);
      const out = QuizCore.applyWrongOnAnswer(wrong, q, res.correct, new Date().toISOString());
      wrong = out.list;
      saveData();
      render();
    }

    function go(d) {
      const n = session.currentIndex + d;
      if (n < 0 || n >= session.questions.length) return;
      session.currentIndex = n;
      render();
    }

    function saveProgress() {
      progress = {
        mode: session.mode,
        questionIds: session.questions.map(q => q.id),
        answers: session.answers,
        currentIndex: session.currentIndex,
        /* 不现场算的话，不限时模式下 elapsed 永远是 0 —— 计时器只在 maxTime 存在时才启动 */
        elapsed: Math.round((Date.now() - session.startTime) / 1000),
        maxTime: session.maxTime,
        startTime: session.startTime
      };
      AppStore.set('quiz:progress', progress);
      showToast('进度已保存，可从仪表盘继续');
    }

    function resumeProgress() {
      if (!progress) return;
      const ids = progress.questionIds || [];
      const saved = progress.answers || [];
      /* 按 id 配对后再过滤已删除的题。直接按位置切会让答案整体错位：
       * 存进度之后删过中间某道题，第 3 题的答案就会落到第 2 题头上。 */
      const pairs = [];
      const byId = qById();   /* 一次建索引，避免逐题线性扫题库 */
      for (let i = 0; i < ids.length; i++) {
        const q = byId.get(ids[i]);
        if (q) pairs.push({ q: q, a: i < saved.length ? saved[i] : null });
      }
      if (!pairs.length) {
        showToast('保存的题目已不存在');
        progress = null;
        AppStore.set('quiz:progress', null);
        render();
        return;
      }
      session = {
        mode: progress.mode,
        questions: pairs.map(p => p.q),
        answers: pairs.map(p => p.a),
        currentIndex: Math.min(progress.currentIndex || 0, pairs.length - 1),
        elapsed: progress.elapsed || 0,
        maxTime: progress.maxTime || null,
        startTime: Date.now() - (progress.elapsed || 0) * 1000
      };
      progress = null;
      AppStore.set('quiz:progress', null);
      result = null;
      tab = 'quiz';
      render();
    }

    async function exitQuiz() {
      if (!session) return;
      if (!(await askConfirm('退出本次答题？未保存的进度将丢失。', '退出'))) return;
      stopTimer();
      session = null;
      result = null;
      render();
    }

    /* 用户主动交卷：有未答题先确认；倒计时自动交卷走 submitQuiz，不打扰 */
    async function requestSubmit() {
      if (!session) return;
      const unanswered = session.answers.filter(a => a == null).length;
      if (unanswered > 0 && !(await askConfirm('还有 ' + unanswered + ' 题未作答，确定提交？', '提交'))) return;
      submitQuiz();
    }

    function submitQuiz() {
      stopTimer();
      const elapsed = Math.round((Date.now() - session.startTime) / 1000);
      const g = QuizCore.grade(session.questions, session.answers);
      const record = {
        id: QuizCore.nextId(records),
        mode: session.mode,
        totalQuestions: g.totalQuestions,
        correctCount: g.correctCount,
        wrongCount: g.wrongCount,
        judgedCount: g.judgedCount,
        score: g.score,
        elapsedSeconds: elapsed,
        answerDetails: g.details,
        completedAt: new Date().toISOString()
      };
      records.unshift(record);
      wrong = QuizCore.syncWrongOnSubmit(wrong, session.questions, session.answers, new Date().toISOString());
      saveData();
      progress = null;
      AppStore.set('quiz:progress', null);
      result = { grade: g, mode: session.mode, elapsed: elapsed };
      session = null;
      render();
    }

    /* ================= 题库管理 ================= */
    function viewBank() {
      const cats = QuizCore.categories(questions);
      const dist = QuizCore.typeDistribution(questions);
      let html = '<div class="bar">' +
        '<select class="field" style="width:160px;" data-bank-cat><option value="">全部分类</option>' +
        cats.map(c => '<option' + (bankCat === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
        '<input class="field" style="width:200px;" placeholder="搜索题目..." data-bank-search value="' + esc(bankSearch) + '">' +
        '<button class="btn btn-sm" data-bank-refresh>刷新</button></div>';
      html += '<div class="tabs">' + tabButtons(QuizCore.TYPES.map(t =>
        [t, QuizCore.TYPE_LABEL[t] + ' ' + (dist.find(d => d.type === t) || {}).count]), bankTab, 'data-bank-tab') + '</div>';

      const list = questions.filter(q => q.type === bankTab)
        .filter(q => !bankCat || q.category === bankCat)
        .filter(q => !bankSearch || q.text.indexOf(bankSearch) >= 0);
      html += '<div class="bar">' +
        '<button class="btn btn-sm btn-primary" data-bank-import>导入 Excel</button>' +
        '<button class="btn btn-sm" data-bank-tpl>下载模板</button>' +
        '<button class="btn btn-sm" data-bank-add>手动添加</button>' +
        '<button class="btn btn-sm" data-bank-clear>清空' + QuizCore.TYPE_LABEL[bankTab] + '</button>' +
        '<span class="sp">共 ' + list.length + ' 题</span></div>';

      if (!list.length) {
        html += '<div class="empty">暂无题目</div>';
      } else {
        html += bankTableHtml(list);
      }
      html += '<input type="file" accept=".xlsx,.xls" data-bank-file style="display:none;">';
      return html;
    }

    function bindBank() {
      root.querySelectorAll('[data-bank-tab]').forEach(b =>
        b.addEventListener('click', () => { bankTab = b.dataset.bankTab; render(); }));
      const cat = root.querySelector('[data-bank-cat]');
      cat.addEventListener('change', () => { bankCat = cat.value; render(); });
      const se = root.querySelector('[data-bank-search]');
      se.addEventListener('input', () => {
        bankSearch = se.value;
        const keep = se;
        const tbl = root.querySelector('[data-panel] table');
        if (tbl) { /* 只重渲染表格区域，避免输入框失焦 */
          const list = questions.filter(q => q.type === bankTab)
            .filter(q => !bankCat || q.category === bankCat)
            .filter(q => !bankSearch || q.text.indexOf(bankSearch) >= 0);
          tbl.outerHTML = bankTableHtml(list);
          bindBankRows();
          const sp = root.querySelector('[data-panel] .sp');
          if (sp) sp.textContent = '共 ' + list.length + ' 题';
        } else { render(); }
        keep.focus();
      });
      root.querySelector('[data-bank-refresh]').addEventListener('click', render);
      root.querySelector('[data-bank-import]').addEventListener('click', () => root.querySelector('[data-bank-file]').click());
      root.querySelector('[data-bank-tpl]').addEventListener('click', () => downloadTemplate(bankTab));
      root.querySelector('[data-bank-add]').addEventListener('click', () => openForm(null));
      root.querySelector('[data-bank-clear]').addEventListener('click', clearByType);
      bindBankRows();
      const fi = root.querySelector('[data-bank-file]');
      fi.addEventListener('change', () => {
        const f = fi.files && fi.files[0];
        fi.value = '';
        if (f) importExcel(f);
      });
    }
    function bankTableHtml(list) {
      let html = '<table class="qz-tbl"><thead><tr><th class="num">#</th><th style="width:90px;">分类</th><th>题目</th>' +
        (bankTab === 'choice' ? '<th>A</th><th>B</th><th>C</th><th>D</th>' : '') +
        '<th style="width:70px;">答案</th><th class="act">操作</th></tr></thead><tbody>';
      list.forEach((q, i) => {
        html += '<tr><td class="num">' + (i + 1) + '</td><td>' + (q.category ? tag(q.category) : '<span class="hint">—</span>') +
          '</td><td>' + esc(q.text) + '</td>' +
          (bankTab === 'choice' ? '<td>' + esc(q.optionA) + '</td><td>' + esc(q.optionB) + '</td><td>' + esc(q.optionC) + '</td><td>' + esc(q.optionD) + '</td>' : '') +
          '<td>' + tag(answerLabel(q, q.answer)) + '</td>' +
          '<td class="act"><button class="btn btn-sm" data-edit="' + q.id + '">编辑</button> ' +
          '<button class="btn btn-sm" data-del="' + q.id + '">删除</button></td></tr>';
      });
      return html + '</tbody></table>';
    }
    function bindBankRows() {
      root.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openForm(questions.find(q => q.id === parseInt(b.dataset.edit, 10)))));
      root.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', async () => {
          const id = parseInt(b.dataset.del, 10);
          if (!(await askConfirm('删除这道题？'))) return;
          questions = questions.filter(q => q.id !== id);
          wrong = wrong.filter(w => w.questionId !== id);
          removeFromSession(new Set([id]));
          saveData(); render();
        }));
    }

    async function clearByType() {
      const n = questions.filter(q => q.type === bankTab).length;
      if (!n) { showToast('该题型下没有题目'); return; }
      /* 桌面 WebView 里 window.confirm 是 no-op（直接返回 true），
       * 不换掉的话这里点一下就把几十道题清了，没有任何确认 */
      if (!(await askConfirm('清空全部 ' + n + ' 道' + QuizCore.TYPE_LABEL[bankTab] + '？此操作不可撤销。', '清空'))) return;
      const ids = new Set(questions.filter(q => q.type === bankTab).map(q => q.id));
      questions = questions.filter(q => q.type !== bankTab);
      wrong = wrong.filter(w => !ids.has(w.questionId));
      removeFromSession(ids);
      saveData(); render();
    }

    /* ---------- 手动添加 / 编辑 ---------- */
    function openForm(q) {
      editForm = q
        ? { mode: 'edit', id: q.id, data: Object.assign({}, q) }
        : { mode: 'add', data: { type: bankTab, text: '', category: '', optionA: '', optionB: '', optionC: '', optionD: '', answer: '', explanation: '' } };
      renderForm();
    }
    function renderForm() {
      const d = editForm.data;
      const isChoice = d.type === 'choice';
      const isTF = d.type === 'truefalse';
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:60;display:flex;align-items:center;justify-content:center;';
      box.innerHTML =
        '<div style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:20px;width:min(560px,92vw);max-height:86vh;overflow:auto;">' +
          '<div style="font-weight:500;margin-bottom:12px;">' + (editForm.mode === 'edit' ? '编辑题目' : '添加题目') + '</div>' +
          '<div class="bar"><select class="field" style="width:150px;" data-f="type">' +
            QuizCore.TYPES.map(t => '<option value="' + t + '"' + (d.type === t ? ' selected' : '') + '>' + QuizCore.TYPE_LABEL[t] + '</option>').join('') + '</select>' +
            '<input class="field" style="flex:1;" placeholder="分类（可留空）" data-f="category" value="' + esc(d.category) + '"></div>' +
          '<textarea class="field" rows="3" placeholder="题目内容" data-f="text" style="margin-bottom:10px;">' + esc(d.text) + '</textarea>' +
          (isChoice
            ? '<div class="bar"><input class="field" style="flex:1;" placeholder="选项 A" data-f="optionA" value="' + esc(d.optionA) + '">' +
              '<input class="field" style="flex:1;" placeholder="选项 B" data-f="optionB" value="' + esc(d.optionB) + '"></div>' +
              '<div class="bar"><input class="field" style="flex:1;" placeholder="选项 C（可选）" data-f="optionC" value="' + esc(d.optionC) + '">' +
              '<input class="field" style="flex:1;" placeholder="选项 D（可选）" data-f="optionD" value="' + esc(d.optionD) + '"></div>'
            : '') +
          (isTF
            ? '<div class="bar"><label style="font-size:13px;"><input type="radio" name="tf" value="A"' + (d.answer === 'A' || !d.answer ? ' checked' : '') + '> 正确 (A)</label>' +
              '<label style="font-size:13px;"><input type="radio" name="tf" value="B"' + (d.answer === 'B' ? ' checked' : '') + '> 错误 (B)</label></div>'
            : '') +
          (!isTF ? '<textarea class="field" rows="2" placeholder="答案' + (isChoice ? '（A/B/C/D）' : '') + '" data-f="answer">' + esc(d.answer) + '</textarea>' : '') +
          '<textarea class="field" rows="2" placeholder="解析（可留空）" data-f="explanation" style="margin-top:10px;">' + esc(d.explanation) + '</textarea>' +
          '<div class="bar" style="margin-top:14px;justify-content:flex-end;">' +
            '<button class="btn" data-fcancel>取消</button>' +
            '<button class="btn btn-primary" data-fsave>保存</button></div>' +
        '</div>';
      document.body.appendChild(box);
      __modalEl = box;   /* 挂到全局遮罩槽位，切走工具时 cleanup 能收掉 */
      box.addEventListener('click', e => { if (e.target === box) uiCloseModal(); });
      box.querySelector('[data-fcancel]').addEventListener('click', () => uiCloseModal());
      box.querySelectorAll('[data-f="type"]').forEach(s =>
        s.addEventListener('change', () => {
          editForm.data.type = s.value;
          uiCloseModal(); renderForm();
        }));
      ['category', 'text', 'optionA', 'optionB', 'optionC', 'optionD', 'answer', 'explanation'].forEach(k => {
        const f = box.querySelector('[data-f="' + k + '"]');
        if (f) f.addEventListener('input', () => { editForm.data[k] = f.value; });
      });
      box.querySelectorAll('input[name="tf"]').forEach(r =>
        r.addEventListener('change', () => { editForm.data.answer = r.value; }));
      box.querySelector('[data-fsave]').addEventListener('click', () => {
        try {
          const clean = QuizCore.normalizeQuestion(editForm.data);
          const now = new Date().toISOString();
          if (editForm.mode === 'edit') {
            const q = questions.find(x => x.id === editForm.id);
            Object.assign(q, clean, { updatedAt: now });
          } else {
            questions.push(Object.assign({ id: nextQid(), createdAt: now, updatedAt: now }, clean));
          }
          saveData();
          box.remove();
          render();
          showToast('已保存');
        } catch (e) { showToast(e.message); }
      });
    }

    /* ---------- Excel 导入 / 模板 ---------- */
    const TPL_COLS = {
      choice: ['编号', '分类', '题目', 'A', 'B', 'C', 'D', '答案', '解析'],
      truefalse: ['编号', '分类', '题目', '答案', '解析'],
      fill: ['编号', '分类', '题目', '答案', '解析'],
      essay: ['编号', '分类', '题目', '答案', '解析']
    };
    const TPL_SAMPLE = {
      choice: ['1', '第一章', '示例题干', '选项A', '选项B', '选项C', '选项D', 'A', '为什么选 A'],
      truefalse: ['1', '第一章', '示例题干', '对', '为什么对'],
      fill: ['1', '第一章', '示例题干', '填空答案', '解析'],
      essay: ['1', '第一章', '示例题干', '参考答案', '评分要点']
    };

    function downloadTemplate(type) {
      loadXlsx().then(XLSX => {
        const cols = TPL_COLS[type], sample = TPL_SAMPLE[type];
        const ws = XLSX.utils.aoa_to_sheet([cols, sample]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, QuizCore.TYPE_LABEL[type]);
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        saveBlob(blob, '题库模板-' + QuizCore.TYPE_LABEL[type] + '.xlsx').then(ok2 => {
          if (ok2) showToast('模板已导出');
        });
      }).catch(e => showToast(e.message));
    }

    function importExcel(file) {
      loadXlsx().then(XLSX => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result));
        r.onerror = () => rej(new Error('读取文件失败'));
        r.readAsArrayBuffer(file);
      })).then(buf => {
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) { showToast('表格里没有数据'); return; }
        const head = rows[0].map(x => String(x).trim());
        const idx = name => head.indexOf(name);
        const iCat = idx('分类'), iText = idx('题目'), iAns = idx('答案'), iExp = idx('解析');
        const iA = idx('A'), iB = idx('B'), iC = idx('C'), iD = idx('D');
        if (iText < 0 || iAns < 0) { showToast('表头缺少「题目」或「答案」列'); return; }
        let added = 0, failed = 0, skipped = 0, firstErr = '';
        const now = new Date().toISOString();
        let maxId = QuizCore.nextId(questions);   // 循环外算一次最大 id，逐行自增，避免每行全量扫描
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || !row.length) { skipped++; continue; }
          const get = k => (k >= 0 && row[k] != null) ? String(row[k]).trim() : '';
          /* 表格末尾常有整行空白（Excel 的"已用区域"会多算几行）。
           * 这些行不是错误，是没填内容，跳过即可 —— 计入失败数会让导入结果看着像出了问题。 */
          const rawText = get(iText), rawAns = get(iAns);
          if (!rawText && !rawAns && !get(iCat) && !get(iA) && !get(iB) && !get(iC) && !get(iD) && !get(iExp)) {
            skipped++;
            continue;
          }
          try {
            const clean = QuizCore.normalizeQuestion({
              type: bankTab,
              text: rawText,
              answer: rawAns,
              category: get(iCat),
              optionA: get(iA), optionB: get(iB), optionC: get(iC), optionD: get(iD),
              explanation: get(iExp)
            });
            questions.push(Object.assign({ id: maxId++, createdAt: now, updatedAt: now }, clean));
            added++;
          } catch (e) { failed++; if (!firstErr) firstErr = '第 ' + (i + 1) + ' 行：' + e.message; }
        }
        saveData(); render();
        showToast('导入 ' + added + ' 题' +
          (failed ? '，失败 ' + failed + ' 题（' + firstErr + '）' : '') +
          (skipped ? '，跳过 ' + skipped + ' 个空行' : ''));
      }).catch(e => showToast(e.message));
    }

    /* ================= 错题本 ================= */
    function viewWrong() {
      const byId = qById();
      const list = wrong.map(w => { const q = byId.get(w.questionId); return q ? { w: w, q: q } : null; }).filter(x => x);
      if (!list.length) return '<div class="empty">错题本是空的</div>';
      let html = '<div class="bar">' +
        '<button class="btn btn-sm btn-primary" data-wrong-practice>错题重做</button>' +
        '<button class="btn btn-sm" data-wrong-export>导出 Excel</button>' +
        '<button class="btn btn-sm" data-wrong-clear>清空错题本</button>' +
        '<span class="sp">共 ' + list.length + ' 题</span></div>';
      html += '<table class="qz-tbl"><thead><tr><th class="num">#</th><th>题目</th><th style="width:70px;">答案</th>' +
        '<th style="width:70px;">答错次数</th><th class="act">操作</th></tr></thead><tbody>';
      list.forEach((x, i) => {
        html += '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(x.q.text) + '</td><td>' + tag(answerLabel(x.q, x.q.answer)) +
          '</td><td>' + x.w.wrongCount + '</td>' +
          '<td class="act"><button class="btn btn-sm" data-wrong-del="' + x.q.id + '">移除</button></td></tr>';
      });
      return html + '</tbody></table>';
    }
    function bindWrong() {
      const p = root.querySelector('[data-wrong-practice]');
      if (p) p.addEventListener('click', () => {
        const byId = qById();
        const list = wrong.map(w => byId.get(w.questionId)).filter(Boolean);
        if (!list.length) { showToast('错题本是空的'); return; }
        session = { mode: 'wrong', questions: list, answers: new Array(list.length).fill(null),
                    currentIndex: 0, elapsed: 0, maxTime: null, startTime: Date.now() };
        result = null; tab = 'quiz'; render();
      });
      const ex = root.querySelector('[data-wrong-export]');
      if (ex) ex.addEventListener('click', exportWrong);
      const c = root.querySelector('[data-wrong-clear]');
      if (c) c.addEventListener('click', async () => {
        if (!wrong.length) return;
        if (!(await askConfirm('清空错题本？', '清空'))) return;
        wrong = []; saveData(); render();
      });
      root.querySelectorAll('[data-wrong-del]').forEach(b =>
        b.addEventListener('click', () => {
          wrong = wrong.filter(w => w.questionId !== parseInt(b.dataset.wrongDel, 10));
          saveData(); render();
        }));
    }

    /* 错题本导出成 Excel。列覆盖全部题型；判断题答案经 answerLabel 归一为「正确/错误」，
     * 与导入模板的解析规则兼容（normalizeTFStrict 认得「正确」），可原样再导回。 */
    function exportWrong() {
      const byId = qById();
      const rows = [['编号', '题型', '分类', '题目', '答案', '解析', '答错次数']];
      let n = 0;
      wrong.forEach(w => {
        const q = byId.get(w.questionId);
        if (!q) return;
        n++;
        rows.push([n, QuizCore.TYPE_LABEL[q.type] || q.type, q.category || '', q.text || '',
          answerLabel(q, q.answer) || '', q.explanation || '', w.wrongCount]);
      });
      if (n === 0) { showToast('错题本是空的'); return; }
      loadXlsx().then(XLSX => {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '错题本');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        saveBlob(blob, '错题本.xlsx').then(ok => { if (ok) showToast('错题本已导出'); });
      }).catch(e => showToast(e.message));
    }

    /* ================= 答题记录 ================= */
    function viewRecords() {
      if (!records.length) return '<div class="empty">还没有答题记录</div>';
      let html = '<div class="bar"><button class="btn btn-sm" data-rec-clear>清空记录</button>' +
        '<span class="sp">共 ' + records.length + ' 次</span></div>';
      html += '<table class="qz-tbl"><thead><tr><th class="num">#</th><th>时间</th><th>模式</th>' +
        '<th>得分</th><th>对/错</th><th>用时</th><th class="act">操作</th></tr></thead><tbody>';
      records.forEach((r, i) => {
        const t = r.completedAt ? r.completedAt.slice(0, 16).replace('T', ' ') : '—';
        html += '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(t) + '</td><td>' +
          esc(QuizCore.MODE_NAMES[r.mode] || r.mode) + '</td><td>' + r.score +
          '</td><td><span style="color:var(--ok);">' + r.correctCount + '</span>/<span style="color:var(--err);">' + r.wrongCount + '</span>' +
          '</td><td>' + QuizCore.fmtDuration(r.elapsedSeconds) + '</td>' +
          '<td class="act"><button class="btn btn-sm" data-rec-open="' + r.id + '">' + (recordOpen === r.id ? '收起' : '详情') + '</button> ' +
          '<button class="btn btn-sm" data-rec-del="' + r.id + '">删除</button></td></tr>';
        if (recordOpen === r.id) {
          const byId = qById();
          html += '<tr><td></td><td colspan="6"><table class="qz-tbl">' +
            (r.answerDetails || []).map((d, j) => {
              const q = byId.get(d.questionId);
              return '<tr><td class="num">' + (j + 1) + '</td><td>' + (q ? esc(q.text) : '<em>已删除</em>') +
                '</td><td>' + (d.selected == null || d.selected === '' ? '<span class="hint">未答</span>' : esc(q ? answerLabel(q, d.selected) : d.selected)) +
                '</td><td>' + (q ? esc(answerLabel(q, q.answer)) : '<em>—</em>') +
                '</td><td>' + (d.correct ? tag('对', 'ok') : tag('错', 'bad')) + '</td></tr>';
            }).join('') + '</table></td></tr>';
        }
      });
      return html + '</tbody></table>';
    }
    function bindRecords() {
      const c = root.querySelector('[data-rec-clear]');
      if (c) c.addEventListener('click', async () => {
        if (!records.length) return;
        if (!(await askConfirm('清空全部答题记录？', '清空'))) return;
        records = []; saveData(); render();
      });
      root.querySelectorAll('[data-rec-open]').forEach(b =>
        b.addEventListener('click', () => {
          const id = parseInt(b.dataset.recOpen, 10);
          recordOpen = recordOpen === id ? null : id;
          render();
        }));
      root.querySelectorAll('[data-rec-del]').forEach(b =>
        b.addEventListener('click', () => {
          records = records.filter(r => r.id !== parseInt(b.dataset.recDel, 10));
          saveData(); render();
        }));
    }

    /* ================= 统计 ================= */
    /* 最近得分趋势：内联 SVG 折线，最多最近 20 次，按时间正序，纵轴 0-100。不引第三方图表库。 */
    function trendChart() {
      const data = records.slice(0, 20).map(r => Number(r.score) || 0).reverse();
      if (data.length < 2) return '';
      const W = 620, H = 140, pad = 24;
      const stepX = (W - pad * 2) / (data.length - 1);
      const yOf = v => H - pad - (Math.max(0, Math.min(100, v)) / 100) * (H - pad * 2);
      const xs = data.map((v, i) => pad + i * stepX);
      const poly = data.map((v, i) => xs[i].toFixed(1) + ',' + yOf(v).toFixed(1)).join(' ');
      const dots = data.map((v, i) =>
        '<circle cx="' + xs[i].toFixed(1) + '" cy="' + yOf(v).toFixed(1) + '" r="2.5" fill="#1D9E75"/>').join('');
      const grid = [0, 50, 100].map(g =>
        '<line x1="' + pad + '" y1="' + yOf(g).toFixed(1) + '" x2="' + (W - pad) + '" y2="' + yOf(g).toFixed(1) +
        '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4"/>' +
        '<text x="2" y="' + (yOf(g) + 3).toFixed(1) + '" font-size="9" fill="var(--muted,#888)">' + g + '</text>').join('');
      return '<div class="bar" style="margin-top:16px;"><span class="hint">最近得分趋势（最多 20 次）</span></div>' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;border:1px solid var(--border);border-radius:8px;">' +
        grid + '<polyline fill="none" stroke="#1D9E75" stroke-width="2" points="' + poly + '"/>' + dots + '</svg>';
    }
    function viewStats() {
      const s = QuizCore.stats(questions, records, wrong);
      let html = '<div class="stats">' +
        statCard('答题次数', s.totalAttempts) + statCard('累计作答', s.cumulativeAnswered) +
        statCard('累计答对', s.cumulativeCorrect) + statCard('正确率', s.accuracyRate + '%') +
        statCard('平均分', s.avgScore) + statCard('最高分', s.bestScore) +
        statCard('累计用时', QuizCore.fmtDuration(s.cumulativeTime)) + '</div>';
      if (s.modeStats.length) {
        html += '<table class="qz-tbl"><thead><tr><th>模式</th><th>次数</th><th>平均分</th></tr></thead><tbody>' +
          s.modeStats.map(m => '<tr><td>' + esc(m.modeName) + '</td><td>' + m.count + '</td><td>' + m.avgScore + '</td></tr>').join('') +
          '</tbody></table>';
      } else html += '<div class="empty">还没有答题记录</div>';
      html += trendChart();
      return html;
    }

    /* ---------- 键盘快捷键 ---------- */
    function onKey(e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (tab !== 'quiz' || !session || result) return;
      const q = session.questions[session.currentIndex];
      if (!q) return;
      if (/^[ABCD]$/.test(e.key) && QuizCore.isJudged(q.type)) {
        const opts = root.querySelectorAll('[data-opt]');
        const want = e.key;
        opts.forEach(o => { if (o.dataset.opt === want) o.click(); });
      } else if (e.key === 'ArrowLeft') { commitFree(); go(-1); }
      else if (e.key === 'ArrowRight') { commitFree(); go(1); }
      else if (e.key === 'Enter') {
        commitFree();
        if (session.currentIndex === session.questions.length - 1) requestSubmit();
        else go(1);
      }
    }
    document.addEventListener('keydown', onKey);

    /* ---------- 初始化 ---------- */
    render();

    return function () {
      stopTimer();
      /* 表单弹窗挂在 document.body 上，切走工具时必须收掉，否则 DOM 节点和监听器泄漏 */
      uiCloseModal();
      document.removeEventListener('keydown', onKey);
    };
  }
});
