// 授業を外国語に訳してみて、使用量と時間を測る（検証用。実データは書きかえない）
//
//   node scripts/try-translate.mjs --lessons jhs-history-3-1,hs-math2-4-1 --langs en,zh,es,fr,ru,ar
//        [--model sonnet] [--effort low] [--concurrency 6] [--tag sonnet-low] [--review] [--redo]
//
// 訳した授業は .try/translate/<tag>/<言語>/<授業の ID>.md、測った値は .try/translate/<tag>/metrics.json に置く。
// --review を付けると、訳し終えたものを AI にもう一度読ませて、意味のずれ・抜けを探させる（点検の使用量を測るため）。
// claude が知らせてくる使用割合が 85% を超えたら、新しい問い合わせを始めない。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const model = opt('model', 'sonnet')
const effort = opt('effort', 'low')
const tag = opt('tag', `${model}-${effort}`)
const langs = opt('langs', 'en').split(',')
const lessons = opt('lessons', '').split(',').filter(Boolean)
const concurrency = Number(opt('concurrency', 6))
const outRoot = join(root, '.try', 'translate', tag)
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
mkdirSync(outRoot, { recursive: true })

export const LANGS = {
  en: { name: 'English', ja: '英語', teacher: 'Ms. Minori' },
  zh: { name: 'Simplified Chinese (Mandarin, as used in mainland China)', ja: '中国語（簡体字）', teacher: '美野里老师' },
  es: { name: 'Spanish (neutral, international)', ja: 'スペイン語', teacher: 'la profesora Minori' },
  fr: { name: 'French', ja: 'フランス語', teacher: 'Mme Minori' },
  ru: { name: 'Russian', ja: 'ロシア語', teacher: 'учительница Минори' },
  ar: { name: 'Modern Standard Arabic', ja: 'アラビア語', teacher: 'المعلمة مينوري' },
  pt: { name: 'Portuguese (Brazilian)', ja: 'ポルトガル語', teacher: 'a professora Minori' },
  hi: { name: 'Hindi', ja: 'ヒンディー語', teacher: 'मिनोरी मैम' },
}

const system = (lang) => `You translate one lesson of a Japanese school textbook app into ${LANGS[lang].name}. The reader is a student of the same grade as the original (the vocabulary of the original tells you the grade). Write the way a good textbook in that language is written: natural, clear, and warm. Do not translate word for word, and do not add, drop, or "improve" content.

The lesson is Markdown. Keep its structure exactly:
- The same headings in the same order and at the same levels, the same lists, tables, block quotes, and bold marks. Do not merge or split sections.
- Math between $...$ or $$...$$ stays exactly as it is. Translate only Japanese words that appear inside \\text{...}.
- Numbers, years, units, and formulas stay as they are (write them the way the target language normally does).

Fenced blocks:
- \`\`\`talk: each line is "speaker(expression): line". Keep the speaker ID and the expression unchanged when the speaker is "sensei" or "s01"–"s20". When the speaker is a historical person's name, translate the name. Translate what is said. Keep the same number of lines in the same order. The teacher (sensei) is called "${LANGS[lang].teacher}" when someone addresses her.
- \`\`\`picture, \`\`\`sim, \`\`\`plot, \`\`\`numberline: one JSON object. Translate only the human-readable strings ("caption", "task", "label", "title" and the like). Keep "id", "kind", numbers, and keys unchanged. Keep it valid JSON on one line if it was on one line.
- \`\`\`figure: SVG. Translate only the text inside <text>…</text>. Keep every tag and attribute unchanged. Keep labels short so that they fit where the Japanese label was.
- Program code blocks (python, sql, html, …): keep the code unchanged; translate comments, and translate strings only when they are messages shown to the learner.

Japan-specific words:
- For Japanese people, places, eras, works, laws, and institutions, give the usual name in the target language, and add the original Japanese in parentheses the first time it appears, e.g. "Prince Shōtoku (聖徳太子)". After that, use the translated name only.
- When the lesson quotes a Japanese or classical Chinese text, keep the original quotation and add a translation right after it.
- Keep Japanese units, currency, and school grades as they are in Japan (do not convert to another country's system).

Output only the translated lesson, starting with its first heading. No preface, no notes, no code fence around the whole thing.`

const reviewSystem = (lang) => `You check a translation of a Japanese school textbook lesson into ${LANGS[lang].name}. You get the Japanese original and the translation. Report only real problems: a change of meaning, a factual error introduced by the translation, missing or added content, a mistranslated technical term, a broken formula or block, text left in Japanese that the reader needs, or language that is unnatural or too hard for the grade. Do not report style preferences. Answer in Japanese.`
const reviewSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'そのまま使ってよければ true' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' }, severity: { type: 'string', enum: ['重い', '軽い'] } },
        required: ['where', 'what', 'severity'],
      },
    },
  },
  required: ['ok', 'problems'],
}

let lastLimit = null
let stop = false

/** claude を 1 回呼ぶ。返答の文章と、使った量・かかった時間を返す */
function ask(systemText, userText, schema) {
  return new Promise((done, fail) => {
    const systemFile = join(tempDir, `translate-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
    writeFileSync(systemFile, systemText, 'utf8')
    const cli = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort, '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '']
    if (schema) cli.push('--json-schema', JSON.stringify(schema))
    const started = Date.now()
    const child = spawn('claude', cli, { cwd: workDir, windowsHide: true })
    let buffer = ''
    let stderr = ''
    let result = null
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'rate_limit_event') {
          lastLimit = { at: Date.now(), info: event.rate_limit_info }
          const five = event.rate_limit_info?.unifiedWindows?.five_hour?.utilization
          if (event.rate_limit_info?.status !== 'allowed' || (typeof five === 'number' && five >= 0.85)) stop = true
        }
        if (event.type === 'result') result = event
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', fail)
    child.on('exit', () => {
      try {
        // 指示文の一時ファイルは残さない
        writeFileSync(systemFile, '', 'utf8')
      } catch {}
      if (!result || result.is_error) return fail(new Error(`claude が失敗しました: ${String(result?.result ?? stderr).slice(0, 300)}`))
      done({
        text: typeof result.result === 'string' ? result.result : '',
        structured: result.structured_output ?? null,
        wallMs: Date.now() - started,
        apiMs: result.duration_api_ms,
        usage: result.usage,
        cost: result.total_cost_usd,
        models: result.modelUsage,
        limit: lastLimit?.info ?? null,
      })
    })
    child.stdin.end(userText, 'utf8')
  })
}

// ───────── 形がくずれていないかの機械的な確認 ─────────
const blocksOf = (body) => [...body.replace(/\r\n/g, '\n').matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].map((m) => ({ kind: m[1] || 'code', text: m[2] }))
const headings = (body) =>
  body
    .replace(/^```[\s\S]*?^```$/gm, '')
    .split('\n')
    .filter((l) => /^#{1,4} /.test(l))
    .map((l) => l.match(/^#+/)[0].length)
const mathOf = (body) => (body.replace(/^```[\s\S]*?^```$/gm, '').match(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g) ?? []).map((m) => m.replace(/\s+/g, ''))
const JA = /[぀-ヿ㐀-鿿]/
export function compare(source, target, lang) {
  const problems = []
  const a = blocksOf(source)
  const b = blocksOf(target)
  if (headings(source).join() !== headings(target).join()) problems.push(`見出しの並びがちがう（${headings(source).length} → ${headings(target).length}）`)
  if (a.map((x) => x.kind).join() !== b.map((x) => x.kind).join()) problems.push(`ブロックの並びがちがう（${a.map((x) => x.kind).join(' ')} → ${b.map((x) => x.kind).join(' ')}）`)
  else
    a.forEach((block, i) => {
      const other = b[i]
      if (block.kind === 'talk') {
        const who = (t) =>
          t
            .split('\n')
            .filter(Boolean)
            .map((l) => (l.match(/^(sensei|s\d\d)(\([a-z]+\))?:/) ?? ['人物'])[0])
            .join()
        if (who(block.text) !== who(other.text)) problems.push(`掛け合い ${i + 1}: 話す人か表情の並びがちがう`)
      } else if (['picture', 'sim', 'plot', 'numberline'].includes(block.kind)) {
        try {
          const x = JSON.parse(block.text)
          const y = JSON.parse(other.text)
          const strip = (o) => JSON.stringify(o, (k, v) => (typeof v === 'string' && JA.test(v) ? '' : v))
          const blank = (o) => JSON.stringify(o, (k, v) => (typeof v === 'string' && !['id', 'kind'].includes(k) ? '' : v))
          if (blank(x) !== blank(y)) problems.push(`${block.kind} ${i + 1}: 文字以外の中身が変わった`)
          void strip
        } catch {
          problems.push(`${block.kind} ${i + 1}: JSON として読めない`)
        }
      } else if (block.kind === 'figure') {
        const shape = (t) => t.replace(/>[^<]*</g, '><').replace(/\s+/g, ' ')
        if (shape(block.text) !== shape(other.text)) problems.push(`図 ${i + 1}: 文字以外（タグや属性）が変わった`)
      }
    })
  const m1 = mathOf(source).filter((m) => !JA.test(m))
  const m2 = new Set(mathOf(target))
  const lost = m1.filter((m) => !m2.has(m))
  if (lost.length) problems.push(`数式が ${lost.length} / ${m1.length} 個、元と同じ形で見つからない（例: ${lost[0].slice(0, 40)}）`)
  const rows = (t) => t.split('\n').filter((l) => /^\|/.test(l)).length
  if (rows(source) !== rows(target)) problems.push(`表の行数がちがう（${rows(source)} → ${rows(target)}）`)
  const kana = (target.match(/[぀-ヿ]/g) ?? []).length
  return { problems, kana, ratio: +(target.length / source.length).toFixed(2), lang }
}

// ───────── 実行 ─────────
if (import.meta.filename === resolve(process.argv[1])) {
  const metricsFile = join(outRoot, 'metrics.json')
  const metrics = existsSync(metricsFile) ? JSON.parse(readFileSync(metricsFile, 'utf8')) : []
  const save = () => writeFileSync(metricsFile, JSON.stringify(metrics, null, 1), 'utf8')
  const jobs = []
  for (const lang of langs) for (const key of lessons) jobs.push({ lang, key })
  const kindOf = has('review') ? 'review' : 'translate'
  const startedAll = Date.now()
  let next = 0
  async function worker() {
    while (next < jobs.length && !stop) {
      const { lang, key } = jobs[next++]
      const source = readFileSync(join(dataDir, 'lessons', `${key}.md`), 'utf8').replace(/\r\n/g, '\n')
      const file = join(outRoot, lang, `${key}.md`)
      mkdirSync(join(outRoot, lang), { recursive: true })
      try {
        if (kindOf === 'translate') {
          if (existsSync(file) && !has('redo')) continue
          const r = await ask(system(lang), source)
          const text = r.text.replace(/^```(?:markdown)?\n([\s\S]*)\n```\s*$/, '$1').trim() + '\n'
          writeFileSync(file, text, 'utf8')
          const check = compare(source, text, lang)
          metrics.push({ kind: 'translate', key, lang, model, effort, srcChars: source.length, outChars: text.length, wallMs: r.wallMs, apiMs: r.apiMs, usage: r.usage, cost: r.cost, limit: r.limit, check })
          console.log(`${lang} ${key}: ${Math.round(r.wallMs / 1000)} 秒、入力 ${r.usage?.input_tokens}+${r.usage?.cache_creation_input_tokens ?? 0}+${r.usage?.cache_read_input_tokens ?? 0}、出力 ${r.usage?.output_tokens}、$${r.cost?.toFixed(4)}${check.problems.length ? '、形の問題: ' + check.problems.join(' / ') : ''}`)
        } else {
          if (!existsSync(file)) continue
          const target = readFileSync(file, 'utf8')
          const r = await ask(reviewSystem(lang), `# 元の授業（日本語）\n\n${source}\n\n# 訳（${LANGS[lang].ja}）\n\n${target}`, reviewSchema)
          const found = r.structured ?? JSON.parse(r.text)
          writeFileSync(join(outRoot, lang, `${key}.review.json`), JSON.stringify(found, null, 1), 'utf8')
          metrics.push({ kind: 'review', key, lang, model, effort, srcChars: source.length, outChars: target.length, wallMs: r.wallMs, apiMs: r.apiMs, usage: r.usage, cost: r.cost, limit: r.limit, found: { ok: found.ok, heavy: found.problems.filter((p) => p.severity === '重い').length, light: found.problems.filter((p) => p.severity === '軽い').length } })
          console.log(`点検 ${lang} ${key}: ${Math.round(r.wallMs / 1000)} 秒、入力 ${r.usage?.input_tokens}+${r.usage?.cache_creation_input_tokens ?? 0}+${r.usage?.cache_read_input_tokens ?? 0}、出力 ${r.usage?.output_tokens}、$${r.cost?.toFixed(4)}、重い ${found.problems.filter((p) => p.severity === '重い').length}・軽い ${found.problems.filter((p) => p.severity === '軽い').length}`)
        }
      } catch (error) {
        console.log(`${lang} ${key}: 失敗 ${error.message}`)
        metrics.push({ kind: kindOf, key, lang, model, effort, error: String(error.message).slice(0, 200) })
      }
      save()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  save()
  console.log(`終わり: ${jobs.length} 件、${Math.round((Date.now() - startedAll) / 1000)} 秒${stop ? '（使用量が上限に近いので途中で止めました）' : ''}`)
  if (lastLimit) console.log('使用割合:', JSON.stringify(lastLimit.info))
}
