// モデルごとの適性を調べる: アプリの主な仕事（ノートの評価、質問への返事、テストづくりと採点、英会話）を、
// アプリが実際に使う指示文のまま、いくつかのモデルに頼んで、できばえ・かかる時間・使う量（API の料金に直した目安）を比べる。
//
//   python tools/model-check/render-notes.py .try/model-check <手書きのノート.json>   （見本の画像を作る。先に 1 回）
//   node --no-warnings tools/model-check.mjs [--models haiku,sonnet,opus,gpt-6-luna,gpt-6.1-terra,gpt-6.2-sol] [--effort medium] [--out .try/model-check]
//
// - AI は、この PC の claude・codex のコマンドで呼ぶ（API キーは使わない。自分のプランの使用量を使う）。
// - 料金の目安は、使ったトークンの数に、API の料金表（src/web/ai/providers.ts の PRICES）を掛けたもの。
// - 結果は <out>/results.json。できばえの確かめ方は、下の「仕事」の check を見る（機械で確かめられる範囲だけ）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLAUDE_MODELS, PRICES, costOf } from '../src/web/ai/providers.ts'
import { runClaude, runCodex, setupCli } from '../web/cli.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const outDir = resolve(opt('out', join(root, '.try', 'model-check')))
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const models = opt('models', 'haiku,sonnet,opus,gpt-6-luna,gpt-6.1-terra,gpt-6.2-sol').split(',').filter(Boolean)
const effort = opt('effort', 'medium')
mkdirSync(outDir, { recursive: true })
setupCli({ workDir: join(outDir, 'workdir'), tempDir: join(outDir, 'temp') })

// アプリの指示文（src/main/ai/prompts.ts）を、そのまま読みこむ（@shared/… と、拡張子の無い読みこみを、Node が分かる形にする）
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) return nextResolve(pathToFileURL(join(root, 'src', 'shared', `${specifier.slice(8)}${extname(specifier) ? '' : '.ts'}`)).href, context)
    if (/^\.\.?\//.test(specifier) && !extname(specifier) && context.parentURL?.includes('/src/')) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const P = await import('../src/main/ai/prompts.ts')

// ───────── 材料 ─────────

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const characters = JSON.parse(readFileSync(join(root, 'resources', 'content', 'characters.json'), 'utf8'))
const teacher = characters.find((c) => c.role === 'teacher') ?? characters[0]
const course = { ...catalog.courses.find((c) => c.id === 'jhs1-math'), title: '中学 1 年 数学' }
const curriculumFile = existsSync(join(dataDir, 'curricula', 'jhs1-math.json')) ? join(dataDir, 'curricula', 'jhs1-math.json') : join(root, 'resources', 'content', 'jhs1-math', 'curriculum.json')
const unit = JSON.parse(readFileSync(curriculumFile, 'utf8')).units[0]
const lessonBody = (n) => {
  const shipped = join(root, 'resources', 'content', 'jhs1-math', `jhs1-math-1-${n}.md`)
  return readFileSync(existsSync(shipped) ? shipped : join(dataDir, 'lessons', `jhs1-math-1-${n}.md`), 'utf8')
}
const lesson = (n) => ({ id: `jhs1-math-1-${n}`, number: `1-${n}`, title: unit.lessons[n - 1].title, summary: unit.lessons[n - 1].summary, unitTitle: unit.title, courseTitle: course.title, body: lessonBody(n) })
const image = (name) => readFileSync(join(outDir, name)).toString('base64')
const clean = (text) => String(text ?? '').replace(/[\s　$\\]/g, '').replace(/[-‐−–ー]/g, '−').replace(/[＜]/g, '<').replace(/[＞]/g, '>')

/** 2 つの文が、どれだけ同じか（0〜1。編集距離から） */
function similarity(a, b) {
  const x = clean(a)
  const y = clean(b)
  if (!x.length || !y.length) return 0
  let row = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const next = [i]
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    row = next
  }
  return +(1 - row[y.length] / Math.max(x.length, y.length)).toFixed(2)
}

const HANDWRITING = '顕著顕著顕著顕著顕著この新しい技術の導入により、生産性が顕著に向上した。'
const GOOD_NOTE = '1-2数直線と絶対値・数直線…まっすぐな線の上に数をならべたもの。右へいくほど大きい。0が原点。・負の数は0より左。−5は−3より左にあるから−5<−3（−5のほうが小さい）→気温でいうと−5℃のほうが寒い！・絶対値＝原点からのきょり。向きは考えない。|−4|=4,|+4|=4,|0|=0・自分のことば:絶対値は「0から何歩はなれているか」。借金300円と貯金300円は、絶対値は同じ300。・まちがえやすい:負の数は、絶対値が大きいほど数としては小さい。−7<−2だけど|−7|>|−2|・問題:絶対値が3より小さい整数→−2,−1,0,1,2の5つ'
const GRADING_SHEET = [
  ['short', 10, '−7 の絶対値を答えましょう。', '7', '7', [10, 10]],
  ['short', 10, '−2 と −6 のうち、大きいほうを答えましょう。', '−2', '−6', [0, 0]],
  ['written', 20, '絶対値とは何かを、自分の言葉で説明しましょう。', '数直線上で、原点からその数を表す点までの距離のこと。', '0 からどれだけはなれているかを表す数。向きは関係ない。', [16, 20]],
  ['written', 20, '−4 ＜ −1 である理由を、数直線を使って説明しましょう。', '数直線では、右にある数ほど大きい。−1 は −4 より右にあるので、−4 ＜ −1 である。', '4 のほうが 1 より大きいから、−4 のほうが小さい。', [4, 16]],
  ['short', 10, '絶対値が 2 である数を、すべて答えましょう。', '+2 と −2', '2', [0, 5]],
]

// ───────── 仕事 ─────────

const evaluationTask = (name, file, lessonForNote, check) => ({
  name,
  system: P.evaluationSystemPrompt(teacher),
  prompt: P.evaluationUserPrompt({ lesson: lessonForNote, pages: [1], typedTexts: {}, debate: '' }),
  images: [image(file)],
  schema: P.EVALUATION_SCHEMA,
  check,
})
const tasks = [
  evaluationTask('手書きを読む', 'handwriting-1.png', null, (o) => ({ 読みとり: similarity(o.transcripts?.[0], HANDWRITING) })),
  evaluationTask('ノートの評価（よいノート）', 'note-good.png', lesson(2), (o) => ({ 読みとり: similarity(o.transcripts?.[0], GOOD_NOTE), 理解: o.understanding?.score, 応用: o.application?.score, 発想: o.creativity?.score })),
  evaluationTask('ノートの評価（誤りのあるノート）', 'note-flawed.png', lesson(2), (o) => {
    const said = clean([o.understanding?.comment, o.application?.comment, o.creativity?.comment, o.overall, o.advice].join(' '))
    return { 理解: o.understanding?.score, 応用: o.application?.score, 発想: o.creativity?.score, 大小の誤りを指摘: /−5/.test(said) && /−3/.test(said), 絶対値の誤りを指摘: /\|0\||0の絶対値/.test(said) }
  }),
  {
    name: '質問への返事',
    system: P.debateSystemPrompt(teacher, lesson(2), []),
    prompt: '−3 と −5 では、どちらが大きいですか？ 絶対値が大きいほうが、大きい数なのではないのですか？',
    check: (text) => ({ 正しい答え: /−3(のほう|の方)?が(−5より)?大き|−3>−5|−5<−3|−5(のほう|の方)?が(−3より)?小さ/.test(clean(text)), 字数: clean(text).length }),
  },
  {
    name: 'テストづくり',
    system: P.testSystemPrompt(course),
    prompt: P.testUserPrompt(`${course.title}・${unit.title}`, [lesson(1), lesson(2)], 5),
    schema: P.TEST_QUESTIONS_SCHEMA,
    check: (o) => {
      const qs = o.questions ?? []
      return { 問題の数: qs.length, 形が正しい: qs.every((q) => ['choice', 'short', 'written'].includes(q.kind) && q.prompt && q.answer && (q.kind !== 'choice' || (q.choices.length >= 2 && q.correctChoice >= 0 && q.correctChoice < q.choices.length))), 種類: qs.map((q) => q.kind[0]).join('') }
    },
    judge: (o) => (o.questions ?? []).map((q, i) => `## 問題 ${i + 1}（${q.kind}）\n${q.prompt}${q.choices?.length ? `\n選択肢: ${q.choices.map((c, j) => `(${j}) ${c}`).join(' ／ ')}\n正解の番号: ${q.correctChoice}` : ''}\n模範解答: ${q.answer}\n解説: ${q.explanation}`).join('\n\n'),
  },
  {
    name: 'テストの採点',
    system: P.testGradingSystemPrompt(course),
    prompt: `「${course.title}・${unit.title}」のテストを採点してください。\n\n${GRADING_SHEET.map(([kind, points, prompt, key, answer], i) => `## 問題 ${i + 1}（${kind}・配点 ${points}）\n${prompt}\n模範解答: ${key}\n生徒の解答: ${answer}`).join('\n\n')}`,
    schema: P.TEST_GRADING_SCHEMA,
    check: (o) => {
      const scores = GRADING_SHEET.map((_, i) => o.results?.find((r) => r.number === i + 1)?.score)
      return { 点数: scores.join('/'), ねらいどおり: scores.filter((s, i) => s >= GRADING_SHEET[i][5][0] && s <= GRADING_SHEET[i][5][1]).length }
    },
  },
  {
    name: '英会話',
    system: P.eikaiwaSystemPrompt(teacher, [], '中学 1 年の 1 学期ていどの英語（be 動詞と一般動詞の現在形、ごく基本の単語だけ）。1〜2 文で短く答える。'),
    prompt: 'I like soccer. Do you like sports?',
    check: (text) => {
      const body = String(text).replace(/\[[^\]]*\]/g, '').trim()
      return { 英語の割合: +((body.match(/[A-Za-z]/g) ?? []).length / Math.max(1, body.replace(/\s/g, '').length)).toFixed(2), 語数: body.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length }
    },
  },
]

// ───────── 実行 ─────────

const isClaude = (model) => model in CLAUDE_MODELS
async function ask(model, task, callEffort = effort) {
  const started = Date.now()
  const call = { model, effort: callEffort, system: task.system, turns: [{ role: 'user', content: [...(task.images ?? []).map((data) => ({ type: 'image', data })), { type: 'text', text: task.prompt }] }], jsonSchema: task.schema }
  const result = await (isClaude(model) ? runClaude(call) : runCodex(call))
  const apiModel = isClaude(model) ? CLAUDE_MODELS[model] : model
  return { text: result.text, usage: result.usage, cost: costOf(apiModel, result.usage), seconds: +((Date.now() - started) / 1000).toFixed(1) }
}

const resultsFile = join(outDir, 'results.json')
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {}
const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 1), 'utf8')

await Promise.all(
  models.map(async (model) => {
    results[model] ??= {}
    for (const task of tasks) {
      if (results[model][task.name] && !results[model][task.name].error) continue
      try {
        const answer = await ask(model, task)
        const output = task.schema ? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, '')) : answer.text
        const row = { check: task.check(output), seconds: answer.seconds, usage: answer.usage, cost: answer.cost, output }
        // テストづくりは、できた問題と模範解答が正しいかを、上のモデル（sonnet）に確かめさせる
        if (task.judge) {
          const verdict = await ask('sonnet', { system: `あなたは、${course.title}の検定教科書の編集者です。テストの問題と模範解答を読み、誤りを探します。自分で解き直して確かめます。誤りとは、模範解答がまちがっている、正解の番号がちがう、答えが 1 つに決まらない、この学年でまだ習わない内容、のいずれかです。`, prompt: `次のテストを確かめてください。\n\n${task.judge(output)}`, schema: { type: 'object', properties: { wrong: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, why: { type: 'string' } }, required: ['number', 'why'], additionalProperties: false } } }, required: ['wrong'], additionalProperties: false } }, 'medium')
          row.check['誤りのある問題'] = JSON.parse(verdict.text).wrong.map((w) => `${w.number}: ${w.why.slice(0, 60)}`)
        }
        results[model][task.name] = row
        console.log(`${model} ／ ${task.name}: ${JSON.stringify(row.check)}　${row.seconds} 秒、入力 ${row.usage.input}・出力 ${row.usage.output}、$${row.cost?.toFixed(5) ?? '?'}`)
      } catch (error) {
        results[model][task.name] = { error: String(error.message).slice(0, 300) }
        console.log(`${model} ／ ${task.name}: 失敗 ${String(error.message).slice(0, 160)}`)
      }
      save()
    }
  }),
)
console.log(`料金表（100 万トークンあたり、入力・キャッシュ・出力）: ${models.map((m) => `${m} ${JSON.stringify(PRICES[isClaude(m) ? CLAUDE_MODELS[m] : m] ?? '?')}`).join('　')}`)
