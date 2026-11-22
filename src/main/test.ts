import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writingTargets } from '@shared/essay'
import type { TestFormat, TestQuestion, TestQuestionResult, TestResult, TestSession, TestSetup } from '@shared/types'
import { rewardTest } from './affinity'
import { askStructured } from './ai/ask'
import {
  TEST_GRADING_SCHEMA,
  TEST_QUESTIONS_SCHEMA,
  testGradingSystemPrompt,
  testSystemPrompt,
  testUserPrompt,
  type GeneratedQuestion,
  type GradingOutput,
} from './ai/prompts'
import { getCourse, getCurriculum, getLesson } from './content'
import { dataDir, safeId } from './paths'
import { createNotebook, dataFile, getSettings, readJson } from './store'
import { t } from '@shared/i18n'

/** 受けている途中のテスト。正解と解説はここ（メインプロセス）だけが持ち、画面には渡さない。 */
interface ActiveTest {
  courseId: string
  session: TestSession
  keys: Record<string, { correctChoice: number; answer: string; explanation: string }>
}

const activeFile = () => dataFile('tests', 'active.json')
const resultFile = (id: string) => dataFile('tests', `${safeId(id)}.json`)

let active: ActiveTest | null | undefined

function loadActive(): ActiveTest | null {
  if (active === undefined) active = readJson<ActiveTest | null>(activeFile(), null)
  return active
}

function setActive(next: ActiveTest | null): void {
  active = next
  // 途中でアプリが閉じても続きから受けられるよう、すぐに書きこむ
  if (next) writeFileSync(activeFile(), JSON.stringify(next), 'utf8')
  else if (existsSync(activeFile())) unlinkSync(activeFile())
}

export function getActiveTest(): TestSession | null {
  return loadActive()?.session ?? null
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/** 配点の合計がちょうど 100 になるように整える */
function normalizePoints(points: number[]): number[] {
  const safe = points.map((p) => Math.max(1, Math.round(Number(p) || 1)))
  const total = safe.reduce((a, b) => a + b, 0)
  const scaled = safe.map((p) => Math.max(1, Math.round((p * 100) / total)))
  // 四捨五入のずれは、配点のいちばん大きい問題で吸収する
  const diff = 100 - scaled.reduce((a, b) => a + b, 0)
  scaled[scaled.indexOf(Math.max(...scaled))] += diff
  return scaled
}

let starting = false

/** AI に問題を作らせて、テストを始める */
export async function startTest(setup: TestSetup): Promise<TestSession> {
  if (loadActive()) throw new Error(t('すでにテストを受けている途中です。'))
  if (starting) throw new Error(t('テストを準備しています。少しお待ちください。'))
  const course = getCourse(safeId(setup.courseId))
  if (course?.subject === 'moral') throw new Error(t('道徳は、点数をつけるテストの対象ではありません。チャットやノートで、自分の考えを深めましょう。'))
  const unit = getCurriculum(setup.courseId)?.units.find((u) => u.id === setup.unitId)
  if (!course || !unit) throw new Error(t('単元が見つかりません。'))
  // 小学校の授業で、学び直し向けの本文しか無い場合はそちらを出題範囲にする
  const lessons = setup.lessonIds.map((id) => getLesson(safeId(id)) ?? getLesson(safeId(id), 'deep')).filter((l) => l !== null)
  if (!lessons.length) throw new Error(t('出題できる授業がありません。先に教科書を用意してください。'))
  const format: TestFormat = setup.format === 'choice' || setup.format === 'written' || setup.format === 'essay' ? setup.format : 'mixed'
  // 論述は、1 問に時間がかかるので 1〜3 問。記述だけのときは、2〜8 問
  const count = format === 'essay' ? Math.max(1, Math.min(3, Math.round(setup.questionCount) || 1)) : format === 'written' ? Math.max(2, Math.min(8, Math.round(setup.questionCount) || 3)) : Math.max(3, Math.min(15, Math.round(setup.questionCount) || 5))
  const targets = writingTargets(course.school, course.school === 'es' ? Number(/(\d) 年$/.exec(course.label)?.[1] ?? 6) : null)
  const lengths = { written: [targets.short[0], targets.short[2]] as [number, number], essay: targets.long }
  const timeLimitMin = setup.timeLimitMin ? Math.max(1, Math.min(180, Math.round(setup.timeLimitMin))) : null

  starting = true
  try {
    const output = await askStructured<{ questions: GeneratedQuestion[] }>(
      getSettings().ai,
      testSystemPrompt(course, format, lengths),
      testUserPrompt(t('{0}・{1}', course.title, unit.title), lessons, count),
      TEST_QUESTIONS_SCHEMA,
    )
    const usable = (q: GeneratedQuestion) => q?.prompt && q.answer && (format !== 'choice' || (q.choices?.length >= 2 && q.correctChoice >= 0 && q.correctChoice < q.choices.length))
    const generated = (output.questions ?? []).filter(usable).slice(0, count)
    if (generated.length < Math.min(3, count)) throw new Error(t('問題を作れませんでした。もう一度お試しください。'))

    const points = normalizePoints(generated.map((q) => q.points))
    const keys: ActiveTest['keys'] = {}
    const questions: TestQuestion[] = generated.map((q, i) => {
      const id = randomUUID()
      // 特化モードでは、その形式だけにする（AI がちがう種類を返しても、選んだ形式として出す）
      if (format === 'written' || format === 'essay') {
        keys[id] = { correctChoice: -1, answer: q.answer, explanation: q.explanation }
        return { id, kind: format, prompt: q.prompt, choices: [], points: points[i] }
      }
      const validChoice = (q.kind === 'choice' || format === 'choice') && q.choices.length >= 2 && q.correctChoice >= 0 && q.correctChoice < q.choices.length
      if (!validChoice) {
        // 選択肢が正しく作られなかった問題は、短く答える形式として出す
        keys[id] = { correctChoice: -1, answer: q.answer, explanation: q.explanation }
        return { id, kind: q.kind === 'written' || q.kind === 'essay' ? q.kind : 'short', prompt: q.prompt, choices: [], points: points[i] }
      }
      // 正解の位置がかたよらないよう、選択肢を並べかえる
      const order = shuffle(q.choices.map((_, index) => index))
      keys[id] = { correctChoice: order.indexOf(q.correctChoice), answer: q.choices[q.correctChoice], explanation: q.explanation }
      return { id, kind: 'choice', prompt: q.prompt, choices: order.map((index) => q.choices[index]), points: points[i] }
    })

    const notebook = await createNotebook(t('テスト用ノート（{0}）', unit.title), null, 'test')
    const session: TestSession = {
      id: randomUUID(),
      subjectId: course.subjectId,
      unitId: unit.id,
      unitTitle: t('{0}・{1}', course.title, unit.title),
      lessonIds: lessons.map((l) => l.id),
      questions,
      timeLimitMin,
      startedAt: Date.now(),
      notebookId: notebook.id,
      format,
      lengths,
    }
    setActive({ courseId: course.id, session, keys })
    return session
  } finally {
    starting = false
  }
}

let grading = false

/** 解答を採点して、テストを終える */
export async function submitTest(answers: Record<string, string>): Promise<TestResult> {
  const current = loadActive()
  if (!current) throw new Error(t('受けている途中のテストがありません。'))
  if (grading) throw new Error(t('採点しています。少しお待ちください。'))
  const { session, keys } = current
  const course = getCourse(current.courseId ?? 'jhs1-math')
  if (!course) throw new Error(t('科目が見つかりません。'))
  const { ai } = getSettings()

  grading = true
  try {
    const drafts = session.questions.map((question) => {
      const key = keys[question.id]
      const raw = String(answers[question.id] ?? '').trim().slice(0, question.kind === 'essay' ? 4000 : 1000)
      if (question.kind === 'choice') {
        const picked = raw === '' ? -1 : Number(raw)
        return {
          question,
          key,
          answer: question.choices[picked] ?? '',
          score: picked === key.correctChoice ? question.points : 0,
          fixed: true,
        }
      }
      // 無回答は AI に聞くまでもなく 0 点
      return { question, key, answer: raw, score: 0, fixed: raw === '' }
    })

    const sheet = drafts
      .map((d, i) => {
        const target = d.question.kind === 'essay' && session.lengths ? t('・字数の目安 {0}〜{1} 字', session.lengths.essay[0], session.lengths.essay[1]) : d.question.kind === 'written' && session.format === 'written' && session.lengths ? t('・字数の目安 {0}〜{1} 字', session.lengths.written[0], session.lengths.written[1]) : ''
        const head = t('## 問題 {0}（{1}・配点 {2}{3}）\n{4}', i + 1, d.question.kind, d.question.points, target, d.question.prompt)
        const choices = d.question.choices.length ? t('\n選択肢: {0}', d.question.choices.join(' ／ ')) : ''
        const graded = d.fixed ? t('\n採点済みの点数: {0}', d.score) : ''
        return t('{0}{1}\n模範解答: {2}\n生徒の解答: {3}{4}', head, choices, d.key.answer, d.answer || t('（無回答）'), graded)
      })
      .join('\n\n')
    const output = await askStructured<GradingOutput>(
      ai,
      testGradingSystemPrompt(course),
      t('「{0}」のテストを採点してください。\n\n{1}', session.unitTitle, sheet),
      TEST_GRADING_SCHEMA,
    )

    const results: TestQuestionResult[] = drafts.map((d, i) => {
      const graded = output.results?.find((r) => r.number === i + 1)
      const score = d.fixed ? d.score : Math.max(0, Math.min(d.question.points, Math.round(Number(graded?.score) || 0)))
      return {
        question: d.question,
        answer: d.answer,
        correctAnswer: d.key.answer,
        explanation: d.key.explanation,
        score,
        feedback: String(graded?.feedback ?? ''),
      }
    })
    const result: TestResult = {
      id: session.id,
      subjectId: session.subjectId,
      unitId: session.unitId,
      unitTitle: session.unitTitle,
      lessonIds: session.lessonIds,
      startedAt: session.startedAt,
      finishedAt: Date.now(),
      timeLimitMin: session.timeLimitMin,
      score: results.reduce((sum, r) => sum + r.score, 0),
      results,
      comment: String(output.comment ?? ''),
      notebookId: session.notebookId,
      ai,
    }
    writeFileSync(resultFile(result.id), JSON.stringify(result), 'utf8')
    setActive(null)
    rewardTest(result.unitTitle, result.score)
    return result
  } finally {
    grading = false
  }
}

/** テストを途中でやめる。点数は付かず、記録にも残らない。 */
export function abortTest(): void {
  setActive(null)
}

export function getTestResult(id: string): TestResult | null {
  return readJson<TestResult | null>(resultFile(id), null)
}

export function listTestResults(): TestResult[] {
  const dir = dataDir('tests')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'active.json')
    .map((f) => readJson<TestResult | null>(join(dir, f), null))
    .filter((r): r is TestResult => !!r && Array.isArray(r.results))
    .sort((a, b) => b.finishedAt - a.finishedAt)
}
