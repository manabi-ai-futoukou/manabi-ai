import type { VocabLang } from './types'
import { t } from './i18n.ts'

export interface VocabLevel {
  id: string
  label: string
  /** どんな語を選ぶか（AI への指示と、画面の説明に使う） */
  guide: string
}

/** 語彙力特訓で選べるレベル */
export const VOCAB_LEVELS: Record<VocabLang, VocabLevel[]> = {
  ja: [
    { id: 'ja-es', label: t('小学校'), guide: t('小学校 4〜6 年の教科書や読み物に出てくる言葉') },
    { id: 'ja-jhs', label: t('中学校'), guide: t('中学校の教科書や、新聞のやさしい記事に出てくる言葉') },
    { id: 'ja-hs', label: t('高校'), guide: t('高校の現代文や評論、新聞の記事に出てくる言葉') },
    { id: 'ja-adv', label: t('大学受験・教養'), guide: t('大学入試の評論文や、新聞の社説、大人向けの本に出てくる言葉') },
  ],
  en: [
    { id: 'en-jhs1', label: t('中学 1 年'), guide: t('中学 1 年の教科書に出てくる、基本の英単語') },
    { id: 'en-jhs2', label: t('中学 2 年'), guide: t('中学 2 年の教科書に出てくる英単語') },
    { id: 'en-jhs3', label: t('中学 3 年'), guide: t('中学 3 年の教科書と、高校入試に出てくる英単語') },
    { id: 'en-hs', label: t('高校'), guide: t('高校の教科書と、大学入学共通テストに出てくる英単語') },
    { id: 'en-exam', label: t('大学受験'), guide: t('難関大学の入試に出てくる英単語') },
  ],
}

export const VOCAB_LANG_LABEL: Record<VocabLang, string> = { ja: t('日本語'), en: t('英語') }

/** 1 語をクリアするのに必要な回数 */
export const VOCAB_WORD_TIMES = 5
export const VOCAB_SENTENCES = 2

export function findVocabLevel(levelId: string): { lang: VocabLang; level: VocabLevel } | null {
  for (const lang of ['ja', 'en'] as const) {
    const level = VOCAB_LEVELS[lang].find((l) => l.id === levelId)
    if (level) return { lang, level }
  }
  return null
}
