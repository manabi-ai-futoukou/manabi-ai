// 授業の本文に残っている誤りを、「文の差しかえ」で直す（用語集・記述論述の直し tools/fix-extras.mjs のつづき）。
//
//   node --no-warnings tools/fix-bodies.mjs --count                         # 対象の数だけ見る
//   node --no-warnings tools/fix-bodies.mjs --sample 60 [--concurrency 10]   # 決まった 60 授業だけ、差しかえの案を作る（試し）
//   node --no-warnings tools/fix-bodies.mjs [--concurrency 10]               # 全部の授業の、差しかえの案を作る
//   node --no-warnings tools/fix-bodies.mjs --verify [--sample 60]           # 差しかえを、codex に 1 件ずつ確かめさせる
//   node --no-warnings tools/fix-bodies.mjs --revise [--sample 60]           # codex が通さなかった差しかえを、理由を添えて直し直す（1 回だけ。あとで、もう一度 --verify）
//   node --no-warnings tools/fix-bodies.mjs --page [--all] [--page-file …]   # 見くらべのページ（既定は試しの授業だけ）
//        [--only 保存名,…] [--limit 件数] [--model sonnet] [--effort medium] [--five 0.85] [--week 0.98] [--codex-week 96] [--redo]
//
// - 対象は、用語集・記述論述の直し（fix-extras）で「授業の本文にも同じ誤りがある」と印が付いた指摘のある授業。
// - 直す役（claude）が、指摘ごとに「本文にその誤りの文があるか」を判定する（誤りがある／直さない／本文には無い）。
//   誤りがあるときだけ、「本文のそのままの文（old）」と「直した文（new）」の組を返す。全文は書き直させない。
// - 機械の確かめ: old が本文にちょうど 1 か所ある／1 行の中／題・見出し・図のブロックの中でない／掛け合いの話者の印をふくまない／
//   長さが元に近い／太字や数式の印がくずれていない／小学校は学年の漢字と分かち書き。通らなければ 1 回やり直させ、それでも通らないものは「保留」。
// - 通った差しかえは、検査役（codex）が 1 件ずつ確かめる（--verify）。「正しい」と出たものだけが、教材に入れる候補になる。
// - 案は <データ置き場>/fix-body/lessons/<保存名>.json に置く。この道具は、まだ教材を書きかえない（入れる手順は、試しのあとで足す）。
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { askClaude, createLimiter } from './lib/claude.mjs'
import { codexExec, codexPrice, codexWeek, parseJson } from './lib/codex.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const fixDir = join(dataDir, 'fix', 'lessons')
const outDir = join(dataDir, 'fix-body')
const recordDir = join(outDir, 'lessons')
const workDir = join(dataDir, 'ai-workdir')
for (const dir of [recordDir, workDir]) mkdirSync(dir, { recursive: true })
const model = opt('model', 'sonnet')
const effort = opt('effort', 'medium')
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value, pretty = false) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, pretty ? 1 : 0), 'utf8')
  renameSync(`${file}.tmp`, file)
}
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
const quiet = has('page') || has('count')
const log = (text) => {
  const line = `${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`
  console.log(line)
  if (!quiet) appendFileSync(join(outDir, 'run.log'), `${line}\n`, 'utf8')
}
const flat = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
const cut = (text, max) => ([...String(text)].length > max ? `${[...String(text)].slice(0, max).join('')}…` : String(text))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const recordFile = (key) => join(recordDir, `${key}.json`)

const kanjiGrades = Object.fromEntries(Object.entries(JSON.parse(gunzipSync(readFileSync(join(root, 'resources', 'kanji', 'kanji.json.gz'))).toString('utf8')).kanji).map(([ch, raw]) => [ch, raw.g || 99]))
const isKanji = (ch) => /[㐀-鿿]/.test(ch)
/** 学年より上の漢字のうち、すぐあとに（よみ）が付いていないもの（tools/fix-extras.mjs と同じ見方） */
function bareHardKanji(source, limit) {
  const chars = [...String(source ?? '')]
  const out = new Set()
  for (let i = 0; i < chars.length; i += 1) {
    if (!isKanji(chars[i]) || (kanjiGrades[chars[i]] ?? 99) <= limit) continue
    let end = i + 1
    while (end < chars.length && isKanji(chars[end])) end += 1
    let kana = end
    while (kana < chars.length && kana - end < 4 && /[ぁ-ゖ]/.test(chars[kana])) kana += 1
    if ('（('.includes(chars[end] ?? '-') || '（('.includes(chars[kana] ?? '-')) continue
    out.add(chars[i])
  }
  return [...out]
}

// ───────── 対象: 「本文にも同じ誤りがある」と印の付いた指摘 ─────────

const onlyKeys = list('only')
// --schools hsp のように、学校をえらべる（えらばなければ、印の付いた授業ぜんぶ）
const schools = list('schools')
/** 高校（専門）の授業に足す決まり（授業を書いたとき・掘り下げたときと同じ考え方） */
const HSP_RULE = '専門教科の決まり: けがや事故、健康の被害につながる作業（機械、電気、薬品、農薬、火、刃物、重機、船、介助、医療的ケア、与薬、食品の衛生に関わる加工など）の手順・分量・濃度・設定値は、書き足しません。誤っている数値や法令・制度・規格・基準の内容は、確かなものにだけ直します。確かめられないときは、数値をけずるか、「決められた基準に従う」「指導者のもとで確かめる」のように書きます。「これだけで仕事ができる・資格がとれる」と読める書き方にしません。'
const GROUPS = ['deep', 'es', 'jhs', 'hs', 'hsp']
const groupOf = (meta) => (meta.school === 'es' && meta.deep ? 'deep' : meta.school)

function readerOf(meta) {
  if (meta.school === 'es' && meta.deep) return '小学校の内容を学び直す、中学生以上の学習者（この授業は「学び直し版」です）。中学生が読める言葉で、です・ます調で書きます。'
  if (meta.school === 'es') {
    const g = meta.grade ?? 6
    return `小学 ${g} 年生本人が、ひとりで読みます。${g} 年生が知っている言葉で、短い文で書きます。使う漢字は ${g} 年生までに習う漢字だけにし、それより上の漢字の言葉は、ひらがなで書くか「用語（よみ）」のように（ ）で読みを添えます。${g <= 2 ? '言葉のまとまりごとに 1 字あけて書きます（分かち書き）。' : ''}`
  }
  if (meta.school === 'jhs') return '中学生（学校に通いにくかった時期のある人をふくみます）。中学生が読める言葉で、ていねいに書きます。'
  if (meta.school === 'hsp') return '高校の専門学科の内容を学ぶ高校生や、その分野の仕事に関心のある人。専門用語は意味が分かるように、正確に書きます。'
  return '高校生（学び直しの人をふくみます）。高校生が読める言葉で、正確に書きます。'
}

const PART_FIELDS = { 問い: ['question'], 解答例: ['answer', 'intro', 'body', 'conclusion'], 要点: ['points'] }
const show = (value) => (Array.isArray(value) ? value.map(flat).join(' ／ ') : flat(value))

/** 用語集・問題を直した記録から、本文も見るべき指摘を取り出す */
function flaggedOf(record) {
  const out = []
  for (const f of record.findings) {
    const v = record.verdicts[f.id]
    if (!v?.bodyAlso || v.verdict === '不採用') continue
    const change = record.changes.find((c) => c.target === f.target && (c.kind === 'term') === (f.kind === 'term'))
    const fields = f.kind === 'term' ? ['short', 'detail'] : (PART_FIELDS[f.part] ?? ['question', 'answer', 'intro', 'body', 'conclusion', 'points'])
    const pick = (shape) => (shape ? fields.filter((k) => shape[k] !== undefined && show(shape[k])).map((k) => show(shape[k])).join(' ／ ') : '')
    out.push({ id: out.length + 1, kind: f.kind, target: f.target, part: f.part, what: flat(f.what), fix: flat(f.fix), sure: f.sure !== false, verdict: v.verdict, reason: flat(v.reason), before: pick(change?.before), after: change?.status === 'ok' ? pick(change?.after) : '' })
  }
  return out
}

/** 図・動く図解・プログラムなどのブロックの中か（掛け合いの talk は、せりふを直せるので別あつかい） */
function fencesOf(body) {
  const lines = body.split('\n')
  const kinds = []
  let inside = null
  for (const line of lines) {
    const mark = line.match(/^```(\S*)/)
    if (mark && inside === null) {
      inside = mark[1] || 'code'
      kinds.push('fence')
    } else if (mark) {
      inside = null
      kinds.push('fence')
    } else kinds.push(inside)
  }
  return { lines, kinds }
}

const works = []
for (const name of existsSync(fixDir) ? readdirSync(fixDir) : []) {
  if (!name.endsWith('.json')) continue
  const record = readJson(join(fixDir, name), null)
  if (!record || (onlyKeys.length && !onlyKeys.includes(record.key)) || (schools.length && !schools.includes(record.meta?.school))) continue
  const findings = flaggedOf(record)
  const file = join(lessonsDir, `${record.key}.md`)
  if (!findings.length || !existsSync(file)) continue
  const body = read(file)
  const meta = record.meta
  const out = ['# 授業', `- 科目: ${meta.course}／${meta.lesson}${meta.deep ? '（学び直し版）' : ''}`, `- 読者: ${readerOf(meta)}`, ...(meta.school === 'hsp' ? [`- ${HSP_RULE}`] : []), '', '# 用語集・問題の検査で見つかった誤り（本文にも同じ誤りがあるかを確かめます）']
  for (const f of findings) {
    out.push('', `## [${f.id}] ${f.kind === 'term' ? `用語「${f.target}」` : f.target}・${f.part}`, `- 検査役の指摘${f.sure ? '' : '（検査役は「自信なし」）'}: ${f.what}`, `- 検査役の直し方の案: ${f.fix}`, `- 用語集・問題を直した役の判定（${f.verdict}）: ${f.reason}`)
    if (f.before) out.push(`- 用語集・問題の文（直す前）: ${f.before}`)
    if (f.after) out.push(`- 用語集・問題の文（直した後）: ${f.after}`)
  }
  out.push('', '# 授業の本文（ここから下が、そのままの本文です）', '', body, '')
  const prompt = out.join('\n')
  works.push({ key: record.key, meta, body, findings, prompt })
}
works.sort((a, b) => a.key.localeCompare(b.key, 'ja', { numeric: true }))

const SYSTEM = `あなたは、日本の小学校・中学校・高等学校の教材の編集者です。学習アプリの授業の本文に残っている誤りを、文の差しかえで直します。

この授業の「用語集」や「記述・論述の問題」は、検査役（別の AI）の指摘を受けて、すでに直してあります。そのとき「授業の本文にも、同じ誤りがありそうだ」という印が付きました。けれども、この印は当てにならないことがあります。あなたの仕事は、指摘の 1 件ずつについて、本文を実際に読んで確かめ、**本文に誤りの文が本当にあるときだけ**、その文を直すことです。

## 判定（指摘ごとに、どれか 1 つ）
- 「誤りがある」: 本文（掛け合い・確かめ問題・答えをふくむ）に、その指摘と同じ誤りを述べた文が実際にある。事実・年代・人名・数値・式・定義の取りちがえ・因果関係・読み・文法の誤りで、生徒がまちがって覚えてしまうもの。
- 「直さない」: 本文に似た文はあるが、直す必要がない。たとえば、その学年でふつうに教える簡略化である／その節・その実験・その例の中に限った言い方で、文脈の中では正しい（用語集は一般的な定義なので直したが、本文ではそのままでよい）／指摘のほうが細かすぎる・まちがっている。
- 「本文には無い」: 本文には、その誤りを述べた文が無い（用語集・問題だけの話だった）。

本文は教材の中心です。**迷ったら「直さない」にします。** はっきりした誤りだけを直します。

## 差しかえ（edits）の作り方
- 「誤りがある」とした指摘ごとに、本文の誤りの文を差しかえます。同じ誤りが本文の何か所かにあるときは、それぞれ別の差しかえにします（説明の文、掛け合いのせりふ、確かめ問題、答え、まとめ など）。
- old: 本文にある文字を、**一字一句そのまま**写します（空白・記号・太字の ** ・数式の $ も、そのまま）。1 つの行の中の、ひと続きの文字にします（改行をまたがない）。ふつうは 1 文、長くても 2〜3 文です。本文にちょうど 1 か所だけ現れるように、短すぎるときは文をまるごと入れます。
- new: old を直した文です。**誤りのところだけを、最小限に直します。** 長さは old と同じくらいにします。文体（です・ます調、掛け合いの話し言葉）、その学年の言葉づかい、ふりがなの書き方（「用語（よみ）」）、太字（**）や数式（$）は、old にそろえます。
- 用語集・問題を直した文と、同じ向きで直します（本文と用語集が食いちがわないように）。
- 新しい事実を足しすぎません。確かでないことは書きません。確かめられないときは、誤りの部分をけずるか、言い切りをやわらげます。
- 掛け合い（\`\`\`talk のブロックの「名前(表情): せりふ」の行）は、せりふの部分だけを old にします（「名前(表情):」は入れない）。話している人の口調は変えません。
- 表（| で区切った行）は、直すマスの中の文字だけを old にします（| は入れない）。

## 直してはいけないところ
- 題（1 行目）と、見出し（# で始まる行）。
- \`\`\`figure・\`\`\`picture・\`\`\`plot・\`\`\`sim・\`\`\`numberline などの、図・挿絵・動く図解のブロックの中と、プログラムのブロックの中。ここに誤りがあるときは、差しかえを作らず、blocks に「どのブロックの、何が誤りか」を書きます。
- 指摘と関係のない文。言い回しの好みで直すことはしません。

## 返事の形（JSON）
- verdicts: 指摘ごとに { id, verdict（「誤りがある」「直さない」「本文には無い」）, reason（1〜2 文。本文のどの文を見て判断したか） }。すべての指摘に付けます。
- edits: 差しかえごとに { ids（その差しかえが直す指摘の番号。ふつうは 1 つ）, old, new, note（何を直したか。1 文） }。「誤りがある」が 1 つも無ければ、空の配列にします。
- blocks: 図などのブロックの中の誤りごとに { id, note }。無ければ空の配列にします。
`

const text = { type: 'string' }
const SCHEMA = {
  type: 'object',
  properties: {
    verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, verdict: { type: 'string', enum: ['誤りがある', '直さない', '本文には無い'] }, reason: text }, required: ['id', 'verdict', 'reason'], additionalProperties: false } },
    edits: { type: 'array', items: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, old: text, new: text, note: text }, required: ['ids', 'old', 'new', 'note'], additionalProperties: false } },
    blocks: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, note: text }, required: ['id', 'note'], additionalProperties: false } },
  },
  required: ['verdicts', 'edits', 'blocks'],
  additionalProperties: false,
}
for (const work of works) work.src = hash(`${model}\n${effort}\n${SYSTEM}\n${work.prompt}`)

// ───────── 返事の確かめ ─────────

const countOf = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0)
const marks = (source, mark) => countOf(source, mark)

/** 返事を確かめて、差しかえごとに「通った（ok）・保留（held）」を付ける */
function settle(work, raw) {
  const { body, meta, findings } = work
  const { lines, kinds } = fencesOf(body)
  const starts = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const verdicts = {}
  for (const v of Array.isArray(raw?.verdicts) ? raw.verdicts : []) {
    if (findings.some((f) => f.id === v?.id) && ['誤りがある', '直さない', '本文には無い'].includes(v?.verdict)) verdicts[v.id] = { verdict: v.verdict, reason: flat(v.reason).slice(0, 400) }
  }
  const missing = findings.filter((f) => !verdicts[f.id]).map((f) => f.id)
  const young = meta.school === 'es' && !meta.deep
  const spaced = young && (meta.grade ?? 6) <= 2
  const edits = []
  for (const item of Array.isArray(raw?.edits) ? raw.edits : []) {
    const old = String(item?.old ?? '')
    const next = String(item?.new ?? '')
    const ids = (Array.isArray(item?.ids) ? item.ids : []).filter((id) => findings.some((f) => f.id === id))
    const edit = { ids, old, new: next, note: flat(item?.note).slice(0, 300), line: 0, context: '', problems: [], cautions: [] }
    edits.push(edit)
    if (!ids.some((id) => verdicts[id]?.verdict === '誤りがある')) edit.problems.push('「誤りがある」とした指摘に結びついていません')
    if (!old.trim()) {
      edit.problems.push('old が空です')
      continue
    }
    if (old.includes('\n') || next.includes('\n')) edit.problems.push('改行をまたいでいます（1 つの行の中の文字にします）')
    const found = countOf(body, old)
    if (found !== 1) {
      edit.problems.push(found ? `old が本文に ${found} か所あります（1 か所だけになるように、文をまるごと入れます）` : 'old が本文に見つかりません（本文の文字を、一字一句そのまま写します）')
      continue
    }
    const at = body.indexOf(old)
    const lineNo = starts.findLastIndex((s) => s <= at)
    const line = lines[lineNo]
    const column = at - starts[lineNo]
    edit.line = lineNo + 1
    edit.at = at
    edit.kind = kinds[lineNo] === 'talk' ? '掛け合い' : /^\s*\|/.test(line) ? '表' : '本文'
    edit.context = line
    if (lineNo === 0 || /^#{1,6}\s/.test(line)) edit.problems.push('題・見出しは直しません')
    if (kinds[lineNo] === 'fence' || (kinds[lineNo] && kinds[lineNo] !== 'talk')) edit.problems.push(`図・プログラムなどのブロック（${kinds[lineNo]}）の中は直しません。blocks に書きます`)
    if (kinds[lineNo] === 'talk') {
      const label = line.match(/^[^:：]{1,24}: /)?.[0] ?? ''
      if (column < label.length) edit.problems.push('掛け合いの「名前(表情):」は old に入れません（せりふだけにします）')
    }
    if (!next.trim()) edit.problems.push('new が空です')
    if (next === old) edit.problems.push('old と new が同じです')
    const a = [...old].length
    const b = [...next].length
    if (b > a * 2 + 40 || b < a * 0.4) edit.problems.push(`長さが大きく変わっています（${a} 字 → ${b} 字）。誤りのところだけを直します`)
    else if (b > a * 1.5 + 20) edit.cautions.push(`長くなっています（${a} 字 → ${b} 字）`)
    for (const mark of ['**', '$', '|', '`']) {
      if (marks(old, mark) !== marks(next, mark)) (mark === '|' || marks(next, mark) % 2 ? edit.problems : edit.cautions).push(`「${mark}」の数が変わっています（${marks(old, mark)} → ${marks(next, mark)}）`)
    }
    if (young) {
      const fresh = bareHardKanji(next, meta.grade ?? 6).filter((ch) => !old.includes(ch))
      if (fresh.length) edit.problems.push(`${meta.grade} 年生より上で習う漢字を、読みを添えずに新しく使っています（${fresh.join('')}）。ひらがなで書くか、（ ）で読みを添えます`)
    }
    if (spaced && /[ 　]/.test(old) && !/[ 　]/.test(next)) edit.problems.push('分かち書き（言葉のまとまりごとに 1 字あける）になっていません')
  }
  // 重なる差しかえは、あとのほうを保留にする
  const placed = edits.filter((e) => e.at !== undefined).sort((x, y) => x.at - y.at)
  placed.forEach((e, i) => {
    const before = placed[i - 1]
    if (before && before.at + before.old.length > e.at) e.problems.push('ほかの差しかえと、場所が重なっています')
  })
  for (const e of edits) e.status = e.problems.length ? 'held' : 'ok'
  const blocks = (Array.isArray(raw?.blocks) ? raw.blocks : []).filter((b) => findings.some((f) => f.id === b?.id)).map((b) => ({ id: b.id, note: flat(b.note).slice(0, 300) }))
  // 「誤りがある」としたのに、差しかえもブロックの知らせも無い指摘
  const orphans = findings.filter((f) => verdicts[f.id]?.verdict === '誤りがある' && !edits.some((e) => e.ids.includes(f.id)) && !blocks.some((b) => b.id === f.id)).map((f) => f.id)
  return { verdicts, missing, edits, blocks, orphans }
}

// ───────── 試しの授業をえらぶ ─────────

let chosen = works
if (opt('sample', '')) {
  const size = Number(opt('sample'))
  const saved = readJson(join(outDir, 'sample.json'), null)
  let keys = saved?.size === size ? saved.keys : null
  if (!keys) {
    // 印の付いた授業の割合に合わせる（学び直し版 42%・小 13%・中 14%・高 31%）。順番は、保存名から決まる
    const share = { deep: 0.42, es: 0.13, jhs: 0.14, hs: 0.31 }
    keys = GROUPS.flatMap((g) => works.filter((w) => groupOf(w.meta) === g).sort((a, b) => hash(`body|${a.key}`).localeCompare(hash(`body|${b.key}`))).slice(0, Math.round(size * share[g])).map((w) => w.key))
    writeJson(join(outDir, 'sample.json'), { size, at: new Date().toISOString(), keys }, true)
  }
  chosen = works.filter((w) => keys.includes(w.key))
}

// ───────── 見くらべのページ ─────────

if (has('page')) {
  const { writeBodyPage } = await import('./lib/body-page.mjs')
  const file = resolve(opt('page-file', join(root, '..', '検査の結果', '本文の直しの試し.html')))
  const sample = readJson(join(outDir, 'sample.json'), null)
  const records = readdirSync(recordDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(recordDir, f), null)).filter(Boolean)
  const picked = records.filter((r) => (!schools.length || schools.includes(r.meta.school)) && (!onlyKeys.length || onlyKeys.includes(r.key)))
  const shown = has('all') || schools.length || onlyKeys.length || !sample ? picked : picked.filter((r) => sample.keys.includes(r.key))
  writeBodyPage(file, shown)
  console.log(`書き出しました: ${file}（授業 ${shown.length} 件）`)
  process.exit(0)
}

// ───────── 教材に入れる・まとめを書き出す ─────────

if (has('apply') || has('report')) {
  const { applyBodies, reportBodies } = await import('./lib/body-apply.mjs')
  const context = { dataDir, lessonsDir, recordDir, schools, works: chosen, hash, readJson, writeJson, log, dry: has('dry'), backup: resolve(opt('backup', join(root, '..', '保管', '直す前の授業の本文'))), reportDir: resolve(opt('report-dir', join(root, '..', '検査の結果'))) }
  if (has('apply')) await applyBodies(context)
  else reportBodies(context)
  process.exit(0)
}

// ───────── 差しかえを、codex に確かめさせる ─────────

if (has('verify')) {
  const codexModel = opt('codex-model', 'gpt-6.2-sol')
  const codexEffort = opt('codex-effort', 'high')
  const CODEX_WEEK = Number(opt('codex-week', 96))
  const BATCH = Number(opt('batch', 6))
  const CHECK_SYSTEM = `あなたは、日本の小学校・中学校・高等学校の教材の校閲者です。学習アプリの授業の本文について、編集者（別の AI）が出した「文の差しかえ」の案を、1 件ずつ確かめます。

授業ごとに、科目と読者、番号の付いた差しかえが並んでいます。差しかえには、もとの指摘、本文のその行（前後の行つき）、直す前の文（old）、直した後の文（new）が書いてあります。

## 判定（番号の付いた差しかえごとに、どれか 1 つ）
- ok: 直す前の文には、指摘どおりの誤り（事実・年代・人名・数値・式・定義の取りちがえ・因果関係・読み・文法）があり、直した後の文は正しい。その学年の言葉づかいに合い、前後の文ともつながる。
- wrong: 直した後の文に誤りがある（誤りが残っている、新しい誤りが入った、何を指すか分からない言葉が入った、前後の文と食いちがう、その学年には難しすぎる）。
- unneeded: 直す前の文は、誤りではない（その学年でふつうに教える簡略化、その場面に限った言い方として正しい、指摘のほうが細かすぎる）。直さないほうがよい。

## 注意
- **同じ授業の差しかえは、すべて一緒に本文に入ります。** ほかの差しかえ（「確かめ済み」と書いたものをふくむ）が入ったあとの本文を前提にして、食いちがいが無いかを見ます。「この差しかえだけでは、ほかの場所と食いちがう」という理由で wrong にするのは、その「ほかの場所」を直す差しかえが、同じ授業に無いときだけです。
- 編集者は、新しい事実を足しすぎないように、わざと直しを小さくしています。もとの指摘の全部を直しきっていなくても、直した後の文が正しく、直す前より良くなっていれば ok です。
- 学校の段階と学習指導要領を考えます。「大学ではこう言う」「厳密にはこうだ」というだけで wrong にはしません。
- 言い回しの好みは問いません。内容が正しく、読者に通じれば ok です。
- 確かめる必要がある事実だけ、ウェブ検索で確かめてかまいません。自信がない判定は sure を false にします。

## 返事の形（JSON）
checks: 差しかえごとに { no（見出しの番号）, verdict（ok / wrong / unneeded）, reason（1〜2 文）, sure }。すべての差しかえに付けます。
`
  const CHECK_SCHEMA = {
    type: 'object',
    properties: { checks: { type: 'array', items: { type: 'object', properties: { no: { type: 'integer' }, verdict: { type: 'string', enum: ['ok', 'wrong', 'unneeded'] }, reason: text, sure: { type: 'boolean' } }, required: ['no', 'verdict', 'reason', 'sure'], additionalProperties: false } } },
    required: ['checks'],
    additionalProperties: false,
  }
  const schemaFile = join(outDir, 'check-schema.json')
  writeJson(schemaFile, CHECK_SCHEMA, true)
  // 確かめる差しかえ: 機械の確かめを通っていて、まだ確かめていないもの。
  // 同じ授業の差しかえは、一緒に本文に入るので、同じまとまりで見せる（確かめ済みのものも、前提として並べる）
  const lessons = []
  for (const work of chosen) {
    const record = readJson(recordFile(work.key), null)
    if (!record || record.src !== work.src) continue
    const { lines } = fencesOf(work.body)
    const near = (from, step) => {
      for (let i = from; i >= 0 && i < lines.length && Math.abs(i - from) < 6; i += step) if (lines[i].trim() && !/^```/.test(lines[i])) return lines[i]
      return ''
    }
    const parts = []
    record.edits.forEach((edit, index) => {
      if (edit.status !== 'ok') return
      const pending = has('redo') || !edit.check
      // 通らなかった差しかえは、教材に入らないので、前提としても並べない
      if (!pending && edit.check.verdict !== 'ok') return
      const about = edit.ids.map((id) => record.findings.find((f) => f.id === id)).filter(Boolean)
      const rows = pending
        ? [...about.map((f) => `- もとの指摘（${f.kind === 'term' ? `用語「${f.target}」` : f.target}・${f.part}）: ${f.what} ／ 直し方の案: ${f.fix}`), `- 前の行: ${cut(near(edit.line - 2, -1), 300) || '（なし）'}`, `- その行（${edit.kind}）: ${cut(edit.context, 700)}`, `- 次の行: ${cut(near(edit.line, 1), 300) || '（なし）'}`, `- 直す前（old）: ${edit.old}`, `- 直した後（new）: ${edit.new}`]
        : [`- 直す前（old）: ${edit.old}`, `- 直した後（new）: ${edit.new}`]
      if (pending && edit.previous?.kept) rows.push(`- （この差しかえは、前回の確かめで通りませんでした。編集者は、この文は変えずに、同じ授業のほかの差しかえを直したり足したりしています。それでも食いちがいや誤りが残るかを見てください。前回の理由: ${edit.previous.reason}）`)
      else if (pending && edit.previous) rows.push(`- （この差しかえは、前回の確かめで通らなかったので、編集者が直したものです。前回の案: ${edit.previous.new} ／ 通らなかった理由: ${edit.previous.reason}）`)
      parts.push({ index, pending, where: `${edit.kind}・${edit.line} 行目`, rows })
    })
    if (!parts.some((p) => p.pending)) continue
    lessons.push({ key: work.key, group: groupOf(work.meta), head: [`## 授業: ${work.meta.course}／${work.meta.lesson}${work.meta.deep ? '（学び直し版）' : ''}`, `- 読者: ${readerOf(work.meta)}`, ...(work.meta.school === 'hsp' ? [`- ${HSP_RULE}（差しかえで、こうした内容が書き足されていれば wrong にします）`] : []), '- この授業には、下の差しかえが、すべて一緒に入ります。'].join('\n'), parts })
  }
  lessons.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.key.localeCompare(b.key, 'ja', { numeric: true }))
  // 授業を切らずに、差しかえが BATCH 件ほどになるまで、1 つのまとまりに入れる
  const batches = []
  for (const lesson of lessons) {
    const last = batches.at(-1)
    const size = (b) => b.reduce((n, l) => n + l.parts.filter((p) => p.pending).length, 0)
    if (last && size(last) + lesson.parts.filter((p) => p.pending).length <= BATCH) last.push(lesson)
    else batches.push([lesson])
  }
  const total = lessons.reduce((n, l) => n + l.parts.filter((p) => p.pending).length, 0)
  log(`確かめる差しかえ ${total} 件（授業 ${lessons.length} 件）＝ まとまり ${batches.length} 個（${codexModel}・${codexEffort}）`)
  if (has('count') || !batches.length) process.exit(0)
  const week = await codexWeek({ workDir, model: codexModel }).catch(() => null)
  log(`codex の週の使用割合: ${week?.percent ?? '?'}%（${CODEX_WEEK}% 以上なら始めません）`)
  if (week && week.percent >= CODEX_WEEK) process.exit(0)
  let at = 0
  let done = 0
  let failed = 0
  let cost = 0
  const tally = { ok: 0, wrong: 0, unneeded: 0 }
  const started = Date.now()
  async function worker() {
    while (at < batches.length) {
      const batch = batches[at++]
      // 判定をもらう差しかえに、まとまりの中の通し番号を付ける
      const numbered = []
      const blocks = batch.map((lesson) => {
        const parts = lesson.parts.map((part) => {
          if (!part.pending) return `### （確かめ済み。一緒に入ります）${part.where}\n${part.rows.join('\n')}`
          numbered.push({ key: lesson.key, index: part.index })
          return `### [${numbered.length}] ${part.where}\n${part.rows.join('\n')}`
        })
        return `${lesson.head}\n\n${parts.join('\n\n')}`
      })
      const input = `${CHECK_SYSTEM}\n# 確かめる差しかえ（判定するのは、番号の付いた ${numbered.length} 件）\n\n${blocks.join('\n\n')}\n`
      let last = null
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const answer = await codexExec({ input, workDir, model: codexModel, effort: codexEffort, schema: schemaFile })
          const checks = parseJson(answer.message).checks ?? []
          if (numbered.some((_, i) => !checks.some((c) => c.no === i + 1))) throw new Error('返事に、判定が足りません')
          cost += codexPrice(answer.usage)
          numbered.forEach((item, i) => {
            const c = checks.find((x) => x.no === i + 1)
            // 同じ授業の差しかえを続けて書くので、書くたびに読み直す
            const record = readJson(recordFile(item.key), null)
            record.edits[item.index].check = { verdict: c.verdict, reason: flat(c.reason).slice(0, 500), sure: c.sure !== false, at: new Date().toISOString(), model: codexModel }
            writeJson(recordFile(item.key), record, true)
            tally[c.verdict] += 1
          })
          done += 1
          last = null
          log(`${done} / ${batches.length} 個（失敗 ${failed}）— 正しい ${tally.ok}・誤りあり ${tally.wrong}・直す必要なし ${tally.unneeded} ／ API 換算 ${cost.toFixed(2)} ドル、${Math.round((Date.now() - started) / 60000)} 分`)
          break
        } catch (error) {
          last = error
          await sleep(5000)
        }
      }
      if (last) {
        failed += 1
        log(`まとまりの失敗 — ${String(last.message).slice(0, 160)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Number(opt('concurrency', 8)), batches.length) }, worker))
  const after = await codexWeek({ workDir, model: codexModel }).catch(() => null)
  log(`確かめが終わりました。まとまり ${done} 個（失敗 ${failed}）— 正しい ${tally.ok}・誤りあり ${tally.wrong}・直す必要なし ${tally.unneeded} ／ API 換算 ${cost.toFixed(2)} ドル ／ codex の週 ${after?.percent ?? '?'}%`)
  process.exit(0)
}

// ───────── 差しかえの案を作る（claude） ─────────

// 教材に入れ終えた授業は、本文が変わって印（src）が合わなくなるが、もう一度案を作ってはいけない（指摘は、直す前の本文へのもの）
const todo = chosen.filter((w) => {
  const record = readJson(recordFile(w.key), null)
  if (record?.appliedAt) return false
  return has('redo') || record?.src !== w.src
})
const queue = opt('limit', '') ? todo.slice(0, Number(opt('limit'))) : todo
{
  const by = Object.fromEntries(GROUPS.map((g) => [g, chosen.filter((w) => groupOf(w.meta) === g).length]))
  log(`印の付いた授業 ${works.length} 件（指摘 ${works.reduce((n, w) => n + w.findings.length, 0)} 件）。今回の対象 ${chosen.length} 件（学び直し版 ${by.deep}・小 ${by.es}・中 ${by.jhs}・高 ${by.hs}・高校（専門） ${by.hsp}）。これから案を作るのは ${queue.length} 件（約 ${Math.round(queue.reduce((n, w) => n + w.prompt.length, 0) / 10000)} 万字）`)
}
if (has('count')) process.exit(0)

const systemFile = join(outDir, 'system.md')
writeFileSync(systemFile, SYSTEM, 'utf8')
const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log })

async function ask(userText) {
  const token = await limiter.enter()
  try {
    return await askClaude({ systemFile, userText, model, effort, schema: SCHEMA, cwd: workDir, limiter, timeoutMs: 10 * 60_000 })
  } catch (error) {
    limiter.fail(error?.message)
    throw error
  } finally {
    limiter.leave(token)
  }
}

// ───────── 検査役が通さなかった差しかえを、直し直す（1 回だけ） ─────────
// codex が「直した文に誤りがある」とした差しかえを、理由を添えて、直す役にもう一度たずねる。
// 直した差しかえは、もう一度 --verify で確かめる（前回と同じ差しかえには、前回の結果を引きつぐ）。

if (has('revise')) {
  const targets = chosen.map((work) => ({ work, record: readJson(recordFile(work.key), null) })).filter(({ work, record }) => record && record.src === work.src && !record.revise && record.edits.some((e) => e.status === 'ok' && e.check?.verdict === 'wrong'))
  log(`検査役が通さなかった差しかえのある授業 ${targets.length} 件（差しかえ ${targets.reduce((n, t) => n + t.record.edits.filter((e) => e.status === 'ok' && e.check?.verdict === 'wrong').length, 0)} か所）を、直し直します`)
  const count = { lessons: 0, changed: 0, kept: 0, dropped: 0, held: 0, failed: 0, cost: 0 }
  let next = 0
  async function reviser() {
    while (next < targets.length) {
      const { work, record } = targets[next++]
      const wrong = record.edits.filter((e) => e.status === 'ok' && e.check?.verdict === 'wrong')
      const previous = { verdicts: Object.entries(record.verdicts).map(([id, v]) => ({ id: Number(id), verdict: v.verdict, reason: v.reason })), edits: record.edits.filter((e) => e.status === 'ok').map((e) => ({ ids: e.ids, old: e.old, new: e.new, note: e.note })), blocks: record.blocks }
      const userText = `${work.prompt}\n# 検査役の確かめで、通らなかった差しかえ\n前回のあなたの差しかえを、検査役（別の AI）が 1 件ずつ確かめました。次の差しかえは、「直した文に、まだ誤りや分かりにくさがある」と判定されました。\n\n${wrong.map((e, i) => `## 通らなかった差しかえ ${i + 1}\n- old: ${e.old}\n- new（前回）: ${e.new}\n- 検査役の理由: ${e.check.reason}`).join('\n\n')}\n\n## してほしいこと\n- 検査役の理由がもっともなら、new を直します（誤りのところだけを最小限に直す、という決まりは同じです。old は本文のそのままの文なので、ふつうは変えません。直す範囲を広げる必要があるときだけ、old を取り直します）。\n- 確かめられない事実を足すのではなく、あいまいな言い方や確かでない部分をけずる向きで直します。\n- 検査役の理由のほうがまちがっていると考えるときは、その差しかえを前回のまま返し、note に理由を書きます。\n- 直さないほうがよいと考え直したときは、その差しかえを外し、その指摘の判定を「直さない」に変えます。\n- そのほかの差しかえは、前回のまま、一字も変えずに返します。\n- 返事は、前回と同じ形（verdicts・edits・blocks のすべて）です。\n\n## 前回の答え（JSON）\n${JSON.stringify(previous)}\n`
      try {
        const answer = await ask(userText)
        const raw = answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
        const settled = settle(work, raw)
        for (const e of settled.edits) {
          // 前回と同じ差しかえには、前回の確かめの結果を引きつぐ。変わったものは、もう一度確かめる。
          // 通らなかった差しかえを前回のまま返したとき（同じ授業のほかの差しかえで食いちがいを直した、など）も、もう一度確かめる
          const same = record.edits.find((o) => o.old === e.old && o.new === e.new)
          if (same?.check && same.check.verdict !== 'wrong') e.check = same.check
          else if (same?.check) e.previous = { new: same.new, reason: same.check.reason, kept: true }
          const before = wrong.find((o) => o.old === e.old) ?? wrong.find((o) => o.line === e.line) ?? wrong.find((o) => o.ids.join() === e.ids.join() && !settled.edits.some((x) => x !== e && x.old === o.old))
          if (!same && before) e.previous = { new: before.new, reason: before.check.reason }
          if (!same) count[e.status === 'ok' ? 'changed' : 'held'] += 1
        }
        count.kept += wrong.filter((o) => settled.edits.some((e) => e.old === o.old && e.new === o.new)).length
        count.dropped += wrong.filter((o) => !settled.edits.some((e) => e.old === o.old || e.line === o.line)).length
        count.lessons += 1
        count.cost += answer.cost
        writeJson(recordFile(work.key), { ...record, cost: +(record.cost + answer.cost).toFixed(4), verdicts: settled.verdicts, missing: settled.missing, orphans: settled.orphans, edits: settled.edits, blocks: settled.blocks, revise: { at: new Date().toISOString(), cost: +answer.cost.toFixed(4), wrong: wrong.length, first: { verdicts: record.verdicts, edits: record.edits } } }, true)
      } catch (error) {
        count.failed += 1
        log(`${work.key}: 直し直しの失敗 — ${String(error.message).slice(0, 160)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Number(opt('concurrency', 10)), targets.length) }, reviser))
  log(`直し直しが終わりました。授業 ${count.lessons} 件（失敗 ${count.failed}）— 直した差しかえ ${count.changed}・前回のまま ${count.kept}・取り下げ ${count.dropped}・保留 ${count.held} ／ API 換算 ${count.cost.toFixed(2)} ドル。このあと --verify で、もう一度確かめます`)
  process.exit(0)
}

async function fix(work) {
  const started = Date.now()
  let cost = 0
  let settled = null
  let userText = work.prompt
  let attempts = 0
  for (attempts = 1; attempts <= 2; attempts += 1) {
    const answer = await ask(userText)
    cost += answer.cost
    const raw = answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, ''))
    settled = settle(work, raw)
    const failures = [...settled.missing.map((id) => `指摘 [${id}] の判定がありません`), ...settled.orphans.map((id) => `指摘 [${id}] を「誤りがある」としたのに、差しかえ（edits）も、ブロックの知らせ（blocks）もありません`), ...settled.edits.flatMap((e) => e.problems.map((p) => `差しかえ「${cut(e.old, 40)}」: ${p}`))]
    if (!failures.length || attempts === 2) break
    userText = `${work.prompt}\n# やり直し\n前回のあなたの答えは、機械の確かめで、次の点が通りませんでした。そこだけを直して、もう一度、すべてを答えてください（ほかは、前回の答えのままにします）。\n${failures.map((f) => `- ${f}`).join('\n')}\n\n## 前回の答え（JSON）\n${JSON.stringify(raw)}\n`
  }
  const record = {
    key: work.key,
    src: work.src,
    bodySrc: hash(work.body),
    at: new Date().toISOString(),
    model,
    effort,
    cost: +cost.toFixed(4),
    seconds: Math.round((Date.now() - started) / 1000),
    attempts: Math.min(attempts, 2),
    meta: work.meta,
    findings: work.findings,
    verdicts: settled.verdicts,
    missing: settled.missing,
    orphans: settled.orphans,
    edits: settled.edits,
    blocks: settled.blocks,
  }
  writeJson(recordFile(work.key), record, true)
  appendFileSync(join(outDir, 'metrics.jsonl'), `${JSON.stringify({ at: record.at, key: work.key, cost: record.cost, seconds: record.seconds, attempts: record.attempts, promptChars: work.prompt.length })}\n`, 'utf8')
  return record
}

let at = 0
let done = 0
let failed = 0
let cost = 0
const tally = { 誤りがある: 0, 直さない: 0, 本文には無い: 0, ok: 0, held: 0, retried: 0, blocks: 0 }
const started = Date.now()
const failures = []
async function worker() {
  while (at < queue.length) {
    const work = queue[at++]
    let last = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const record = await fix(work)
        cost += record.cost
        done += 1
        for (const v of Object.values(record.verdicts)) tally[v.verdict] += 1
        for (const e of record.edits) tally[e.status] += 1
        tally.blocks += record.blocks.length
        if (record.attempts > 1) tally.retried += 1
        last = null
        if (done % 10 === 0 || done === queue.length) log(`${done} / ${queue.length} 件（失敗 ${failed}）— 誤りがある ${tally.誤りがある}・直さない ${tally.直さない}・本文には無い ${tally.本文には無い} ／ 差しかえ ${tally.ok}・保留 ${tally.held}・ブロックの中 ${tally.blocks} ／ やり直した授業 ${tally.retried} ／ API 換算 ${cost.toFixed(2)} ドル、${Math.round((Date.now() - started) / 60000)} 分`)
        break
      } catch (error) {
        last = error
      }
    }
    if (last) {
      failed += 1
      failures.push(work.key)
      log(`${work.key}: 失敗 — ${String(last.message).slice(0, 160)}`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(Number(opt('concurrency', 10)), queue.length) }, worker))
const usage = limiter.state?.() ?? null
log(`終わりました。案を作った授業 ${done} 件（失敗 ${failed}${failures.length ? `: ${failures.slice(0, 12).join(', ')}` : ''}）／ API 換算 ${cost.toFixed(2)} ドル ／ ${Math.round((Date.now() - started) / 60000)} 分${usage ? ` ／ claude の使用割合 5 時間 ${Math.round((usage.five ?? 0) * 100)}%・週 ${Math.round((usage.week ?? 0) * 100)}%` : ''}`)
