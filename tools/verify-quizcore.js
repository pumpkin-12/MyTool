// 验证 web/index.html 里的 QuizCore（刷题领域逻辑）。
// 用例对应 quiz-app 的 QuizServiceTest / QuestionServiceTest / StatsServiceTest。
// 用法: node tools/verify-quizcore.js <web/index.html> <报告输出路径>
const fs = require('fs');
const vm = require('vm');

const HTML = process.argv[2];
const REPORT = process.argv[3];
const html = fs.readFileSync(HTML, 'utf8');

const lines = [];
function log(s) { lines.push(s); }
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; log('  PASS  ' + label); }
  else { fail++; log('  FAIL  ' + label + (extra ? '   << ' + extra : '')); }
}
function throws(fn, label, msgPart) {
  try { fn(); ok(false, label, '没有抛错'); }
  catch (e) {
    const m = String(e && e.message || e);
    ok(!msgPart || m.indexOf(msgPart) >= 0, label, m);
  }
}

/* ---------------- 抽出 QuizCore ---------------- */
log('[0] 抽取 QuizCore');
const startMark = 'const QuizCore = (function () {';
const start = html.indexOf(startMark);
ok(start >= 0, '定位 QuizCore 定义');
const endMark = '\n})();';
const end = html.indexOf(endMark, start);
ok(end >= 0, '定位 QuizCore 结束');
const src = html.slice(start, end + endMark.length);
log('  QuizCore 源码长度 = ' + src.length);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nglobalThis.__QC = QuizCore;', sandbox);
const QC = sandbox.__QC;
ok(!!QC, 'QuizCore 取出成功');

/* ---------------- 夹具 ---------------- */
const Q = [
  { id: 1, type: 'choice', text: '甲', optionA: 'a1', optionB: 'b1', optionC: 'c1', optionD: 'd1', category: '第一章', answer: 'A', explanation: '解1' },
  { id: 2, type: 'choice', text: '乙', optionA: 'a2', optionB: 'b2', optionC: '', optionD: '', category: '第一章', answer: 'B', explanation: '' },
  { id: 3, type: 'truefalse', text: '丙', optionA: '', optionB: '', optionC: '', optionD: '', category: '第二章', answer: '对', explanation: '解3' },
  { id: 4, type: 'fill', text: '丁', optionA: '', optionB: '', optionC: '', optionD: '', category: '第二章', answer: '标准答案', explanation: '' },
  { id: 5, type: 'essay', text: '戊', optionA: '', optionB: '', optionC: '', optionD: '', category: '', answer: '要点一二', explanation: '' }
];

/* ---------------- 1. normalizeQuestion ---------------- */
log('[1] normalizeQuestion：清洗与校验');
let n;
n = QC.normalizeQuestion({ type: 'choice', text: '  x  ', answer: ' b ', optionA: null, category: null });
ok(n.answer === 'B', '选择题答案自动转大写', n.answer);
throws(() => QC.normalizeQuestion({ type: 'choice', text: 'x', answer: 'E' }),
       '选择题答案不在 A-D 时报错（否则 Excel 填 E 会静默入库且永远判错）', '选择题答案必须是');
throws(() => QC.normalizeQuestion({ type: 'choice', text: 'x', answer: 'AB' }),
       '选择题答案填 AB 也报错', '选择题答案必须是');
ok(n.text === 'x', '题目文本首尾去空白');
ok(n.category === '' && n.optionA === '', '分类/选项为 null 时默认空字符串');

n = QC.normalizeQuestion({ type: 'fill', text: 'y', answer: ' AbC ' });
ok(n.answer === 'AbC', '填空题答案保留大小写并去空白', n.answer);

n = QC.normalizeQuestion({ text: 'z', answer: 'A' });
ok(n.type === 'choice', '题型缺省默认 choice', n.type);

n = QC.normalizeQuestion({ type: 'essay', text: 'w', answer: ' 要点 ' });
ok(n.answer === '要点', '简答题答案保持原样');

n = QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: '对' });
ok(n.answer === 'A', '判断题「对」→ A', n.answer);
n = QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: '错误' });
ok(n.answer === 'B', '判断题「错误」→ B', n.answer);
n = QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: 't' });
ok(n.answer === 'A', '判断题「t」→ A', n.answer);
n = QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: 'F' });
ok(n.answer === 'B', '判断题「F」→ B', n.answer);
n = QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: 'A' });
ok(n.answer === 'A', '判断题「A」原样保留', n.answer);
throws(() => QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: 'X' }),
       '判断题答案认不出来时严格报错', '不支持的判断题答案');
throws(() => QC.normalizeQuestion({ type: 'truefalse', text: 'v', answer: '' }),
       '判断题答案为空时报「答案不能为空」（Java 里空值检查先于归一化）', '答案不能为空');

throws(() => QC.normalizeQuestion({ type: 'choice', text: '   ', answer: 'A' }), '题目为空报错', '题目内容不能为空');
throws(() => QC.normalizeQuestion({ type: 'choice', text: 'ok', answer: '  ' }), '答案为空报错', '答案不能为空');
throws(() => QC.normalizeQuestion({ type: 'judge', text: 'ok', answer: 'A' }), '非法题型报错', '不支持的题型');

/* ---------------- 2. startQuiz：抽题 ---------------- */
log('[2] startQuiz：四种模式与过滤');
let r;
r = QC.startQuiz({ questions: Q, mode: 'order' });
ok(r.questions.length === 5, '顺序模式返回全部题目');
ok(r.questions.map(x => x.id).join(',') === '1,2,3,4,5', '顺序模式不打乱顺序');
ok(r.maxTime === null && r.examCount === null && r.customRandom === null, '顺序模式不设置限时/题量/随机标记');

r = QC.startQuiz({ questions: Q, mode: 'random' });
ok(r.questions.length === 5, '随机模式返回全部题目');
ok(r.questions.map(x => x.id).sort().join(',') === '1,2,3,4,5', '随机模式不丢题');

r = QC.startQuiz({ questions: Q, mode: 'exam', count: 2, maxTime: 600 });
ok(r.questions.length === 2, '考试模式按指定数量抽题', r.questions.length);
ok(r.maxTime === 600, '考试模式限时透传');
ok(r.examCount === null, '考试模式不写 examCount（与 Java 一致）');

r = QC.startQuiz({ questions: Q, mode: 'exam', count: 999 });
ok(r.questions.length === 5, '考试模式 count 超过总数时返回全部', r.questions.length);

r = QC.startQuiz({ questions: Q, mode: 'custom', count: 2, random: true, maxTime: 0 });
ok(r.questions.length === 2, '自定义模式带数量限制');
ok(r.customRandom === true, '自定义模式随机标记为 true');
ok(r.maxTime === null, '自定义模式 maxTime<=0 视为不限时', r.maxTime);
ok(r.examCount === 2, '自定义模式 examCount 记录设定题量');

r = QC.startQuiz({ questions: Q, mode: 'custom', count: 0, random: false });
ok(r.questions.length === 1, '自定义模式 count 夹紧到至少 1 题', r.questions.length);

r = QC.startQuiz({ questions: Q, mode: 'exam', count: 1 });
ok(r.questions.length === 1 && r.questions[0].id >= 1, 'count 夹紧到 1 时返回 1 题');

r = QC.startQuiz({ questions: Q, mode: 'order', category: '第一章' });
ok(r.questions.length === 2 && r.questions.every(x => x.category === '第一章'), '分类筛选只返回该分类');
r = QC.startQuiz({ questions: Q, mode: 'random', types: ['truefalse', 'fill'] });
ok(r.questions.length === 2 && r.questions.every(x => x.type === 'truefalse' || x.type === 'fill'),
   '题型筛选只返回所选题型');

throws(() => QC.startQuiz({ questions: [], mode: 'order' }), '题库为空报错', '题库为空');
throws(() => QC.startQuiz({ questions: Q, mode: 'order', category: '不存在' }), '分类不存在报错', '所选分类下没有题目');
throws(() => QC.startQuiz({ questions: Q, mode: 'order', types: ['judge'] }), '题型非法报错', '不支持的题型');

r = QC.startQuiz({ questions: Q, mode: 'order' });
ok(r.mode === 'order', 'mode 缺省为 order');

/* ---------------- 3. judge / answerOf：判题 ---------------- */
log('[3] judge：判题规则');
const byId = id => Q.find(q => q.id === id);
ok(QC.answerOf(byId(3)) === 'A', '判断题答案读取时归一化（对 → A）', QC.answerOf(byId(3)));
ok(QC.judge(byId(1), 'a').correct === true, '选择题判题不区分大小写');
ok(QC.judge(byId(1), null).correct === false, '未作答不算对');
ok(QC.judge(byId(3), 'A').correct === true, '判断题按归一化后的答案判');
ok(QC.judge(byId(3), 'B').correct === false, '判断题答错判为错误');
ok(QC.judge(byId(4), '随便').judged === false, '填空题不判题');
ok(QC.judge(byId(5), '随便').judged === false, '简答题不判题');
ok(QC.judge(byId(1), 'A').correctAnswer === 'A' && QC.judge(byId(1), 'A').explanation === '解1',
   '判题结果带标准答案与解析');
ok(QC.judge(null, 'A').judged === false, '题目缺失时不判分');

/* ---------------- 4. grade：计分 ---------------- */
log('[4] grade：计分（分母只算可判题）');
let g;
// 2 choice（1对1错）+ 1 truefalse（对）+ 1 fill + 1 essay
g = QC.grade(Q, ['A', 'A', 'A', 'x', 'x']);
ok(g.judgedCount === 3, '可判题数 = 3（2 choice + 1 truefalse）', g.judgedCount);
ok(g.correctCount === 2, '正确数 = 2', g.correctCount);
ok(g.wrongCount === 1, '错误数 = 1', g.wrongCount);
ok(g.score === 67, '得分 = round(2*100/3) = 67', g.score);
ok(g.totalQuestions === 5, '总题数包含不判分的题目', g.totalQuestions);
ok(g.details.length === 5, '逐题明细覆盖全部题目');

g = QC.grade([byId(4), byId(5)], ['a', 'b']);
ok(g.judgedCount === 0 && g.score === 0 && g.wrongCount === 0, '全是填空/简答时无可判题，得分为 0', JSON.stringify(g));

g = QC.grade(Q.slice(0, 3), ['A']);
ok(g.details[1].selected === null && g.details[1].correct === false,
   'answers 比题目短时，缺答视为未答且判错');
ok(g.details[2].selected === null && g.details[2].correct === false, '末题缺答同样视为未答');

g = QC.grade([byId(1), byId(2)], ['A', 'B']);
ok(g.correctCount === 2 && g.judgedCount === 2 && g.score === 100, '全对得 100 分');

/* ---------------- 5. 错题本同步 ---------------- */
log('[5] 错题本：两处同步时机');
let w = [{ questionId: 9, wrongCount: 3, lastWrongAt: 't0' }];
let out;
out = QC.applyWrongOnAnswer(w, byId(1), true, 't1');
ok(out.list.length === 1 && out.list[0].questionId === 9 && out.wrongCount === 0,
   '答对且原本不在错题本 → 不新增');
ok(w[0].wrongCount === 3, '传入的错题本未被就地修改（不可变性）');

out = QC.applyWrongOnAnswer([{ questionId: 1, wrongCount: 2, lastWrongAt: 't0' }], byId(1), true, 't1');
ok(out.list.length === 0, '答对且原本在错题本 → 移除');

out = QC.applyWrongOnAnswer(w, byId(1), false, 't1');
ok(out.list.length === 2 && out.list[1].questionId === 1 && out.list[1].wrongCount === 1,
   '答错且不在错题本 → 新增计数 1');

out = QC.applyWrongOnAnswer(w, { id: 9 }, false, 't1');
ok(out.list[0].wrongCount === 4 && out.list[0].lastWrongAt === 't1',
   '再答错 → 计数 +1 并刷新时间');

// 交卷补录：只新增缺失的，不重复、不改已有计数、跳过不判题的
w = [{ questionId: 2, wrongCount: 5, lastWrongAt: 't0' }];
out = QC.syncWrongOnSubmit(w, Q, ['A', 'B', 'B', 'x', 'x'], 't9');
// Q1 对（原本不在 → 不加）；Q2 对（已在 → 不动）；Q3 判错（新增）；Q4/Q5 不判题（跳过）
ok(out.length === 2, '交卷补录只新增缺失的可判题', JSON.stringify(out.map(x => x.questionId)));
ok(out.some(x => x.questionId === 3) && out.some(x => x.questionId === 2), '新增了答错的判断题，保留了原有记录');
ok(out.find(x => x.questionId === 2).wrongCount === 5, '补录不会改动已有记录的计数');

out = QC.syncWrongOnSubmit([], [byId(4), byId(5)], ['x', 'x'], 't9');
ok(out.length === 0, '填空/简答不进错题本');

out = QC.syncWrongOnSubmit([], Q, ['A', 'B', 'A', 'x', 'x'], 't9');
ok(out.length === 0, '全部答对时错题本不变');

/* ---------------- 6. stats ---------------- */
log('[6] stats：统计汇总');
let s = QC.stats(Q, [], []);
ok(s.totalQuestions === 5 && s.totalAttempts === 0 && s.accuracyRate === 0
   && s.avgScore === 0 && s.bestScore === 0 && s.modeStats.length === 0,
   '无记录时全部为零值');

s = QC.stats(Q, [{ mode: 'order', totalQuestions: 4, correctCount: 3, judgedCount: 4,
                   score: 75, elapsedSeconds: 120 }], [{ questionId: 1 }]);
ok(s.totalAttempts === 1 && s.cumulativeAnswered === 4 && s.cumulativeCorrect === 3
   && s.accuracyRate === 75 && s.avgScore === 75 && s.bestScore === 75 && s.cumulativeTime === 120,
   '单条记录各项统计正确', JSON.stringify(s));
ok(s.wrongCount === 1 && s.totalQuestions === 5, '统计带出题库数与错题数');

s = QC.stats(Q, [{ mode: 'order', totalQuestions: 3, correctCount: 2, judgedCount: 3, score: 80, elapsedSeconds: 60 }], []);
ok(s.accuracyRate === 66.67, '正确率保留两位小数（2/3 → 66.67）', s.accuracyRate);
ok(s.modeStats.length === 1 && s.modeStats[0].avgScore === 80,
   '模式平均分照实输出', JSON.stringify(s.modeStats));
ok(s.bestScore === 80, '最高分取最大值');

s = QC.stats(Q, [
  { mode: 'order', totalQuestions: 2, correctCount: 2, judgedCount: 2, score: 80, elapsedSeconds: 60 },
  { mode: 'order', totalQuestions: 2, correctCount: 1, judgedCount: 2, score: 75, elapsedSeconds: 60 }
], []);
ok(s.modeStats.length === 1 && s.modeStats[0].avgScore === 77.5,
   '模式平均分保留一位小数（80/75 → 77.5）', JSON.stringify(s.modeStats));
ok(s.cumulativeJudged === 4 && s.cumulativeCorrect === 3,
   '跨记录累加正确数与可判题数', s.cumulativeJudged + '/' + s.cumulativeCorrect);

s = QC.stats(Q, [{ mode: 'weird', totalQuestions: 2, correctCount: 0, judgedCount: 2, score: 0, elapsedSeconds: 0 }], []);
ok(s.modeStats.length === 0, '未定义的模式不进模式统计', JSON.stringify(s.modeStats));

s = QC.stats(Q, [{ mode: 'wrong', totalQuestions: 2, correctCount: 2, judgedCount: 2, score: 100, elapsedSeconds: 0 }], []);
ok(s.modeStats.length === 1 && s.modeStats[0].modeName === '错题重做', '错题重做模式正常统计');

s = QC.stats(Q, [{ mode: 'order', totalQuestions: 4, correctCount: 2, judgedCount: null, score: 50, elapsedSeconds: 0 }], []);
ok(s.cumulativeJudged === 4, '历史记录没有 judgedCount 时回退用 totalQuestions', s.cumulativeJudged);

/* ---------------- 7. 杂项 ---------------- */
log('[7] 杂项');
ok(JSON.stringify(QC.typeDistribution(Q)) ===
   JSON.stringify([{ type: 'choice', label: '选择题', count: 2 },
                   { type: 'truefalse', label: '判断题', count: 1 },
                   { type: 'fill', label: '填空题', count: 1 },
                   { type: 'essay', label: '简答题', count: 1 }]), '题型分布统计正确');
ok(JSON.stringify(QC.categories(Q)) === JSON.stringify(['第一章', '第二章']), '分类去重排序', JSON.stringify(QC.categories(Q)));
ok(QC.categories([{ id: 1, category: '' }]).length === 0, '空分类不进列表');
ok(QC.nextId([]) === 1 && QC.nextId([{ id: 3 }, { id: 7 }]) === 8, 'nextId 取最大值 +1');
ok(QC.fmtDuration(0) === '00:00' && QC.fmtDuration(65) === '01:05' && QC.fmtDuration(3661) === '1:01:01',
   '时长格式化', QC.fmtDuration(3661));

log('');
log('===== 结果: ' + pass + ' passed, ' + fail + ' failed =====');
fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
process.exitCode = fail ? 1 : 0;
