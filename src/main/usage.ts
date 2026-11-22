import { powerMonitor } from 'electron'
import { dateKey } from './calendar'
import { JsonState, dataFile } from './store'

/** 日付 → 教科 → 学習していた秒数 */
type UsageData = Record<string, Record<string, number>>

const usage = new JsonState<UsageData>(() => dataFile('usage.json'), () => ({}))

// 自動確認では間隔を短くし、「操作が無い」判定をゆるめられるようにしておく
const TICK_MS = Number(process.env['MANABI_USAGE_TICK_MS']) || 15_000
const IDLE_LIMIT_S = Number(process.env['MANABI_IDLE_LIMIT_S']) || 90

/**
 * 学習時間を数えはじめる（評価の「継続力」に使う）。
 *
 * 一定の間隔で様子を見て、(1) 学習用のウィンドウが手前にあり、(2) 直前までマウス・キーボード・ペンの
 * 操作があった場合だけ、その間隔ぶんを学習時間に足す。開いたまま放置している時間は数えない。
 *
 * @param focusedSubject いま手前にあるウィンドウが学習中の教科。学習用のウィンドウでなければ null。
 */
export function startUsageTracking(focusedSubject: () => string | null): void {
  setInterval(() => {
    const subject = focusedSubject()
    if (!subject || powerMonitor.getSystemIdleTime() >= IDLE_LIMIT_S) return
    usage.update((data) => {
      const day = dateKey(new Date())
      return { ...data, [day]: { ...data[day], [subject]: (data[day]?.[subject] ?? 0) + TICK_MS / 1000 } }
    })
  }, TICK_MS).unref()
}

/** ある日の、ある教科の学習時間（分） */
export function minutesOn(day: string, subjectId: string): number {
  const record = usage.get()[day] ?? {}
  // 以前の版は「科目」の ID（jhs1-math）で記録していたので、中学数学にはその分も足す
  const legacy = subjectId === 'jhs-math' ? (record['jhs1-math'] ?? 0) : 0
  return ((record[subjectId] ?? 0) + legacy) / 60
}

/** 記録がある教科の一覧 */
export function usageSubjects(): string[] {
  const ids = new Set(Object.values(usage.get()).flatMap((day) => Object.keys(day)))
  if (ids.delete('jhs1-math')) ids.add('jhs-math')
  return [...ids]
}

/** 記録がある日付の一覧 */
export function usageDays(): string[] {
  return Object.keys(usage.get())
}
