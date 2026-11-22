// 授業の本文を外国語に訳して、データ置き場の i18n/<言語>/lessons/ に置く（元の日本語の授業は書きかえない）。
//
//   node tools/translate-lessons.mjs [--lang en] [--only 授業の保存名,…] [--only-file 保存名のファイル] [--courses 科目の ID,…] [--limit 件数]
//        [--concurrency 20] [--model sonnet] [--effort low] [--redo] [--stale] [--five 0.85] [--week 0.86] [--first 学校,…] [--out フォルダ]
//
// - --first jhs のように学校（es・jhs・hs・hsp）を書くと、その学校の授業を先に訳す。
// - --recheck を付けると、いまある訳を、いまの確かめ方でもう一度確かめて、通らないものだけを訳し直す（確かめ方を足したあとに使う）。
//   --dry は、何件を訳す（訳し直す）ことになるかを理由ごとに数えるだけで、AI は呼ばない。
// - すでに訳してあるものは飛ばす。--stale を付けると、元の授業があとから変わったもの（掛け合いや挿絵が足されたものなど）だけを訳し直す。--redo は全部やり直す。
//   掘り下げて書き直した授業（tools/deepen-lessons.mjs。一覧は <データ置き場>/deepened.json）は、訳を前の版のまま残してある（アプリは「日本語版と
//   内容が異なる」と表示する）。--stale は、これらも訳し直す。--recheck と読み直し（review-translations.mjs）は、これらを飛ばす。
// - 訳し方の決まり（AI への指示文と、訳の形の確かめ方）は src/shared/translate.ts にある（アプリの中で 1 件ずつ訳すときと同じもの）。
//   形が元とちがう訳は、2 回まで訳し直す（どこがちがったかを、元の授業の形といっしょに AI に伝える）。
//   挿絵や図解の ID・数値、掛け合いの話し手と表情は、元のものにもどす。
//   「日本語が残っている」で続けて落ちる授業（敬語の使い方など、日本語そのものを扱うもの）は、確かめをゆるくして通し、記録に lenient と書く。
// - claude が知らせてくる使用割合が、5 時間あたり --five、週あたり --week を超えたら休む。休んでいるあいだは、1 時間ごと（回復の時刻が
//   先に来れば、その時刻）に 1 件だけ訳して、回復していれば続ける（上限が、決まった時刻より前にもどされることがあるため）。
//   --week 1.01 のように 1 より大きくすると、割合では休まない（上限に達して使えなくなったら休み、30 分ごとに試して続ける）。
// - --from-review を付けると、読み直し（tools/review-translations.mjs）で重い問題が見つかった授業を、その指摘を添えて訳し直す。
//   訳し直す前の訳は i18n/<言語>/previous/ に取っておく（悪くなったら、tools/settle-review.mjs がもどす）。1 つの授業につき --max-fixes 回（2 回）まで。
// - 同梱の授業（resources/content/<科目>/*.md）は、同じフォルダに <授業の ID>.<言語>.md として置く。
// - 記録は i18n/<言語>/lessons-index.json（保存名 → 訳した時刻・元の本文の指紋・掛け合いに出た人物の名前の訳）、
//   訳せなかったものは failed.json、進み具合は progress.json。終わったら node tools/translate-data.mjs --names で、人物の名前の表を作り直す。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { askClaude, createLimiter } from './lib/claude.mjs'
import { Mismatch, TRANSLATION_LANGS, isLeftover, lessonKind, normalizeSource, retryHint, settleTranslation, translationSystem, translationUser } from '../src/shared/translate.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
const model = opt('model', 'sonnet')
const effort = opt('effort', 'low')
const concurrency = Number(opt('concurrency', 20))
const FIVE = Number(opt('five', 0.85))
const WEEK = Number(opt('week', 0.86))
const outRoot = opt('out', '') ? resolve(opt('out', '')) : join(dataDir, 'i18n', lang)
const outLessons = join(outRoot, 'lessons')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [outLessons, workDir, tempDir]) mkdirSync(dir, { recursive: true })
if (!TRANSLATION_LANGS[lang]) throw new Error(`まだ用意していない言語です: ${lang}`)

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const courses = new Map(catalog.courses.map((c) => [c.id, c]))
const courseOf = (key) => courses.get(key.replace(/^shipped:/, '').replace(/\.deep$/, '').replace(/-\d+-\d+$/, ''))

// ───────── claude の呼び出しと、使用量の見はり ─────────

// 休みに入るときに、ここまでの記録を書いておく（休んでいるあいだに道具を止めても、記録が残るように）。中身は下で入れる
let onPause = () => undefined
const limiter = createLimiter({ five: FIVE, week: WEEK, wait: true, onPause: () => onPause() })
const ask = (systemFile, userText) => askClaude({ systemFile, userText, model, effort, cwd: workDir, limiter })

// ───────── 対象を集める ─────────

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const indexFile = join(outRoot, 'lessons-index.json')
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {}
let dirty = 0
function saveIndex(force = false) {
  if (!force && ++dirty < 25) return
  dirty = 0
  // アプリの中で 1 件ずつ訳したものが、あとから足されていることがある。こちらに無い記録は取りこんでから書く
  try {
    const onDisk = JSON.parse(readFileSync(indexFile, 'utf8'))
    for (const [key, value] of Object.entries(onDisk)) if (!index[key]) index[key] = value
  } catch {}
  writeFileSync(`${indexFile}.tmp`, JSON.stringify(index), 'utf8')
  renameSync(`${indexFile}.tmp`, indexFile)
}

const MAX_FIXES = Number(opt('max-fixes', 2))
const reviewFile = (key) => join(outRoot, 'review', `${key.replace(':', '_')}.json`)
const readReview = (key) => {
  try {
    return JSON.parse(readFileSync(reviewFile(key), 'utf8'))
  } catch {
    return null
  }
}
/** 読み直しで見つかった問題を、訳し直すときに AI に伝える文 */
const reviewHint = (notes) =>
  notes?.length
    ? `IMPORTANT — a reviewer compared an earlier translation of this lesson with the original and found the problems below (described in Japanese). Translate the lesson again from the original, and make sure that none of them occurs:\n${notes.map((p) => `- ${p.what}${p.where ? ` (the earlier translation said: "${String(p.where).slice(0, 200)}")` : ''}`).join('\n')}`
    : ''
/** 訳し直す前の訳と、その読み直しの結果を取っておく（訳し直したほうが悪くなったら、tools/settle-review.mjs がもどす） */
const previousDir = join(outRoot, 'previous')
function keepPrevious(job) {
  mkdirSync(previousDir, { recursive: true })
  const name = job.key.replace(':', '_')
  copyFileSync(job.target, join(previousDir, `${name}.md`))
  if (existsSync(reviewFile(job.key))) copyFileSync(reviewFile(job.key), join(previousDir, `${name}.review.json`))
}

// --only-file には、保存名をならべたファイル（JSON の配列か、1 行に 1 つ）を書く。数が多いときに使う
const listed = opt('only-file', '') ? readFileSync(resolve(opt('only-file', '')), 'utf8').trim() : ''
const only = new Set([...opt('only', '').split(','), ...(listed.startsWith('[') ? JSON.parse(listed) : listed.split(/\r?\n/))].map((k) => String(k).trim()).filter(Boolean))
const onlyCourses = opt('courses', '').split(',').filter(Boolean)
const jobs = []
const wanted = (key) => (!only.size || only.has(key)) && (!onlyCourses.length || onlyCourses.includes(courseOf(key)?.id))
for (const file of readdirSync(join(dataDir, 'lessons')).filter((f) => f.endsWith('.md'))) {
  const key = file.slice(0, -3)
  if (wanted(key)) jobs.push({ key, source: join(dataDir, 'lessons', file), target: join(outLessons, file) })
}
// 同梱の授業（人が書いたもの）
if (!opt('out', ''))
  for (const course of catalog.courses) {
    const dir = join(root, 'resources', 'content', course.id)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => /^[\w-]+\.md$/.test(f))) {
      const key = `shipped:${file.slice(0, -3)}`
      if (wanted(file.slice(0, -3))) jobs.push({ key, source: join(dir, file), target: join(dir, `${file.slice(0, -3)}.${lang}.md`) })
    }
  }

const todo = []
for (const job of jobs) {
  const body = normalizeSource(readFileSync(job.source, 'utf8'))
  const stamp = hash(body)
  const done = index[job.key] && existsSync(job.target)
  // --recheck: いまある訳を、いまの確かめ方でもう一度確かめて、通らないものだけを訳し直す（確かめ方を足したあとに使う）
  let why = ''
  // 記録に accepted と書いてある授業は、人が読んで「このままでよい」と決めたものなので、確かめ直さない
  if (has('recheck') && done && !index[job.key].accepted && index[job.key].src === stamp) {
    try {
      settleTranslation(body, readFileSync(job.target, 'utf8'), lessonKind(courseOf(job.key)), {}, !!index[job.key].lenient)
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error
      why = error.message
    }
  }
  // --from-review: 読み直し（review-translations.mjs）で重い問題が見つかった授業を、その指摘を添えて訳し直す（1 つの授業につき --max-fixes 回まで）
  let notes = null
  if (has('from-review') && done && (index[job.key].fixes ?? 0) < MAX_FIXES) {
    const review = readReview(job.key)
    if (review && review.stamp === hash(readFileSync(job.target, 'utf8'))) {
      const heavy = (review.problems ?? []).filter((p) => p.severity === '重い')
      if (heavy.length) notes = heavy
    }
  }
  if (has('redo') || !done || (has('stale') && index[job.key].src !== stamp) || why || notes) todo.push({ ...job, body, stamp, why, notes })
}
if (has('dry')) {
  // 何を訳し直すことになるかを、理由ごとに数えて終わる（AI は呼ばない）
  const tally = new Map()
  for (const job of todo) {
    const reason = job.why ? job.why.replace(/（.*$/, '') : job.notes ? '読み直しで重い問題が見つかった' : '訳がまだ無い・元が変わった'
    tally.set(reason, [...(tally.get(reason) ?? []), job.key])
  }
  console.log(`${lang}: 対象 ${jobs.length} 件のうち、訳す（訳し直す）ことになるのは ${todo.length} 件`)
  for (const [reason, keys] of [...tally].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${keys.length} 件  ${reason}  例: ${keys.slice(0, 4).join(', ')}`)
  process.exit(0)
}
// --first に書いた学校（es・jhs・hs・hsp）の授業を先に訳す。あとは保存名の順
const first = opt('first', '').split(',').filter(Boolean)
const rank = (key) => {
  const at = first.indexOf(courseOf(key)?.school)
  return at >= 0 ? at : first.length
}
const plain = (key) => key.replace(/^shipped:/, '')
todo.sort((x, y) => rank(x.key) - rank(y.key) || (plain(x.key) < plain(y.key) ? -1 : 1))
const queue = todo.slice(0, Number(opt('limit', todo.length)))

// ───────── 実行 ─────────

const systemFiles = {}
for (const kind of ['general', 'japanese', 'english']) {
  systemFiles[kind] = join(tempDir, `translate-${lang}-${kind}-${process.pid}.txt`)
  writeFileSync(systemFiles[kind], translationSystem(kind, lang), 'utf8')
}
const failedFile = join(outRoot, 'failed.json')
const failed = existsSync(failedFile) ? JSON.parse(readFileSync(failedFile, 'utf8')) : {}
const progressFile = join(outRoot, 'progress.json')
const started = Date.now()
const count = { done: 0, failed: 0, retried: 0, cost: 0 }
function report(state) {
  const usage = limiter.state()
  writeFileSync(
    progressFile,
    JSON.stringify({ state, total: queue.length, ...count, cost: +count.cost.toFixed(2), already: jobs.length - todo.length, minutes: Math.round((Date.now() - started) / 60000), five: usage.five, week: usage.week, pauseUntil: usage.pauseUntil, pauseWhy: usage.pauseWhy, at: new Date().toISOString() }, null, 1),
    'utf8',
  )
}
onPause = () => {
  saveIndex(true)
  report('休み')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`${lang}: 対象 ${jobs.length} 件のうち、これから訳すのは ${queue.length} 件（同時に ${concurrency} 件、${model}・${effort}）`)
let next = 0
async function worker() {
  while (next < queue.length) {
    // 使用量の目安を超えていたら、ここで休む（休み明けは、1 件だけ試して回復を確かめる）
    const token = await limiter.enter()
    if (next >= queue.length) {
      limiter.leave(token)
      break
    }
    const job = queue[next++]
    const course = courseOf(job.key)
    const kind = lessonKind(course)
    let saved = false
    let requeued = false
    let why = ''
    // 形の確かめで落ちた理由。訳し直すときに、元の授業の形を具体的に添える（前の実行で訳せなかった授業は、最初から添える）
    let rejected = job.why || (typeof failed[job.key] === 'string' ? failed[job.key] : '')
    // 「日本語が残っている」で 2 回続けて落ちたら、日本語そのものを扱う授業とみて、確かめをゆるくする
    // （前の実行で 3 回とも「日本語が残っている」で落ちた授業は、最初からゆるくする。--recheck で見つけた授業は、ふつうの確かめから始める）
    let leftovers = !job.why && isLeftover(rejected) ? 2 : 0
    const reasons = new Set()
    for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
      try {
        const lenient = leftovers >= 2
        // 落ちた理由は、前のものも重ねて伝える（1 つ直すと別のところで落ちる、をくり返さないように）
        if (rejected) reasons.add(rejected)
        const hint = [retryHint(job.body, [...reasons].join('／')), reviewHint(job.notes)].filter(Boolean).join('\n\n')
        const answer = await ask(systemFiles[kind], translationUser(job.key, course, job.body, lang, hint))
        count.cost += answer.cost
        const people = {}
        const text = settleTranslation(job.body, answer.text, kind, people, lenient)
        const fixes = (index[job.key]?.fixes ?? 0) + (job.notes ? 1 : 0)
        if (job.notes) keepPrevious(job)
        writeFileSync(job.target, text, 'utf8')
        index[job.key] = { at: Date.now(), src: job.stamp, ...(attempt > 1 ? { tries: attempt } : {}), ...(lenient ? { lenient: true } : {}), ...(fixes ? { fixes } : {}), ...(Object.keys(people).length ? { people } : {}) }
        saveIndex()
        saved = true
        if (attempt > 1) count.retried += 1
        delete failed[job.key]
      } catch (error) {
        why = String(error.message).slice(0, 200)
        if (error instanceof Mismatch) {
          rejected = why
          leftovers = isLeftover(why) ? leftovers + 1 : 0
        } else {
          // 上限や通信の失敗。少し待ってから、同じ授業をもう一度
          console.log(`${job.key}: ${why}`)
          limiter.fail(why)
          await sleep(20_000)
          if (limiter.paused) {
            // 休みに入るときは、この授業を列のうしろにもどして、休み明けにやり直す
            queue.push(job)
            requeued = true
            break
          }
        }
      }
    }
    if (saved) count.done += 1
    else if (!requeued && job.notes) {
      // 読み直しの指摘を添えた訳し直しが通らなかった。いまの訳はそのまま残し、回数だけ数える
      count.failed += 1
      index[job.key] = { ...index[job.key], fixes: (index[job.key]?.fixes ?? 0) + 1 }
      saveIndex()
      console.log(`${job.key}: 訳し直せませんでした（${why}）。いまの訳を残します`)
    } else if (!requeued) {
      count.failed += 1
      failed[job.key] = why
      writeFileSync(failedFile, JSON.stringify(failed, null, 1), 'utf8')
      console.log(`${job.key}: 訳せませんでした（${why}）`)
    }
    if ((count.done + count.failed) % 50 === 0) {
      report('進行中')
      const usage = limiter.state()
      console.log(`${count.done + count.failed} / ${queue.length} 件（失敗 ${count.failed}、訳し直し ${count.retried}）、${Math.round((Date.now() - started) / 60000)} 分、5 時間 ${usage.five ?? '?'}・週 ${usage.week ?? '?'}`)
    }
    limiter.leave(token)
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
saveIndex(true)
writeFileSync(failedFile, JSON.stringify(failed, null, 1), 'utf8')
report('終わり')
for (const file of Object.values(systemFiles)) {
  try {
    unlinkSync(file)
  } catch {}
}
console.log(`終わり: 訳した ${count.done} 件、訳せなかった ${count.failed} 件、訳し直し ${count.retried} 件、${Math.round((Date.now() - started) / 60000)} 分、API 換算 ${count.cost.toFixed(2)} ドル`)
