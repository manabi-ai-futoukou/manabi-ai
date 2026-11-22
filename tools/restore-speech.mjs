// 掘り下げで、お話や例文の中のせりふが「です・ます」に書きかえられた授業を、元の言い方に戻す。
//
//   node --no-warnings tools/restore-speech.mjs [--schools es,jhs,hs] [--only 保存名,…] [--limit 件数] [--concurrency 12]
//        [--count]（対象の数だけを出す） [--no-apply]（置きかえの案だけを作る） [--apply-only]（作ってある案を入れるだけ）
//
// - わけ: 掘り下げの指示に「全文を敬語で書く」とあったため、説明の文だけでなく、かぎかっこの中のせりふや例文まで
//   です・ます調になった授業がある（2026-11-20 に気づいた）。
// - 対象: 掘り下げで置きかえた授業のうち、元の授業（アプリの外の「保管/掘り下げ前の授業」）にあったくだけたせりふが消えて、
//   ていねいなせりふが増えているもの（機械で選ぶ）。
// - 戻し方: 別の AI（claude の sonnet）に、元の授業といまの授業を見くらべさせ、「いまの授業のこの文字列を、こう置きかえる」という
//   案を返させる。案は機械で確かめる（いまの授業にその文字列があるか、コードブロックの中でないか、長すぎないか、戻した文が
//   です・ます調のままでないか）。通ったものだけを入れ、入れたあとの本文を授業の検査（scripts/lib/check-lesson.mjs）にかける。
// - アプリが開いているあいだは、授業のファイルを書かない。直す前の授業は <データ置き場>/deepen/raw/speech-before/ に写す。
// - 記録は <データ置き場>/deepen/speech/（保存名.json: 案と、入れた結果）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkLesson } from '../scripts/lib/check-lesson.mjs'
import { askClaude, createLimiter } from './lib/claude.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const deepenDir = join(dataDir, 'deepen')
const outDir = join(deepenDir, 'speech')
const keepDir = join(deepenDir, 'raw', 'speech-before')
const backupDir = resolve(opt('backup', join(root, '..', '保管', '掘り下げ前の授業')), 'lessons')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [outDir, keepDir, workDir, tempDir]) mkdirSync(dir, { recursive: true })
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value, pretty = true) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, pretty ? 1 : 0), 'utf8')
  renameSync(`${file}.tmp`, file)
}
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

// ───────── 対象を選ぶ ─────────

const stateFile = join(deepenDir, 'state.json')
const state = readJson(stateFile, {})
const schools = list('schools').length ? list('schools') : ['es', 'jhs', 'hs']
const schoolOf = (key) => (key.startsWith('es') ? 'es' : key.startsWith('jhs') ? 'jhs' : key.startsWith('hsp') ? 'hsp' : key.startsWith('hs') ? 'hs' : '')
const squeeze = (text) => text.replace(/\s+/g, '')
const prose = (text) => text.replace(/```[\s\S]*?```/g, '')
/** かぎかっこの中身（4〜80 字。コードブロックの中は見ない） */
const quotes = (text) => [...prose(text).matchAll(/[「『]([^「」『』\n]{4,80})[」』]/g)].map((m) => squeeze(m[1]))
const POLITE = /(です|ます|でした|ました|ません|ください|でしょう|ましょう|ですか|ますか|ですね|ますね|ですよ|ますよ)[。！？!?…]*$/
const polite = (q) => POLITE.test(q)
/** 元の授業のくだけたせりふ・例文が消えて、ていねいなものが増えているか */
function looksChanged(original, current) {
  const before = quotes(original)
  const after = quotes(current)
  const afterSet = new Set(after)
  const beforeSet = new Set(before)
  const lost = before.filter((q) => !polite(q) && !afterSet.has(q))
  const gained = after.filter((q) => polite(q) && !beforeSet.has(q))
  if (has('loose')) return lost.length >= 1 && gained.length >= 1
  // ふつうは、書き出しが同じで、言い方だけが変わったと見られる組が 1 つ以上あるものにしぼる
  return lost.some((q) => gained.some((a) => a.slice(0, 3) === q.slice(0, 3)))
}
let keys = Object.keys(state)
  .filter((key) => state[key].stage === 'applied' && schools.includes(schoolOf(key)))
  .filter((key) => existsSync(join(backupDir, `${key}.md`)) && existsSync(join(lessonsDir, `${key}.md`)))
if (list('only').length) keys = keys.filter((key) => list('only').includes(key))
else if (!has('all')) keys = keys.filter((key) => looksChanged(read(join(backupDir, `${key}.md`)), read(join(lessonsDir, `${key}.md`))))
if (opt('limit', '')) keys = keys.slice(0, Number(opt('limit')))
const bySchool = {}
for (const key of keys) bySchool[schoolOf(key)] = (bySchool[schoolOf(key)] ?? 0) + 1
if (has('count')) {
  console.log(`対象: ${keys.length} 件 ${JSON.stringify(bySchool)}`)
  process.exit(0)
}

// ───────── 案を作らせる ─────────

const SYSTEM = `あなたは、日本の小学校・中学校・高等学校の教材の校閲者です。学習アプリの授業の本文を、別の AI が掘り下げて書き直しました。そのとき、「全文を敬語で書く」という指示のために、説明の文だけでなく、かぎかっこの中のせりふや、例として示した文まで、です・ます調に書きかえてしまった箇所があります。元の授業と見くらべて、そういう箇所だけを元の言い方に戻すための、置きかえの案を作ります。

# 戻すもの
- お話や場面の中の、登場人物のせりふ・心の中の言葉（「 」『 』の中）。元の授業では、子ども・友だち・家族がくだけた言い方（〜だよ、〜かな、〜しよう、〜なの？ など）で話していたのに、書き直した版で、です・ます調（〜です、〜ます、〜ですか、〜しましょう）になっているもの。
- 例として示した文・意見・主張・要約・きまり（「 」『 』の中や、引用の行）。元の授業では「〜だ」「〜である」「〜べきだ」などの形だったのに、書き直した版で、です・ます調になっているもの。

# 戻さないもの
- 説明の文（地の文）、問題文、答えの解説。これらは、です・ます調のままにします。
- 元の授業でも、です・ます調だったせりふ・例文（先生や大人に話すせりふ、ていねいな言い方を教える例文など）。
- 書き直した版で新しく足されたせりふ・例文のうち、元の授業に対応するものが無く、です・ます調でも不自然でないもの。ただし、同じ人物が同じ場面で話すせりふで、ほかのせりふを戻すのに合わせないと調子がそろわないものは、同じ調子にそろえます。
- 用語や言葉をかぎかっこで囲んだだけのもの。
- コードブロック（\`\`\` で囲まれた部分。掛け合い・図・挿絵・動く図解）の中。

# 戻し方
- 言い方（文末や、話し言葉の調子）だけを戻します。書き直した版が内容を直している場合（事実・数・言葉の誤りを直した、言葉を足した、など）は、その内容を保ったまま、言い方だけを元の調子にします。元の授業のせりふと内容が同じなら、元の授業のせりふを使います。
- 漢字とひらがなの使い分けと、分かち書き（言葉の間の空白）は、書き直した版の書き方に合わせます（書き直した版が分かち書きなら、戻したせりふも分かち書きにします）。
- かぎかっこの外の地の文（「と言いました」など）は、変えません。

# 返すもの
- replacements: 置きかえの並び。from は、書き直した版の中の文字列を、1 文字もちがえずに写したもの（かぎかっこをふくめ、その箇所が 1 つに決まる長さにします。長くても 200 字まで）。to は、置きかえたあとの文字列。
- 戻す箇所が無ければ、空の配列を返します。`
const SCHEMA = {
  type: 'object',
  properties: { replacements: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  required: ['replacements'],
}
const systemFile = join(tempDir, 'restore-speech-system.md')
writeFileSync(systemFile, SYSTEM, 'utf8')
const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log })

/** その文字列がある行の、行の初めからその文字列の終わりまで（引用・表・選択肢の行かを見るため） */
function lineOf(text, from) {
  const at = text.indexOf(from)
  return at < 0 ? '' : text.slice(text.lastIndexOf('\n', at) + 1, at + from.length)
}
/** 案を確かめて、入れられるものだけを入れた本文を返す */
function applyTo(current, replacements) {
  // コードブロックの範囲（この中は、変えない）
  const blocks = [...current.matchAll(/```[\s\S]*?```/g)].map((m) => [m.index, m.index + m[0].length])
  const inBlock = (at) => blocks.some(([a, b]) => at >= a && at < b)
  let text = current
  const done = []
  const skipped = []
  for (const { from, to } of replacements) {
    const why =
      typeof from !== 'string' || typeof to !== 'string' || !from || from === to
        ? '形がおかしい'
        : from.length > 240 || to.length > from.length * 1.6 + 20 || to.length < from.length * 0.4
          ? '長さがおかしい'
          : !/[「『]/.test(from) && !/^\s*(>|\||[①-⑳]|[ア-コ][ 　.．)）]|（[ア-コ]）|\([ア-コ]\))/.test(lineOf(text, from))
            ? 'かぎかっこ・引用・表・選択肢の例文のどれでもない'
            : !text.includes(from)
              ? 'いまの授業に無い'
              : inBlock(current.indexOf(from)) && current.includes(from)
                ? 'コードブロックの中'
                : // 戻したあとのかぎかっこの中が、まだ全部です・ます調なら、戻したことにならない
                  quotes(to).length && quotes(to).every(polite) && quotes(from).every(polite) && squeeze(to).length >= squeeze(from).length
                  ? '戻っていない'
                  : ''
    if (why) {
      skipped.push({ from, to, why })
      continue
    }
    text = text.replaceAll(from, () => to)
    done.push({ from, to })
  }
  return { text, done, skipped }
}

function appOpen() {
  const script = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq '学びアイ.exe') -and ($_.ExecutablePath -like '*学びアイ*' -or $_.CommandLine -like '*学びアイ*') } | Measure-Object).Count"
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return !(result.status === 0 && Number(String(result.stdout ?? '').trim()) === 0)
}

const recordFile = (key) => join(outDir, `${key}.json`)
async function propose(key) {
  const current = read(join(lessonsDir, `${key}.md`))
  const saved = readJson(recordFile(key), null)
  if (saved && saved.src === hash(current)) return saved
  if (saved?.applied && saved.to === hash(current)) return saved
  const original = read(join(backupDir, `${key}.md`))
  const answer = await askClaude({ systemFile, userText: `次の授業について、置きかえの案を作ってください。\n\n# 元の授業\n\n${original}\n\n────────\n\n# 書き直した版\n\n${current}\n`, model: opt('model', 'sonnet'), effort: opt('effort', 'medium'), schema: SCHEMA, cwd: workDir, limiter, timeoutMs: 10 * 60_000 })
  const out = answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
  const record = { key, at: new Date().toISOString(), src: hash(current), cost: answer.cost, replacements: Array.isArray(out.replacements) ? out.replacements : [] }
  writeJson(recordFile(key), record)
  return record
}

/** 案を入れる（アプリが閉じているときだけ） */
function applyAll(targets) {
  if (has('no-apply')) return { applied: 0, lessons: 0 }
  if (appOpen()) {
    log('アプリが開いているので、授業は書きかえません。アプリを閉じてから、--apply-only を付けて実行してください。')
    return { applied: 0, lessons: 0 }
  }
  const deepenedFile = join(dataDir, 'deepened.json')
  const deepened = readJson(deepenedFile, {})
  let lessons = 0
  let applied = 0
  for (const key of targets) {
    const record = readJson(recordFile(key), null)
    if (!record || record.applied || !record.replacements.length) continue
    const file = join(lessonsDir, `${key}.md`)
    const current = read(file)
    if (hash(current) !== record.src) continue // 案を作ったあとに、授業が変わった
    const { text, done, skipped } = applyTo(current, record.replacements)
    if (!done.length) {
      writeJson(recordFile(key), { ...record, applied: false, done, skipped })
      continue
    }
    const errors = checkLesson(text).filter((x) => x.level === 'error')
    if (errors.length) {
      writeJson(recordFile(key), { ...record, applied: false, done: [], skipped, error: errors.map((x) => x.message).join(' ／ ') })
      log(`${key}: 入れたあとの本文が検査を通らないので、入れません（${errors[0].message}）`)
      continue
    }
    if (!existsSync(join(keepDir, `${key}.md`))) copyFileSync(file, join(keepDir, `${key}.md`))
    writeFileSync(`${file}.tmp`, text, 'utf8')
    renameSync(`${file}.tmp`, file)
    const to = hash(text)
    writeJson(recordFile(key), { ...record, applied: true, to, done, skipped })
    if (state[key]?.stage === 'applied') state[key] = { ...state[key], to, speech: done.length, at: Date.now() }
    if (deepened[key]) deepened[key] = { ...deepened[key], to }
    lessons += 1
    applied += done.length
  }
  if (lessons) {
    writeJson(stateFile, state, false)
    writeJson(deepenedFile, deepened, false)
  }
  return { applied, lessons }
}

if (has('apply-only')) {
  const result = applyAll(keys)
  log(`${result.lessons} 件の授業で、${result.applied} か所を戻しました。`)
  process.exit(0)
}

log(`対象は ${keys.length} 件（${JSON.stringify(bySchool)}）。案を作らせます（${opt('model', 'sonnet')}）`)
const size = Number(opt('concurrency', 12))
let at = 0
let proposed = 0
let failed = 0
let cost = 0
await Promise.all(
  Array.from({ length: Math.min(size, keys.length) }, async () => {
    while (at < keys.length) {
      const key = keys[at++]
      try {
        const record = await propose(key)
        proposed += 1
        cost += record.cost ?? 0
        if (proposed % 25 === 0) log(`案 ${proposed} / ${keys.length} 件（失敗 ${failed}）`)
      } catch (error) {
        failed += 1
        log(`失敗: ${key} ${String(error?.message ?? error).slice(0, 160)}`)
      }
    }
  }),
)
const result = applyAll(keys)
const records = keys.map((key) => readJson(recordFile(key), null)).filter(Boolean)
const total = records.reduce((a, r) => a + r.replacements.length, 0)
const skipped = records.reduce((a, r) => a + (r.skipped?.length ?? 0), 0)
log(`終わりました。案を作った授業 ${proposed} 件（失敗 ${failed}）、案 ${total} か所。${result.lessons} 件の授業で ${result.applied} か所を戻しました（確かめで外した案 ${skipped} か所）。Claude の料金（API 換算）${cost.toFixed(2)} ドル`)
