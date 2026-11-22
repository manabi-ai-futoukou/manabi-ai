// 訳した授業を AI に読み直させて、意味のずれ・抜け・訳したせいで成り立たなくなった問題を探す（訳は書きかえない）。
//
//   node tools/review-translations.mjs [--lang en] [--per-school 75 | --all] [--seed 1] [--only 授業の保存名,…] [--courses 科目の ID,…]
//        [--concurrency 10] [--model sonnet] [--effort medium] [--five 0.85] [--week 0.97] [--wait] [--redo] [--report]
//        [--older-than 時刻] [--kinds general,japanese,english]
//
// - 何も付けないと、学校（es・jhs・hs・hsp）ごとに --per-school 件ずつ、決まった順（--seed で変わる）で抜き取って読む。--all は全部。
// - 結果は <データ置き場>/i18n/<言語>/review/<保存名>.json（読んだ時刻・訳の指紋・見つかった問題）。訳が変わっていなければ、読み直さない。
// - 使用割合が --five・--week を超えたら、そこで止まる（もう一度実行すれば、続きから読む）。
//   --wait を付けると、止まらずに休み、1 時間ごと（回復の時刻が先に来れば、その時刻）に 1 件だけ読んで、回復していれば続ける。
// - --report は、AI を呼ばずに、これまでの結果のまとめだけを出す。
// - 1 回の読み直しには見落としがある（問題なしとされた授業の 2〜3% で、もう一度読むと重い問題が見つかる）。もう一度読ませるときは、
//   --older-than に「いまの時刻」（2026-11-18T07:30:00Z のような形か、ミリ秒の数）を書く。それより前に読んだ授業を、訳が変わっていなくても読み直す。
//   読み直した授業は時刻が新しくなるので、途中で止めても、同じ時刻を書いてもう一度実行すれば続きから進む（--redo は、毎回はじめから読む）。
//   --kinds は、訳し方の種類（ふつうの教科・国語・英語）でしぼる。
// - 見つかった問題を訳に入れるのは tools/apply-review.mjs。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { askClaude, createLimiter } from './lib/claude.mjs'
import { TRANSLATION_LANGS, lessonKind, normalizeSource } from '../src/shared/translate.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
if (!TRANSLATION_LANGS[lang]) throw new Error(`まだ用意していない言語です: ${lang}`)
const NAME = TRANSLATION_LANGS[lang].name
const model = opt('model', 'sonnet')
const effort = opt('effort', 'medium')
const concurrency = Number(opt('concurrency', 10))
const FIVE = Number(opt('five', 0.85))
const WEEK = Number(opt('week', 0.97))
const perSchool = Number(opt('per-school', 75))
const seed = opt('seed', '1')
const outRoot = join(dataDir, 'i18n', lang)
const reviewDir = join(outRoot, 'review')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [reviewDir, workDir, tempDir]) mkdirSync(dir, { recursive: true })

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const courses = new Map(catalog.courses.map((c) => [c.id, c]))
const courseOf = (key) => courses.get(key.replace(/\.deep$/, '').replace(/-\d+-\d+$/, ''))
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)

// ───────── 指示文 ─────────

const KIND_NOTE = {
  general: `- This lesson is not about the Japanese language. Where the original only explains how something is said or written in Japanese, the translation was told to say how it works in ${NAME} instead. That is intended.`,
  japanese: `- This lesson teaches the Japanese language. Example words and sentences, kanji, kana, passages, classical texts, and answers that are Japanese words were kept in Japanese on purpose, often with a reading in rōmaji and a gloss. That is intended. Report it only when the explanation around them is wrong or missing.`,
  english: `- This lesson teaches English to speakers of Japanese. English examples were kept, and Japanese glosses of English examples were dropped on purpose. That is intended.`,
}

const system = (kind) => `You check a translation of one lesson from a Japanese school textbook app into ${NAME}. You get the Japanese original and the translation. The reader is a student of the grade named in the user message.

Report real problems only:
- a change of meaning, or a fact that became wrong in translation (numbers, years, names, directions, cause and effect, negation, more/less);
- content of the original that is missing, or content that was added;
- a wrong technical term for the subject;
- a question, worked example, or answer that no longer works in ${NAME} (the answer does not match the question, a choice label points at the wrong choice, a blank cannot be filled in, a hint gives a wrong clue);
- a statement that holds only for the Japanese language or Japanese writing and is false or meaningless for a reader of the ${NAME} text;
- text left in Japanese that the reader needs in order to follow the lesson;
- ${NAME} that is ungrammatical, a sentence that is broken or unfinished, or wording clearly too hard for the grade.

These are intended. Do NOT report them:
${KIND_NOTE[kind]}
- Japanese proper nouns followed by the original in parentheses; rōmaji for Japanese terms.
- The teacher in this app is a character called ${TRANSLATION_LANGS[lang].teacher}; 先生 addressed or mentioned in a talk line may be translated with that name.
- An exercise that gave a Japanese sentence to be put into ${NAME} may give the meaning as an indirect instruction instead ("Say in English that you do not eat meat."). That is intended. Report it only when the finished answer sentence itself can be read in the question.
- In \`\`\`talk blocks, the "speaker(expression):" prefixes are kept as in the original (including speakers written in Japanese). Only what is said is translated.
- In \`\`\`picture, \`\`\`sim, \`\`\`plot, \`\`\`numberline blocks, ids, numbers and keys are unchanged. In \`\`\`figure blocks only the words inside <text> are translated.
- Choice labels ア, イ, ウ, エ became A, B, C, D. Units, yen, Japanese school grades, and Japanese eras are kept as in Japan.
- Wording that is merely different from what you would choose, or any other matter of taste.

For each problem give:
- "where": the exact passage of the translation that is wrong, copied character for character from the translation — one sentence or less, and long enough to be found by a search. For missing content, copy the passage right before the place where it should be.
- "what": what is wrong, in Japanese, in one or two sentences.
- "severity": "重い" when a student would learn something wrong, could not answer, or would miss content; "軽い" when the text is understandable but should be polished.
- "fix": the corrected ${NAME} text that should replace "where" exactly. Use an empty string when the fix is not a simple replacement.

If the translation can be used as it is, return ok: true with an empty list. Be strict about facts and lenient about style.`

const schema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' }, severity: { type: 'string', enum: ['重い', '軽い'] }, fix: { type: 'string' } },
        required: ['where', 'what', 'severity', 'fix'],
      },
    },
  },
  required: ['ok', 'problems'],
}

const SCHOOL = { es: 'elementary school', jhs: 'junior high school', hs: 'high school', hsp: 'a specialized (vocational) high school course' }
const audience = (key, course) => {
  if (!course) return 'school students in Japan'
  const grades = course.school === 'es' ? (course.id.match(/^es(\d+)/)?.[1] ?? '') : ''
  return `${SCHOOL[course.school] ?? 'school'}${grades ? ` grade${grades.length > 1 ? 's' : ''} ${[...grades].join('–')}` : ''}; the course is 「${course.subjectLabel} ${course.label}」`
}

// ───────── claude の呼び出しと、使用量の見はり ─────────

const wait = has('wait')
const limiter = createLimiter({ five: FIVE, week: WEEK, wait })
async function ask(systemFile, userText) {
  const answer = await askClaude({ systemFile, userText, model, effort, schema, cwd: workDir, limiter })
  let found = answer.structured
  if (!found) {
    try {
      found = JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
    } catch {
      throw new Error('返事を読み取れませんでした')
    }
  }
  return { found, cost: answer.cost }
}

// ───────── 対象を選ぶ ─────────

const only = opt('only', '').split(',').filter(Boolean)
const onlyCourses = opt('courses', '').split(',').filter(Boolean)
const all = []
for (const file of readdirSync(join(outRoot, 'lessons')).filter((f) => f.endsWith('.md'))) {
  const key = file.slice(0, -3)
  const source = join(dataDir, 'lessons', file)
  if (existsSync(source)) all.push({ key, source, target: join(outRoot, 'lessons', file) })
}
for (const course of catalog.courses) {
  const dir = join(root, 'resources', 'content', course.id)
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter((f) => /^[\w-]+\.md$/.test(f))) {
    const target = join(dir, `${file.slice(0, -3)}.${lang}.md`)
    if (existsSync(target)) all.push({ key: `shipped:${file.slice(0, -3)}`, source: join(dir, file), target })
  }
}
const plain = (key) => key.replace(/^shipped:/, '')
let chosen
if (only.length || onlyCourses.length) chosen = all.filter((job) => (!only.length || only.includes(plain(job.key))) && (!onlyCourses.length || onlyCourses.includes(courseOf(plain(job.key))?.id)))
else if (has('all')) chosen = all
else {
  // 学校ごとに、保存名と --seed から決まる順でならべて、先頭から取る（同じ --seed なら、いつも同じ授業になる）
  chosen = []
  for (const school of ['es', 'jhs', 'hs', 'hsp']) {
    const group = all.filter((job) => courseOf(plain(job.key))?.school === school).map((job) => ({ ...job, order: hash(`${seed}:${job.key}`) }))
    group.sort((x, y) => (x.order < y.order ? -1 : 1))
    chosen.push(...group.slice(0, perSchool))
  }
}
// --kinds: 訳し方の種類でしぼる。--older-than: この時刻より前に読んだものは、訳が変わっていなくても読み直す
const kinds = opt('kinds', '').split(',').filter(Boolean)
if (kinds.length) chosen = chosen.filter((job) => kinds.includes(lessonKind(courseOf(plain(job.key)))))
const olderThan = opt('older-than', '') ? Number(opt('older-than', '')) || Date.parse(opt('older-than', '')) : 0
if (opt('older-than', '') && !olderThan) throw new Error(`--older-than の時刻を読み取れません: ${opt('older-than', '')}`)
const reviewFile = (key) => join(reviewDir, `${key.replace(':', '_')}.json`)
const readReview = (key) => {
  try {
    return JSON.parse(readFileSync(reviewFile(key), 'utf8'))
  } catch {
    return null
  }
}

// ───────── 実行 ─────────

const count = { done: 0, failed: 0, cost: 0 }
if (!has('report')) {
  const todo = []
  const translatedIndex = existsSync(join(outRoot, 'lessons-index.json')) ? JSON.parse(readFileSync(join(outRoot, 'lessons-index.json'), 'utf8')) : {}
  for (const job of chosen) {
    // 訳したあとに日本語の本文が書き直された授業（掘り下げたもの。訳は前の版のまま）は、見くらべても意味が無いので読まない
    const from = translatedIndex[job.key]?.src
    if (from && from !== hash(normalizeSource(readFileSync(job.source, 'utf8')))) continue
    const text = readFileSync(job.target, 'utf8')
    const stamp = hash(text)
    const last = readReview(job.key)
    if (has('redo') || last?.stamp !== stamp || (olderThan && !(last.at >= olderThan))) todo.push({ ...job, text, stamp })
  }
  const systemFiles = {}
  for (const kind of ['general', 'japanese', 'english']) {
    systemFiles[kind] = join(tempDir, `review-${lang}-${kind}-${process.pid}.txt`)
    writeFileSync(systemFiles[kind], system(kind), 'utf8')
  }
  console.log(`${lang}: 選んだ ${chosen.length} 件のうち、これから読むのは ${todo.length} 件（同時に ${concurrency} 件、${model}・${effort}）`)
  let next = 0
  const started = Date.now()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const progressFile = join(outRoot, 'review-progress.json')
  const progress = (state) => writeFileSync(progressFile, JSON.stringify({ state, total: todo.length, done: count.done, failed: count.failed, cost: +count.cost.toFixed(2), minutes: Math.round((Date.now() - started) / 60000), ...limiter.state(), at: new Date().toISOString() }, null, 1), 'utf8')
  async function worker() {
    for (;;) {
      // 使用量の目安を超えていたら、ここで休む（--wait が無ければ、ここで終わる）
      const token = await limiter.enter()
      if (!token) break
      if (next >= todo.length) {
        limiter.leave(token)
        break
      }
      const job = todo[next++]
      const course = courseOf(plain(job.key))
      const kind = lessonKind(course)
      const user = `Audience: ${audience(job.key, course)}\n\n# ORIGINAL (Japanese)\n\n${normalizeSource(readFileSync(job.source, 'utf8'))}\n\n# TRANSLATION (${NAME})\n\n${job.text}\n`
      try {
        const answer = await ask(systemFiles[kind], user)
        count.cost += answer.cost
        const problems = (answer.found.problems ?? []).filter((p) => p && typeof p.where === 'string' && typeof p.what === 'string')
        writeFileSync(reviewFile(job.key), JSON.stringify({ at: Date.now(), stamp: job.stamp, model, effort, ok: problems.length === 0, problems }, null, 1), 'utf8')
        count.done += 1
      } catch (error) {
        console.log(`${job.key}: ${String(error.message).slice(0, 160)}`)
        limiter.fail(error.message)
        if (limiter.paused) {
          // 上限のせいで失敗した。列のうしろにもどして、休み明けに読む
          todo.push(job)
          progress('休み')
        } else {
          count.failed += 1
          await sleep(5_000)
        }
      }
      if ((count.done + count.failed) % 50 === 0) {
        const usage = limiter.state()
        progress(usage.paused ? '休み' : '進行中')
        console.log(`${count.done + count.failed} / ${todo.length} 件、${Math.round((Date.now() - started) / 60000)} 分、5 時間 ${usage.five ?? '?'}・週 ${usage.week ?? '?'}`)
      }
      limiter.leave(token)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  progress(next >= todo.length ? '終わり' : '休み')
  if (next < todo.length) console.log(`${limiter.state().pauseWhy}なので、ここで止めました（残り ${todo.length - next} 件。もう一度実行すると、続きから読みます）`)
  console.log(`読んだ ${count.done} 件、失敗 ${count.failed} 件、API 換算 ${count.cost.toFixed(2)} ドル`)
}

// ───────── まとめ ─────────

const rows = { es: [], jhs: [], hs: [], hsp: [] }
for (const job of chosen) {
  const review = readReview(job.key)
  const school = courseOf(plain(job.key))?.school
  if (review && rows[school] && review.stamp === hash(readFileSync(job.target, 'utf8'))) rows[school].push({ key: job.key, ...review })
}
const heavy = (r) => r.problems.filter((p) => p.severity === '重い').length
const light = (r) => r.problems.filter((p) => p.severity === '軽い').length
console.log('\n学校\t読んだ\t問題なし\t重い問題あり\t軽い問題だけ\t重い問題の数\t軽い問題の数')
for (const [school, list] of Object.entries(rows)) {
  if (!list.length) continue
  console.log(`${catalog.schools[school]}\t${list.length}\t${list.filter((r) => !r.problems.length).length}\t${list.filter((r) => heavy(r)).length}\t${list.filter((r) => !heavy(r) && light(r)).length}\t${list.reduce((s, r) => s + heavy(r), 0)}\t${list.reduce((s, r) => s + light(r), 0)}`)
}
const everything = Object.values(rows).flat()
writeFileSync(join(outRoot, 'review-summary.json'), JSON.stringify(everything.filter((r) => r.problems.length).map((r) => ({ key: r.key, problems: r.problems })), null, 1), 'utf8')
console.log(`\nまとめ: ${join(outRoot, 'review-summary.json')}（問題のあった ${everything.filter((r) => r.problems.length).length} 件）`)
