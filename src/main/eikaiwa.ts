import { readdirSync } from 'node:fs'
import type { ChatMessage, EikaiwaLevel } from '@shared/types'
import { sendEikaiwa } from './ai'
import { askText } from './ai/ask'
import { courseIdOfLesson, getCourse, getCurriculum } from './content'
import { dataDir } from './paths'
import { raiseSkill } from './skills'
import { getSettings, listNotebooks } from './store'
import { listTestResults } from './test'
import { t } from '@shared/i18n'

/**
 * 英会話モード。先生や同級生（AI）と、英語で会話する。
 *
 *   1. 言いたいことを、英語または日本語で書く（日本語は、いまのレベルの英語に直す）
 *   2. その英文を声に出して言う。音声認識が正しく聞き取れたら、相手に送られる
 *   3. 相手が英語（日本語訳つき）で返事をする。英語の部分は読み上げられる
 *
 * 会話に使う英語のむずかしさは、英語の授業をどこまで進めたかに合わせる（設定で制限を外せる）。
 * 1 回やりとりするたびに、英会話力が上がる。
 */

/** 英語の科目を、習う順に並べたもの */
const ORDER = ['es5-english', 'es6-english', 'jhs1-english', 'jhs2-english', 'jhs3-english', 'hs-eicom1', 'hs-ronhyo1', 'hs-eicom2', 'hs-ronhyo2', 'hs-eicom3', 'hs-ronhyo3']

/** 学習したあとがある授業（ノートを作った、質問した、テストの範囲にした） */
function studiedLessons(): Set<string> {
  const ids = new Set<string>()
  for (const notebook of listNotebooks()) if (notebook.kind === 'lesson' && notebook.lessonId) ids.add(notebook.lessonId)
  for (const name of readdirSync(dataDir('chats'))) ids.add(name)
  for (const result of listTestResults()) for (const id of result.lessonIds) ids.add(id)
  return ids
}

interface Level extends EikaiwaLevel {
  /** AI への指示に使う説明 */
  guide: string
}

function currentLevel(): Level {
  if (getSettings().eikaiwa.unlimited) {
    return {
      label: t('制限なし'),
      unlimited: true,
      guide: t('制限なし。語彙や文法をしぼらず、自然な英語で話します。ただし、生徒の英文から力を見きわめ、伝わらないほどむずかしい表現は避けます。'),
    }
  }
  // いちばん先まで進んだ英語の授業を探す
  let best: { course: number; unit: number; lesson: number } | null = null
  for (const id of studiedLessons()) {
    const course = ORDER.indexOf(courseIdOfLesson(id))
    const match = /-(\d+)-(\d+)$/.exec(id)
    if (course < 0 || !match) continue
    const here = { course, unit: Number(match[1]), lesson: Number(match[2]) }
    if (!best || here.course > best.course || (here.course === best.course && (here.unit > best.unit || (here.unit === best.unit && here.lesson > best.lesson)))) best = here
  }
  if (!best) {
    return {
      label: t('英語を習いはじめたところ'),
      unlimited: false,
      guide:
        t('英語を習いはじめたばかりです。あいさつ、自己紹介、好きなもの・できること、身のまわりのものについて、小学校で習うやさしい単語と、I am / I like / I can / Do you ...? のような基本の文だけを使います。1 文は 4〜8 語にします。'),
    }
  }
  const course = getCourse(ORDER[best.course])
  const curriculum = getCurriculum(ORDER[best.course])
  const reached = best
  const unit = curriculum?.units.find((u) => u.number === reached.unit)
  const learnedUnits = (curriculum?.units ?? []).filter((u) => u.number <= reached.unit).map((u) => u.title)
  const earlier = ORDER.slice(0, best.course)
    .map((id) => getCourse(id))
    .filter((c) => !!c)
    .map((c) => `- ${c.title}: ${c.scope}`)
  const title = course?.title ?? t('英語')
  return {
    label: `${title}${unit ? t(' {0}「{1}」まで', unit.number, unit.title) : ''}`,
    unlimited: false,
    guide: t('「{0}」の{1}まで学習しています。\n{2}\n{3}\nここまでに習う文法と語彙の範囲で話します。まだ習っていない文法（上に無いもの）は使いません。1 文は短めにします。', title, unit ? t('単元 {0}「{1}」', unit.number, unit.title) : t('途中'), learnedUnits.length ? t('この科目でこれまでに学んだ単元: {0}', learnedUnits.join('、')) : t('この科目の内容: {0}', course?.scope ?? ''), earlier.length ? t('それより前に学んだ内容:\n{0}', earlier.join('\n')) : ''),
  }
}

export function eikaiwaLevel(): EikaiwaLevel {
  const { label, unlimited } = currentLevel()
  return { label, unlimited }
}

/** 日本語で書いた「言いたいこと」を、いまのレベルの英語にする */
export async function toEnglish(text: string): Promise<string> {
  const reply = await askText(
    getSettings().ai,
    t('あなたは、日本の学習者の英会話を助ける英語の教師です。'),
    t('生徒が、英会話で相手に言いたいことを日本語で書きました。これを、そのまま声に出して言える自然な英語にしてください。\n\n# 生徒の英語のレベル\n{0}\n\n# 決まり\n- レベルに合った語彙と文法を使い、短くシンプルな文にします（1〜2 文）。\n- 生徒の言いたい内容を変えません。言いすぎたり、足したりしません。\n- 英文だけを出力します。説明、かぎかっこ、日本語は付けません。\n\n# 生徒が書いた日本語\n{1}', currentLevel().guide, text),
  )
  const english = reply
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/[ぁ-んァ-ヶ一-龠]/.test(line))
    .join(' ')
    .replace(/^["“「]+|["”」]+$/g, '')
    .slice(0, 400)
  if (!english) throw new Error(t('英語にできませんでした。もう一度お試しください。'))
  return english
}

/** 声に出して言えた英文を、相手に送る */
export async function sayInEikaiwa(characterId: string, english: string, onDelta: (messageId: string, full: string) => void): Promise<ChatMessage[]> {
  const added = await sendEikaiwa(characterId, english, currentLevel().guide, onDelta)
  raiseSkill('english')
  return added
}
