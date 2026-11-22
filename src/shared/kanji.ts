import type { KanjiScope, KanjiWords } from './types'
import { t } from './i18n.ts'

/** 漢字のまとまり。習う順に並べてある。 */
export const KANJI_GROUPS = [
  { id: 'g1', label: t('小学 1 年'), joyo: true },
  { id: 'g2', label: t('小学 2 年'), joyo: true },
  { id: 'g3', label: t('小学 3 年'), joyo: true },
  { id: 'g4', label: t('小学 4 年'), joyo: true },
  { id: 'g5', label: t('小学 5 年'), joyo: true },
  { id: 'g6', label: t('小学 6 年'), joyo: true },
  { id: 'g8', label: t('中学以降'), joyo: true },
  { id: 'jinmei', label: t('人名用漢字'), joyo: false },
  { id: 'other', label: t('そのほか'), joyo: false },
] as const

export type KanjiGroupId = (typeof KANJI_GROUPS)[number]['id']

/** KANJIDIC2 の学年（1〜6 = 小学校、8 = そのほかの常用漢字、9・10 = 人名用漢字、0 = それ以外）から、まとまりを決める */
export function groupOfGrade(grade: number): KanjiGroupId {
  if (grade >= 1 && grade <= 6) return `g${grade}` as KanjiGroupId
  if (grade === 8) return 'g8'
  return grade === 9 || grade === 10 ? 'jinmei' : 'other'
}

export const KANJI_SCOPE_LABEL: Record<KanjiScope, string> = { joyo: t('常用漢字のみ'), other: t('常用外のみ'), all: t('全部') }

/** 対象（常用のみ／常用外のみ／全部）にふくまれるまとまり */
export function groupsInScope(scope: KanjiScope) {
  return KANJI_GROUPS.filter((g) => scope === 'all' || g.joyo === (scope === 'joyo'))
}

/** 1 字をクリアするのに、正しい書き順で書く回数 */
export const KANJI_TIMES = 10

/** 書き順の線が描かれている枠の大きさ（KanjiVG の座標。0〜109） */
export const KANJI_BOX = 109

const strip = (text: string) => text.replace(/[\s　、。，．,.!！?？「」『』（）()・]/g, '')

/**
 * 単語と例文を、どのくらい書き写せたか（0〜1）。AI は使わず、書いた量から機械的に見積もる。
 *   タイピング … その言葉や文が、入力した文章の中にそのままあれば、書き写したとみなす
 *   手書き     … 1 文字あたり 1.5 本ぶんの線が書かれていれば、書き写したとみなす（ひらがなは 1〜4 画、漢字はもっと多い）
 */
export function copyProgress(words: KanjiWords, inkStrokes: number, typed: string): number {
  const targets = [...words.words.map((w) => w.word), ...words.sentences].map(strip).filter(Boolean)
  const total = targets.reduce((sum, target) => sum + target.length, 0)
  if (!total) return 1
  const text = strip(typed)
  const typedChars = targets.filter((target) => text.includes(target)).reduce((sum, target) => sum + target.length, 0)
  return Math.min(1, typedChars / total + inkStrokes / (total * 1.5))
}

/** KANJIDIC2 の訓読みの書き方（「つ.ぐ」「-ひと」）を、読みやすい形（「つ（ぐ）」「ひと」）にする */
export function formatKun(reading: string): string {
  const [stem, okuri] = reading.replace(/-/g, '').split('.')
  return okuri ? `${stem}（${okuri}）` : stem
}
