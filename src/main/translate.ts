import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLang, t } from '@shared/i18n'
import { Mismatch, TRANSLATION_LANGS, isLeftover, lessonKind, normalizeSource, retryHint, settleTranslation, translationSystem, translationUser } from '@shared/translate'
import type { Lesson, LessonVariant } from '@shared/types'
import { askText } from './ai/ask'
import { getLesson, getSourceLesson, sourceCourse, translatedLessonFile } from './content'
import { dataDir } from './paths'
import { getSettings } from './store'

/**
 * 授業 1 つを、いまの表示の言語に訳す（訳がまだ無い授業を、教科書の画面から訳すときに使う）。
 *
 * 全部の授業をまとめて訳すのは、道具（tools/translate-lessons.mjs）の仕事。訳し方の決まりは、どちらも src/shared/translate.ts を使う。
 * 日本語の授業そのものは書きかえない。
 */

const working = new Map<string, Promise<Lesson>>()

export function translateLesson(lessonId: string, variant: LessonVariant): Promise<Lesson> {
  const lang = getLang()
  if (lang === 'ja' || !TRANSLATION_LANGS[lang]) throw new Error(t('この言語には、まだ訳せません。'))
  const source = getSourceLesson(lessonId, variant)
  if (!source) throw new Error(t('この授業の教科書がまだ用意されていません。'))
  const running = working.get(source.key)
  if (running) return running

  const job = (async () => {
    const course = sourceCourse(source.courseId)
    const kind = lessonKind(course)
    const body = normalizeSource(source.body)
    // 訳は、思考を少なめにして速く作る（まとめて訳すときと同じ条件）
    const ai = { ...getSettings().ai, effort: 'low' }
    let why = ''
    // 「日本語が残っている」で 2 回続けて落ちたら、日本語そのものを扱う授業とみて、確かめをゆるくする
    let leftovers = 0
    // 落ちた理由は、前のものも重ねて伝える
    const reasons = new Set<string>()
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 訳し直すときは、前の訳が形の確かめでどう落ちたかを添える
      if (why) reasons.add(why)
      const raw = await askText(ai, translationSystem(kind, lang), translationUser(source.key, course, body, lang, retryHint(body, [...reasons].join('／'))))
      try {
        const people: Record<string, string> = {}
        const text = settleTranslation(body, raw, kind, people, leftovers >= 2)
        writeFileSync(translatedLessonFile(source), text, 'utf8')
        record(lang, source.authored ? `shipped:${source.key}` : source.key, body, people)
        const lesson = getLesson(lessonId, variant)
        if (!lesson) throw new Error(t('授業が見つかりません。'))
        return lesson
      } catch (error) {
        // 形が元とちがう訳は、訳し直す（3 回まで）
        if (!(error instanceof Mismatch)) throw error
        why = error.message
        leftovers = isLeftover(why) ? leftovers + 1 : 0
      }
    }
    throw new Error(t('この授業を訳せませんでした（{0}）。もう一度お試しください。', why))
  })()
  working.set(source.key, job)
  void job.catch(() => undefined).finally(() => working.delete(source.key))
  return job
}

/** 訳した記録（まとめて訳す道具と同じファイル）に書きたす。掛け合いに出た人物の名前の訳は、名前の表にも足す */
function record(lang: string, key: string, body: string, people: Record<string, string>): void {
  const dir = dataDir('i18n', lang)
  const read = <T>(file: string, fallback: T): T => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
    } catch {
      return fallback
    }
  }
  const indexFile = join(dir, 'lessons-index.json')
  const index = read<Record<string, unknown>>(indexFile, {})
  index[key] = { at: Date.now(), src: createHash('sha1').update(body).digest('hex').slice(0, 12), ...(Object.keys(people).length ? { people } : {}) }
  writeFileSync(indexFile, JSON.stringify(index), 'utf8')
  if (Object.keys(people).length) {
    const namesFile = join(dir, 'people.json')
    writeFileSync(namesFile, JSON.stringify({ ...people, ...read<Record<string, string>>(namesFile, {}) }, null, 1), 'utf8')
  }
}
