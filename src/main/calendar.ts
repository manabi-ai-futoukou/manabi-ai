import { getLang, t } from '@shared/i18n'
/** 日付と週の計算。すべてこの PC の現地時刻で考える。 */

const DAY_MS = 24 * 60 * 60 * 1000

/** YYYY-MM-DD */
export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** その日をふくむ週の月曜日（0 時） */
export function weekStartOf(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const sinceMonday = (start.getDay() + 6) % 7
  return addDays(start, -sinceMonday)
}

const WEEKDAYS = [t('日'), t('月'), t('火'), t('水'), t('木'), t('金'), t('土')]

/** 「2026年11月15日（日）午前2時15分」 */
export function formatMoment(date: Date): string {
  // 日本語以外では、その言語のふつうの書き方にする
  if (getLang() !== 'ja') return date.toLocaleString(getLang(), { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const hour = date.getHours()
  const half = hour < 12 ? t('午前') : t('午後')
  return t('{0}年{1}月{2}日（{3}）{4}{5}時{6}分', date.getFullYear(), date.getMonth() + 1, date.getDate(), WEEKDAYS[date.getDay()], half, hour % 12, date.getMinutes())
}

/** 「3 日前」「約 5 時間前」のような、前回からの間隔 */
export function formatGap(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime()
  const days = Math.round(
    (new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime() -
      new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) /
      DAY_MS,
  )
  if (days >= 2) return t('{0} 日前', days)
  if (days === 1) return t('昨日')
  if (ms >= 60 * 60 * 1000) return t('今日の約 {0} 時間前', Math.round(ms / (60 * 60 * 1000)))
  if (ms >= 60 * 1000) return t('{0} 分前', Math.round(ms / (60 * 1000)))
  return t('たったいま')
}
