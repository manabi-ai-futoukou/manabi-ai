// 画面の文言（t('…')・tx('…') で囲んだ日本語）の辞書を点検する・足りない訳を AI に下書きさせる。
//
//   node tools/i18n-dict.mjs [--lang en]              足りない訳・使われていない訳・{0} の数が合わない訳を数える（--list で一覧）
//   node tools/i18n-dict.mjs --translate [--long]     足りない訳を AI に下書きさせて、辞書（src/shared/i18n/<言語>.ts）に足す
//                                                     （--long を付けると、AI への指示文のような長い文も訳す。付けなければ短い文言だけ）
//   node tools/i18n-dict.mjs --set 直した訳.json      人が直した訳（日本語の文 → 訳の JSON）を辞書に入れる
//   node tools/i18n-dict.mjs --json                   文言の一覧（どのファイルにあるか）を JSON で出す
//
// 辞書は「日本語の文 → 訳」。訳の下書きは、人（または別の AI）が読んで直す前提。
import { parse } from '@babel/parser'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const lang = opt('lang', 'en')
const dictFile = join(root, 'src', 'shared', 'i18n', `${lang}.ts`)
const LONG = 220

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p) ? [p] : [])

/** ソースから、t('…')・tx('…') の文言を集める（文 → 使っているファイル） */
export function collect() {
  const messages = new Map()
  for (const file of walk(join(root, 'src'))) {
    if (file.includes(`${join('shared', 'i18n')}`)) continue
    const src = readFileSync(file, 'utf8')
    if (!/\bt[x]?\(/.test(src)) continue
    const ast = parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const rel = relative(root, file).replace(/\\/g, '/')
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return
      if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && node.callee.type === 'Identifier' && (node.callee.name === 't' || node.callee.name === 'tx')) {
        const first = node.arguments[0]
        const text = first?.type === 'StringLiteral' ? first.value : first?.type === 'TemplateLiteral' && !first.expressions.length ? first.quasis[0].value.cooked : null
        if (text !== null && /[぀-ヿ㐀-鿿]/.test(text)) {
          if (!messages.has(text)) messages.set(text, [])
          if (!messages.get(text).includes(rel)) messages.get(text).push(rel)
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key.endsWith('Comments') || key === 'extra') continue
        const value = node[key]
        if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child)
        else if (value && typeof value.type === 'string') visit(value)
      }
    }
    visit(ast.program)
  }
  return messages
}

const holes = (text) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join()

async function loadDict() {
  try {
    const module = await import(`${pathToFileURL(dictFile).href}?${Date.now()}`)
    return { ...module[lang] }
  } catch {
    return {}
  }
}

const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/ /g, '\\u00a0')}'`

function writeDict(dict, messages) {
  // ソースに出てくる順（ファイルごと）に並べる。使われていない訳は、最後にまとめて残す
  const byFile = new Map()
  for (const [text, files] of messages) {
    if (!(text in dict)) continue
    const file = files[0]
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(text)
  }
  const lines = [`/** 画面の文言の訳（日本語の文 → ${lang}）。足りない文言は node tools/i18n-dict.mjs で調べる */`, `export const ${lang}: Record<string, string> = {`]
  for (const [file, texts] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push(`  // ${file}`)
    for (const text of texts) lines.push(`  ${quote(text)}: ${quote(dict[text])},`)
  }
  const unused = Object.keys(dict).filter((text) => !messages.has(text))
  if (unused.length) {
    lines.push('  // （いまは使われていない文言）')
    for (const text of unused) lines.push(`  ${quote(text)}: ${quote(dict[text])},`)
  }
  lines.push('}', '')
  writeFileSync(dictFile, lines.join('\n'), 'utf8')
}

// ───────── 訳の下書き ─────────

const LANG_NAME = { en: 'English' }[lang] ?? lang
const UI_SYSTEM = `You translate the user-interface strings of "学びアイ" (Manabi-Ai), a Japanese desktop learning app for school students (elementary to high school; many users are children who have stopped attending school and study at home at their own pace), into ${LANG_NAME}.

Rules:
- Translate naturally and concisely, the way a well-made educational app in ${LANG_NAME} would phrase it: friendly, calm, encouraging, never childish. Buttons and labels are short (Title Case is not needed; use sentence case).
- Keep every placeholder {0}, {1}, … exactly; you may move them to fit the word order. Keep line breaks (\\n), leading/trailing spaces, and symbols such as ●, ／, —, …, ▸.
- Japanese brackets 「」 become quotation marks; Japanese parentheses （） become ( ); ／ used as a separator stays " / " or "／" as fits.
- A string may be a fragment used next to a value (for example " 回" after a number → " times", "点" → "pts"). Translate fragments so that they read naturally in that position.
- Glossary: 学びアイ → Manabi-Ai; 教科書 → textbook; チャット → chat; ノート → notebook (the mode) / notes; テスト → test; ディベート → debate; 英会話 → English conversation; 語彙力特訓 → vocabulary training; 漢字特訓 → kanji training; 成績 → report; 教材づくり → lesson builder; 設定 → settings; 掛け合い → dialogue (a short exchange between the teacher and classmates inserted in a lesson); 動く図解 → interactive diagram; 挿絵 → illustration; 単元表 → unit list; 単元 → unit; 授業 → lesson; 科目 → course; 教科 → subject; 学び直し向け → relearning version; 深掘り → in-depth; 先生 → teacher; 同級生 → classmate; 小学校 → elementary school; 中学校 → junior high school; 高校 → high school; 高校（専門）→ high school (specialized); 見開き → spread; 罫線 → ruled lines; 好感度 → rapport; 講評 → comments; 使用量 → usage (of the AI plan); 立論 → constructive speech; 反対尋問 → cross-examination; 反駁 → rebuttal; 最終弁論 → closing statement; 肯定側 → affirmative; 否定側 → negative; 書き順 → stroke order; 画 → stroke(s).
- The teacher character is "Ms. Minori". "あなた" addresses the student.
- Do not translate file names, key names (Ctrl, Shift, Esc), model names, or URLs.`

const LONG_SYSTEM = `You translate instructions (prompts) written for an AI model inside "学びアイ" (Manabi-Ai), a Japanese learning app for school students, into English. The translated prompt will be given to the AI model when the app is used in a language other than Japanese, so it must tell the model the same things, completely and precisely.

Rules:
- Translate faithfully and completely: every rule, every number, every field name. Do not summarize, soften, or add rules.
- Keep the structure: headings (# …), bullet lists, line breaks (\\n), field names in ASCII (kanji, words, reading, meaning, wordCount, sentences, ok, feedback, …), and every placeholder {0}, {1}, … exactly.
- Character counts for the model's output (for example "200〜350 字") become comparable word counts in English (roughly 2.3 Japanese characters per English word; "200〜350 字" → "about 90–150 words").
- "敬語で" (polite Japanese) becomes "in a polite, respectful tone".
- When the prompt is about practicing the Japanese language itself (Japanese vocabulary, kanji, readings, Japanese example sentences), the items being practiced stay Japanese: the model must still produce Japanese words, readings in hiragana, and Japanese example sentences. But text that explains things to the learner (meanings, feedback, comments, hints) should be written in the learner's display language; say so explicitly in the translated prompt as "the learner's display language (given at the end of these instructions)".
- When the prompt asks for English output for English practice, keep that.
- The app's name is "Manabi-Ai". The teacher character is "Ms. Minori".`

function ask(system, user, schema) {
  return new Promise((done, fail) => {
    const tempDir = join(process.env['APPDATA'] ?? '.', '学びアイ', 'data', 'ai-temp')
    mkdirSync(tempDir, { recursive: true })
    const systemFile = join(tempDir, `i18n-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
    writeFileSync(systemFile, system, 'utf8')
    const cli = ['-p', '--output-format', 'json', '--model', opt('model', 'sonnet'), '--effort', 'medium', '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '', '--json-schema', JSON.stringify(schema)]
    const child = spawn('claude', cli, { cwd: tempDir, windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', fail)
    child.on('exit', () => {
      try {
        const result = JSON.parse(out)
        if (result.is_error) return fail(new Error(String(result.result).slice(0, 200)))
        done(result.structured_output ?? JSON.parse(result.result))
      } catch (error) {
        fail(new Error(`返答を読み取れません: ${out.slice(0, 200)}`))
      }
    })
    child.stdin.end(user, 'utf8')
  })
}

const messages = collect()
const dict = await loadDict()

// --set <JSON ファイル>: 人が直した訳（日本語の文 → 訳）を辞書に入れる
if (opt('set', '')) {
  const fixes = JSON.parse(readFileSync(resolve(opt('set', '')), 'utf8'))
  for (const [text, value] of Object.entries(fixes)) {
    if (!messages.has(text)) console.log(`ソースに無い文言です（入れますが、使われません）: ${text.slice(0, 60)}`)
    if (holes(text) !== holes(value)) throw new Error(`{0} の数が合いません: ${text.slice(0, 60)}`)
    dict[text] = value
  }
  writeDict(dict, messages)
  console.log(`${Object.keys(fixes).length} 個の訳を入れました`)
}

if (has('json')) {
  console.log(JSON.stringify([...messages].map(([text, files]) => ({ text, files, [lang]: dict[text] ?? null })), null, 1))
} else if (has('translate')) {
  const missing = [...messages.keys()].filter((text) => !(text in dict))
  const short = missing.filter((text) => text.length <= LONG)
  const long = missing.filter((text) => text.length > LONG)
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' } }, required: ['n', 'text'] } } }, required: ['items'] }
  const jobs = []
  // 短い文言は、同じファイルのものをまとめて（文脈が伝わるように）50 個ずつ
  const ordered = short.slice().sort((a, b) => (messages.get(a)[0] < messages.get(b)[0] ? -1 : messages.get(a)[0] > messages.get(b)[0] ? 1 : 0))
  for (let i = 0; i < ordered.length; i += 50) jobs.push({ system: UI_SYSTEM, texts: ordered.slice(i, i + 50) })
  if (has('long')) for (const text of long) jobs.push({ system: LONG_SYSTEM, texts: [text] })
  console.log(`足りない訳 ${missing.length}（短い ${short.length}、長い ${long.length}）→ ${jobs.length} 回に分けて訳します`)
  let next = 0
  let done = 0
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++]
      const user = `Translate each numbered string into ${LANG_NAME}. Return one item per string with the same number.\n\n${job.texts.map((text, i) => `### ${i + 1} (used in ${messages.get(text)[0].replace(/^src\//, '')})\n${JSON.stringify(text)}`).join('\n\n')}`
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const answer = await ask(job.system, user, schema)
          for (const item of answer.items ?? []) {
            const source = job.texts[item.n - 1]
            if (!source || typeof item.text !== 'string' || !item.text.trim()) continue
            let text = item.text
            // JSON の文字列として返してきたときは、中身を取り出す
            if (/^".*"$/s.test(text.trim())) {
              try {
                text = JSON.parse(text.trim())
              } catch {}
            }
            if (holes(source) !== holes(text)) {
              console.log(`{0} の数が合わないので、入れません: ${source.slice(0, 50)} → ${text.slice(0, 50)}`)
              continue
            }
            dict[source] = text
          }
          break
        } catch (error) {
          console.log(`失敗（${attempt} 回目）: ${error.message}`)
        }
      }
      done += 1
      if (done % 5 === 0) console.log(`${done} / ${jobs.length}`)
      writeDict(dict, messages)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker))
  writeDict(dict, messages)
  console.log(`辞書に ${Object.keys(dict).length} 個。まだ足りない訳 ${[...messages.keys()].filter((text) => !(text in dict)).length} 個`)
} else {
  const missing = [...messages.keys()].filter((text) => !(text in dict))
  const unused = Object.keys(dict).filter((text) => !messages.has(text))
  const broken = [...messages.keys()].filter((text) => text in dict && holes(text) !== holes(dict[text]))
  console.log(`文言 ${messages.size}、訳がある ${messages.size - missing.length}、足りない ${missing.length}（うち長い文 ${missing.filter((t) => t.length > LONG).length}）、使われていない訳 ${unused.length}、{0} の数が合わない ${broken.length}`)
  if (has('list')) {
    for (const text of missing) console.log(`足りない\t${messages.get(text)[0]}\t${text.replace(/\n/g, '\\n').slice(0, 160)}`)
    for (const text of broken) console.log(`{0}\t${text.slice(0, 80)}\t${dict[text].slice(0, 80)}`)
  }
  if (missing.length || broken.length) process.exitCode = 1
}
