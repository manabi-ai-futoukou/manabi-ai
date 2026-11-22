// 授業を Codex（GPT 6.2 Sol）に評価させ、掘り下げて分量を増やした版に書き直させて、元の授業と置きかえる。
//
//   node tools/deepen-lessons.mjs [--schools jhs,hs] [--courses 科目の ID,…] [--only 保存名,…] [--limit 件数]
//        [--deep]（小学校の「学び直し版」= <保存名>.deep.md だけを対象にする。--schools es と合わせる）
//        [--concurrency 6] [--review-concurrency 4] [--model gpt-6.2-sol] [--effort high] [--review-model sonnet] [--review-effort medium]
//        [--codex-week 90] [--api-budget 0] [--five 0.85] [--week 0.86] [--max-fixes 2] [--backup フォルダ] [--no-apply] [--apply-only] [--status]
//
// 1 つの授業は、次の順に進む（途中で止めても、もう一度実行すれば続きから進む）。
//   1. 評価（codex）… 学校段階と学習指導要領を物差しにして読み、「本物の誤り」と「軽微な点（簡略化など）」に分けて返す
//   2. 掘り下げ（codex）… 本物の誤りを先に直し、その学年の生徒が分かる範囲で、説明・例題・確かめ問題を増やした版を書く
//   3. 機械の検査 … 書式・数式・図（scripts/lib/check-lesson.mjs）、掛け合い・動く図解・挿絵が元のまま残っているか、分量、本文に URL が無いか
//   4. 読み直し（claude）… 別の AI が、元の授業と見くらべて読む。重い問題（本物の誤り・学校段階をこえる内容・欠落・壊れた書式。
//      「学年への合い方」の点が 5 点中 2 点以下のものもふくむ）が
//      あれば codex に直させて（--max-fixes 回まで）、もう一度読む。それでも残るものは置きかえずに取っておく（held）
//   5. 置きかえ … 元の授業を --backup（既定は アプリの外の「保管/掘り下げ前の授業」）に写してから、<データ置き場>/lessons/ に書く。
//      アプリが開いているあいだは書かない（閉じているときに、まとめて書く。あとから --apply-only でも書ける）
//
// - 途中の記録は <データ置き場>/deepen/（eval・drafts・changes・review・state.json・progress.json・metrics.jsonl）。
//   置きかえた授業の一覧は <データ置き場>/deepened.json（保存名 → 置きかえた時刻・元と新しい本文の指紋）。
// - 英語などの訳は作り直さない（訳は、掘り下げる前の授業のまま残る。アプリは「日本語版と内容が異なる」と表示する）。
// - 同時に進める数は、動かしたまま変えられる。<データ置き場>/deepen/control.json を 10 秒ごとに読む:
//     { "concurrency": 評価・掘り下げ（codex）を同時に進める数, "reviewConcurrency": 読み直し（claude）を同時に進める数,
//       "codexWeek": codex を休む週の使用割合（%）, "stop": true にすると、進めている分を終えてから止まる }
//   起動のときに --concurrency などを付けると、その値をこのファイルに書く（付けなければ、前に書いた値のまま進める）。
//   進み具合のページ（tools/deepen-view.mjs）からも変えられる。
// - codex の週の使用割合が --codex-week（%）に届く手前で、codex を休む（1 時間ごと、または回復の時刻に確かめて、回復していれば続ける）。
//   見はりの合間に進む分（同時に進める数が多いほど大きい）を見こんで、1〜2 ポイント手前で止める。
//   使用割合は、短い問いを 1 回送り、その記録（~/.codex/sessions/…）から読む。読んだあとの記録は消す。
// - --api-budget（ドル。control.json の apiBudget でも変えられる）を 1 以上にすると、codex がプランの週の上限で休みに入ったあと、
//   OpenAI の API（従量の料金）で続ける。環境変数 OPENAI_API_KEY の鍵を、その呼び出しにだけ CODEX_API_KEY として渡す。
//   使った金額は、トークン数と料金の表から多めに見積もり、<データ置き場>/deepen/api-usage.json に足していく。予算に届く手前で止める。
//   既定は 0（切りかえない。上限に届いたら、回復を待つ）。
// - claude の使用割合の見はりは、訳す道具と同じ（--five・--week）。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkLesson } from '../scripts/lib/check-lesson.mjs'
import { askClaude, createLimiter } from './lib/claude.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const outDir = join(dataDir, 'deepen')
const backupDir = resolve(opt('backup', join(root, '..', '保管', '掘り下げ前の授業')))
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
const model = opt('model', 'gpt-6.2-sol')
const effort = opt('effort', 'high')
const reviewModel = opt('review-model', 'sonnet')
const reviewEffort = opt('review-effort', 'medium')
const MAX_FIXES = Number(opt('max-fixes', 2))
const PROBE_EVERY = Number(opt('probe-every', 30))
for (const dir of [workDir, tempDir, backupDir, ...['eval', 'drafts', 'changes', 'review', 'raw'].map((d) => join(outDir, d))]) mkdirSync(dir, { recursive: true })

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
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)

// ───────── 進め方の調整（動かしたまま変えられる） ─────────

const controlFile = join(outDir, 'control.json')
const CONTROL = { concurrency: [0, 48, '評価・掘り下げを同時に進める数'], reviewConcurrency: [0, 24, '読み直しを同時に進める数'], codexWeek: [1, 100, 'codex を休む週の使用割合（%）'], apiBudget: [0, 2000, 'API に切りかえたときに使ってよい金額（ドル）'] }
const control = { concurrency: 6, reviewConcurrency: 4, codexWeek: 90, apiBudget: 0, stop: false }
function readControl(announce = false) {
  const saved = readJson(controlFile, null)
  if (!saved) return
  for (const [name, [min, max, label]] of Object.entries(CONTROL)) {
    const value = Math.round(Number(saved[name]))
    if (!Number.isFinite(value) || value < min || value > max || value === control[name]) continue
    if (announce) log(`${label}を ${control[name]} → ${value} に変えました`)
    control[name] = value
  }
  if (typeof saved.stop === 'boolean' && saved.stop !== control.stop) {
    control.stop = saved.stop
    if (announce) log(saved.stop ? '止める指示を受けました。進めている分を終えてから、止まります' : '止める指示が取り消されました。続けます')
  }
}
readControl()
if (opt('concurrency', '')) control.concurrency = Number(opt('concurrency'))
if (opt('review-concurrency', '')) control.reviewConcurrency = Number(opt('review-concurrency'))
if (opt('codex-week', '')) control.codexWeek = Number(opt('codex-week'))
if (opt('api-budget', '')) control.apiBudget = Number(opt('api-budget'))

// ───────── 対象の授業 ─────────

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const courseIndex = new Map(catalog.courses.map((c, i) => [c.id, i]))
/** 学び直し版（小学校の内容を、中学生以上の人が学び直すための本文。保存名の終わりが「.deep」）か */
const isDeep = (key) => key.endsWith('.deep')
const baseOf = (key) => key.replace(/\.deep$/, '')
const courseOf = (key) => {
  const course = catalog.courses.find((c) => c.id === baseOf(key).replace(/-\d+-\d+$/, ''))
  // 学び直し版は、読み手と言葉づかいがちがうので、科目に印（deep）を付けて渡す
  return course && isDeep(key) ? { ...course, deep: true } : course
}
const curricula = new Map()
const curriculumOf = (course) => {
  if (!curricula.has(course.id)) {
    const own = join(dataDir, 'curricula', `${course.id}.json`)
    curricula.set(course.id, JSON.parse(readFileSync(existsSync(own) ? own : join(root, 'resources', 'content', course.id, 'curriculum.json'), 'utf8')))
  }
  return curricula.get(course.id)
}
const numbers = (key) => baseOf(key).match(/-(\d+)-(\d+)$/).slice(1).map(Number)

const schools = list('schools').length ? list('schools') : ['jhs', 'hs']
// --deep を付けると、学び直し版（<保存名>.deep.md）だけを対象にする（付けなければ、ふつうの本文だけ）
const wantDeep = has('deep')
let keys = readdirSync(lessonsDir)
  .filter((f) => f.endsWith('.md') && f.endsWith('.deep.md') === wantDeep)
  .map((f) => f.slice(0, -3))
  .filter((key) => /-\d+-\d+$/.test(baseOf(key)) && courseOf(key))
  // 単元表に無い授業のファイル（単元表を作り直す前の、古い授業。アプリには出ない）は、対象にしない
  .filter((key) => {
    const [u, l] = numbers(key)
    return !!curriculumOf(courseOf(key)).units[u - 1]?.lessons[l - 1]
  })
if (list('only').length) keys = keys.filter((key) => list('only').includes(key))
else {
  keys = keys.filter((key) => schools.includes(courseOf(key).school))
  if (list('courses').length) keys = keys.filter((key) => list('courses').includes(courseOf(key).id))
}
const schoolOrder = (key) => (schools.indexOf(courseOf(key).school) + 1 || 99)
keys.sort((a, b) => schoolOrder(a) - schoolOrder(b) || courseIndex.get(courseOf(a).id) - courseIndex.get(courseOf(b).id) || numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1])
if (opt('limit', '')) keys = keys.slice(0, Number(opt('limit', '')))

// ───────── 記録 ─────────

const stateFile = join(outDir, 'state.json')
/** 保存名 → { stage, src, fixes, fails, ratio, why, at }。stage は evaluated・drafted・fix・passed・applied・held・failed（無ければ、まだ何もしていない） */
const state = readJson(stateFile, {})
let stateDirty = false
const saveState = () => {
  stateDirty = false
  writeJson(stateFile, state, false)
}
const touch = (key, patch) => {
  state[key] = { ...(state[key] ?? {}), ...patch, at: Date.now() }
  stateDirty = true
}
const deepenedFile = join(dataDir, 'deepened.json')
const file = {
  lesson: (key) => join(lessonsDir, `${key}.md`),
  eval: (key) => join(outDir, 'eval', `${key}.json`),
  draft: (key) => join(outDir, 'drafts', `${key}.md`),
  changes: (key) => join(outDir, 'changes', `${key}.json`),
  review: (key) => join(outDir, 'review', `${key}.json`),
}
const readLesson = (key) => readFileSync(file.lesson(key), 'utf8').replaceAll('\r\n', '\n')
const plainLength = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, '').length

// ───────── 指示文 ─────────

const SCHOOL = { es: '小学校', jhs: '中学校', hs: '高等学校', hsp: '高等学校（専門学科）' }
const GUIDE = { es: '小学校学習指導要領（平成 29 年告示）', jhs: '中学校学習指導要領（平成 29 年告示）', hs: '高等学校学習指導要領（平成 30 年告示）', hsp: '高等学校学習指導要領（平成 30 年告示）' }
const READER = {
  es: '小学生本人が、ひとりで読みます。その学年までに習う漢字と言葉で、身近なものにたとえて、やさしく語りかけます。',
  jhs: '学校に通えず学習に空白がある中学生が、ひとりで読み進めます。前の授業の内容は、短く思い出せるように書き添えます。',
  hs: '大学受験を目指す高校生が、ひとりで読み進めます。定義や導出を省かず、考え方の筋道を示します。大学入試でどのように問われるかにも、必要に応じて触れます。',
  hsp: '高校の専門学科の内容を学びたい高校生や、その分野の仕事に関心のある人が、ひとりで読み進めます。専門用語は意味を説明してから使い、具体的な場面や例で示します。',
}
/** 小学校の学年（「1・2 年」のようにまとめた科目は、上の学年）と、学年のまとまり（言葉づかいと分量を、これで変える） */
const gradeOf = (course) => Number(course.label?.match(/(\d) 年$/)?.[1] ?? 6)
const bandOf = (course) => (course.school !== 'es' || course.deep ? '' : gradeOf(course) <= 2 ? 'lower' : gradeOf(course) <= 4 ? 'middle' : 'upper')
/** 学び直し版の読み手（授業を書いたときの決まり = src/main/ai/authoring.ts と同じ） */
const DEEP_READER = '小学校の内容を学び直す、中学生以上の人が、ひとりで読み進めます。小学生向けの説明をくり返すのではなく、「なぜそうなるのか」という理由、つまずきやすいところ、中学校以降の学習へのつながりを掘り下げます。漢字や用語は、中学生がふつうに読めるものを使います。'
const ES_BAND = { lower: '1・2 年', middle: '3・4 年', upper: '5・6 年' }
const ES_READER = {
  lower: 'ひらがなを中心にし、1 文を短くします（長くても 40 字くらい）。むずかしい言葉は使わず、身近なものにたとえて、やさしく語りかけます。',
  middle: 'その学年までに習う漢字と言葉を中心にし、むずかしい言葉は使わないか、すぐに言いかえます。1 文を短めにし、身近なものにたとえて、やさしく語りかけます。',
  upper: 'その学年までに習う漢字と言葉を中心にし、むずかしい言葉は使わないか、すぐに言いかえます。身近なものにたとえて、やさしく語りかけます。',
}
/** 高校の専門教科の種類: 職業に関する科目（vocational）・実技が中心の科目（skill）・理数や英語（academic）。専門教科でなければ '' */
const HSP_VOCATIONAL = new Set(['agriculture', 'industry', 'commerce', 'fishery', 'home', 'nursing', 'information', 'welfare'])
const HSP_SKILL = new Set(['pe', 'music', 'art'])
/** 実技が中心の科目で、「指導者に見てもらいながら身につける」ものの言い方（教科ごと） */
const HSP_SKILL_WORD = { pe: '実際の動き', music: '実際の発声や奏法', art: '実際の制作' }
const hspKind = (course) => (course.school !== 'hsp' ? '' : HSP_VOCATIONAL.has(course.subject) ? 'vocational' : HSP_SKILL.has(course.subject) ? 'skill' : 'academic')
const HSP_READER = {
  vocational: `${READER.hsp}仕事の現場でどう役立つかにも、必要に応じて触れます。`,
  skill: '高校の専門学科（体育科、音楽科、美術科など）の内容を学びたい高校生や、その分野に関心のある人が、ひとりで読み進めます。専門用語は意味を説明してから使い、具体的な作品・競技・場面で示します。実技（運動、演奏、制作）そのものはこのアプリでは行えないので、知識・理論・歴史・鑑賞と、練習や制作を自分で組み立てるための考え方を、読んで身につけられるように書きます。',
  academic: '高校の専門学科（理数科、英語科など）の内容を学びたい高校生が、ひとりで読み進めます。各学科に共通する科目（数学 I、英語コミュニケーション I など）より一歩ふみこんだ内容を、定義や導出、考え方の筋道を省かずに示します。',
}
const readerOf = (course) => (course.deep ? DEEP_READER : course.school === 'es' ? `${course.label}の小学生本人が、ひとりで読みます。${ES_READER[bandOf(course)]}` : course.school === 'hsp' ? HSP_READER[hspKind(course)] : READER[course.school])
/** 専門教科の決まり（授業を書いたときの決まり = src/main/ai/authoring.ts と同じ考え方）。掘り下げと直しの指示に足す */
const hspRule = (course) => {
  const kind = hspKind(course)
  if (!kind) return ''
  const rules = []
  if (kind === 'vocational') {
    rules.push(
      '- 職業に関する専門科目です。現場での実習や、資格をとるための勉強の代わりにはなりません。「これだけで仕事ができる」「資格がとれる」と受け取れる書き方をしません。',
      '- けがや事故、健康の被害につながる作業（機械、電気、薬品、農薬、火、刃物、重機、船、高い所の作業、人の体に触れる介助、医療的ケア、注射や与薬などの看護の技術、食品の衛生に関わる加工）は、手順を身につけさせる書き方にしません。掘り下げで足すのは、しくみ、観察のポイント、どこに危険があり、どう防ぐか、なぜその決まりがあるのか、です。手順・分量・濃度・設定値・操作の順番を、新しく書き足しません。例題や確かめ問題でも、危険な作業の手順や数値を答えさせません。いまの本文にある「学校や職場で、指導者のもとで行う」という文は残します。',
      '- 法律・制度・規格・基準値・資格や検定の内容は、改正されることがあります。足すのは基本の考え方を中心にし、条文の番号・年・金額・数値・基準値は、資料で確かめられたものだけを書きます。確かめられなければ、数値を書かずに「法律で決められています」のように書きます。いまの本文の内容が古い・誤りだと確かめられたときは、直します。',
      '- 例に使う会社名・人名・数値は、自分で作った架空のものにします（実在の会社・商品・個人を、評価する形で取り上げません）。',
    )
  }
  if (kind === 'skill') {
    rules.push(
      `- 実技（運動、演奏、制作）が中心の専門科目です。実技そのものは、このアプリでは行えません。掘り下げで足すのは、知識・理論・歴史・鑑賞と、練習や制作を組み立てる考え方です。体の動かし方・奏法・技法を「やり方」として細かく書き足しません。元の授業に「${HSP_SKILL_WORD[course.subject] ?? '実際の技能'}は、指導者に見てもらいながら身につける」という趣旨の文があれば、元の言葉のまま残します（無ければ、足さなくてかまいません。ほかの教科の言葉を並べた決まり文句にはしません）。`,
      '- けがにつながる運動（投げ技や絞め技、器械運動の高度な技、野外での活動など）、のど・手・腕・耳を痛める無理な練習、薬品・溶剤・粉じん・刃物・電動工具・窯や炉を使う工程は、あらましと、どこに危険があり、どう防ぐかを中心に書きます。濃度や調合、機械の操作の手順は書き足しません。',
      '- トレーニングの量や強さ、回数、食事や水分の量などの数値は、一般的な目安として書き、年齢・体力・体調による個人差があることを添えます。',
      '- 作品名・作者・作曲者・年代・所蔵先は、確かなものだけを書きます。著作権が続いている曲の歌詞・楽譜や作品は、引用・再現しません。',
    )
  }
  if (kind === 'academic') rules.push('- 専門学科（理数科・英語科など）の科目です。各学科に共通する科目より一歩ふみこんだ内容を扱いますが、この科目の範囲（「科目の範囲」に書かれた内容）をこえて、大学の内容に進みません。')
  if (course.practice) {
    rules.push(
      '- この科目は、学校では実習や課題研究として行う科目です。実習そのものは、このアプリでは行えません。掘り下げで足すのは、取り組む前に知っておくこと、計画の立て方、進め方、記録とふり返りのしかた、安全と倫理の説明と、具体的な（架空の）事例です。',
      '- 確かめ問題は、計画を立てる・記録を書く・事例から考える、といった、読んだ人がひとりでできる形にします。分量は、ほかの科目より短くてかまいません。',
    )
  }
  return `

# 専門教科の授業として書きます（${course.subjectLabel}「${course.label}」）
${rules.join('\n')}`
}
/** 専門教科を評価するときに、足して見ること */
const hspEvalRule = (course) =>
  !hspKind(course)
    ? ''
    : `

# 専門教科として見ること
- 法律・制度・規格・基準値・資格や検定の内容・統計は、いまの内容（改正のあと）に合っているかを、資料で確かめます。古い内容や誤った数値は real_errors に入れます（確かめられたときだけ sure を true にします）。
- けがや事故、健康の被害につながる作業（機械、電気、薬品、農薬、火、刃物、人の体に触れる介助、医療的ケア、けがにつながる運動など）について、読んだ人がひとりで試せるほど手順・分量・濃度・設定値が細かく書かれている箇所や、「これだけで仕事ができる」「資格がとれる」と受け取れる箇所があれば、over_scope に書きます。安全に関わる誤り（危険を小さく見せる説明、誤った防ぎ方）は real_errors に入れます。
- additions（足すとよいもの）には、危険な作業の手順を入れません。しくみ、理由、危険と防ぎ方、事例から考える問い、を挙げます。${course.practice ? '\n- この科目は、学校では実習や課題研究として行う科目です。計画の立て方・進め方・記録とふり返り・安全と倫理を、読んで学べるかを見ます。実習そのものの手順が書かれていないことは、欠点にしません。' : ''}`
/** 小学校では、言葉づかい（漢字・言葉・文の長さ）も学校段階のうち。掘り下げと直しの指示に足す */
const esRule = (course) =>
  course.school !== 'es'
    ? ''
    : course.deep
      ? `

# 学び直し版として書きます（小学校 ${course.label} ${course.subjectLabel}の内容）
- この本文は、小学校の内容を、中学生以上の人が学び直すための版です。扱う内容の範囲は、小学校のこの学年・この科目のままにします。中学校より上で習う内容は、「この先どうつながるか」を短く紹介するだけにし、それを前提にした説明・例題・確かめ問題は作りません。
- 小学生向けのやさしい言いかえをくり返すのではなく、「なぜそうなるのか」という理由、つまずきやすいところとその直し方、中学校以降の学習へのつながりを、ていねいに書きます。
- 漢字や用語は、中学生がふつうに読めるものを使います。小学生向けの、ひらがなの多い書き方や分かち書きにはしません。言葉づかいは、いまの本文にそろえます。`
      : `

# 小学生の言葉で書きます（${course.label}）
- 漢字とひらがなの使い分け、言葉のやさしさ、文の短さは、いまの本文にそろえます。いまの本文がひらがなで書いている言葉を、漢字に変えません。
- 新しく使う漢字は、${gradeOf(course)} 年生までに習う漢字（学年別漢字配当表）だけにします。まだ習わない漢字の言葉は、ひらがなで書くか、やさしい言葉に言いかえます。地名・人名などの名前や、教科書がその学年で使う大事な用語を、どうしても漢字で書くときは、はじめに出るところで「庄内平野（しょうないへいや）」のように（ ）で読みを添えます。
- 分量を増やすために、文を長くしたり、むずかしい言葉を足したりしません。短い文を、順番に重ねます。「なぜ」の説明は、具体的なもの（おはじき、時計、身のまわりの出来事など）を使って書きます。
- おとな向けの言い方（「〜と考えられます」「〜に注目すると」「〜を踏まえて」など）を使いません。${bandOf(course) === 'lower' ? '1・2 年生が声に出して読める文にします。\n- 1・2 年生向けなので、本文は、言葉のまとまり（文節）ごとに 1 字あけて書きます（分かち書き。例:「おはじきが 7こ あります。」「左の おさらに 1こ 入れます。」）。箇条書き・表の中の文・例題・確かめ問題・答えも同じです。いまある見出しの文言は、そのままにします。' : ''}${moralRule(course)}`
/** 道徳（特別の教科）は、答えを教えこまない。掘り下げと直しの指示に足す */
const moralRule = (course) =>
  course.subject !== 'moral'
    ? ''
    : `

# 道徳の授業として書きます
- 答えが 1 つに決まらない問いを、1 つの正解があるようには書きません。「答え」の節では、はじめに「考え方の例です。ほかの考えでもかまいません」と書き、2 つ以上の見方を示します。
- お話に書かれていない登場人物の気持ちや事情を、言い切りません（「〜かもしれません」と書きます）。
- いまの本文にある問いと「考えるヒント」は、順番も中身も残します。ヒントを、答えに置きかえません。いまの本文が挙げている考えや選択肢を、消しません。
- 掘り下げで足すのは、気持ちや立場を考える手がかり、身近な場面とのつながり、自分のこととして考える問いです。「〜することが大切です」のような教えこむ説明を、くり返して足しません。
- ほかの教科より短くてかまいません。分量のために、お話を長く書きかえません。`
/** 学校段階を物差しにする、という決まり（評価・掘り下げ・読み直しで共通） */
const stageRule = (course) => `# 学校段階を物差しにします
- 物差しは、${GUIDE[course.school]}の「${course.subjectLabel}」と、その検定教科書がふつうに扱う内容・言葉・厳密さです。${course.deep ? 'この本文は学び直し版なので、内容の範囲は小学校のまま、言葉づかいと説明の深さは、中学生以上の読み手に合わせます。' : ''}大学以上の厳密さや、専門家向けの正確さを物差しにしません。
- その学年の生徒がまだ習っていない用語・記号・公式・考え方を前提にしません。この科目でここまでに学んだ内容と、前の学年までに学ぶ内容だけを前提にします。
- 検定教科書でも同じように書く簡略化（条件を省いた言い方、モデルとしての説明、近似の値など）は、誤りではありません。その段階の教え方として正しいものです。`

function context(key) {
  const course = courseOf(key)
  const [u, l] = numbers(key)
  const units = curriculumOf(course).units
  const unit = units[u - 1]
  const lesson = unit.lessons[l - 1]
  const before = unit.lessons.slice(0, l - 1).map((x, i) => `- ${u}-${i + 1} ${x.title}: ${x.summary}`).join('\n')
  const after = unit.lessons.slice(l).map((x, i) => `- ${u}-${l + i + 1} ${x.title}`).join('\n')
  const earlier = units.slice(0, u - 1).map((x) => x.title).join('、')
  const body = readLesson(key)
  const chars = plainLength(body)
  // 分量のねらい: いまの 1.7 倍（学校ごとの下限と上限の中で）。もともと長い授業は、1.2 倍まで
  // 小学校は、ひとりで読める長さにおさえる（1・2 年は 1.5 倍、3・4 年は 1.6 倍。下限と上限も学年のまとまりごと）
  const [floor, ceil, factor] =
    // 学び直し版（中学生以上が読む）は、中学校と同じねらい
    course.school === 'jhs' || course.deep || (course.school === 'hsp' && !course.practice && hspKind(course) !== 'academic')
      ? [2800, 5500, 1.7]
      : course.school === 'hs' || (course.school === 'hsp' && !course.practice)
        ? [3400, 7000, 1.7]
        : course.school === 'es'
          ? { lower: [1500, 2400, 1.5], middle: [2100, 3400, 1.6], upper: [2300, 3800, 1.7] }[bandOf(course)]
          : // 専門教科の、実習・課題研究の科目（短くてよい）
            [1800, 3600, 1.4]
  const target = Math.round(Math.max(Math.min(Math.max(chars * factor, floor), ceil), chars * 1.2) / 100) * 100
  const about = `科目: ${SCHOOL[course.school]} ${course.subjectLabel} ${course.label}${course.deep ? '（学び直し版: 小学校の内容を、中学生以上の人が学び直すための本文）' : ''}
科目の範囲: ${course.scope ?? ''}
単元: ${unit.title}${unit.domain ? `（${unit.domain}）` : ''}
授業: ${u}-${l} ${lesson.title}
この授業で扱う内容: ${lesson.summary}

# この科目でここまでに学んだ単元
${earlier || '（最初の単元です）'}

# この単元でここまでに学んだこと
${before || '（この単元の最初の授業です）'}

# この後の授業で扱うこと（今回は踏みこみません）
${after || '（この単元の最後の授業です）'}`
  return { key, course, body, chars, target, about, src: hash(body) }
}

const evalSystem = (c) => `あなたは、日本の学校教育にくわしい、${SCHOOL[c.course.school]}の検定教科書の編集者です。学習アプリの 1 回ぶんの授業の本文を読み、内容を評価します。本文は AI が書いたもので、人の確認を経ていません。コマンドの実行やファイルの操作はしません。

# 読み手
${readerOf(c.course)}

${stageRule(c.course)}${hspEvalRule(c.course)}

# 評価すること
1. 正確さ（accuracy）: 事実・年代・人名・用語の定義・公式・単位・計算・答えの誤り。例題と確かめ問題は、すべて自分で解き直して確かめます。図（figure の SVG、plot、numberline）や掛け合い（talk）が、本文と食いちがっていないかも見ます。
2. 範囲（coverage）: 「この授業で扱う内容」を説明できているか。抜けている要点はないか。学習指導要領の範囲から外れていないか。
3. 深さ（depth）: 「なぜそうなるのか」の説明、つまずきやすい点、ほかの内容とのつながりが足りているか。結論だけになっている説明はないか。
4. 分かりやすさ（clarity）: 読み手の学年に合った言葉か。説明の順番、例の具体性。${c.course.school === 'es' && !c.course.deep ? '小学校では、漢字・言葉のむずかしさ・文の長さが、その学年に合っているかも見ます（合っていない箇所は、minor の wording に書きます）。' : ''}
5. 練習（exercises）: 例題と確かめ問題の数、むずかしさの幅、答えの解説が足りているか。

# 見つけた点は、2 つに分けます
- real_errors（本物の誤り）: その学校段階の検定教科書に照らしても誤りであるもの。生徒がそのまま覚えると、学校のテストや入試で誤答になるもの、あとの学習で覚え直さなければならないもの。事実・年代・人名、用語の定義、公式、単位、計算、例題や確かめ問題の答え、解けない問題・答えが 1 つに決まらない問題、本文と図の食いちがい、がこれに当たります。
- minor（軽微な点）: 誤りとまでは言えないもの。kind で種類を示します。
  - simplification: 検定教科書でも同じように書く、学校段階としてふつうの簡略化。直す必要はありません（気づいたものを記録するだけ）。
  - precision: その学年の言葉のままで、少し言い足すと誤解を防げるもの。
  - wording: 言い回し・用語のゆれ・読みにくさ。
  - other: そのほか。
- 迷ったら「その学年の検定教科書に、同じ書き方が載っていておかしくないか」で決めます。載っていておかしくなければ、real_errors には入れません。

# 返すもの
- scores: 5 つの観点を、1〜5 の整数で（5 がもっとも良い）。accuracy は real_errors だけで決めます（minor では下げません）。
- real_errors: where は本文の該当箇所をそのまま写し、what に何が誤りか、fix に正しい内容（その学年の言葉で）、sure は確信があれば true（自分では確かめきれない疑いは false）。無ければ空の配列。
- minor: where、what、kind、fix（直すなら、その学年の言葉でどう書くか。直さなくてよければ空の文字列）。無ければ空の配列。
- over_scope: 学習指導要領のこの科目・この学年の範囲をこえている内容が本文にあれば、その箇所と理由。無ければ空の配列。
- thin: 説明がうすい・結論だけになっている箇所と、そこに何を書き足すとよいか（具体的に。その学年で分かる内容で）。
- additions: この授業を掘り下げるなら足すとよいもの（例題、よくあるまちがい、身近な場面や入試とのつながりなど）を、優先度の高い順に。範囲をこえるものは入れません。
- summary: 全体の評価を 2〜3 文で。`

const errorItem = {
  type: 'object',
  properties: { where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' }, sure: { type: 'boolean' } },
  required: ['where', 'what', 'fix', 'sure'],
  additionalProperties: false,
}
const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: { accuracy: { type: 'integer' }, coverage: { type: 'integer' }, depth: { type: 'integer' }, clarity: { type: 'integer' }, exercises: { type: 'integer' } },
      required: ['accuracy', 'coverage', 'depth', 'clarity', 'exercises'],
      additionalProperties: false,
    },
    real_errors: { type: 'array', items: errorItem },
    minor: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' }, kind: { type: 'string', enum: ['simplification', 'precision', 'wording', 'other'] }, fix: { type: 'string' } },
        required: ['where', 'what', 'kind', 'fix'],
        additionalProperties: false,
      },
    },
    over_scope: { type: 'array', items: { type: 'string' } },
    thin: { type: 'array', items: { type: 'string' } },
    additions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['scores', 'real_errors', 'minor', 'over_scope', 'thin', 'additions', 'summary'],
  additionalProperties: false,
}

/** 構成と書式の決まり（掘り下げと、直しで共通） */
const FORMAT = `# 構成と書式（アプリの決まり）
- 説明の文（地の文）を敬語（です・ます調）で書きます。問題文は「〜しましょう」「〜を求めましょう」の形にします。ただし、かぎかっこ「 」の中の文（お話の登場人物のせりふ、心の中の言葉、例として示す文や意見、引用）と、国語・英語の例文は、いまの本文の言い方（くだけた話し言葉、「〜だ・である」の形）のまま残します。せりふや例文を、です・ます調に直しません。
- 見出しの順番は、「# 題」→「## この授業のねらい」→ 本文（「## 」の見出し）→ 例題の節 →（あれば「## 発展」）→ 確かめ問題の節と「### 答え」→ ノートの節、です。いまある見出しの文言は変えません。本文の「## 」の見出しは足してかまいません。
- Markdown で書きます。HTML は使いません。表は Markdown の表でかきます。数式は $…$（文の中）と $$…$$（独立した式）で書きます。
- いまの本文にあるコードブロックのうち、\`\`\`sim・\`\`\`picture は、中身を 1 文字も変えずに、同じ順番で（同じ節の中に）残します。\`\`\`figure・\`\`\`plot・\`\`\`numberline も残し、誤りがあるときだけ直します。
- \`\`\`talk（先生と同級生の掛け合い）も、同じ数・同じ順番で残します。中身は、本物の誤り（生徒がまちがったまま覚えてしまうせりふ）を直すときだけ変えてよく、それ以外は 1 文字も変えません。直すときは、1 行を「話し手(表情): せりふ」の形のままにし、話し手と表情は、その掛け合いに出てくるものだけを使います（まちがった考えを言った生徒のあとに、先生が正しく言い直す行を足す、という直し方がよい）。
- 図を足すときは、次の 3 種類だけを使います。正確にかけないものは、図にせず言葉で説明します。
  - 数直線: \`\`\`numberline に JSON。例 {"min": -5, "max": 5, "points": [{"at": -3, "label": "A"}], "arrows": [{"from": 0, "to": 3, "label": "+3"}]}
  - 関数のグラフや座標: \`\`\`plot に JSON。例 {"xMin": -5, "xMax": 5, "yMin": -5, "yMax": 5, "functions": [{"expr": "2*x+1", "label": "y=2x+1"}], "points": [{"x": 1, "y": 3, "label": "A"}]}。式は x だけを変数にし、+ - * / ^ とかっこ、sqrt、abs、sin、cos、tan、log、exp が使えます（不等号や条件式は使えません）。
  - そのほかの図: \`\`\`figure に SVG。<svg viewBox="0 0 400 300"> から始め、line、rect、circle、ellipse、polygon、polyline、path、text だけを使います。style 属性と class は使えません。線は stroke="#2c2a35"、文字は font-size="14" 程度にします。
- 本文には、出典のリンク・URL・参照した資料の名前を入れません（読むのは生徒です）。「評価では」「元の本文では」のような、書き直しの作業についての文も入れません。`

const RETURNS = `# 返すもの
- lesson: 書き直した本文の Markdown の全文（前置きや後書きは入れません）。
- changes: 何を足し、何を直したかを、短い箇条書きで（5〜10 個）。本物の誤りを直したものは、先頭に「誤りの修正: 」と付けます。
- sources: 事実を確かめるのに使った資料（題と URL）。無ければ空の配列。
- notes: 人に確かめてほしい点（残したブロックの問題、確かめきれなかった事実、当たっていないと判断して直さなかった指摘とその理由）。無ければ空の配列。`

const expandSystem = (c) => `あなたは、日本の${SCHOOL[c.course.school]}の検定教科書を書く、経験豊かな著者です。学習アプリの 1 回ぶんの授業の本文を、評価の結果をふまえて、内容を掘り下げ、分量を増やした版に書き直します。コマンドの実行やファイルの操作はしません。

# 読み手
${readerOf(c.course)}

${stageRule(c.course)}${esRule(c.course)}${c.course.school === 'es' ? '' : moralRule(c.course)}${hspRule(c.course)}

# 書き直しの方針（上から順に優先します）
1. 本物の誤り（評価の real_errors）を、すべて直します。確信のない点（sure が false）は、自分で確かめられる範囲で直し、確かめられなければ断定を避ける書き方にします。
2. 軽微な点（評価の minor）は、kind が precision・wording・other のものを、その学年の生徒が分かる言葉で短く直せるときだけ直します。simplification（学校段階としてふつうの簡略化）は、そのままにします。厳密にするために、その学年で習わない用語・条件・例外を持ちこみません。
3. 掘り下げます。掘り下げるとは、扱う範囲を広げることではなく、同じ内容を「なぜそうなるのか」「どう考えるのか」「どこでつまずくのか」まで、ていねいに書くことです。増やすのは次のものです。
   - 「なぜそうなるのか」の説明、考え方の筋道、定義や導出（その学年で分かる範囲で）
   - つまずきやすい点・よくあるまちがいと、その直し方
   - 例題（段階を追った解き方つき）。いまの例題は残し、少しむずかしいものを足します
   - 確かめ問題（基本 → 応用の順。いまの問題は残して、合わせて ${bandOf(c.course) === 'lower' ? '5〜6' : '6〜8'} 問にします。答えには短い解説を付けます）
   - ほかの単元や教科、身近な場面${c.course.school === 'hs' ? '、大学入試での問われ方' : hspKind(c.course) === 'vocational' ? '、仕事の現場' : hspKind(c.course) === 'academic' ? '、大学入試や大学での学び' : ''}とのつながり
4. いまの本文は、図や掛け合いのブロックをのぞいて約 ${c.chars} 字です。これを ${c.target} 字前後にします。${Math.round((c.target * 1.25) / 100) * 100} 字をこえません。同じことのくり返しや前置きで水増しはしません。書くことが足りなければ、短くてかまいません。

# 学校段階をこえないために
- 学習指導要領のこの科目・この学年の範囲をこえる内容（評価の over_scope もふくみます）は、本文の流れには入れません。どうしても触れる価値があるときだけ、「## 発展」という節（確かめ問題の前）に短くまとめ、範囲をこえる内容だと分かるように書きます。確かめ問題には出しません。
- この後の授業で扱う内容には踏みこみません。
- 確信の持てない事実は書きません。既存の教科書・参考書・入試問題の文章や、現代の作品を引き写しません。
- 残したブロック（掛け合い・図解・挿絵とその説明文）に問題が残るときは、本文に断り書きや注記を足さず、notes に書きます。

${FORMAT}

${RETURNS}`

const fixSystem = (c) => `あなたは、日本の${SCHOOL[c.course.school]}の検定教科書を書く、経験豊かな著者です。学習アプリの授業の本文（掘り下げて書き直した版）に、校閲で問題が見つかりました。指摘を確かめて、本文を直します。コマンドの実行やファイルの操作はしません。

# 読み手
${readerOf(c.course)}

${stageRule(c.course)}${esRule(c.course)}${c.course.school === 'es' ? '' : moralRule(c.course)}${hspRule(c.course)}

# 直し方
- 指摘を 1 つずつ、自分で確かめます（計算は解き直し、事実は調べます）。当たっている指摘は、本文を直します。当たっていない指摘は直さず、notes に「どの指摘が、なぜ当たっていないか」を書きます。
- 指摘されていない箇所は、変えません（直した箇所とつじつまを合わせるための変更は、かまいません）。分量を増やしません。「長すぎる」という指摘のときは、くり返しと、範囲をこえる内容から削ります。
- 「学校段階をこえる」という指摘は、その内容を削るか、その学年の言葉に言いかえるか、「## 発展」の節に移します。

${FORMAT}

${RETURNS}`

const EXPAND_SCHEMA = {
  type: 'object',
  properties: { lesson: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } } },
  required: ['lesson', 'changes', 'sources', 'notes'],
  additionalProperties: false,
}

const reviewSystem = (school, band = '') => `あなたは、日本の学校教育にくわしい、${SCHOOL[school]}の検定教科書の校閲者です。学習アプリの授業の本文を、別の AI が「掘り下げて分量を増やした版」に書き直しました。書き直した版を、元の授業と見くらべて読み、元の授業と置きかえてよいかを判断します。

# 読み手
${band === 'deep' ? DEEP_READER : school === 'es' ? `小学校 ${ES_BAND[band]}生の本人が、ひとりで読みます。${ES_READER[band]}` : READER[school]}

# 学校段階を物差しにします
- 物差しは、${GUIDE[school]}のその科目と、その検定教科書がふつうに扱う内容・言葉・厳密さです。大学以上の厳密さを物差しにしません。
- 検定教科書でも同じように書く簡略化（条件を省いた言い方、モデルとしての説明、近似の値など）は、誤りではありません。指摘しません。${
  band === 'deep'
    ? '\n- この本文は「学び直し版」です。小学校の内容を、中学生以上の人が学び直すためのもので、内容の範囲は小学校のまま、言葉づかいは中学生以上に合わせてあります。中学生がふつうに読める漢字や用語が使われていることは、問題にしません。中学校より上で習う内容が、説明の前提・例題・確かめ問題として使われていれば、beyond として指摘します（「この先こうつながる」という短い紹介は、問題ではありません）。'
    : school === 'es'
    ? '\n- 小学校では、言葉づかいも学校段階のうちです。その学年でまだ習わない漢字やむずかしい言葉、長い文、おとな向けの言い回しが、元の授業より目立って増えているときは、beyond として指摘します（地名・人名や大事な用語に（ ）で読みが添えてある程度なら、指摘しません）。'
    : ''
}${
  school === 'hsp'
    ? `

# 専門教科として見ること
- 職業に関する科目（農業・工業・商業・水産・家庭・看護・情報・福祉）と、実技が中心の科目（体育・音楽・美術）では、けがや事故、健康の被害につながる作業（機械、電気、薬品、農薬、火、刃物、重機、船、人の体に触れる介助、医療的ケア、けがにつながる運動、薬品や窯を使う制作など）について、手順・分量・濃度・設定値・操作の順番が、元の授業より細かく書き足されていないかを見ます。読んだ人がひとりで試せるほど細かく足されていれば、beyond として指摘します（しくみ、危険と防ぎ方、理由の説明が増えているのは、問題ではありません）。
- 「これだけで仕事ができる」「資格がとれる」と受け取れる書き方が足されていれば、beyond として指摘します。元の授業にあった「学校や職場で、指導者のもとで行う」という文が消えていれば、missing として指摘します。
- 法律・制度・規格・基準値・資格や検定の内容は、改正されていることがあります。著者が資料で確かめて直した点は、下の決まりのとおり、自分の覚えている内容のほうが古くないかをうたがいます。
- 実習・課題研究の科目は、計画・記録・ふり返り・安全を読んで学ぶ授業です。ほかの科目より短いことや、実習の手順が書かれていないことは、問題にしません。`
    : ''
}

# 元の授業にも、誤りがあります
- 書き直した版は、別の AI（著者）が資料で確かめて、元の授業の誤りを直しています。直した点とその根拠は、「元の授業の誤りとして、著者が直した点」に示します。
- 書き直した版が元の授業とちがう、というだけでは誤りにしません。元の授業とちがう事実・数値・規則・用語・分類を error にするのは、書き直した版のほうが誤りだと、自分で確かめて確信できるときだけです。
- 競技の規則、法律や制度、統計の数字、用語の定義や分類は、改められていることがあります。自分の覚えている内容のほうが古くないかを、一度うたがいます。著者が根拠の資料を示している直しは、その資料より確かな根拠が自分にあるときだけ、誤りとします。
- 確信が持てないときは、heavy にせず、light に「要確認: 」と付けて書きます。

# 重い問題（heavy）: 置きかえを止めるもの
- error（本物の誤り）: 事実・年代・人名・用語の定義・公式・単位・計算の誤り。例題と確かめ問題は、すべて自分で解き直し、答えと解説が合っているかを確かめます。解けない問題、答えが 1 つに決まらない問題、本文と図（figure・plot・numberline）の食いちがいも、これに入ります。
- beyond（学校段階をこえる）: その学年・その科目でまだ習わない用語・記号・公式・考え方が、「## 発展」の節の外で、説明の前提や確かめ問題として使われている。
- missing（欠落）: 元の授業にあった大事な内容・例題・確かめ問題が、理由なく消えている。
- format（壊れた書式）: 見出しの順番のくずれ、読めない数式、本文に混ざった URL・出典・作業のメモ（「評価では」「元の本文では」のように、読み手に関係のない文）。
- 先生と同級生の掛け合い（\`\`\`talk）は、誤りを直すためにせりふが書きかえられていることがあります。書きかえは問題ではありません。掛け合いの中に、生徒がまちがったまま覚えてしまうせりふが残っていれば error です（生徒役がまちがえて、先生がすぐ正す流れは、誤りではありません）。
- 道徳の授業では、答えが 1 つに決まらない問いに 1 つの正解だけを示していないか、元の授業にあった問い・考えるヒント・考えの選択肢が消えていないかを見ます。当てはまれば、format（正解を 1 つに決めている）または missing（消えている）として指摘します。
- 確信のあるものだけを heavy にします。計算は、自分の検算が合っているかを、もう一度確かめてから書きます。確信のない疑いは light に「要確認: 」と付けて書きます。

# 軽い点（light）: 記録するだけのもの
- 言い回し、細かすぎて読み手に重い記述、もう少し説明があるとよい箇所、長すぎる節、など。多くても 5 個までにします。

# 返すもの
- scores: 書き直した版を 1〜5 の整数で（5 がもっとも良い）。accuracy（正確さ）、level（その学年の生徒に合っているか。むずかしすぎれば低く）、depth（「なぜ」の説明やつまずきへの手当ての深さ）、clarity（分かりやすさ）、exercises（例題と確かめ問題）。
- heavy: kind（error・beyond・missing・format）、where（書き直した版の該当箇所をそのまま写す）、what（何が問題か）、fix（どう直すか。その学年の言葉で）。無ければ空の配列。
- light: where と what。無ければ空の配列。
- summary: 全体の評価を 1〜2 文で。`

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: { accuracy: { type: 'integer' }, level: { type: 'integer' }, depth: { type: 'integer' }, clarity: { type: 'integer' }, exercises: { type: 'integer' } },
      required: ['accuracy', 'level', 'depth', 'clarity', 'exercises'],
    },
    heavy: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['error', 'beyond', 'missing', 'format'] }, where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' } },
        required: ['kind', 'where', 'what', 'fix'],
      },
    },
    light: { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, what: { type: 'string' } }, required: ['where', 'what'] } },
    summary: { type: 'string' },
  },
  required: ['scores', 'heavy', 'light', 'summary'],
}

// ───────── codex の呼び出しと、使用量の見はり ─────────

function codex({ input, schemaFile, ephemeral = true, callEffort = effort, timeoutMs = 25 * 60_000, viaApi = false }) {
  return new Promise((done, fail) => {
    const cli = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '-C', workDir, '-m', model, '-c', `model_reasoning_effort=${callEffort}`]
    if (ephemeral) cli.push('--ephemeral')
    if (schemaFile) cli.push('--output-schema', schemaFile)
    cli.push('-')
    const started = Date.now()
    // ふだんは、ChatGPT のプラン（保存してあるログイン）で動かす。API で動かすときだけ、この 1 回の呼び出しに鍵を渡す
    const env = { ...process.env }
    delete env.CODEX_API_KEY
    if (viaApi) env.CODEX_API_KEY = process.env.OPENAI_API_KEY
    const child = spawn('codex', cli, { cwd: workDir, windowsHide: true, env })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    let buffer = ''
    let stderr = ''
    let message = ''
    let failure = ''
    let usage = null
    let thread = ''
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
        if (event.type === 'thread.started') thread = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
        if (event.type === 'turn.completed') usage = event.usage
        if (event.type === 'error' || event.type === 'turn.failed') failure = event.message ?? event.error?.message ?? failure
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(new Error(`codex を起動できませんでした: ${error.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1000)
      if (message && usage) done({ message, usage, seconds, thread })
      else fail(new Error(failure || `codex から返事がありませんでした（コード ${code}、${seconds} 秒）${stderr.trim().slice(-300)}`))
    })
    child.stdin.end(input, 'utf8')
  })
}

/** 週の使用割合を読む: 短い問いを 1 回送り（記録を残す）、その記録に書かれた割合を読んで、記録を消す */
async function codexUsage() {
  const answer = await codex({ input: '「はい」とだけ答えてください。', ephemeral: false, callEffort: 'low', timeoutMs: 3 * 60_000 })
  let limits = null
  const now = new Date()
  for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
    const dir = join(homedir(), '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    const found = existsSync(dir) && readdirSync(dir).find((f) => f.includes(answer.thread))
    if (!found) continue
    const match = [...readFileSync(join(dir, found), 'utf8').matchAll(/"rate_limits":(\{.*?"rate_limit_reached_type":[^}]*\})/g)].pop()
    try {
      if (match) limits = JSON.parse(match[1])
    } catch {}
    break
  }
  if (answer.thread) spawnSync('codex', ['delete', '--force', answer.thread], { windowsHide: true })
  return limits
}

const guard = { calls: 0, percent: null, resetsAt: 0, paused: false, limit: false, until: 0, why: '', probing: false, probedAt: 0, lastProbeCalls: 0, base: null }

// API（従量の料金）での続き。料金は 100 万トークンあたりの米ドル（入力・キャッシュから読んだ入力・出力。src/web/ai/providers.ts と同じ値）
const API_PRICES = { 'gpt-6.2-sol': [2, 0.1, 10], 'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6.2-astra': [8, 0.4, 40] }
/** ウェブ検索の料金などを見こんで、多めに数える（実際の請求額は、この道具からは読めない。予算をこえないよう、大きめに取る） */
const API_MARGIN = 1.4
/** 1 回の呼び出しの目安（評価 約 0.15、掘り下げ 約 0.2 ドル）。進めている途中の分を、予算から取っておくのに使う */
const API_RESERVE = 0.4
const apiFile = join(outDir, 'api-usage.json')
const api = { spent: 0, calls: 0, ...readJson(apiFile, {}), flying: 0, blocked: '', announced: false }
function apiCost(usage) {
  const price = API_PRICES[model] ?? API_PRICES['gpt-6.2-astra']
  const cached = Number(usage?.cached_input_tokens) || 0
  const input = Math.max(0, (Number(usage?.input_tokens) || 0) - cached)
  return ((input * price[0] + cached * price[1] + (Number(usage?.output_tokens) || 0) * price[2]) / 1_000_000) * API_MARGIN
}
/** API で 1 回呼んでよいか（予算が決めてあり、鍵があり、進めている途中の分をふくめても予算に収まる） */
const apiReady = () => control.apiBudget > 0 && !!process.env.OPENAI_API_KEY && !api.blocked && api.spent + (api.flying + 1) * API_RESERVE <= control.apiBudget
/** 1 回の呼び出しで進む、週の枠の割合（ポイント）。この実行で十分に測れていれば実測、まだなら目安（Pro Lite で約 0.025） */
function perCall() {
  const b = guard.base
  if (b && guard.percent != null && guard.calls - b.calls >= 150 && guard.percent - b.percent >= 2) return Math.min(0.06, Math.max(0.002, (guard.percent - b.percent) / (guard.calls - b.calls)))
  return 0.025
}
/** 上限に近づいたら、こまめに確かめる */
const probeEvery = () => (guard.percent != null && guard.percent >= control.codexWeek - 5 ? Math.min(10, PROBE_EVERY) : PROBE_EVERY)
/** 見はりの合間に進む分と、止めたときに進めている途中の分を見こんだ、休みに入る割合 */
// 100% まで使ってよいときは、手前で止めない（上限に届いたという知らせが返るまで、プランで進める。そのあと、API に切りかえるか、回復を待つ）
const codexStopAt = () => (control.codexWeek >= 100 ? 100 : control.codexWeek - Math.ceil(perCall() * (probeEvery() + control.concurrency)))
async function probeCodex() {
  if (guard.probing) return
  guard.probing = true
  try {
    const limits = await codexUsage()
    guard.probedAt = Date.now()
    const windows = [limits?.primary, limits?.secondary].filter(Boolean)
    const worst = windows.sort((a, b) => b.used_percent - a.used_percent)[0]
    if (!worst) return
    const weekly = windows.find((w) => w.window_minutes >= 10000) ?? worst
    // 枠がもどされた（割合が下がった）ときは、測り直す
    if (!guard.base || weekly.used_percent < guard.base.percent) guard.base = { percent: weekly.used_percent, calls: guard.calls }
    guard.percent = weekly.used_percent
    guard.resetsAt = weekly.resets_at * 1000
    if (worst.used_percent >= codexStopAt()) pauseCodex(worst.resets_at * 1000, `codex の使用割合が ${worst.used_percent}%（${worst.window_minutes >= 10000 ? '週' : `${Math.round(worst.window_minutes / 60)} 時間`}の枠）`, 60, true)
    else if (guard.paused) {
      guard.paused = false
      log(`codex が回復したので、続けます（週 ${guard.percent}%）`)
    }
  } catch (error) {
    // 短い問いも通らないときは、上限に達しているとみて休む
    pauseCodex(0, `codex を呼べない（${String(error.message).slice(0, 80)}）`, 30)
  } finally {
    guard.probing = false
  }
}
function pauseCodex(resetAt, why, minutes = 60, limit = false) {
  guard.limit = limit
  const now = Date.now()
  const probe = now + minutes * 60_000
  guard.until = resetAt > now ? Math.min(resetAt + 120_000, probe) : probe
  if (!guard.paused) log(`${why}なので、codex を休みます（${new Date(guard.until).toLocaleString('ja-JP')} にもう一度確かめます。回復の時刻は ${resetAt ? new Date(resetAt).toLocaleString('ja-JP') : '不明'}）`)
  guard.paused = true
  guard.why = why
}
/** codex を 1 回呼んでよくなるまで待つ。返すのは、API で呼ぶかどうか（プランの週の上限で休んでいて、API の予算が残っているとき） */
async function codexEnter() {
  for (;;) {
    if (!guard.paused) return false
    if (guard.limit && apiReady()) {
      // API で進めているあいだも、プランが回復したかは確かめる
      if (Date.now() >= guard.until) void probeCodex()
      return true
    }
    if (Date.now() >= guard.until) await probeCodex()
    else await sleep(Math.min(guard.until - Date.now(), 30_000))
  }
}
async function askCodex(key, stage, input, schemaFile) {
  const viaApi = await codexEnter()
  if (!viaApi) {
    try {
      const answer = await codex({ input, schemaFile })
      appendFileSync(join(outDir, 'metrics.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), key, stage, seconds: answer.seconds, usage: answer.usage, n: working.codex })}\n`, 'utf8')
      guard.calls += 1
      if (guard.calls - guard.lastProbeCalls >= probeEvery()) {
        guard.lastProbeCalls = guard.calls
        void probeCodex()
      }
      return answer
    } catch (error) {
      if (/limit|quota|429|rate|usage/i.test(String(error.message))) pauseCodex(0, `codex が上限に達した（${String(error.message).slice(0, 80)}）`, 30, true)
      throw error
    }
  }
  // API（従量の料金）で呼ぶ
  if (!api.announced) {
    api.announced = true
    log(`codex のプランが上限なので、API に切りかえて続けます（使ってよい金額 ${control.apiBudget} ドル、これまでに ${api.spent.toFixed(2)} ドル）`)
  }
  api.flying += 1
  try {
    const answer = await codex({ input, schemaFile, viaApi: true })
    const cost = apiCost(answer.usage)
    api.spent += cost
    api.calls += 1
    writeJson(apiFile, { spent: +api.spent.toFixed(4), calls: api.calls, at: new Date().toISOString() })
    appendFileSync(join(outDir, 'metrics.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), key, stage, seconds: answer.seconds, usage: answer.usage, n: working.codex, api: true, cost: +cost.toFixed(4) })}\n`, 'utf8')
    if (!apiReady()) log(`API の予算（${control.apiBudget} ドル）を使い切るので、API での続きを止めます（これまでに ${api.spent.toFixed(2)} ドル）`)
    return answer
  } catch (error) {
    // 鍵・残高・権限の問題は、くり返しても通らないので、この実行では API を使わない
    if (/insufficient_quota|billing|credit|401|403|invalid.api.key|incorrect api key|exceeded your current quota/i.test(String(error.message))) {
      api.blocked = String(error.message).slice(0, 120)
      log(`API を使えません（${api.blocked}）。API での続きを止めて、プランの回復を待ちます`)
    }
    throw error
  } finally {
    api.flying -= 1
  }
}
const parse = (text) => JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, ''))

// ───────── claude（読み直し） ─────────

// claude の週の上限は、2026-11-20 に 98% まで使ってよいことになった（それまでは 86%）
const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log, onPause: () => stateDirty && saveState() })
const reviewSystemFile = (school, band = '') => {
  const path = join(tempDir, `deepen-review-${school}${band ? `-${band}` : ''}.md`)
  writeFileSync(path, reviewSystem(school, band), 'utf8')
  return path
}
const reviewFiles = Object.fromEntries([...['jhs', 'hs', 'hsp'].map((s) => [s, reviewSystemFile(s)]), ...Object.keys(ES_BAND).map((band) => [`es-${band}`, reviewSystemFile('es', band)]), ['es-deep', reviewSystemFile('es', 'deep')]])

// ───────── 機械の検査 ─────────

/** 漢字 → 習う学年（1〜6。中学校以降は 8 以上）。同梱の漢字のデータ（resources/kanji）から読む */
let kanjiGrades = null
function kanjiGrade(char) {
  kanjiGrades ??= Object.fromEntries(Object.entries(JSON.parse(gunzipSync(readFileSync(join(root, 'resources', 'kanji', 'kanji.json.gz'))).toString('utf8')).kanji).map(([ch, raw]) => [ch, raw.g || 99]))
  return kanjiGrades[char] ?? 99
}
/** 本文に出てくる漢字（挿絵・動く図解・図のブロックの中は見ない） */
const kanjiIn = (text) => new Set(text.replace(/```(?:sim|picture|figure|plot|numberline)[\s\S]*?```/g, '').match(/[\u4e00-\u9fff]/g) ?? [])
/** 小学校: その学年でまだ習わない漢字のうち、元の授業に無く、（ ）の読みも添えていないもの */
function newHardKanji(course, original, draft) {
  const grade = gradeOf(course)
  const before = kanjiIn(original)
  const withReading = new Set((draft.match(/[\u4e00-\u9fff々]+（[\u3040-\u309fー・]+）/g) ?? []).join('').match(/[\u4e00-\u9fff]/g) ?? [])
  return [...kanjiIn(draft)].filter((ch) => !before.has(ch) && !withReading.has(ch) && kanjiGrade(ch) > grade)
}
const KANJI_LIMIT = { lower: 2, middle: 4, upper: 6 }

const blocksOf = (text, kinds = 'sim|picture') => [...text.replaceAll('\r\n', '\n').matchAll(new RegExp('```(' + kinds + ')[ \\t]*\\n[\\s\\S]*?```', 'g'))].map((m) => m[0].trim())
/** 掛け合いの話し手（「s03(joy): …」の s03）の集まり */
const speakers = (block) => new Set(block.split('\n').slice(1, -1).map((line) => line.match(/^\s*([^:：(（]+?)\s*(?:[(（][^)）]*[)）])?\s*[:：]/)?.[1]).filter(Boolean))
function gate(c, draft) {
  const problems = []
  for (const found of checkLesson(draft)) if (found.level === 'error') problems.push(found.message)
  const before = blocksOf(c.body)
  const after = blocksOf(draft)
  if (before.length !== after.length || before.some((block, i) => block !== after[i])) problems.push(`動く図解・挿絵のブロック（元は ${before.length} 個）が、元と同じ中身・同じ順番で残っていない。元の本文のブロックを、1 文字も変えずにもどす`)
  // 掛け合いは、誤りを直すためにせりふを変えてよい。数と、話し手の顔ぶれは元のまま
  const talksBefore = blocksOf(c.body, 'talk')
  const talksAfter = blocksOf(draft, 'talk')
  let talkChanged = 0
  if (talksBefore.length !== talksAfter.length) problems.push(`掛け合いのブロックの数が元とちがう（元は ${talksBefore.length} 個、いまは ${talksAfter.length} 個）。元の本文の掛け合いを、同じ数・同じ順番で残す`)
  else
    talksBefore.forEach((block, i) => {
      if (block === talksAfter[i]) return
      talkChanged += 1
      const known = speakers(block)
      const extra = [...speakers(talksAfter[i])].filter((v) => !known.has(v))
      if (extra.length) problems.push(`掛け合いに、元の掛け合いに出てこない話し手がいる: ${extra.join('、')}`)
    })
  const title = (text) => text.match(/^# (.+)$/m)?.[1]?.trim()
  if (title(c.body) !== title(draft)) problems.push(`題（1 行目の「# 」）が元とちがう。元は「${title(c.body)}」`)
  const prose = draft.replace(/```[\s\S]*?```/g, '')
  // 説明のための例のドメイン名（www.example.com など。例に使うために取ってある名前）は、出典の URL ではないので見のがす
  // 「.example」「.test」「.invalid」で終わる名前（www.hikari-shoten.example など）も、例に使うために取ってある名前（ウェブのしくみを教える授業で、本文に出てくる）
  const examples = /(?:https?:\/\/)?(?:(?:www\.)?example\.(?:com|org|net|jp|co\.jp)|(?:[\w-]+\.)+(?:example|test|invalid))\b(?:\/[\w./%#?=&-]*)?/g
  if (/https?:\/\/|www\./.test(prose.replace(examples, ''))) problems.push('本文に URL がある（出典は本文に入れない）')
  // 学び直し版は、中学生以上が読むので、学年の漢字の検査はしない
  if (c.course.school === 'es' && !c.course.deep) {
    const hard = newHardKanji(c.course, c.body, draft)
    if (hard.length > KANJI_LIMIT[bandOf(c.course)]) problems.push(`${gradeOf(c.course)} 年生までに習わない漢字が、新しく ${hard.length} 字使われている（${hard.join('')}）。ひらがなで書くか、やさしい言葉に言いかえる。名前や大事な用語を漢字で書くときは、はじめに出るところで（ ）に読みを添える`)
  }
  const length = plainLength(draft)
  if (length > c.target * 1.6) problems.push(`長すぎる（ブロックをのぞいて ${length} 字。${Math.round((c.target * 1.25) / 100) * 100} 字以内にする）`)
  if (length < c.chars * 1.2) problems.push(`分量がほとんど増えていない（${c.chars} 字 → ${length} 字）`)
  return { problems, length, talkChanged }
}

// ───────── 1 つの授業を進める ─────────

const schemaFiles = { eval: join(outDir, 'eval-schema.json'), expand: join(outDir, 'expand-schema.json') }
writeJson(schemaFiles.eval, EVAL_SCHEMA)
writeJson(schemaFiles.expand, EXPAND_SCHEMA)

const contexts = new Map()
const contextOf = (key) => {
  if (!contexts.has(key)) contexts.set(key, context(key))
  return contexts.get(key)
}

/** 掘り下げた版（または直した版）を受けとって、機械の検査にかける */
function acceptDraft(c, answer, stage) {
  const out = parse(answer.message)
  const draft = String(out.lesson).replaceAll('\r\n', '\n').trim() + '\n'
  writeFileSync(file.draft(c.key), draft, 'utf8')
  const record = readJson(file.changes(c.key), { rounds: [] })
  record.rounds.push({ at: Date.now(), stage, changes: out.changes ?? [], sources: out.sources ?? [], notes: out.notes ?? [] })
  writeJson(file.changes(c.key), record)
  const { problems, length, talkChanged } = gate(c, draft)
  const ratio = +(length / c.chars).toFixed(2)
  const fixes = state[c.key]?.fixes ?? 0
  if (!problems.length) touch(c.key, { stage: 'drafted', length, ratio, gate: [], talkChanged })
  else if (fixes < MAX_FIXES) touch(c.key, { stage: 'fix', length, ratio, gate: problems })
  else touch(c.key, { stage: 'held', length, ratio, gate: problems, why: `機械の検査を通らない: ${problems[0]}` })
  return { problems, length }
}

async function codexStep(key) {
  const c = contextOf(key)
  const stage = state[key]?.stage
  if (!stage) {
    const answer = await askCodex(key, 'eval', `${evalSystem(c)}\n\n────────\n\n次の授業を評価してください。\n\n${c.about}\n\n# 授業の本文\n\n${c.body}\n`, schemaFiles.eval)
    const evaluation = parse(answer.message)
    writeJson(file.eval(key), evaluation)
    touch(key, { stage: 'evaluated', src: c.src, chars: c.chars, fixes: 0 })
    log(`${key}: 評価 ${answer.seconds} 秒（本物の誤り ${evaluation.real_errors.length}、軽微 ${evaluation.minor.length}）`)
  } else if (stage === 'evaluated') {
    const evaluation = readFileSync(file.eval(key), 'utf8')
    const answer = await askCodex(key, 'expand', `${expandSystem(c)}\n\n────────\n\n次の授業を、掘り下げて分量を増やした版に書き直してください。\n\n${c.about}\n\n# 評価の結果（JSON）\n\n${evaluation}\n\n# いまの本文\n\n${c.body}\n`, schemaFiles.expand)
    const { problems, length } = acceptDraft(c, answer, 'expand')
    log(`${key}: 掘り下げ ${answer.seconds} 秒、${c.chars} → ${length} 字${problems.length ? `（機械の検査: ${problems[0]}）` : ''}`)
  } else if (stage === 'fix') {
    const review = readJson(file.review(key), null)
    const fromGate = state[key].gate ?? []
    const findings = fromGate.length
      ? fromGate.map((p, i) => `${i + 1}. （機械の検査）${p}`).join('\n')
      : (review?.heavy ?? []).map((h, i) => `${i + 1}. [${h.kind}] 箇所: ${h.where}\n   問題: ${h.what}\n   直し方の案: ${h.fix}`).join('\n')
    const draft = readFileSync(file.draft(key), 'utf8')
    const round = (state[key].fixes ?? 0) + 1
    const original = fromGate.some((p) => /ブロック|題/.test(p)) ? `\n\n# 元の本文（ブロックと題は、ここから写します）\n\n${c.body}` : ''
    const answer = await askCodex(key, 'fix', `${fixSystem(c)}\n\n────────\n\n次の授業の本文を、指摘に沿って直してください。\n\n${c.about}\n\n# 指摘\n\n${findings}\n\n# 直す本文\n\n${draft}${original}\n`, schemaFiles.expand)
    touch(key, { fixes: round })
    const { problems, length } = acceptDraft(c, answer, 'fix')
    log(`${key}: 直し ${round} 回め ${answer.seconds} 秒、${length} 字${problems.length ? `（機械の検査: ${problems[0]}）` : ''}`)
  }
}

async function reviewStep(key) {
  const c = contextOf(key)
  const draft = readFileSync(file.draft(key), 'utf8')
  const previous = readJson(file.review(key), null)
  const rounds = readJson(file.changes(key), { rounds: [] }).rounds
  const lastNotes = rounds.at(-1)?.stage === 'fix' ? rounds.at(-1).notes : []
  const earlier =
    previous?.heavy?.length && rounds.at(-1)?.stage === 'fix'
      ? `\n\n# 前回の校閲で指摘したことと、著者の返答\n前回の指摘は、この版で直されているはずです。直っているかを確かめてください。\n${previous.heavy.map((h, i) => `${i + 1}. [${h.kind}] ${h.where} — ${h.what}`).join('\n')}\n著者の返答（当たっていないと判断して直さなかった指摘とその理由。返答が正しければ、その指摘はくり返しません）:\n${lastNotes.length ? lastNotes.map((n) => `- ${n}`).join('\n') : '（なし）'}`
      : ''
  // 著者（codex）が、元の授業の誤りとして挙げた点（根拠の資料つき）。読み直し役が、正しい直しを「元の授業とちがう」という理由で誤りにしないようにする
  const errors = (readJson(file.eval(key), null)?.real_errors ?? []).filter((e) => e.sure !== false)
  const corrected = errors.length ? `\n\n# 元の授業の誤りとして、著者が直した点（根拠の資料つき）\n${errors.map((e, i) => `${i + 1}. 元の授業「${String(e.where).replace(/\s+/g, ' ').slice(0, 160)}」— ${e.what}\n   直し方: ${e.fix}`).join('\n')}` : ''
  const userText = `次の授業の、書き直した版を校閲してください。\n\n${c.about}${earlier}${corrected}\n\n# 元の授業\n\n${c.body}\n\n────────\n\n# 書き直した版\n\n${draft}\n`
  const began = Date.now()
  const answer = await askClaude({ systemFile: reviewFiles[c.course.deep ? 'es-deep' : c.course.school === 'es' ? `es-${bandOf(c.course)}` : c.course.school], userText, model: reviewModel, effort: reviewEffort, schema: REVIEW_SCHEMA, cwd: workDir, limiter, timeoutMs: 15 * 60_000 })
  appendFileSync(join(outDir, 'metrics.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), key, stage: 'review', seconds: Math.round((Date.now() - began) / 1000), cost: answer.cost, n: working.review })}\n`, 'utf8')
  const review = answer.structured ?? parse(answer.text)
  if (!Array.isArray(review?.heavy)) throw new Error('読み直しの返事を読み取れません')
  if (!review.heavy.length && Number(review.scores?.level) <= 2) {
    review.heavy.push({ kind: 'beyond', where: '（全体）', what: `全体として、その学年の生徒にはむずかしすぎる（学年への合い方が 5 点中 ${review.scores.level} 点）。${(review.light ?? []).map((l) => l.what).join(' ／ ').slice(0, 600)}`, fix: 'むずかしすぎる記述・問題を、その学年の言葉と内容に直すか、削る' })
  }
  const history = [...(previous?.history ?? []), ...(previous ? [{ at: previous.at, heavy: previous.heavy, scores: previous.scores }] : [])]
  writeJson(file.review(key), { at: Date.now(), draft: hash(draft), ...review, history })
  const fixes = state[key]?.fixes ?? 0
  if (!review.heavy.length) touch(key, { stage: 'passed', heavy: 0, light: review.light?.length ?? 0, why: '' })
  else if (fixes < MAX_FIXES) touch(key, { stage: 'fix', heavy: review.heavy.length, gate: [] })
  else touch(key, { stage: 'held', heavy: review.heavy.length, why: `読み直しで重い問題が残った: ${review.heavy[0].what.slice(0, 80)}` })
  log(`${key}: 読み直し — 重い ${review.heavy.length}、軽い ${review.light?.length ?? 0}${review.heavy.length ? `（${review.heavy[0].kind}: ${review.heavy[0].what.slice(0, 60)}）` : ''}`)
}

// ───────── 置きかえ ─────────

/** アプリが開いているか（開いているあいだは、授業のファイルを書かない）。確かめられないときは、開いているものとして扱う */
let appCheck = { at: 0, open: true }
function appOpen() {
  if (Date.now() - appCheck.at < 45_000) return appCheck.open
  const script = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq '学びアイ.exe') -and ($_.ExecutablePath -like '*学びアイ*' -or $_.CommandLine -like '*学びアイ*') } | Measure-Object).Count"
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  const count = Number(String(result.stdout ?? '').trim())
  appCheck = { at: Date.now(), open: !(result.status === 0 && count === 0) }
  return appCheck.open
}

function backup(key) {
  const to = join(backupDir, 'lessons', `${key}.md`)
  mkdirSync(join(backupDir, 'lessons'), { recursive: true })
  // 最初の 1 回だけ写す（置きかえたあとの本文で、元の控えを上書きしない）
  if (!existsSync(to)) copyFileSync(file.lesson(key), to)
  const review = join(lessonsDir, `${key}.review.json`)
  if (existsSync(review) && !existsSync(join(backupDir, 'lessons', `${key}.review.json`))) copyFileSync(review, join(backupDir, 'lessons', `${key}.review.json`))
}

let appliedNow = 0
function applyPassed() {
  if (has('no-apply')) return 0
  const ready = keys.filter((key) => state[key]?.stage === 'passed')
  if (!ready.length || appOpen()) return 0
  const deepened = readJson(deepenedFile, {})
  let count = 0
  for (const key of ready) {
    const current = readLesson(key)
    if (hash(current) !== state[key].src) {
      // 評価のあとに、元の授業が変わった（アプリで掛け合いを足した、など）。古い下書きは使わず、はじめからやり直す
      for (const f of [file.eval(key), file.draft(key), file.changes(key), file.review(key)]) if (existsSync(f)) unlinkSync(f)
      contexts.delete(key)
      delete state[key]
      stateDirty = true
      continue
    }
    const draft = readFileSync(file.draft(key), 'utf8')
    const review = readJson(file.review(key), {})
    backup(key)
    writeFileSync(`${file.lesson(key)}.tmp`, draft, 'utf8')
    renameSync(`${file.lesson(key)}.tmp`, file.lesson(key))
    // 「精査しました」の表示（アプリの教科書の画面）
    const fixes = state[key].fixes ?? 0
    writeJson(join(lessonsDir, `${key}.review.json`), { by: 'Claude', at: review.at ?? Date.now(), verdict: fixes ? 'fixed' : 'ok', note: `Codex（${model}）が掘り下げて書き直した版を、Claude（${reviewModel}）が読み直しました。${review.summary ?? ''}`.slice(0, 600) })
    deepened[key] = { at: Date.now(), by: model, from: state[key].src, to: hash(draft) }
    touch(key, { stage: 'applied', to: hash(draft) })
    count += 1
  }
  if (count) {
    writeJson(deepenedFile, deepened, false)
    saveState()
    appliedNow += count
    log(`${count} 件を、元の授業と置きかえました`)
  }
  return count
}

// ───────── 実行 ─────────

const counts = () => {
  const out = { 未着手: 0, evaluated: 0, drafted: 0, fix: 0, passed: 0, applied: 0, held: 0, failed: 0 }
  for (const key of keys) out[state[key]?.stage ?? '未着手'] += 1
  return out
}
const started = Date.now()
function saveProgress() {
  if (stateDirty) saveState()
  writeJson(join(outDir, 'progress.json'), { at: new Date().toISOString(), total: keys.length, ...counts(), codex: { percent: guard.percent, resetsAt: guard.resetsAt ? new Date(guard.resetsAt).toISOString() : null, paused: guard.paused, why: guard.paused ? guard.why : '', calls: guard.calls }, claude: limiter.state(), minutes: Math.round((Date.now() - started) / 60000), appOpen: appCheck.open, control: { ...control, codexStopAt: codexStopAt() }, working: { ...working }, api: { budget: control.apiBudget, spent: +api.spent.toFixed(2), calls: api.calls, active: guard.paused && guard.limit && apiReady(), blocked: api.blocked } })
}

if (has('status')) {
  console.log(JSON.stringify({ total: keys.length, ...counts() }, null, 1))
  for (const key of keys) if (state[key]?.stage === 'held' || state[key]?.stage === 'failed') console.log(`${state[key].stage} ${key}: ${state[key].why ?? ''}`)
  process.exit(0)
}

// はじめに、対象の授業をすべて控えに写す（置きかえの前に、元が手もとに残っているように）
for (const key of keys) if (state[key]?.stage !== 'applied') backup(key)

if (has('apply-only')) {
  if (appOpen()) console.log('アプリが開いているので、置きかえません。アプリを閉じてから、もう一度実行してください。')
  else console.log(`${applyPassed()} 件を置きかえました。`)
  process.exit(0)
}

// 保留（held）になった授業のうち、指摘を 1 件ずつ確かめ直して「書き直した版を入れてよい」と判断したものを置きかえる。
//   --accept 保存名,… [--accept-note "確かめた内容"]
// 入れるのは、いまの下書き（<データ置き場>/deepen/drafts/<保存名>.md。手で直したものでもよい）。機械の検査は、ここでもう一度かける。
if (opt('accept', '')) {
  if (appOpen()) {
    console.log('アプリが開いているので、置きかえません。アプリを閉じてから、もう一度実行してください。')
    process.exit(1)
  }
  const deepened = readJson(deepenedFile, {})
  const note = opt('accept-note', '')
  let count = 0
  for (const key of opt('accept', '').split(',').filter(Boolean)) {
    const s = state[key]
    if (!keys.includes(key) || s?.stage !== 'held') {
      console.log(`${key}: 保留の授業ではありません（${s?.stage ?? '記録なし'}）`)
      continue
    }
    const c = contextOf(key)
    if (c.src !== s.src) {
      console.log(`${key}: 評価のあとに、元の授業が変わっています。入れません`)
      continue
    }
    const draft = readFileSync(file.draft(key), 'utf8').replaceAll('\r\n', '\n').trim() + '\n'
    const checked = gate(c, draft)
    const { length, talkChanged } = checked
    // --accept-allow length,blocks: 読んで確かめたうえで、分量の検査（増え方が足りない）や、動く図解のブロックの変更（図解そのものの誤りを直したとき）を見のがす
    const allow = list('accept-allow')
    const problems = checked.problems.filter((p) => !(allow.includes('length') && /分量がほとんど増えていない/.test(p)) && !(allow.includes('blocks') && /動く図解・挿絵のブロック/.test(p)))
    if (problems.length) {
      console.log(`${key}: 機械の検査を通りません — ${problems.join(' ／ ')}`)
      continue
    }
    backup(key)
    writeFileSync(`${file.lesson(key)}.tmp`, draft, 'utf8')
    renameSync(`${file.lesson(key)}.tmp`, file.lesson(key))
    writeJson(join(lessonsDir, `${key}.review.json`), { by: 'Claude', at: Date.now(), verdict: 'fixed', note: `Codex（${model}）が掘り下げて書き直した版です。読み直しで保留になったあと、残った指摘を 1 件ずつ確かめ直して入れました。${note}`.slice(0, 600) })
    deepened[key] = { at: Date.now(), by: model, from: s.src, to: hash(draft), accepted: true }
    touch(key, { stage: 'applied', to: hash(draft), length, ratio: +(length / c.chars).toFixed(2), gate: [], talkChanged, accepted: note || true, heldWhy: s.why ?? '', why: '' })
    count += 1
    console.log(`${key}: 入れました（${c.chars} → ${length} 字）`)
  }
  if (count) {
    writeJson(deepenedFile, deepened, false)
    saveState()
    // 進み具合のページの数も合わせる（動いている掘り下げが無いときだけ、ここで書く）
    const progressFile = join(outDir, 'progress.json')
    const progress = readJson(progressFile, null)
    if (progress) writeJson(progressFile, { ...progress, at: new Date().toISOString(), ...counts() })
  }
  console.log(`${count} 件を置きかえました。`)
  process.exit(0)
}

// 評価のあとに元の授業が変わったものは、はじめからやり直す
for (const key of keys) {
  const s = state[key]
  if (!s || s.stage === 'applied' || !s.src) continue
  if (hash(readLesson(key)) !== s.src) {
    for (const f of [file.eval(key), file.draft(key), file.changes(key), file.review(key)]) if (existsSync(f)) unlinkSync(f)
    delete state[key]
    stateDirty = true
  }
}

control.stop = false
writeJson(controlFile, control)
log(`対象は ${keys.length} 件（${JSON.stringify(counts())}）。控えは ${backupDir}`)
log(`同時に進める数: 評価・掘り下げ ${control.concurrency}、読み直し ${control.reviewConcurrency}（${controlFile} を書きかえると、動かしたまま変えられます）`)
await probeCodex()
log(`codex の週の使用割合: ${guard.percent ?? '?'}%（${control.codexWeek}% の手前の ${codexStopAt()}% で休みます。回復は ${guard.resetsAt ? new Date(guard.resetsAt).toLocaleString('ja-JP') : '不明'}）`)

const busy = new Set()
const working = { codex: 0, review: 0 }
const fails = new Map()
const CODEX_STAGES = new Set([undefined, 'evaluated', 'fix'])
/** 次に進める授業を選ぶ。codex は、直し → 掘り下げ → 評価の順（途中の授業を先に終わらせる） */
function pick(kind) {
  if (kind === 'review') return keys.find((key) => !busy.has(key) && state[key]?.stage === 'drafted')
  for (const stage of ['fix', 'evaluated', undefined]) {
    const found = keys.find((key) => !busy.has(key) && state[key]?.stage === stage)
    if (found) return found
  }
  return undefined
}
const remaining = () => keys.some((key) => CODEX_STAGES.has(state[key]?.stage) || state[key]?.stage === 'drafted')

const LIMITED = /limit|quota|429|rate|usage/i
/** 同時に進める数（止める指示が出ていれば 0） */
const target = (kind) => (control.stop ? 0 : kind === 'review' ? control.reviewConcurrency : control.concurrency)
const staffed = { codex: new Set(), review: new Set() }

async function worker(kind, slot, wait) {
  try {
    await sleep(wait)
    for (;;) {
      // 同時に進める数が減らされた（または、止める指示が出た）ら、この係は、いまの 1 件を終えたところで終わる
      if (slot >= target(kind)) return
      const key = pick(kind)
      if (!key) {
        if (!remaining()) return
        // もう一方の係の仕事が終わるのを待つ（評価が終わると掘り下げ、掘り下げが終わると読み直し、と仕事が生まれる）
        await sleep(4000)
        continue
      }
      busy.add(key)
      working[kind] += 1
      try {
        if (kind === 'review') {
          const token = await limiter.enter()
          try {
            await reviewStep(key)
          } finally {
            limiter.leave(token)
          }
        } else await codexStep(key)
        fails.delete(key)
      } catch (error) {
        // 上限のせいらしい失敗は、授業のせいではないので、軽く数える（上限のたびに「失敗」にしない）
        const n = (fails.get(key) ?? 0) + (LIMITED.test(String(error.message)) ? 0.25 : 1)
        fails.set(key, n)
        log(`${key}: 失敗（${String(error.message).slice(0, 200)}）`)
        if (kind === 'review') limiter.fail(error.message)
        if (n >= 3) touch(key, { stage: 'failed', why: String(error.message).slice(0, 200) })
        await sleep(5000)
      } finally {
        busy.delete(key)
        working[kind] -= 1
      }
    }
  } finally {
    staffed[kind].delete(slot)
  }
}
/** 足りない係を足す（いちどに大勢を始めないよう、少しずつずらす） */
function staff() {
  let fresh = 0
  for (const kind of ['codex', 'review'])
    for (let slot = 0; slot < target(kind); slot += 1)
      if (!staffed[kind].has(slot)) {
        staffed[kind].add(slot)
        void worker(kind, slot, fresh++ * 800)
      }
}

const ticker = setInterval(() => {
  try {
    applyPassed()
    saveProgress()
  } catch (error) {
    log(`記録を書けませんでした: ${error.message}`)
  }
}, 60_000)

for (;;) {
  readControl(true)
  if (!busy.size && (control.stop || !remaining())) break
  if (remaining()) staff()
  await sleep(10_000)
}
clearInterval(ticker)
appCheck.at = 0
applyPassed()
saveProgress()
const c = counts()
log(`${control.stop && remaining() ? '止める指示で、止まりました' : '終わりました'}（${Math.round((Date.now() - started) / 60000)} 分）。${JSON.stringify(c)}`)
if (c.passed) log(has('no-apply') ? `読み直しを通った ${c.passed} 件は、--no-apply を付けたので、置きかえていません。` : `読み直しを通った ${c.passed} 件は、アプリが開いているので、まだ置きかえていません。アプリを閉じてから node tools/deepen-lessons.mjs --apply-only を実行すると置きかわります。`)
for (const key of keys) if (state[key]?.stage === 'held' || state[key]?.stage === 'failed') log(`${state[key].stage} ${key}: ${state[key].why ?? ''}`)
