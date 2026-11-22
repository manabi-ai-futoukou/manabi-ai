import type { AxisKey, AxisValue, NoteEvaluation, WeeklyReport } from '@shared/types'
import { rewardWeek } from './affinity'
import { askText } from './ai/ask'
import { weeklyCommentSystemPrompt } from './ai/prompts'
import { addDays, dateKey, parseDateKey, weekStartOf } from './calendar'
import { getCharacters, subjectOfLesson, subjectTitle } from './content'
import { JsonState, dataFile, getAllEvaluations, getSettings } from './store'
import { listTestResults } from './test'
import { minutesOn, usageDays, usageSubjects } from './usage'
import { t } from '@shared/i18n'

/**
 * 週ごとの評価。月曜から日曜までを 1 週間とし、教科（学校 + 教科。例: 中学 数学）ごとに
 * 5 つの観点で 100 点満点の点を出す。
 *
 *   理解力・応用力・発想力 … その週に先生が評価したノートの平均（同じノートは最後の評価を使う）
 *   記憶力 … その週に受けたテストの平均点
 *   継続力 … 学習した日数と合計時間（下の PERSISTENCE を参照）
 *
 * 週が終わると内容を確定して保存し、総合点に応じた好感度を全員に配る。
 */
const PERSISTENCE = {
  /** この分数以上学習した日を「学習した日」と数える */
  minutesPerDay: 10,
  /** 学習した日がこの日数で、日数ぶんの満点（50 点） */
  fullDays: 5,
  /** 1 週間の合計がこの分数で、時間ぶんの満点（50 点） */
  fullMinutes: 300,
}

interface Stored {
  /** 確定した週。キーは「週の始まり|教科」 */
  final: Record<string, WeeklyReport>
  /** 途中の週に頼んだ講評 */
  comments: Record<string, string>
}

const stored = new JsonState<Stored>(() => dataFile('reports.json'), () => ({ final: {}, comments: {} }))
const keyOf = (weekStart: string, subjectId: string) => `${weekStart}|${subjectId}`
const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length)

export function weekLabel(weekStart: string): string {
  const start = parseDateKey(weekStart)
  const end = addDays(start, 6)
  return t('{0}/{1}〜{2}/{3} の週', start.getMonth() + 1, start.getDate(), end.getMonth() + 1, end.getDate())
}

/** テストの記録にある教科の ID（以前の版は科目の ID で記録していたので読みかえる） */
const testSubject = (subjectId: string) => (subjectId === 'jhs1-math' ? 'jhs-math' : subjectId)

function compute(weekStart: string, subjectId: string): WeeklyReport {
  const start = parseDateKey(weekStart)
  const end = addDays(start, 7)
  const inWeek = (at: number) => at >= start.getTime() && at < end.getTime()

  // ノート: 同じノートを何度か見てもらった場合は、その週の最後の評価を使う
  const latest = new Map<string, NoteEvaluation>()
  for (const evaluation of getAllEvaluations()) {
    if (!inWeek(evaluation.at) || subjectOfLesson(evaluation.lessonId) !== subjectId) continue
    const seen = latest.get(evaluation.notebookId)
    if (!seen || seen.at < evaluation.at) latest.set(evaluation.notebookId, evaluation)
  }
  const notes = [...latest.values()]
  const noteAxis = (key: 'understanding' | 'application' | 'creativity'): AxisValue =>
    notes.length
      ? { score: mean(notes.map((n) => n[key].score)), basis: t('ノート {0} 冊の評価の平均', notes.length) }
      : { score: null, basis: t('この週に評価を受けたノートはありません') }

  const tests = listTestResults().filter((t) => testSubject(t.subjectId) === subjectId && inWeek(t.finishedAt))
  const memory: AxisValue = tests.length
    ? { score: mean(tests.map((t) => t.score)), basis: t('テスト {0} 回の平均点', tests.length) }
    : { score: null, basis: t('この週に受けたテストはありません') }

  const dailyMinutes = Array.from({ length: 7 }, (_, i) => Math.round(minutesOn(dateKey(addDays(start, i)), subjectId)))
  const activeDays = dailyMinutes.filter((m) => m >= PERSISTENCE.minutesPerDay).length
  const activeMinutes = dailyMinutes.reduce((a, b) => a + b, 0)
  const persistence: AxisValue = {
    score: Math.round(
      (50 * Math.min(activeDays, PERSISTENCE.fullDays)) / PERSISTENCE.fullDays +
        (50 * Math.min(activeMinutes, PERSISTENCE.fullMinutes)) / PERSISTENCE.fullMinutes,
    ),
    basis: t('{0} 分以上学習した日が {1} 日、合計 {2} 分', PERSISTENCE.minutesPerDay, activeDays, activeMinutes),
  }

  const axes: Record<AxisKey, AxisValue> = {
    understanding: noteAxis('understanding'),
    application: noteAxis('application'),
    creativity: noteAxis('creativity'),
    memory,
    persistence,
  }
  const scores = Object.values(axes).flatMap((a) => (a.score === null ? [] : [a.score]))
  const hasActivity = notes.length > 0 || tests.length > 0 || activeMinutes > 0

  return {
    weekStart,
    weekEnd: dateKey(addDays(start, 6)),
    subjectId,
    subjectTitle: subjectTitle(subjectId),
    axes,
    overall: hasActivity ? mean(scores) : null,
    dailyMinutes,
    activeMinutes,
    activeDays,
    noteCount: notes.length,
    testCount: tests.length,
    final: end.getTime() <= Date.now(),
    bonus: null,
    comment: stored.get().comments[keyOf(weekStart, subjectId)] ?? null,
  }
}

/** 学習の記録がある教科（評価を受けたノート、テスト、学習時間のどれかがある） */
export function activeSubjects(): string[] {
  const ids = new Set<string>(usageSubjects())
  for (const evaluation of getAllEvaluations()) {
    const subject = subjectOfLesson(evaluation.lessonId)
    if (subject) ids.add(subject)
  }
  for (const test of listTestResults()) ids.add(testSubject(test.subjectId))
  return [...ids]
}

/** 記録が残っている、いちばん古い週の月曜日 */
function firstWeek(): Date | null {
  const stamps = [
    ...usageDays().map((day) => parseDateKey(day).getTime()),
    ...getAllEvaluations().map((e) => e.at),
    ...listTestResults().map((t) => t.finishedAt),
  ]
  return stamps.length ? weekStartOf(new Date(Math.min(...stamps))) : null
}

/**
 * 終わった週のうち、まだ確定していないものを教科ごとに確定する。
 * 起動時と、起動中は 1 時間ごとに呼ぶ。新しく確定した週があれば true。
 */
export function settleWeeks(): boolean {
  const first = firstWeek()
  if (!first) return false
  const thisWeek = weekStartOf(new Date())
  const subjects = activeSubjects()
  let settled = false
  for (let week = first; week < thisWeek; week = addDays(week, 7)) {
    const weekStart = dateKey(week)
    for (const subjectId of subjects) {
      const key = keyOf(weekStart, subjectId)
      if (stored.get().final[key]) continue
      const report = compute(weekStart, subjectId)
      const bonus = report.overall === null ? 0 : rewardWeek(`${weekLabel(weekStart)}（${report.subjectTitle}）`, report.overall)
      stored.update((s) => ({ ...s, final: { ...s.final, [key]: { ...report, final: true, bonus } } }))
      settled = true
    }
  }
  return settled
}

/** ある教科の、今週（途中経過）と確定した週を新しい順に返す */
export function listReports(subjectId: string): WeeklyReport[] {
  const current = compute(dateKey(weekStartOf(new Date())), subjectId)
  const past = Object.values(stored.get().final)
    .filter((r) => r.subjectId === subjectId && r.overall !== null)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
  return [current, ...past]
}

/** 先生に、その週の講評を書いてもらう */
export async function commentOnWeek(weekStart: string, subjectId: string): Promise<WeeklyReport> {
  const key = keyOf(weekStart, subjectId)
  const report = stored.get().final[key] ?? compute(weekStart, subjectId)
  if (report.overall === null) throw new Error(t('この週の学習の記録がまだありません。'))
  const teacher = getCharacters().find((c) => c.role === 'teacher') ?? getCharacters()[0]
  const names: Record<AxisKey, string> = {
    understanding: t('理解力'),
    application: t('応用力'),
    creativity: t('発想力'),
    memory: t('記憶力'),
    persistence: t('継続力'),
  }
  const lines = (Object.keys(names) as AxisKey[]).map(
    (axis) => `- ${names[axis]}: ${report.axes[axis].score ?? t('なし')}${report.axes[axis].score === null ? '' : t(' 点')}（${report.axes[axis].basis}）`,
  )
  const prompt = t('{0}（{1}）の評価です。{2}\n\n{3}\n- 総合: {4} 点\n\nこの内容について、講評をお願いします。', weekLabel(weekStart), report.subjectTitle, report.final ? '' : t('この週はまだ途中です。'), lines.join('\n'), report.overall)
  const comment = (await askText(getSettings().ai, weeklyCommentSystemPrompt(teacher), prompt)).trim()

  if (stored.get().final[key]) {
    stored.update((s) => ({ ...s, final: { ...s.final, [key]: { ...s.final[key], comment } } }))
    return stored.get().final[key]
  }
  stored.update((s) => ({ ...s, comments: { ...s.comments, [key]: comment } }))
  return compute(weekStart, subjectId)
}
