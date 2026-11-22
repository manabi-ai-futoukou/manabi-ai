import type { SkillKey, SkillState } from '@shared/types'
import { JsonState, dataFile } from './store'

/**
 * 教科とは別に育つ 5 つの力（100 点満点）。
 *
 *   ディベート力   … ディベートで勝つたびに上がる
 *   英会話力       … 英会話で 1 回やりとりするたびに上がる
 *   漢字力         … 漢字特訓で 1 字クリアするたびに上がる
 *   語彙力（日本語・英語） … 語彙力特訓で 1 語クリアするたびに上がる
 *
 * 上がり方は「100 点までの残りの一定割合」。はじめは伸びやすく、100 点に近づくほどゆっくりになる。
 * 割合は、それぞれの力が 90 点前後に届くまでの回数の目安から決めている
 * （ディベート 約 22 勝、英会話 約 230 回、漢字 約 580 字、語彙 約 770 語）。
 */
const RATES: Record<SkillKey, number> = { debate: 0.1, english: 0.01, kanji: 0.004, vocabJa: 0.003, vocabEn: 0.003 }
const KEYS = Object.keys(RATES) as SkillKey[]
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<SkillKey, number>

const stored = new JsonState<SkillState>(() => dataFile('skills.json'), () => ({ values: zero(), counts: zero() }))

export function getSkills(): SkillState {
  const saved = stored.get()
  return { values: { ...zero(), ...saved.values }, counts: { ...zero(), ...saved.counts } }
}

/** 力を 1 回ぶん上げる */
export function raiseSkill(key: SkillKey): SkillState {
  const current = getSkills()
  const value = current.values[key] + (100 - current.values[key]) * RATES[key]
  const next: SkillState = {
    values: { ...current.values, [key]: Math.round(value * 100) / 100 },
    counts: { ...current.counts, [key]: current.counts[key] + 1 },
  }
  stored.set(next)
  return next
}
