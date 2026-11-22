// 授業の挿絵と、歴史上の人物のイメージ画を、codex CLI の画像生成で作る。
//
//   挿絵:   node tools/gen-pictures.mjs --courses <科目の ID> […]     その科目の授業すべて
//           node tools/gen-pictures.mjs --lessons <授業の ID> […]     授業を指定
//           授業の本文を codex に読ませ、絵にすると分かりやすい場面を 1 つ選ばせて描かせる（合う場面が無い授業には作らない）。
//   人物:   node tools/gen-pictures.mjs --guests <科目の ID> […]      その科目の掛け合いに出てくる歴史上の人物すべて
//           node tools/gen-pictures.mjs --people "<名前>=<時代や立場、服装の手がかり>" […]
//
//   --concurrency <数>   同時に作る数（はじめは 5）
//   --no-check           できた絵の確認をしない
//
// できた絵は、もう一度 codex に見せて確かめる（文字が入っていないか、説明や時代と合っているか、形がくずれていないか）。
// 問題があれば、その内容を伝えて作り直す（2 回まで）。それでも直らなかった絵は、確認の結果に「ok: false」と残り、アプリには入れない。
//
// 置き場所: assets-src/media/lessons/<授業の ID>.png・.json（置き場所と説明）・.check.json（確認の結果）、.none（合う場面なし）
//           assets-src/media/people/<名前>.png・.check.json
// すでにあるものは飛ばすので、途中で止まっても再実行すれば続きから進む。記録は assets-src/media/gen.log。
// このあと `node scripts/install-media.mjs` で、大きさを整えてアプリのデータ置き場に入れる。
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outRoot = join(root, 'assets-src', 'media')
const workRoot = join(tmpdir(), 'manabi-pictures')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const sheetDir = resolve(root, '..', '先生')
const sheet = join(sheetDir, readdirSync(sheetDir).find((f) => f.endsWith('.png')))
mkdirSync(join(outRoot, 'lessons'), { recursive: true })
mkdirSync(join(outRoot, 'people'), { recursive: true })

const args = process.argv.slice(2)
const mode = args.shift()
const flag = (name, fallback) => {
  const at = args.indexOf(name)
  if (at < 0) return fallback
  const [, value] = args.splice(at, 2)
  return value
}
const CONCURRENCY = Number(flag('--concurrency', 5))
const CHECK = !args.includes('--no-check')
if (!CHECK) args.splice(args.indexOf('--no-check'), 1)
const MAX_ATTEMPTS = 3

const log = (text) => {
  const line = `${new Date().toLocaleTimeString('ja-JP')} ${text}`
  console.log(line)
  appendFileSync(join(outRoot, 'gen.log'), line + '\n')
}

const USE_TOOL = 'コードで描画や合成をするのではなく、必ず組み込みの画像生成機能を使ってください。'

const scenePrompt = (title, feedback) =>
  `作業ディレクトリの lesson.md は、学習アプリの授業「${title}」の本文です。sheet.png は、このアプリの登場人物の絵柄の見本です。` +
  'この授業の理解を助ける挿絵を 1 枚、組み込みの画像生成機能で生成してください。' +
  '【場面の選び方】本文の中で、情景や様子を絵にすると分かりやすくなる場面を 1 つ選びます。図・グラフ・表・地図で表すべき内容や、文字や数値が必要な内容は選びません。' +
  '絵にして分かりやすくなる場面が無い授業（文法や計算、しくみや制度の説明だけの授業など）では、画像を生成せず、picture.json に {"none": true} とだけ保存して終わります。' +
  '【絵の条件】sheet.png と同じ、やわらかいアニメ調の絵柄（線と塗り）。横長（3:2）。文字・数字・ラベル・吹き出し・枠線・地図は入れない。' +
  '実在する現代の人物、商標やロゴのあるものは描かない。実在する絵画や写真などの作品を再現しない。子どもが見て怖くない表現にし、戦いや災害の場面でも血や傷、たおれた人は描かない。' +
  '時代・地域・季節・服装・建物・道具は、本文の内容に合わせ、その時代や地域に無いものを描かない。sheet.png の人物そのものは描かない。' +
  '宗教の開祖や、信仰の対象になっている人物・神（ブッダ、イエス、ムハンマドなど）の姿は描かない。そうした授業では、当時の町や人びとの暮らし、建物、道具などの場面を選ぶ（仏像や寺院、教会などの建物や文化財は描いてよい）。' +
  '【保存】画像を作業ディレクトリ直下の picture.png に保存し、次の形の JSON を picture.json に保存してください。' +
  '{"after": "挿絵を置く節の見出し。lesson.md の「## 」で始まる見出しのうち 1 つを、文字どおりに（## は付けない）。「この授業のねらい」「確かめ問題」「ノートに書いてみましょう」は選ばない", ' +
  '"caption": "絵の説明（40 字以内。本文と同じ読み手に合わせた言葉と漢字で書く）", "alt": "絵に描かれているものの説明（80 字以内）"}' +
  (feedback ? `【前に生成した絵の問題】次の点を直した絵にしてください: ${feedback}` : '') +
  USE_TOOL

const personPrompt = (name, hint, withLesson, feedback) =>
  `sheet.png は、学習アプリの登場人物の絵柄の見本です。同じ絵柄（線の太さ、塗り方、目の描き方）で、歴史上の人物「${name}」${hint ? `（${hint}）` : ''}のイメージ画を、組み込みの画像生成機能で 1 枚生成してください。` +
  (withLesson ? '作業ディレクトリの lesson.md は、この人物が出てくる授業の本文です。人物の時代・地域・立場は、本文とあなたの知識から判断します。' : '') +
  '【絵の条件】純白の背景。正方形。胸から上のバストアップを 1 人だけ、中央に大きく、正面からやや斜め向きで。' +
  'その時代・地域・立場にふさわしい服装と髪型にし、伝わっている肖像画や像の特徴を参考にする。年齢は、活躍した時期に合わせる。' +
  'おだやかで親しみやすい表情。文字・ラベル・枠線・小物の描きこみすぎは避ける。sheet.png の人物（先生）に似せない。' +
  '【保存】画像を作業ディレクトリ直下の picture.png に保存してください。' +
  (feedback ? `【前に生成した絵の問題】次の点を直した絵にしてください: ${feedback}` : '') +
  USE_TOOL

/** 姿を描かない人物（像・如来・〜教 のように、文化財や宗教の名前として出てくる場合はのぞく） */
const NO_DEPICT = /(ムハンマド|マホメット|イエス|キリスト|ブッダ|仏陀|釈迦|シャカ|ゴータマ|アッラー|ヤハウェ)(?!教|像|の像|如来|三尊)/

const CHECK_FORM = '答えは、次の形の JSON だけにしてください（前置きや説明は書かない）: {"ok": true または false, "problems": ["問題を 1 つずつ、短く"]}。画風の小さなちがいや好みは問題にせず、見てはっきり分かる問題だけを挙げます。問題が無ければ problems は空の配列にします。'

const sceneCheckPrompt = (title) =>
  `添付の画像 picture.png は、学習アプリの授業「${title}」の挿絵として生成したものです。作業ディレクトリの lesson.md が授業の本文、picture.json が絵の説明と置き場所です。次の点を確かめてください。` +
  '(1) 文字・数字・ラベル・吹き出し・透かしが入っていないか。' +
  '(2) picture.json の説明（caption・alt）と、実際に描かれているものが合っているか。' +
  '(3) 本文の時代・地域・季節と合わないもの（その時代や地域に無い建物・服装・道具・乗り物など）が描かれていないか。' +
  '(4) 人の体や物の形に、はっきりしたくずれ（指の本数、顔のゆがみ、つながらない形）が無いか。' +
  '(5) 子どもが見て怖い表現、血や傷、たおれた人が無いか。実在する現代の人物や商標が描かれていないか。' +
  '(6) picture.json の after が、lesson.md の「## 」の見出しのどれかと一致しているか。' +
  CHECK_FORM

const personCheckPrompt = (name) =>
  `添付の画像 picture.png は、学習アプリで使う、歴史上の人物「${name}」のイメージ画として生成したものです。次の点を確かめてください。` +
  '(1) 描かれているのが 1 人だけで、胸から上のバストアップ、背景が白になっているか。文字・ラベル・枠線が入っていないか。' +
  `(2) 服装・髪型・持ち物が、「${name}」の時代・地域・立場に合っているか（はっきりした時代や地域のちがいが無いか）。性別やおよその年齢が、その人物として不自然でないか。` +
  '(3) 顔や手の形に、はっきりしたくずれが無いか。' +
  '(4) 人物をおとしめるような表現や、怖い表現になっていないか。' +
  CHECK_FORM

/** codex を 1 回呼ぶ。終わったら、終了コードと、かかった秒数を返す */
function codex(dir, prompt, images, timeoutMs) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn('codex', ['exec', prompt, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', join(dir, 'last.txt'), ...images.flatMap((image) => ['-i', image])], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const finish = (code) => {
      clearTimeout(timer)
      done({ code, seconds: Math.round((Date.now() - started) / 1000) })
    }
    child.on('close', finish)
    child.on('error', () => finish('spawn'))
  })
}

const readJson = (file) => {
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

let failuresInRow = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 1 つ作る（確認して、問題があれば作り直す）。結果を表す短い言葉を返す */
async function run(job) {
  let feedback = ''
  let last = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dir = join(workRoot, `${job.slug}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    copyFileSync(sheet, join(dir, 'sheet.png'))
    if (job.lesson) copyFileSync(job.lesson, join(dir, 'lesson.md'))
    const made = await codex(dir, job.prompt(feedback), [join(dir, 'sheet.png')], 420000)
    const info = job.kind === 'scene' ? readJson(join(dir, 'picture.json')) : {}
    if (job.kind === 'scene' && info?.none) {
      writeFileSync(job.none, '')
      failuresInRow = 0
      return '合う場面なし'
    }
    if (!existsSync(join(dir, 'picture.png')) || !info || (job.kind === 'scene' && !String(info.caption ?? '').trim())) {
      // 絵ができなかった（混雑や上限のことが多い）。続くようなら、しばらく休む
      failuresInRow += 1
      log(`${job.label}: 生成できませんでした（exit=${made.code}、${made.seconds} 秒、${attempt} 回目）`)
      if (failuresInRow >= 4) {
        log('失敗が続いているので、10 分休みます。')
        await sleep(600000)
        failuresInRow = 0
      }
      continue
    }
    failuresInRow = 0
    last = { dir, info }
    // 開祖や信仰の対象を描いた場面は、確認を待たずに作り直す
    if (job.kind === 'scene' && NO_DEPICT.test(`${info.caption} ${info.alt}`)) {
      last.verdict = { ok: false, problems: ['宗教の開祖や信仰の対象になっている人物の姿を描いている。その人物を描かず、当時の町や人びとの暮らしの場面にする'], attempts: attempt }
      feedback = last.verdict.problems[0]
      log(`${job.label}: 作り直します（開祖や信仰の対象を描いた場面だったため）`)
      continue
    }
    if (!CHECK) break
    const checked = await codex(dir, job.check, [join(dir, 'picture.png')], 240000)
    const verdict = readJson(join(dir, 'last.txt'))
    if (!verdict || typeof verdict.ok !== 'boolean') {
      log(`${job.label}: 確認の答えを読み取れませんでした（exit=${checked.code}）`)
      last.verdict = { ok: false, problems: ['確認の答えを読み取れなかった'], attempts: attempt }
      continue
    }
    last.verdict = { ok: verdict.ok, problems: (verdict.problems ?? []).map(String).slice(0, 8), attempts: attempt }
    if (verdict.ok) break
    feedback = last.verdict.problems.join('／').slice(0, 400)
    log(`${job.label}: 作り直します（${attempt} 回目の問題: ${feedback.slice(0, 120)}）`)
  }
  if (!last) return '失敗'
  copyFileSync(join(last.dir, 'picture.png'), job.target)
  if (job.json) writeFileSync(job.json, JSON.stringify(last.info), 'utf8')
  writeFileSync(job.checkFile, JSON.stringify(last.verdict ?? { ok: true, problems: [], attempts: 1, unchecked: true }), 'utf8')
  return last.verdict && !last.verdict.ok ? `問題が残りました（${last.verdict.problems.join('／').slice(0, 100)}）` : `できました${last.verdict?.attempts > 1 ? `（${last.verdict.attempts} 回目）` : ''}`
}

const lessonFile = (key) => join(dataDir, 'lessons', `${key}.md`)
const titleOf = (file) => /^# (?:\d+-\d+[ 　]+)?(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
/** その科目の授業（ふつうの本文）を、単元表の順に */
function lessonsOf(courseId) {
  const curriculum = readJson(join(dataDir, 'curricula', `${courseId}.json`))
  if (!curriculum) throw new Error(`${courseId}: 単元表がありません`)
  return curriculum.units.flatMap((unit, u) => unit.lessons.map((_l, l) => `${courseId}-${u + 1}-${l + 1}`)).filter((key) => existsSync(lessonFile(key)))
}
function sceneJob(key) {
  const base = join(outRoot, 'lessons', key)
  const title = titleOf(lessonFile(key))
  return { kind: 'scene', label: key, slug: key.replace(/[^a-z0-9-]/gi, '_'), lesson: lessonFile(key), prompt: (feedback) => scenePrompt(title, feedback), check: sceneCheckPrompt(title), target: `${base}.png`, json: `${base}.json`, checkFile: `${base}.check.json`, none: `${base}.none` }
}
function personJob(name, hint, lesson, index) {
  const base = join(outRoot, 'people', name)
  return { kind: 'person', label: name, slug: `person${index}`, lesson, prompt: (feedback) => personPrompt(name, hint, !!lesson, feedback), check: personCheckPrompt(name), target: `${base}.png`, checkFile: `${base}.check.json`, none: `${base}.none` }
}

let jobs = []
if (mode === '--courses') jobs = args.flatMap(lessonsOf).map(sceneJob)
else if (mode === '--lessons') jobs = args.map(sceneJob)
else if (mode === '--people') jobs = args.map((arg, i) => personJob(arg.split('=')[0], arg.split('=')[1] ?? '', null, i))
else if (mode === '--guests') {
  // 掛け合いに出てくる、登場人物でない話し手（歴史上の人物）を拾う。同じ人は、はじめに出てきた授業を手がかりにする
  const found = new Map()
  for (const key of args.flatMap(lessonsOf)) {
    for (const [, block] of readFileSync(lessonFile(key), 'utf8').matchAll(/^```talk\n([\s\S]*?)\n```/gm)) {
      for (const line of block.split('\n')) {
        const speaker = /^([^\s()（）:：、。「」]{1,16})\s*(?:[（(][A-Za-z]*[)）])?\s*[:：]/.exec(line)?.[1]
        if (speaker && !/^(sensei|s\d\d)$/.test(speaker) && !/[\\/:*?"<>|]/.test(speaker) && !found.has(speaker)) found.set(speaker, key)
      }
    }
  }
  // 宗教の開祖や、信仰の対象になっている人物は、絵にしない（姿を描くこと自体が、信仰をもつ人を傷つけることがあるため）
  const NO_IMAGE = /ムハンマド|マホメット|イエス|キリスト|ブッダ|仏陀|釈迦|シャカ|ゴータマ|アッラー|ヤハウェ/
  for (const name of [...found.keys()]) if (NO_IMAGE.test(name)) found.delete(name)
  jobs = [...found].map(([name, key], i) => personJob(name, '', lessonFile(key), i))
  writeFileSync(join(outRoot, 'guests.json'), JSON.stringify(Object.fromEntries(found), null, 1), 'utf8')
} else throw new Error('--courses・--lessons・--guests・--people のどれかを指定してください。')

const todo = jobs.filter((job) => !(existsSync(job.none) || (existsSync(job.target) && existsSync(job.checkFile))))
log(`はじめます: ${mode} ${jobs.length} 件のうち、これから作るのは ${todo.length} 件（同時に ${CONCURRENCY}、確認${CHECK ? 'あり' : 'なし'}）`)
let next = 0
const tally = {}
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length) {
      const job = todo[next++]
      const result = await run(job).catch((error) => `失敗（${String(error).slice(0, 80)}）`)
      const kind = result.replace(/（.*$/, '')
      tally[kind] = (tally[kind] ?? 0) + 1
      log(`${job.label}: ${result}［${next}/${todo.length}］`)
    }
  }),
)
log(`終わり: ${JSON.stringify(tally)}`)
