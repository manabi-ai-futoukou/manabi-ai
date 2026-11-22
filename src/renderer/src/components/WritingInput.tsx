import { ESSAY_PARTS, countChars, joinEssay, splitEssay, type EssayParts } from '@shared/essay'
import { t, tx } from '@/lib/i18n'

/** 序論・本論・結論の、画面に出す名前と説明 */
export const PART_TEXT: Record<keyof EssayParts, { label: string; hint: string }> = {
  intro: { label: t('序論'), hint: t('問いに対する自分の答え（立場）を、はじめに書きます。') },
  body: { label: t('本論'), hint: t('そう考える理由を、根拠や具体例を挙げて書きます。') },
  conclusion: { label: t('結論'), hint: t('全体をまとめて、もう一度、自分の答えを書きます。') },
}

/** 字数と、目安に対する様子（少ない・ちょうどよい・多い） */
function Counter({ count, min, max }: { count: number; min: number; max: number }) {
  const state = count === 0 ? 'empty' : count < min ? 'short' : count > max ? 'long' : 'good'
  return (
    <span className="writing-count" data-state={state}>
      {tx('{0} 字', count)}
      <small>{tx('（目安 {0}〜{1} 字）', min, max)}</small>
    </span>
  )
}

/** 記述（短い説明）を書く欄。字数を数えて、目安とくらべる */
export function WrittenInput({ value, onChange, min, max, label, disabled }: { value: string; onChange: (value: string) => void; min: number; max: number; label: string; disabled?: boolean }) {
  return (
    <div className="writing">
      <textarea className="answer" rows={4} value={value} disabled={disabled} maxLength={600} placeholder={t('自分の言葉で説明しましょう')} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <Counter count={countChars(value)} min={min} max={max} />
    </div>
  )
}

/**
 * 論述を書く欄。序論・本論・結論に分けて書く。
 * 値は、3 つをまとめた 1 つの文章（【序論】…【本論】…【結論】…）で持つ。
 */
export function EssayInput({ value, onChange, min, max, label, disabled }: { value: string; onChange: (value: string) => void; min: number; max: number; label: string; disabled?: boolean }) {
  const parts = splitEssay(value)
  const set = (id: keyof EssayParts, text: string) => onChange(joinEssay({ ...parts, [id]: text }))
  const total = countChars(parts.intro) + countChars(parts.body) + countChars(parts.conclusion)
  return (
    <div className="writing writing-essay">
      {ESSAY_PARTS.map((part) => (
        <label key={part.id} className="writing-part">
          <span>
            <strong>{PART_TEXT[part.id].label}</strong>
            <small>{PART_TEXT[part.id].hint}</small>
            <em>{tx('{0} 字', countChars(parts[part.id]))}</em>
          </span>
          <textarea className="answer" rows={part.id === 'body' ? 9 : 4} value={parts[part.id]} disabled={disabled} maxLength={part.id === 'body' ? 2400 : 900} aria-label={`${label} ${PART_TEXT[part.id].label}`} onChange={(e) => set(part.id, e.target.value)} />
        </label>
      ))}
      <Counter count={total} min={min} max={max} />
    </div>
  )
}
