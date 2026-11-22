// 授業ごとの「注釈」（用語集・ふりがな・前提と関連・年表のできごと）を、AI にまとめて作らせる。
//
//   node --no-warnings tools/annotate-lessons.mjs [--schools es,jhs,hs] [--courses 科目,…] [--only 保存名,…] [--limit 件数]
//        [--concurrency 10] [--model sonnet] [--effort low] [--redo]（作ってあるものも作り直す） [--count]（対象の数だけを出す）
//        [--five 0.85] [--week 0.98]（Claude の使用量がここまで来たら休む）
//
// - 1 つの授業につき、AI（claude）に 1 回たずねる。指示文・返事の形・確かめは、アプリと同じもの（src/shared/annotate.ts）を使う。
// - できたものは <データ置き場>/annot/<保存名>.json に置く（アプリは、教科書を開いたときにこれを読む）。
//   授業の本文は読むだけで、書きかえない（アプリを開いたままでも動かせる）。
// - 本文の目印（src）が同じものは、作り直さない。授業を書き直したあとにもう一度動かすと、変わった授業だけを作り直す。
// - 歴史の科目（中学 歴史、高校 歴史総合・日本史探究・世界史探究、小学 6 年 社会）では、年表のできごとも作る。
// - 進み具合は <データ置き場>/annot/_progress.json。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HISTORY_COURSES, annotationSchema, annotationSystemPrompt, annotationUserPrompt, cleanAnnotation, kanjiIn } from '../src/shared/annotate.ts'
import { askClaude, createLimiter } from './lib/claude.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const outDir = join(dataDir, 'annot')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [outDir, workDir, tempDir]) mkdirSync(dir, { recursive: true })
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8')
  renameSync(`${file}.tmp`, file)
}
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

// ───────── 科目・単元表・授業 ─────────

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const SCHOOL_SHORT = { es: '小学', jhs: '中学', hs: '高校', hsp: '高校（専門）', univ: '大学', grad: '大学院' }
function courseTitle(c) {
  if (/^\d(・\d)? 年$/.test(c.label)) return `${SCHOOL_SHORT[c.school]} ${c.label} ${c.subjectLabel}`
  if (c.school === 'hs') return `高校 ${c.label}`
  if (c.school === 'hsp') return `高校 ${c.subjectLabel}（${c.label}）`
  if (c.school === 'univ') return `大学 ${c.label}（${c.subjectLabel}）`
  if (c.school === 'grad') return `大学院 ${c.label}（${c.subjectLabel}）`
  return c.label === c.subjectLabel ? `${SCHOOL_SHORT[c.school]} ${c.label}` : `${SCHOOL_SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
}
const kanjiGrades = Object.fromEntries(Object.entries(JSON.parse(gunzipSync(readFileSync(join(root, 'resources', 'kanji', 'kanji.json.gz'))).toString('utf8')).kanji).map(([ch, raw]) => [ch, raw.g || 99]))
const gradeOfKanji = (ch) => kanjiGrades[ch] ?? 99

const schools = list('schools').length ? list('schools') : ['es', 'jhs', 'hs']
const onlyCourses = list('courses')
const onlyKeys = list('only')
const generated = new Set(readdirSync(lessonsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))

/** 対象の授業（歴史の科目を先に。年表を早く使えるようにするため） */
const targets = []
for (const c of catalog.courses) {
  if (onlyCourses.length ? !onlyCourses.includes(c.id) : !schools.includes(c.school)) continue
  const shipped = join(root, 'resources', 'content', c.id, 'curriculum.json')
  const curriculum = existsSync(shipped) ? readJson(shipped, null) : readJson(join(dataDir, 'curricula', `${c.id}.json`), null)
  if (!curriculum?.units?.length) continue
  const grade = c.school === 'es' ? Number(c.label.match(/(\d) 年$/)?.[1] ?? 6) : null
  curriculum.units.forEach((unit, u) =>
    unit.lessons.forEach((lesson, l) => {
      const id = `${c.id}-${u + 1}-${l + 1}`
      const authored = join(root, 'resources', 'content', c.id, `${id}.md`)
      const variants = [
        [id, existsSync(authored) ? authored : generated.has(id) ? join(lessonsDir, `${id}.md`) : null, false],
        [`${id}.deep`, generated.has(`${id}.deep`) ? join(lessonsDir, `${id}.deep.md`) : null, true],
      ]
      for (const [key, file, deep] of variants) {
        if (!file || (onlyKeys.length && !onlyKeys.includes(key))) continue
        targets.push({ key, file, deep, course: c, grade, unitTitle: unit.title, number: `${u + 1}-${l + 1}`, title: lesson.title })
      }
    }),
  )
}
const SCHOOL_ORDER = ['jhs', 'hs', 'es', 'hsp', 'univ', 'grad']
targets.sort((a, b) => Number(HISTORY_COURSES.includes(b.course.id)) - Number(HISTORY_COURSES.includes(a.course.id)) || SCHOOL_ORDER.indexOf(a.course.school) - SCHOOL_ORDER.indexOf(b.course.school))

const recordFile = (key) => join(outDir, `${key}.json`)
const todo = targets.filter((t) => has('redo') || readJson(recordFile(t.key), null)?.src !== hash(read(t.file)))
const queue = opt('limit', '') ? todo.slice(0, Number(opt('limit'))) : todo
const bySchool = {}
for (const t of queue) bySchool[t.course.school] = (bySchool[t.course.school] ?? 0) + 1
if (has('count')) {
  console.log(`授業 ${targets.length} 件のうち、作るのは ${queue.length} 件 ${JSON.stringify(bySchool)}`)
  process.exit(0)
}

// ───────── AI にたずねる ─────────

const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log })
const model = opt('model', 'sonnet')
const effort = opt('effort', 'low')

async function annotate(t) {
  const body = read(t.file)
  const history = HISTORY_COURSES.includes(t.course.id)
  // 読者の学年より上で習う漢字（小学校）。中学校より上と、学び直し向けの本文では、常用漢字でないもの
  const limit = t.course.school === 'es' && !t.deep ? t.grade : 8
  const hardKanji = kanjiIn(body).filter((ch) => gradeOfKanji(ch) > limit)
  const target = { school: t.course.school, courseTitle: courseTitle(t.course), grade: t.grade, deep: t.deep, unitTitle: t.unitTitle, number: t.number, title: t.title, history, body, hardKanji }
  const systemFile = join(tempDir, `annot-system-${t.key}.md`)
  writeFileSync(systemFile, annotationSystemPrompt(target), 'utf8')
  try {
    const token = await limiter.enter()
    let answer
    try {
      answer = await askClaude({ systemFile, userText: annotationUserPrompt(target), model, effort, schema: annotationSchema(history), cwd: workDir, limiter, timeoutMs: 8 * 60_000 })
    } catch (error) {
      limiter.fail(error?.message)
      throw error
    } finally {
      limiter.leave(token)
    }
    const raw = answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
    const { annotation, dropped } = cleanAnnotation(raw, body, history)
    writeJson(recordFile(t.key), { src: hash(body), at: Date.now(), ...annotation })
    return { cost: answer.cost, terms: annotation.terms.length, readings: annotation.readings.length, events: annotation.events?.length ?? 0, dropped }
  } finally {
    rmSync(systemFile, { force: true })
  }
}

log(`授業 ${targets.length} 件のうち、${queue.length} 件の注釈を作ります（${JSON.stringify(bySchool)}。${model}・${effort}・同時に ${opt('concurrency', 10)} 件）`)
const progressFile = join(outDir, '_progress.json')
const started = Date.now()
let at = 0
const sum = { done: 0, failed: 0, cost: 0, terms: 0, readings: 0, events: 0, dropped: 0 }
const report = (finished = false) => writeJson(progressFile, { ...sum, total: queue.length, startedAt: started, at: Date.now(), finished, limiter: limiter.state() })
await Promise.all(
  Array.from({ length: Math.min(Number(opt('concurrency', 10)), queue.length) }, async () => {
    while (at < queue.length) {
      const t = queue[at++]
      let ok = false
      // 1 回だけ、やり直す（返事の形がくずれた、通信が切れた、など）
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          const result = await annotate(t)
          sum.done += 1
          for (const name of ['cost', 'terms', 'readings', 'events', 'dropped']) sum[name] += result[name]
          ok = true
        } catch (error) {
          if (attempt === 1) {
            sum.failed += 1
            log(`失敗: ${t.key} ${String(error?.message ?? error).slice(0, 160)}`)
          }
        }
      }
      if ((sum.done + sum.failed) % 25 === 0) {
        log(`${sum.done} / ${queue.length} 件（失敗 ${sum.failed}）用語 ${sum.terms}・読み ${sum.readings}・できごと ${sum.events}・料金（API 換算）${sum.cost.toFixed(2)} ドル`)
        report()
      }
    }
  }),
)
report(true)
log(`終わりました。${sum.done} 件（失敗 ${sum.failed}）。用語 ${sum.terms}・読み ${sum.readings}・できごと ${sum.events}（確かめで外したもの ${sum.dropped}）。料金（API 換算）${sum.cost.toFixed(2)} ドル`)
