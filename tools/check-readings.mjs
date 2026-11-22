// 注釈の「読み」（ふりがな・用語の読み）を、別のモデル（claude の sonnet）にまとめて点検させて、まちがいを直す。
//
//   node --no-warnings tools/check-readings.mjs [--model sonnet] [--batch 250] [--concurrency 6] [--limit 回数] [--no-apply]（点検だけ）
//        [--apply-only]（点検ずみの直しを、注釈に入れるだけ）
//
// - 注釈（<データ置き場>/annot/<保存名>.json）から「言葉と読み」の組を集め、同じ組は 1 回だけ点検する。
// - AI には、言葉と読みの組を 250 個ずつ渡し、「明らかにまちがっている読み」だけを、正しい読みといっしょに返させる
//   （文の中での読みがいくつかある言葉は、その読みがありうるなら、まちがいとしない）。
// - 点検の記録は <データ置き場>/annot/_readings.json（組 → 'ok' または 正しい読み）。点検ずみの組は、次からは聞かない。
// - 直しは、注釈のファイルに入れる（読みだけを置きかえる。授業の本文は変えない）。
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { askClaude, createLimiter } from './lib/claude.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const annotDir = join(dataDir, 'annot')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [workDir, tempDir]) mkdirSync(dir, { recursive: true })
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)
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
const HIRAGANA = /^[ぁ-ゖー・]+$/
const checkedFile = join(annotDir, '_readings.json')
const checked = readJson(checkedFile, {})
const pairKey = (word, reading) => `${word}\t${reading}`

// ───────── 組を集める ─────────

const files = readdirSync(annotDir).filter((name) => name.endsWith('.json') && !name.startsWith('_'))
const pairs = new Map()
for (const name of files) {
  const a = readJson(join(annotDir, name), null)
  if (!a) continue
  for (const [word, reading] of a.readings ?? []) pairs.set(pairKey(word, reading), [word, reading])
  for (const term of a.terms ?? []) if (/[㐀-鿿]/.test(term.term)) pairs.set(pairKey(term.term, term.reading), [term.term, term.reading])
}
const todo = [...pairs.values()].filter(([word, reading]) => !(pairKey(word, reading) in checked))
log(`注釈 ${files.length} 件から、言葉と読みの組 ${pairs.size} 個。まだ点検していないのは ${todo.length} 個`)

// ───────── 点検 ─────────

const SYSTEM = `あなたは、日本語の教材の校閲者です。学習アプリの教科書に付ける「ふりがな」を点検します。

渡されるのは、「言葉」と、その「読み」（ひらがな）の組の一覧です。それぞれの組について、読みが正しいかを確かめ、**明らかにまちがっている組だけ**を返します。

# 決まり
- 言葉は、小学校・中学校・高等学校の教科書（全教科）に出てくるものです。学校で教える読み方を基準にします。
- 文の中での読みが、いくつかありうる言葉（例:「一日」いちにち／ついたち、「上手」じょうず／うわて）は、渡された読みがそのうちの 1 つなら、正しいとします。
- 人名・地名・歴史の用語は、教科書でふつうに使われる読みを基準にします（例:「万里の長城」は「ばんりのちょうじょう」）。
- 送りがなや、言葉の中のひらがな・カタカナは、読みの中にもそのまま（カタカナは、ひらがなにして）入っているはずです。抜けや余分があれば、まちがいです。
- 連濁や促音（「三角形」さんかくけい／さんかっけい のような、どちらも使われる読み）は、まちがいとしません。
- 自信が無いものは、返しません。

# 返すもの
- wrong: まちがっている組の並び。n は一覧の番号、reading は正しい読み（ひらがなだけ）。
- まちがいが 1 つも無ければ、空の並びを返します。`
const SCHEMA = {
  type: 'object',
  properties: { wrong: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, reading: { type: 'string' } }, required: ['n', 'reading'] } } },
  required: ['wrong'],
}
const systemFile = join(tempDir, 'check-readings-system.md')
writeFileSync(systemFile, SYSTEM, 'utf8')

if (!has('apply-only') && todo.length) {
  const size = Number(opt('batch', 250))
  const batches = []
  for (let at = 0; at < todo.length; at += size) batches.push(todo.slice(at, at + size))
  const queue = opt('limit', '') ? batches.slice(0, Number(opt('limit'))) : batches
  const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log })
  let at = 0
  let done = 0
  let fixed = 0
  let cost = 0
  await Promise.all(
    Array.from({ length: Math.min(Number(opt('concurrency', 6)), queue.length) }, async () => {
      while (at < queue.length) {
        const batch = queue[at++]
        const userText = `次の ${batch.length} 個の組を点検してください。\n\n${batch.map(([word, reading], i) => `${i + 1}. ${word} → ${reading}`).join('\n')}\n`
        try {
          const token = await limiter.enter()
          let answer
          try {
            answer = await askClaude({ systemFile, userText, model: opt('model', 'sonnet'), effort: opt('effort', 'low'), schema: SCHEMA, cwd: workDir, limiter, timeoutMs: 8 * 60_000 })
          } finally {
            limiter.leave(token)
          }
          const out = answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
          const wrong = new Map((out.wrong ?? []).map((w) => [Number(w.n), String(w.reading ?? '').trim()]))
          batch.forEach(([word, reading], i) => {
            const correct = wrong.get(i + 1)
            const usable = correct && HIRAGANA.test(correct) && correct !== reading
            checked[pairKey(word, reading)] = usable ? correct : 'ok'
            if (usable) fixed += 1
          })
          cost += answer.cost
          done += 1
          writeJson(checkedFile, checked)
          if (done % 10 === 0) log(`${done} / ${queue.length} 回（直す読み ${fixed} 個・料金（API 換算）${cost.toFixed(2)} ドル）`)
        } catch (error) {
          limiter.fail(error?.message)
          log(`失敗: ${String(error?.message ?? error).slice(0, 160)}`)
        }
      }
    }),
  )
  log(`点検が終わりました。${done} 回・直す読み ${fixed} 個・料金（API 換算）${cost.toFixed(2)} ドル`)
}

// ───────── 直しを入れる ─────────

if (!has('no-apply')) {
  let changedFiles = 0
  let changed = 0
  for (const name of files) {
    const file = join(annotDir, name)
    const a = readJson(file, null)
    if (!a) continue
    let touched = false
    const fix = (word, reading) => {
      const correct = checked[pairKey(word, reading)]
      if (!correct || correct === 'ok') return reading
      touched = true
      changed += 1
      return correct
    }
    a.readings = (a.readings ?? []).map(([word, reading]) => [word, fix(word, reading)])
    for (const term of a.terms ?? []) term.reading = fix(term.term, term.reading)
    if (touched) {
      writeJson(file, a)
      changedFiles += 1
    }
  }
  log(`${changedFiles} 件の注釈で、読みを ${changed} か所直しました。用語集の索引は、tools/build-glossary.mjs で作り直してください。`)
  if (existsSync(checkedFile)) log(`点検の記録: ${checkedFile}`)
}
