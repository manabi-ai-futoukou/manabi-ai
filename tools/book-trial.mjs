// 参考書（講義系・網羅系）と問題集の試作: 中学校・高校の単元をいくつか選び、Claude（Sonnet）に書かせて、codex に確かめさせる。
// 「十分な質のものを作れるか」を調べるための道具で、アプリにはまだ入れない。
//
//   node --no-warnings tools/book-trial.mjs --write     書かせる（1 つの単元につき、講義系 1 章・網羅系 1 章・問題集 3 水準）
//   node --no-warnings tools/book-trial.mjs --judge     codex に確かめさせる（参考書は 1 回。問題集は「解答を見ずに解く」→「解答・解説と照らし合わせる」の 2 回）
//   node --no-warnings tools/book-trial.mjs --fix       指摘のあったものを、書いたモデルに直させて、もう一度確かめさせる
//   node --no-warnings tools/book-trial.mjs --report    結果の表（<データ置き場>/book-trial/results.json にも書く）
//
//   そのほか: --model sonnet  --effort medium  --judge-model gpt-6.2-sol  --only <単元,…（例 jhs2-math-u2）>  --kinds lecture,digest,drill-a,drill-b,drill-c
//             --tag <名前>（条件を変えた試しを、別の名前で取っておく。例: --effort high --tag high）  --concurrency 6
//
// - 学習の流れは「① 教科書を読む → ② 分からなかったところを、講義系か網羅系の参考書で学ぶ → ③ 問題集と参考書で練習する」。
//   講義系は「つまずくところを、話して聞かせるように説明する本」、網羅系は「要点と問題の型を、もれなく整理した本」、
//   問題集は「全問に解答と解説が付いた、基礎・標準・入試の 3 水準の問題」。
// - AI は、この PC の claude・codex のコマンドで呼ぶ（API キーは使わない。自分のプランの使用量を使う）。
// - 教科ごとの書き方と書式の決まりは、アプリが授業を作るときのもの（src/main/ai/authoring.ts）から取る。
// - 途中の記録は <データ置き場>/book-trial/（drafts・solve・judge・final・raw・metrics.json）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkLesson } from '../scripts/lib/check-lesson.mjs'
import { CLAUDE_MODELS, costOf } from '../src/web/ai/providers.ts'
import { runClaude, runCodex, setupCli } from '../web/cli.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const outDir = join(dataDir, 'book-trial')
const model = opt('model', 'sonnet')
const effort = opt('effort', 'medium')
const judgeModel = opt('judge-model', 'gpt-6.2-sol')
const only = opt('only', '').split(',').filter(Boolean)
const tag = opt('tag', '')
const size = Number(opt('concurrency', 6))
for (const dir of ['drafts', 'solve', 'judge', 'final', 'raw']) mkdirSync(join(outDir, dir), { recursive: true })
setupCli({ workDir: join(outDir, 'workdir'), tempDir: join(outDir, 'temp') })

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 1), 'utf8')
const log = (...parts) => console.log(new Date().toLocaleTimeString('ja-JP'), ...parts)
const plainLength = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, '').length
const user = (text) => [{ role: 'user', content: [{ type: 'text', text }] }]
const modelId = (name) => CLAUDE_MODELS[name] ?? name
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN)

/** モデルの返事から、本文を取り出す（全体を ``` で囲んだものと、最初の「# 」より前の前置きを外す） */
function bodyOf(text) {
  let body = text.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, '$1')
  const at = body.search(/^# \S/m)
  if (at > 0 && at <= 3000 && !/^## |```/m.test(body.slice(0, at))) body = body.slice(at)
  return `${body.trim()}\n`
}

// アプリの指示文を読みこむ（@shared/… と、拡張子の無い読みこみを、Node が分かる形にする）
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) return nextResolve(pathToFileURL(join(root, 'src', 'shared', `${specifier.slice(8)}${extname(specifier) ? '' : '.ts'}`)).href, context)
    if (/^\.\.?\//.test(specifier) && !extname(specifier) && context.parentURL?.includes('/src/')) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const A = await import('../src/main/ai/authoring.ts')

// ───────── 試す単元 ─────────

/** 科目と、単元の番号。計算が多い教科・事実が多い教科・言葉の教科を、中学校と高校から選んである */
const TARGETS = [
  ['jhs2-math', 2], // 連立方程式
  ['jhs3-science', 5], // 仕事とエネルギー
  ['jhs-history', 7], // 江戸時代の社会と文化
  ['jhs2-english', 3], // 不定詞
  ['jhs1-japanese', 7], // 単語の分類（品詞）
  ['hs-math2', 8], // 微分法
  ['hs-butsuri-kiso', 2], // 力と運動の法則
  ['hs-kagaku-kiso', 4], // 物質量
  ['hs-gengo-bunka', 2], // 用言の活用と助動詞
  ['hs-sekaishi', 7], // 市民革命・産業革命・国民国家
  ['hs-ronhyo1', 6], // 比較と仮定法
  ['hs-joho1', 6], // アルゴリズムとプログラミング
]
const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const SCHOOL = { jhs: '中学校', hs: '高等学校' }
const SHORT = { jhs: '中学', hs: '高校' }
const GUIDE = { jhs: '中学校学習指導要領（平成 29 年告示）', hs: '高等学校学習指導要領（平成 30 年告示）' }
/** アプリの中での科目の形（src/main/content.ts の toCourse と同じもの。試作に要る分だけ） */
function toCourse(c) {
  const title = /^\d(・\d)? 年$/.test(c.label) ? `${SHORT[c.school]} ${c.label} ${c.subjectLabel}` : c.school === 'hs' ? `高校 ${c.label}` : c.label === c.subjectLabel ? `${SHORT[c.school]} ${c.label}` : `${SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
  return { id: c.id, school: c.school, schoolLabel: catalog.schools[c.school], subject: c.subject, subjectLabel: c.subjectLabel, label: c.label, title, subjectId: `${c.school}-${c.subject}`, scope: c.scope, lessonTarget: c.lessons, hasDeep: false, guide: c.guide ?? c.subject, vocational: false, higher: false, skill: false, practice: !!c.practice }
}
function targetOf([courseId, number]) {
  const course = toCourse(catalog.courses.find((c) => c.id === courseId))
  const own = join(dataDir, 'curricula', `${courseId}.json`)
  const units = JSON.parse(readFileSync(existsSync(own) ? own : join(root, 'resources', 'content', courseId, 'curriculum.json'), 'utf8')).units
  const unit = units[number - 1]
  return { key: `${courseId}-u${number}`, course, units, number, unit, lessons: unit.lessons.map((lesson, i) => ({ number: `${number}-${i + 1}`, ...lesson })) }
}
const targets = TARGETS.map(targetOf).filter((t) => !only.length || only.includes(t.key))

// ───────── 本の種類 ─────────

const KINDS = {
  lecture: { name: '講義系の参考書', short: '講義' },
  digest: { name: '網羅系の参考書', short: '網羅' },
  'drill-a': { name: '問題集（基礎）', short: '問題・基礎', level: '基礎', count: 10 },
  'drill-b': { name: '問題集（標準）', short: '問題・標準', level: '標準', count: 10 },
  'drill-c': { name: '問題集（入試）', short: '問題・入試', level: '入試', count: 8 },
  // 量を増やせるかの試し: すでにある標準の 10 問を見せて、重ならない 10 問を足させる（--kinds drill-b2 を付けたときだけ作る）
  'drill-b2': { name: '問題集（標準・追加）', short: '問題・標準（追加）', level: '標準', count: 10, after: 'drill-b' },
}
const kinds = opt('kinds', Object.keys(KINDS).filter((k) => !KINDS[k].after).join(',')).split(',').filter((k) => KINDS[k])
const isDrill = (kind) => kind.startsWith('drill')
const suffix = tag ? `@${tag}` : ''
const file = {
  draft: (t, kind) => join(outDir, 'drafts', `${t.key}.${kind}${suffix}.md`),
  solve: (t, kind, round) => join(outDir, 'solve', `${t.key}.${kind}${suffix}.${round}.json`),
  judge: (t, kind, round) => join(outDir, 'judge', `${t.key}.${kind}${suffix}.${round}.json`),
  final: (t, kind) => join(outDir, 'final', `${t.key}.${kind}${suffix}.md`),
}

const exam = (course) => (course.school === 'jhs' ? '高校入試' : '大学入試')
const examLong = (course) => (course.school === 'jhs' ? '高校入試（公立高校の入試が中心。発展では、難関の国立・私立高校の水準）' : '大学入試（大学入学共通テストと、国公立大学・私立大学の個別試験。発展では、難関大学の水準）')
const next = (course) => (course.school === 'jhs' ? '高校' : '大学')
const reader = (course) =>
  course.school === 'jhs'
    ? '中学生が、ひとりで読みます。学校に通えず、学習に空白がある生徒もいます。前の学年や前の単元の内容は、使うときに短く思い出せるように書き添えます。その学年までに習っていない用語・記号・公式は、【発展】や「その先へ」と明示した場所の外では使いません。'
    : '高校生が、ひとりで読みます。基礎があやふやな生徒から、大学受験を目指す生徒までが使います。定義や導出を省かず、考え方の筋道を示します。この科目でここまでに学んでいない内容は、【発展】や「その先へ」と明示した場所の外では前提にしません。'
const FLOW = '学習アプリには、すでに教科書（授業ごとの本文）があります。生徒は、① まず教科書を読み、② 分からなかったところを参考書（講義系か網羅系）で学び、③ 問題集と参考書を使って練習します。'
/** アプリの授業の指示文から、教科ごとの書き方と、書式の決まりを取り出す */
function fromLessonPrompt(course) {
  const base = A.lessonSystemPrompt(course, 'standard')
  const guide = base.split('# この教科で気をつけること\n')[1]?.split('\n\n# 書式')[0] ?? ''
  const format = base.split('# 書式\n')[1]?.split('\n\n本文の Markdown だけ')[0] ?? ''
  if (!guide || !format) throw new Error('授業の指示文から、教科の書き方と書式を取り出せません（authoring.ts の形が変わった）')
  return { guide, format }
}
const HONEST = `- 既存の教科書・参考書・問題集・入試の過去問の文章や問題を引き写さず、すべて自分の言葉で書き、問題は自分で作ります。入試の問題は、実際の過去問を載せず、同じ形式・同じ水準のものを作ります（大学名・高校名・年度は書きません）。
- 確信の持てない事実・数値は書きません。計算と答えは、書いたあとに自分で解き直して確かめます。`

function about(t) {
  const before = t.units.slice(0, t.number - 1).map((u) => u.title).join('、')
  const after = t.units.slice(t.number).map((u) => u.title).join('、')
  return `科目: ${t.course.title}（${SCHOOL[t.course.school]}・${t.course.subjectLabel}）
科目の範囲: ${t.course.scope}
単元: ${t.number} ${t.unit.title}${t.unit.domain ? `（${t.unit.domain}）` : ''} — ${t.unit.summary ?? ''}

# この単元の授業（教科書の目次）
${t.lessons.map((l) => `- ${l.number} ${l.title}: ${l.summary}`).join('\n')}

# この科目で、この単元より前に学ぶ単元
${before || '（最初の単元です）'}

# この単元より後に学ぶ単元（今回は扱いません）
${after || '（最後の単元です）'}`
}

const ROLE = {
  lecture: `講義系の参考書は、教科書を読んでも分からなかった生徒に、先生が横で話して聞かせるように説明する本です。
- 教科書の内容を、順番にもう一度まとめ直す本ではありません。この単元で生徒がつまずくところ、「なぜそうなるのか」が分かりにくいところを選び、そこに紙面を使います。
- 結論や公式を先に言わず、身近な例や具体的な数から入り、考えの筋道を 1 歩ずつ進めます。「なぜ、そう考えるのか」「なぜ、ほかのやり方ではうまくいかないのか」まで説明します。
- よくあるまちがいは、まちがえる理由まで説明します。
- 基礎でつまずいている生徒が読めることを第一にします。そのうえで、章の後半で入試で問われる形につなげます。`,
  digest: `網羅系の参考書は、その単元で身につけることを、もれなく整理して載せる本です。辞書のように引いて使い、問題集で分からなかったときにも立ちもどります。
- この単元の要点（用語・定義・公式・決まり・年代や人物・文法の形など）を、もれなく、表や箇条書きで整理します。
- 問題の「型」を、基礎から入試まで段階を付けて、例題として載せます。例題には、考え方（指針）と解答を付けます。
- 説明は簡潔にします（長い語りは、講義系の参考書の役目です）。ただし、結論だけにせず、理由を 1〜2 文で添えます。`,
  drill: `問題集は、教科書と参考書で学んだことを、自分で解いて身につけるための本です。
- すべての問題に、解答と解説を付けます。解説には、答えだけでなく「どう考えて、その答えになるか」を書きます。まちがえた生徒が、解説を読むだけで、自分のまちがいに気づけるように書きます（選択問題は、ほかの選択肢がなぜちがうかも書きます）。
- 1 つの問題で確かめることは、はっきり 1 つ（多くても 2 つ）にします。答えが 1 つに決まる問題にします（記述の問題は、採点の基準を解説に書きます）。
- 図が無いと解けない問題は、図のブロックを付けるか、言葉と表だけで条件が伝わる問題にします。`,
}

function lectureSystem(t) {
  const { guide, format } = fromLessonPrompt(t.course)
  const chars = t.course.school === 'jhs' ? '6,000〜8,000' : '8,000〜10,000'
  return `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}を長く教えてきた、説明の分かりやすさで知られる講師です。${GUIDE[t.course.school]}の範囲に沿って、「講義系の参考書」の 1 章（1 つの単元ぶん）を書きます。

# この本の役目
${FLOW}
${ROLE.lecture}

# 読み手
${reader(t.course)}

# 文体
- 全文を敬語（です・ます調）で、話しかけるように書きます（「ここで手が止まる人が多いです」「〜ですよね」のような言い方を使ってかまいません）。先生と生徒の会話の形にはしません。
- 1 つの段落を短くします。大切な用語や決まりは太字にします。
${HONEST}

# 構成
1. 「# ${t.unit.title}（講義）」
2. 「## この講義で分かること」… この単元でつまずきやすい点を、生徒の言葉の問い（「なぜ〜なのか」「〜と〜は、何がちがうのか」）で 3〜5 個
3. 「## 第 1 講 …」「## 第 2 講 …」… 問い 1 つにつき 1 講（3〜5 講）。それぞれに、次のものを入れます。
   - つまずきの中身（どこで、なぜ分からなくなるのか）
   - かみくだいた説明（身近な例、具体的な数、図や表）。1 歩ずつ進めます
   - 「### ここがポイント」（2〜3 行のまとめ）
   - 「### 確認」（その場で確かめる小さな問いを 1〜2 問。すぐ下に、答えと理由を書きます）
4. 「## 入試ではこう問われる」… ${examLong(t.course)}での、この単元の問われ方を説明し、代表的な形の問題を 1〜2 題、自分で作って、考え方から順に解いて見せます
5. 「## その先へ」… この単元が、あとの学年や${next(t.course)}のどんな内容につながるかを、短く（5〜8 行）。範囲をこえる内容なので、紹介にとどめます
6. 「## この章のまとめ」… 箇条書きで 5〜8 個

分量は ${chars} 字程度にします。同じことのくり返しや前置きで水増しはしません。

# この教科で気をつけること
${guide}

# 書式
${format}

本文の Markdown だけを出力します。前置きや後書きは書きません。`
}

function digestSystem(t) {
  const { guide, format } = fromLessonPrompt(t.course)
  const chars = t.course.school === 'jhs' ? '8,000〜10,000' : '10,000〜13,000'
  return `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}の、網羅系の参考書（学校で配られるような、厚い総合参考書）を書く著者です。${GUIDE[t.course.school]}の範囲に沿って、その 1 章（1 つの単元ぶん）を書きます。

# この本の役目
${FLOW}
${ROLE.digest}

# 読み手
${reader(t.course)}

# 文体
- 全文を敬語（です・ます調）で、簡潔に書きます。大切な用語や決まりは太字にします。
${HONEST}

# 構成
1. 「# ${t.unit.title}（要点と例題）」
2. 「## 要点の整理」… この単元の項目を、「### 1 …」「### 2 …」のように分けて、授業の順に整理します。項目ごとに、定義・公式・決まり（表や箇条書き）→ 補足（理由、使い分け、注意）の順に書きます
3. 「## 例題」… 問題の型ごとに 8〜12 題。見出しは「### 例題 1【基礎】型の名前」の形にし、水準は【基礎】【標準】【入試】【発展】のどれかにします（基礎 3〜4 題、標準 3〜4 題、入試 2〜3 題、発展 1 題）。それぞれ、問題 →「**考え方**」→「**解答**」→（必要なときだけ）「**注意**」の順に書きます。
   - 型は、教科に合わせて選びます。数学・理科は計算・証明・グラフや実験の読み取り、英語は文法の選択・並べかえ・書きかえ・英作文、国語は識別・読解・記述、社会は正誤の判定・並べかえ・資料の読み取り・論述、情報はプログラムの読み取りと作成、などです。
   - 【入試】は${examLong(t.course)}の水準、【発展】は教科書の範囲をこえてよい水準です。
4. 「## よくあるまちがい」… 3〜5 個（まちがいの例 → 正しくは → なぜまちがえるのか）
5. 「## 入試に向けて」… ${exam(t.course)}で、この単元がどんな形で、何と組み合わせて問われるかと、その備え方。確かでない統計や、学校名は書きません
6. 「## チェックリスト」… この単元で「できるようになったか」を自分で確かめる項目を、10 個前後

分量は ${chars} 字程度にします。

# この教科で気をつけること
${guide}

# 書式
${format}

本文の Markdown だけを出力します。前置きや後書きは書きません。`
}

const LEVELS = (course) => ({
  基礎: '教科書の本文と例題を読めば解ける水準です。用語・公式・基本の手順を、1 つずつ確かめます。',
  標準: '学校の定期テストの水準です。基本を 2 つ組み合わせる、少し形を変える、理由を説明する、といった問題にします。',
  入試: `${examLong(course)}の水準です。単元の中の内容を組み合わせる、初めて見る場面にあてはめる、資料・グラフ・長めの文を読み取る、記述する、といった問題にします。最後の 1〜2 問は、難関校の水準の問題にしてかまいません（その問題は、見出しを【発展】にします）。`,
})

function drillSystem(t, kind) {
  const { guide, format } = fromLessonPrompt(t.course)
  const { level, count } = KINDS[kind]
  return `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}の問題集を作る、経験豊かな編集者です。${GUIDE[t.course.school]}の範囲に沿って、1 つの単元の、ある水準の問題を作ります。

# この本の役目
${FLOW}
${ROLE.drill}

# 読み手
${reader(t.course)}

# 今回作る水準: ${level}
${LEVELS(t.course)[level]}

# 作り方
- ${count} 問を作ります。問題の形（選択、穴うめ、計算、短い記述、並べかえ、正誤の判定、資料やプログラムの読み取り、証明・説明など）を、教科と水準に合わせて混ぜます。同じ形・同じ内容の問題をくり返しません。
- この単元の授業を、まんべんなく扱います。
- 全文を敬語（です・ます調）で書きます。問題文は「〜を求めましょう」「〜を答えましょう」の形にします。
${HONEST}
- 数値は、計算しやすいものにします。すべての問題を、作ったあとに自分で解き直し、解答と解説が正しいことを確かめます。

# 出力の形（見出しの文言を変えません）
1 行目は「# ${t.unit.title}（問題集・${level}）」。そのあと、次の形を、問題の数だけくり返します。

### 問 1【${level}】
ねらい: （この問題で確かめること。1 行）（授業 ${t.lessons[0].number}）

（問題文。小問は (1)、(2) … と書きます）

#### 解答
（答えだけを、短く）

#### 解説
（考え方の筋道、途中の式、まちがえやすい点）

# この教科で気をつけること
${guide}

# 書式
${format}

問題集の Markdown だけを出力します。前置きや後書きは書きません。`
}
const systemOf = (t, kind) => (kind === 'lecture' ? lectureSystem(t) : kind === 'digest' ? digestSystem(t) : drillSystem(t, kind))
/** すでにある問題（量を増やすときに、重ならないように見せる） */
function existing(t, kind) {
  const before = KINDS[kind].after
  if (!before) return ''
  const problems = parseDrill(readFileSync(existsSync(file.final(t, before)) ? file.final(t, before) : file.draft(t, before), 'utf8'))
  return `\n\n# すでにある問題（${KINDS[before].name}）\n次の ${problems.length} 問は、もう問題集に入っています。これらと、確かめる内容・問題の形・場面・数値が重ならない問題を、新しく作ってください。番号は 1 から付けます。\n\n${problems.map((p) => `- 問 ${p.n}: ${p.question.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`
}
const askOf = (t, kind) => `次の単元の、${KINDS[kind].name}を${isDrill(kind) ? `作ってください（${KINDS[kind].count} 問）` : '書いてください'}。\n\n${about(t)}${existing(t, kind)}`

/** 問題集の Markdown を、問題ごとに分ける */
function parseDrill(body) {
  const parts = body.split(/^### 問\s*(\d+)\s*【([^】]+)】[^\n]*$/m)
  const problems = []
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const rest = parts[i + 2] ?? ''
    const [question = '', afterAnswer = ''] = rest.split(/^#### 解答[^\n]*$/m)
    const [answer = '', explanation = ''] = afterAnswer.split(/^#### 解説[^\n]*$/m)
    problems.push({ n: Number(parts[i]), level: parts[i + 1].trim(), question: question.trim(), answer: answer.trim(), explanation: explanation.trim() })
  }
  return problems
}
/** 書式・数式・図の検査（授業用の見出しの決まりは、参考書・問題集には当てはめない） */
const checkBody = (body) => checkLesson(body).filter((x) => !x.message.startsWith('見出し「'))

async function pool(jobs, width, run) {
  let at = 0
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      while (at < jobs.length) {
        const job = jobs[at++]
        try {
          await run(job)
        } catch (error) {
          log('失敗:', job.name ?? '', String(error?.message ?? error).slice(0, 300))
        }
      }
    }),
  )
}

// ───────── 指示文を見る（確かめ用） ─────────

if (has('show')) {
  const t = targets[0]
  for (const kind of kinds) console.log(`════════ ${t.key}.${kind} ════════\n${systemOf(t, kind)}\n\n──── 依頼 ────\n${askOf(t, kind)}\n`)
}

// ───────── 書かせる ─────────

// 名前（--tag）を付けた試しは、別のファイルに記録する（いくつかの試しを同時に動かしても、書きこみがぶつからない）
const metricsFile = join(outDir, `metrics${suffix}.json`)
const metrics = readJson(metricsFile, {})
// 前の版では、名前を付けた試しも metrics.json に書いていたので、そこからも読む
if (suffix) for (const [key, value] of Object.entries(readJson(join(outDir, 'metrics.json'), {}))) if (key.includes(suffix) && !(key in metrics)) metrics[key] = value
const idOf = (t, kind) => `${t.key}.${kind}${suffix}`

/** 書いたもの（または直したもの）が、形として使えるかを確かめる。使えなければ、わけを返す */
function shapeProblem(t, kind, body, base = 0) {
  const chars = plainLength(body)
  if (isDrill(kind)) {
    const problems = parseDrill(body)
    if (problems.length < KINDS[kind].count - 1) return `問題の数が足りません（${problems.length} / ${KINDS[kind].count} 問）`
    const broken = problems.filter((p) => !p.question || !p.answer || !p.explanation)
    if (broken.length) return `問題文・解答・解説のどれかが無い問題があります（問 ${broken.map((p) => p.n).join('、')}）`
    return ''
  }
  if (chars < Math.max(3000, base * 0.7)) return `本文が短すぎます（${chars} 字）`
  if (!/^## /m.test(body)) return '見出し（## ）がありません'
  return ''
}

/**
 * Claude に書かせる。形の検査（accept）に通らない返事や、呼び出しの失敗は、3 回までやり直す。
 * Fable 5.2 は、この呼び出し方だと、数語だけの返事（指示文の続きのような文）で終わったり、
 * 安全のための仕組みに止められたりすることが、6〜8 回に 1 回ほどある（2026-11-19 の試し）。Sonnet・Opus では、起きなかった。
 * 返すもの: accept が返したもの + result（最後の返事）・tries（呼んだ回数）・cost（やり直しの分もふくめた料金）
 */
async function ask(call, accept, name) {
  let cost = 0
  let last = ''
  for (let tries = 1; tries <= 3; tries += 1) {
    let result
    try {
      result = await runClaude(call)
    } catch (error) {
      last = String(error?.message ?? error)
      log(`やり直します（${tries} 回め）: ${name} — ${last.replace(/\s+/g, ' ').slice(0, 120)}`)
      continue
    }
    cost += result.cost ?? costOf(call.model, result.usage) ?? 0
    const out = accept(result)
    if (!out.bad) return { ...out, result, tries, cost }
    last = out.bad
    writeFileSync(join(outDir, 'raw', `bad-${name}.txt`), `${JSON.stringify(result.usage)}\n${result.text}`, 'utf8')
    log(`やり直します（${tries} 回め）: ${name} — ${last}`)
  }
  throw new Error(last)
}

if (has('write')) {
  const jobs = targets.flatMap((t) => kinds.filter((kind) => !existsSync(file.draft(t, kind))).map((kind) => ({ name: idOf(t, kind), t, kind })))
  log(`書かせます（${jobs.length} 件、${model}・思考量 ${effort}）`)
  await pool(jobs, size, async ({ t, kind }) => {
    const began = Date.now()
    const { result, body, tries, cost } = await ask(
      { model: modelId(model), effort, system: systemOf(t, kind), turns: user(askOf(t, kind)) },
      (result) => {
        const body = bodyOf(result.text)
        const bad = shapeProblem(t, kind, body)
        return bad ? { bad } : { body }
      },
      idOf(t, kind),
    )
    writeFileSync(file.draft(t, kind), body, 'utf8')
    const found = checkBody(body)
    const m = (metrics[idOf(t, kind)] = {
      unit: t.key,
      kind,
      model,
      effort,
      seconds: Math.round((Date.now() - began) / 1000),
      input: result.usage.input,
      output: result.usage.output,
      cost,
      tries,
      chars: plainLength(body),
      problems: isDrill(kind) ? parseDrill(body).length : (body.match(/^### 例題/gm) ?? []).length,
      errors: found.filter((x) => x.level === 'error').map((x) => x.message),
      warns: found.filter((x) => x.level === 'warn').map((x) => x.message),
    })
    writeJson(metricsFile, metrics)
    log(`${idOf(t, kind)}（${t.unit.title}・${KINDS[kind].short}）: ${m.seconds} 秒、${m.chars} 字、出力 ${m.output} トークン、${m.cost.toFixed(3)} ドル${isDrill(kind) ? `、${m.problems} 問` : `、例題 ${m.problems}`}${m.errors.length ? `、検査の誤り ${m.errors.length}` : ''}`)
  })
}

// ───────── 確かめさせる ─────────

const stageRule = (course) => `# 学校段階を物差しにします
- 物差しは、${GUIDE[course.school]}の「${course.subjectLabel}」と、その検定教科書・広く使われている学習参考書が、ふつうに扱う内容・言葉・厳密さです。大学以上の厳密さを物差しにしません。
- 検定教科書でも同じように書く簡略化（条件を省いた言い方、モデルとしての説明、近似の値など）は、誤りではありません。
- 【入試】【発展】や「その先へ」と明示された部分は、教科書の範囲をこえてかまいません。そこでは、${exam(course)}で実際に問われる範囲か、その先の学習の紹介にとどまっているかを見ます。`

const errorItem = {
  type: 'object',
  properties: { where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' }, kind: { type: 'string', enum: ['wrong', 'rigor'] }, sure: { type: 'boolean' } },
  required: ['where', 'what', 'fix', 'kind', 'sure'],
  additionalProperties: false,
}
const scoreProps = (keys) => ({ type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'integer', minimum: 1, maximum: 5 }])), required: keys, additionalProperties: false })
const DOC_SCORES = ['accuracy', 'level', 'role', 'clarity', 'examples']
const DOC_SCHEMA = {
  type: 'object',
  properties: {
    scores: scoreProps(DOC_SCORES),
    real_errors: { type: 'array', items: errorItem },
    over_scope: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    minor: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ok', 'fix', 'redo'] },
    summary: { type: 'string' },
  },
  required: ['scores', 'real_errors', 'over_scope', 'missing', 'minor', 'verdict', 'summary'],
  additionalProperties: false,
}
const docJudgeSystem = (t, kind) => `あなたは、日本の${SCHOOL[t.course.school]}の検定教科書と学習参考書の校閲者です。学習アプリにのせる「${KINDS[kind].name}」の 1 章（1 つの単元ぶん）を、きびしく、公平に評価します。本文は AI が書いたもので、人の確認を経ていません。コマンドの実行やファイルの操作はしません。

# この本の役目
${FLOW}
${ROLE[kind]}

${stageRule(t.course)}

# 評価のしかた
- 事実・年代・人名・用語の定義・公式・単位・計算・例文・コード・例題と確認の答えを、自分で 1 つずつ確かめます。計算と例題は、すべて解き直します。図（figure・plot・numberline）と本文の食いちがいも見ます。
- real_errors（本物の誤り）: 生徒がそのまま覚えると、学校のテストや入試で誤答になるもの。kind で分けます。
  - wrong: 答え・計算・事実・定義・公式・例文・コードが、はっきりまちがっている。本文の中で食いちがっている。解けない例題、答えが 1 つに決まらない例題。
  - rigor: おおむね正しいが、その学校段階の教科書・参考書でも書くはずの条件や例外を言い落としている。または、言いすぎている。
  sure は、確かにそう言えるなら true、確かめきれない疑いは false にします。where には、本文の該当箇所をそのまま写します。
- over_scope: この科目・この学年の範囲をこえる内容が、【入試】【発展】や「その先へ」と明示されていない場所で、説明の前提や問題に使われている箇所。無ければ空の配列。
- missing: ${kind === 'lecture' ? 'この単元で多くの生徒がつまずくのに、取り上げられていない点' : 'この単元の要点や問題の型のうち、載っていないもの'}。多くても 5 個。無ければ空の配列。
- minor: 言い回し、説明の順序、もう少しくわしく書けるところ。多くても 5 個。
- scores（1〜5 の整数。3 が「市販の参考書として、そのまま出せる最低の水準」）
  - accuracy: 内容の正しさ（wrong が 1 つでもあれば 3 以下、複数あれば 2 以下）
  - level: 読み手の学年に合っているか。基礎から${exam(t.course)}までの段階が付いているか
  - role: この本の役目を果たしているか。${kind === 'lecture' ? '教科書を読んで分からなかった生徒が、これを読めば分かるようになるか。つまずくところを選び、「なぜ」をかみくだいて説明しているか（教科書の言いかえに終わっていれば低い）' : '要点と問題の型が、もれなく整理されているか。辞書のように引けるか（抜けが多ければ低い）'}
  - clarity: ひとりで読んで分かるか。例が適切か
  - examples: 例題・確認の質（型の選び方、解き方の筋道、答えの正しさ）
- verdict: ok（このまま載せてよい）/ fix（指摘を直せば載せてよい）/ redo（作り直しが要る）
- summary: 全体の評価を 2〜3 文で。`

const SOLVE_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: { type: 'object', properties: { n: { type: 'integer' }, answer: { type: 'string' }, status: { type: 'string', enum: ['ok', 'ambiguous', 'unsolvable'] }, note: { type: 'string' } }, required: ['n', 'answer', 'status', 'note'], additionalProperties: false },
    },
  },
  required: ['answers'],
  additionalProperties: false,
}
const solveSystem = (t) => `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}の教員です。問題集の問題を、自分で解きます（解答と解説は、見せられていません）。コマンドの実行やファイルの操作はしません。
- 問題を 1 つずつ解き、answer に答えを書きます（小問があれば、すべて。計算問題は最後の値と単位、記述の問題は要点を 1〜2 文で）。
- status: ok（ふつうに解けた）/ ambiguous（答えが 1 つに決まらない。問題文があいまい）/ unsolvable（条件や資料が足りない、または条件がまちがっていて解けない）
- note: ambiguous・unsolvable のときは、そのわけ。ok のときは、問題文の誤りや不自然な点に気づいたら書きます（無ければ空文字）。`

const DRILL_SCORES = ['accuracy', 'level', 'variety', 'explanation', 'coverage']
const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          verdict: { type: 'string', enum: ['ok', 'answer_wrong', 'explanation_wrong', 'flawed', 'minor'] },
          level: { type: 'string', enum: ['基礎', '標準', '入試', '発展', '範囲外'] },
          what: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['n', 'verdict', 'level', 'what', 'fix'],
        additionalProperties: false,
      },
    },
    scores: scoreProps(DRILL_SCORES),
    duplicates: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ok', 'fix', 'redo'] },
    summary: { type: 'string' },
  },
  required: ['items', 'scores', 'duplicates', 'verdict', 'summary'],
  additionalProperties: false,
}
const checkSystem = (t, kind) => `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}の問題集の校閲者です。学習アプリにのせる問題集の、1 つの単元・1 つの水準（${KINDS[kind].level}）の問題を、解答・解説といっしょに点検します。AI が作ったもので、人の確認を経ていません。コマンドの実行やファイルの操作はしません。

# この本の役目
${FLOW}
${ROLE.drill}

${stageRule(t.course)}

# 水準の目安
${Object.entries(LEVELS(t.course)).map(([name, text]) => `- ${name}: ${text}`).join('\n')}

# 点検のしかた
- すべての問題を、自分でも解き直して、解答が正しいかを確かめます。
- 「別の教員が、解答を見ずに解いた答え」を渡します。問題集の解答と食いちがう問題は、どちらが正しいかを、もう一度解いて決めます（別の教員がまちがえていることもあります）。
- 解説を読み、考え方・途中の計算・ほかの選択肢の説明に誤りがないかを確かめます。
- items: すべての問題について、1 つずつ書きます。
  - verdict: ok（問題なし）/ answer_wrong（解答が誤り）/ explanation_wrong（解答は正しいが、解説に誤りがある）/ flawed（問題の不備。解けない、答えが 1 つに決まらない、条件や資料が足りない、図が無いと解けないのに図が無い、範囲をこえている）/ minor（誤りではないが、直したほうがよい点がある）
  - level: その問題の、実際の水準（基礎・標準・入試・発展・範囲外）
  - what: 問題点（ok なら空文字）。fix: 直し方（ok なら空文字）
- scores（1〜5 の整数。3 が「市販の問題集として、そのまま出せる最低の水準」）
  - accuracy: 解答と解説の正しさ（answer_wrong・flawed が 1 つでもあれば 3 以下、複数あれば 2 以下）
  - level: 表示された水準と、実際のむずかしさが合っているか
  - variety: 問題の形と内容に幅があるか（同じような問題のくり返しは低い）
  - explanation: 解説が、まちがえた生徒が読んで自分のまちがいに気づける書き方か（答えの言いかえだけなら低い）
  - coverage: この単元の授業を、まんべんなく扱っているか
- duplicates: 内容がほぼ同じ問題の組（「問 3 と問 7」のように）。無ければ空の配列。
- verdict: ok（このまま載せてよい）/ fix（指摘を直せば載せてよい）/ redo（作り直しが要る）
- summary: 全体の評価を 2〜3 文で。`

async function codex(system, text, schema, name) {
  const began = Date.now()
  const result = await runCodex({ model: judgeModel, effort: 'high', system, turns: user(text), jsonSchema: schema })
  writeFileSync(join(outDir, 'raw', `${name}.txt`), result.text, 'utf8')
  return { value: JSON.parse(result.text), seconds: Math.round((Date.now() - began) / 1000), usage: result.usage }
}

/** 1 つの本文を確かめる（round は 1 = 書いたまま、2 = 直したあと） */
async function judge(t, kind, body, round) {
  const name = `${idOf(t, kind)}.${round}`
  if (!isDrill(kind)) {
    const out = await codex(docJudgeSystem(t, kind), `${about(t)}\n\n# 評価する本文（${KINDS[kind].name}）\n\n${body}`, DOC_SCHEMA, `judge-${name}`)
    writeJson(file.judge(t, kind, round), { ...out.value, seconds: out.seconds, usage: out.usage })
    return out.value
  }
  const problems = parseDrill(body)
  // 1 回め: 解答を見せずに解かせる
  let solved = readJson(file.solve(t, kind, round), null)
  if (!solved) {
    const blind = problems.map((p) => `### 問 ${p.n}\n${p.question.replace(/^ねらい:[^\n]*\n?/m, '').trim()}`).join('\n\n')
    const out = await codex(solveSystem(t), `${about(t)}\n\n# 問題（${KINDS[kind].name}）\n\n${blind}`, SOLVE_SCHEMA, `solve-${name}`)
    solved = { ...out.value, seconds: out.seconds, usage: out.usage }
    writeJson(file.solve(t, kind, round), solved)
  }
  // 2 回め: 解答・解説と照らし合わせる
  const blindAnswers = solved.answers.map((a) => `- 問 ${a.n}: ${a.answer}${a.status !== 'ok' ? `（${a.status}: ${a.note}）` : a.note ? `（気づいた点: ${a.note}）` : ''}`).join('\n')
  const out = await codex(checkSystem(t, kind), `${about(t)}\n\n# 点検する問題集（${KINDS[kind].name}）\n\n${body}\n\n────────\n\n# 別の教員が、解答を見ずに解いた答え\n${blindAnswers}`, CHECK_SCHEMA, `check-${name}`)
  writeJson(file.judge(t, kind, round), { ...out.value, problems: problems.length, blind: { ambiguous: solved.answers.filter((a) => a.status === 'ambiguous').length, unsolvable: solved.answers.filter((a) => a.status === 'unsolvable').length }, seconds: out.seconds + (solved.seconds ?? 0), usage: out.usage })
  return out.value
}
const BAD = new Set(['answer_wrong', 'explanation_wrong', 'flawed'])
const describe = (kind, value) =>
  isDrill(kind)
    ? `点 ${Object.values(value.scores).join('/')}、解答の誤り ${value.items.filter((i) => i.verdict === 'answer_wrong').length}・不備 ${value.items.filter((i) => i.verdict === 'flawed').length}・解説の誤り ${value.items.filter((i) => i.verdict === 'explanation_wrong').length}・軽微 ${value.items.filter((i) => i.verdict === 'minor').length}（${value.items.length} 問）、${value.verdict}`
    : `点 ${Object.values(value.scores).join('/')}、はっきりした誤り ${value.real_errors.filter((e) => e.kind === 'wrong' && e.sure).length}・言い落とし ${value.real_errors.filter((e) => e.kind === 'rigor' && e.sure).length}・疑い ${value.real_errors.filter((e) => !e.sure).length}、範囲外 ${value.over_scope.length}、${value.verdict}`

if (has('judge')) {
  const jobs = targets.flatMap((t) => kinds.filter((kind) => existsSync(file.draft(t, kind)) && !existsSync(file.judge(t, kind, 1))).map((kind) => ({ name: `評価 ${idOf(t, kind)}`, t, kind })))
  log(`確かめさせます（${jobs.length} 件、${judgeModel}）`)
  await pool(jobs, size, async ({ t, kind }) => {
    const value = await judge(t, kind, readFileSync(file.draft(t, kind), 'utf8'), 1)
    log(`評価 ${idOf(t, kind)}: ${describe(kind, value)}`)
  })
}

// ───────── 直させる ─────────

/** 直す必要があるか（誤り・不備・範囲外の指摘があるか） */
const needsFix = (kind, value) => (isDrill(kind) ? value.items.some((i) => BAD.has(i.verdict)) : value.real_errors.length > 0 || value.over_scope.length > 0)

/** n 回めの版の置き場（1 = 書いたまま、2 = 1 回直したあと、3 = 2 回直したあと） */
const versionFile = (t, kind, round) => (round === 1 ? file.draft(t, kind) : round === 2 ? file.final(t, kind) : join(outDir, 'final', `${idOf(t, kind)}.r${round}.md`))
// 4 = 3 回直したあと（--fix --round 4。直しをもう 1 回増やすと、どこまで減るかを見るために足した）
const ROUNDS = [1, 2, 3, 4]
/** 問題集を、前書き（題）と、問題ごとのかたまり（見出しから、次の見出しの前まで）に分ける */
function splitDrill(body) {
  const pieces = body.split(/^(?=### 問\s*\d+\s*【)/m)
  const blocks = new Map()
  for (const piece of pieces.slice(1)) blocks.set(Number(/^### 問\s*(\d+)/.exec(piece)[1]), piece)
  return { head: pieces[0], blocks }
}

if (has('fix')) {
  // --round 2（既定）: 書いたままの版を直す。--round 3: 1 回直した版を、もう一度直す
  const round = Number(opt('round', 2))
  const jobs = targets
    .flatMap((t) => kinds.map((kind) => ({ name: `直し ${idOf(t, kind)}`, t, kind, first: readJson(file.judge(t, kind, round - 1), null) })))
    .filter((job) => job.first && existsSync(versionFile(job.t, job.kind, round - 1)) && needsFix(job.kind, job.first) && !existsSync(file.judge(job.t, job.kind, round)))
  log(`指摘を直させます（${round - 1} 回めの直し、${jobs.length} 件）`)
  await pool(jobs, size, async ({ t, kind, first }) => {
    const body = readFileSync(versionFile(t, kind, round - 1), 'utf8')
    // 2 回め以降の問題集は、誤り・不備のあった問題だけを直させる（軽微な点には、さわらせない）
    const flaggedOnly = isDrill(kind) && round > 2
    const flagged = first.items?.filter((i) => (flaggedOnly ? BAD.has(i.verdict) : i.verdict !== 'ok')) ?? []
    const list = isDrill(kind)
      ? flagged.map((i) => `- 問 ${i.n}【${{ answer_wrong: '解答が誤り', explanation_wrong: '解説に誤り', flawed: '問題の不備', minor: '軽微な点' }[i.verdict]}】${i.what}\n  直し方の案: ${i.fix}`).join('\n')
      : [
          ...first.real_errors.map((e) => `- ${e.sure ? '【誤り】' : '【誤りの疑い。自分で確かめて、誤りなら直す。正しければ、そのままにする】'} ${e.where}: ${e.what}\n  直し方の案: ${e.fix}`),
          ...first.over_scope.map((s) => `- 【範囲をこえる内容】${s}（削るか、その学年の言葉に言いかえるか、【発展】・「その先へ」に移す）`),
        ].join('\n')
    const began = Date.now()
    const task = flaggedOnly
      ? `すでに作った問題集のうち、校閲者から指摘のあった問題（問 ${flagged.map((i) => i.n).join('、問 ')}）だけを直します。指摘を、自分でも解き直して確かめたうえで直します。問題そのものに不備があって直せないときは、同じねらいの別の問題に差しかえます。出力するのは、直した問題だけです（番号は元のまま。見出し・ねらい・問題文・「#### 解答」・「#### 解説」の形で、問題ごとに全文を書きます）。指摘されていない問題は、出力しません。1 行目の題も要りません。`
      : isDrill(kind)
        ? 'すでに作った問題集に、校閲者から指摘がありました。指摘された問題を、自分でも解き直して確かめたうえで直します。問題そのものに不備があって直せないときは、同じねらいの別の問題に差しかえます。指摘されていない問題は、変えません。問題の数と番号、見出しの形は保ち、問題集の全文を出力します。'
        : 'すでに書いた本文に、校閲者から指摘がありました。指摘された点を、自分でも確かめたうえで直します（当たっていない指摘は、直しません）。指摘されていないところは、変えません。構成・見出し・分量は保ち、直したあとの本文の全文を出力します。'
    const { result, fixed, tries, cost } = await ask(
      { model: modelId(model), effort, system: `${systemOf(t, kind)}\n\n# 今回の仕事\n${task}`, turns: user(`${askOf(t, kind)}\n\n# 校閲者からの指摘\n${list}\n\n# いまの${isDrill(kind) ? '問題集' : '本文'}\n\n${body}`) },
      (result) => {
        let fixed
        if (flaggedOnly) {
          // 直した問題だけを差しかえる（ほかの問題は、元の文字のまま）
          const old = splitDrill(body)
          const fresh = splitDrill(`\n${result.text.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, '$1')}\n`)
          const missing = flagged.filter((i) => !fresh.blocks.has(i.n)).map((i) => i.n)
          if (missing.length) return { bad: `直した問題が返ってきません（問 ${missing.join('、')}）` }
          for (const i of flagged) old.blocks.set(i.n, `${fresh.blocks.get(i.n).trim()}\n\n`)
          fixed = `${old.head}${[...old.blocks.values()].join('')}`.trim() + '\n'
        } else fixed = bodyOf(result.text)
        const bad = shapeProblem(t, kind, fixed, plainLength(body))
        return bad ? { bad: `直したあと: ${bad}` } : { fixed }
      },
      `fix${round}-${idOf(t, kind)}`,
    )
    writeFileSync(versionFile(t, kind, round), fixed, 'utf8')
    metrics[`${idOf(t, kind)}#fix${round > 2 ? round : ''}`] = { unit: t.key, kind, model, effort, seconds: Math.round((Date.now() - began) / 1000), input: result.usage.input, output: result.usage.output, cost, tries, chars: plainLength(fixed), flagged: flagged.length }
    writeJson(metricsFile, metrics)
    const again = await judge(t, kind, fixed, round)
    log(`直し ${idOf(t, kind)}: ${describe(kind, first)} → ${describe(kind, again)}`)
  })
}

// ───────── 指摘の重さを分ける ─────────
//
// codex の点検は「市販の本として出せるか」を物差しにしているので、きびしい（条件の言い落としや、言葉の選び方も「誤り」に入る）。
// 指摘を、別の AI（claude の opus）に、重さで 4 つに分けさせる。どの種類の指摘として出されたかは、見せない。

const CLASSES = { A: '内容の誤り', B: '問題の不備', C: '言い落とし・言いすぎ', D: '表現・作り' }
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, kind: { type: 'string', enum: Object.keys(CLASSES) } }, required: ['n', 'kind'], additionalProperties: false } } },
  required: ['items'],
  additionalProperties: false,
}
const classifyModel = opt('classify-model', 'opus')
const classifyFile = (t, kind, round) => join(outDir, 'classify', `${idOf(t, kind)}.${round}.json`)
/** 重さを分ける対象の指摘（誤り・不備・範囲外。軽微な点は入れない） */
const findingsOf = (kind, value) =>
  isDrill(kind)
    ? value.items.filter((i) => BAD.has(i.verdict)).map((i) => `問 ${i.n}: ${i.what}`)
    : [...value.real_errors.filter((e) => e.sure).map((e) => `箇所「${e.where.slice(0, 200)}」— ${e.what}`), ...value.over_scope.map((s) => `範囲について: ${s}`)]
const classifySystem = (t) => `あなたは、日本の${SCHOOL[t.course.school]}の${t.course.subjectLabel}の教員で、学習参考書と問題集の編集もしています。校閲者が、参考書や問題集の原稿に付けた指摘を、重さで分けます。指摘が当たっているかどうかは判断しません（当たっているものとして、重さだけを決めます）。

# 物差し
${GUIDE[t.course.school]}と、その検定教科書・広く使われている学習参考書が、ふつうに扱う内容・言葉・厳密さを物差しにします。大学以上の厳密さを物差しにしません。

# 分け方
- A（内容の誤り）: 事実・年代・人名・定義・公式・計算・答え・例文・コード・解説の内容が、誤っている。生徒がそのまま覚えると、学校のテストや入試で誤答になる。正しい文や正しい答えを「まちがい」と教えているものも、ここに入れます。
- B（問題の不備）: 問題や例題が、解けない、答えが 1 つに決まらない（示された解答のほかにも正解がある）、条件や資料が足りない、問題文と解答や採点の基準が合っていない。
- C（言い落とし・言いすぎ）: その学年で扱う範囲ではおおむね通用するが、条件や例外を書いていない。または、少し言いすぎている。検定教科書や学習参考書でも、同じように書くことがある。
- D（表現・作り）: 言葉の選び方、書きまちがい（意味は読み取れる）、説明の順序、問いの作りの弱さ（答えが問題文から分かる、ねらいとずれている、水準の表示が合っていない、など）。内容の誤りではない。
- 迷ったら、「生徒が、まちがったことを覚えるか」で A かどうかを、「正しく考えた生徒が、× にされるか」で B かどうかを決めます。
- 1 つの指摘に、いくつかの点がふくまれるときは、いちばん重いもの（A > B > C > D）にします。

# 返すもの
items: 指摘の番号（n）と、分けた結果（kind）。すべての指摘について、1 つずつ。`

if (has('classify')) {
  mkdirSync(join(outDir, 'classify'), { recursive: true })
  const jobs = targets.flatMap((t) =>
    kinds.flatMap((kind) =>
      ROUNDS
        .map((round) => ({ name: `重さ ${idOf(t, kind)}.${round}`, t, kind, round, value: readJson(file.judge(t, kind, round), null) }))
        .filter((job) => job.value && !existsSync(classifyFile(job.t, job.kind, job.round))),
    ),
  )
  log(`指摘の重さを分けさせます（${jobs.length} 件、${classifyModel}）`)
  await pool(jobs, size, async ({ t, kind, round, value }) => {
    const list = findingsOf(kind, value)
    if (!list.length) return writeJson(classifyFile(t, kind, round), [])
    const result = await runClaude({ model: modelId(classifyModel), effort: 'medium', system: classifySystem(t), turns: user(`${about(t)}\n\n# 校閲者の指摘（${KINDS[kind].name}の原稿に付いたもの）\n${list.map((text, i) => `${i + 1}. ${text}`).join('\n')}`), jsonSchema: CLASSIFY_SCHEMA })
    const out = JSON.parse(result.text)
    const classes = list.map((_text, i) => out.items.find((item) => item.n === i + 1)?.kind ?? null)
    if (classes.some((c) => !c)) throw new Error('分けられなかった指摘があります')
    writeJson(classifyFile(t, kind, round), classes)
    log(`重さ ${idOf(t, kind)}.${round}: ${Object.keys(CLASSES).map((c) => `${c} ${classes.filter((x) => x === c).length}`).join('・')}`)
  })
}

// ───────── できあがりを選ぶ ─────────

/** 指摘の重さ（誤り・不備の数）。直したあとに増えていたら、直す前の版を使う */
const weight = (kind, value) => (isDrill(kind) ? value.items.filter((i) => BAD.has(i.verdict)).length : value.real_errors.filter((e) => e.sure).length + value.over_scope.length)
/** のせる版: 直すたびに点検し、指摘が増えていなければ、直した版に進む（増えていたら、その前の版のまま） */
function chosen(t, kind) {
  let round = readJson(file.judge(t, kind, 1), null) ? 1 : 0
  // --max-round 3 を付けると、2 回直した版までの中から選ぶ（モデルどうしを、同じ回数で比べるとき）
  for (const next of ROUNDS.slice(1).filter((r) => r <= Number(opt('max-round', 99)))) {
    const value = existsSync(versionFile(t, kind, next)) ? readJson(file.judge(t, kind, next), null) : null
    if (!round || !value) break
    if (weight(kind, value) <= weight(kind, readJson(file.judge(t, kind, round), null))) round = next
  }
  const source = versionFile(t, kind, round || 1)
  return { round, fixed: round > 1, judge: round ? readJson(file.judge(t, kind, round), null) : null, body: existsSync(source) ? readFileSync(source, 'utf8') : null }
}

// ───────── 見本を読むページの中身を書く ─────────

if (has('export')) {
  const dir = resolve(root, '..', '参考書と問題集の見本')
  mkdirSync(dir, { recursive: true })
  const samples = []
  for (const t of targets)
    for (const kind of kinds) {
      const { fixed, round, judge: value, body } = chosen(t, kind)
      if (!body) continue
      const check = !value
        ? 'まだ点検していません。'
        : isDrill(kind)
          ? `Codex の点検: ${value.items.length} 問のうち、解答の誤り ${value.items.filter((i) => i.verdict === 'answer_wrong').length}・問題の不備 ${value.items.filter((i) => i.verdict === 'flawed').length}・解説の誤り ${value.items.filter((i) => i.verdict === 'explanation_wrong').length}。${value.summary}`
          : `Codex の点検: はっきりした誤り ${value.real_errors.filter((e) => e.kind === 'wrong' && e.sure).length}・言い落とし ${value.real_errors.filter((e) => e.kind === 'rigor' && e.sure).length}・範囲をこえる内容 ${value.over_scope.length}。${value.summary}`
      const remaining = !value
        ? []
        : isDrill(kind)
          ? value.items.filter((i) => BAD.has(i.verdict)).map((i) => `問 ${i.n}: ${i.what}`)
          : [...value.real_errors.filter((e) => e.sure).map((e) => `${e.where.slice(0, 60)} — ${e.what}`), ...value.over_scope.map((s) => `範囲をこえる内容: ${s}`)]
      samples.push({ id: `${t.key}.${kind}`, unit: t.key, course: t.course.title, title: t.unit.title, kind, kindLabel: KINDS[kind].short, body, check, remaining, fixed, fixes: Math.max(0, round - 1) })
    }
  // 名前（--tag）を付けた試しは、data@<名前>.js に書く。見本のページは、あるものを全部読んで、書いたモデルを切りかえられるようにする
  const set = { tag, at: new Date().toISOString(), model: opt('label', { sonnet: 'Claude Sonnet 5.5', opus: 'Claude Opus 5.5', haiku: 'Claude Haiku 5.5', fable: 'Claude Fable 5.2' }[model] ?? model), judge: judgeModel === 'gpt-6.2-sol' ? 'Codex（GPT 6.2 Sol）' : `Codex（${judgeModel}）`, samples }
  writeFileSync(join(dir, `data${suffix}.js`), `(window.BOOK_SETS = window.BOOK_SETS || []).push(${JSON.stringify(set).replaceAll('</', '<\\/')})\n`, 'utf8')
  log(`見本を ${samples.length} 件、${join(dir, `data${suffix}.js`)} に書きました`)
}

// ───────── 結果 ─────────

if (has('report')) {
  const tally = (list) => (list ? Object.fromEntries(Object.keys(CLASSES).map((c) => [c, list.filter((x) => x === c).length])) : null)
  const rows = []
  for (const t of targets)
    for (const kind of kinds) {
      const m = metrics[idOf(t, kind)]
      if (!m || !existsSync(file.draft(t, kind))) continue
      const found = checkBody(readFileSync(file.draft(t, kind), 'utf8'))
      const judged = ROUNDS.map((round) => readJson(file.judge(t, kind, round), null))
      const count = (value) =>
        !value
          ? null
          : isDrill(kind)
            ? { problems: value.items.length, answer: value.items.filter((i) => i.verdict === 'answer_wrong').length, flawed: value.items.filter((i) => i.verdict === 'flawed').length, explanation: value.items.filter((i) => i.verdict === 'explanation_wrong').length, minor: value.items.filter((i) => i.verdict === 'minor').length, levelOff: value.items.filter((i) => i.level !== KINDS[kind].level && !(KINDS[kind].level === '入試' && i.level === '発展')).length, duplicates: value.duplicates.length, verdict: value.verdict, scores: value.scores, seconds: value.seconds }
            : { wrong: value.real_errors.filter((e) => e.kind === 'wrong' && e.sure).length, rigor: value.real_errors.filter((e) => e.kind === 'rigor' && e.sure).length, unsure: value.real_errors.filter((e) => !e.sure).length, overScope: value.over_scope.length, missing: value.missing.length, verdict: value.verdict, scores: value.scores, seconds: value.seconds }
      const used = chosen(t, kind).round
      rows.push({
        id: idOf(t, kind),
        unit: t.key,
        school: t.course.school,
        subject: t.course.subjectLabel,
        title: t.unit.title,
        kind,
        ...m,
        errors: found.filter((x) => x.level === 'error').map((x) => x.message),
        fix: metrics[`${idOf(t, kind)}#fix`] ?? null,
        first: count(judged[0]),
        second: count(judged[1]),
        third: count(judged[2]),
        fix2: metrics[`${idOf(t, kind)}#fix3`] ?? null,
        classSecond: tally(readJson(classifyFile(t, kind, 2), null)),
        // のせる版（直したあとに指摘が増えていなければ、直した版）
        used,
        final: used ? count(judged[used - 1]) : null,
        classFirst: tally(readJson(classifyFile(t, kind, 1), null)),
        classFinal: used ? tally(readJson(classifyFile(t, kind, used), null)) : null,
      })
    }
  const sum = (list, key) => list.reduce((a, x) => a + (x?.[key] ?? 0), 0)
  const scoreAvg = (list) => (list.length ? Object.fromEntries(Object.keys(list[0].scores).map((key) => [key, +avg(list.map((x) => x.scores[key])).toFixed(2)])) : null)
  const classSum = (list) => (list.length && list.every(Boolean) ? Object.fromEntries(Object.keys(CLASSES).map((c) => [c, sum(list, c)])) : null)
  /** いくつかの行をまとめる */
  function digest(mine) {
    const drill = isDrill(mine[0].kind)
    const judged = mine.filter((row) => row.first)
    const fixed = mine.filter((row) => row.fix)
    const stage = (list) =>
      !list.length
        ? null
        : drill
          ? { problems: sum(list, 'problems'), answer: sum(list, 'answer'), flawed: sum(list, 'flawed'), explanation: sum(list, 'explanation'), minor: sum(list, 'minor'), levelOff: sum(list, 'levelOff'), clean: list.filter((x) => x.answer + x.flawed + x.explanation === 0).length, verdicts: ['ok', 'fix', 'redo'].map((v) => `${v} ${list.filter((x) => x.verdict === v).length}`).join('・'), scores: scoreAvg(list) }
          : { wrong: sum(list, 'wrong'), rigor: sum(list, 'rigor'), unsure: sum(list, 'unsure'), overScope: sum(list, 'overScope'), clean: list.filter((x) => x.wrong + x.rigor + x.overScope === 0).length, verdicts: ['ok', 'fix', 'redo'].map((v) => `${v} ${list.filter((x) => x.verdict === v).length}`).join('・'), scores: scoreAvg(list) }
    return {
      count: mine.length,
      seconds: Math.round(avg(mine.map((row) => row.seconds))),
      chars: Math.round(avg(mine.map((row) => row.chars))),
      output: Math.round(avg(mine.map((row) => row.output))),
      input: Math.round(avg(mine.map((row) => row.input))),
      cost: +avg(mine.map((row) => row.cost)).toFixed(4),
      items: +avg(mine.map((row) => row.problems)).toFixed(1),
      checkErrors: mine.reduce((a, row) => a + row.errors.length, 0),
      judgeSeconds: Math.round(avg(judged.map((row) => row.first.seconds))),
      first: stage(judged.map((row) => row.first)),
      classFirst: classSum(judged.map((row) => row.classFirst)),
      fixed: fixed.length,
      fixSeconds: Math.round(avg(fixed.map((row) => row.fix.seconds))),
      fixCost: +avg(fixed.map((row) => row.fix.cost)).toFixed(4),
      // 直した版が、直す前より悪くなって、使わなかった数
      fixRejected: mine.filter((row) => row.second && row.used === 1).length,
      final: stage(judged.map((row) => row.final)),
      classFinal: classSum(judged.map((row) => row.classFinal)),
      // 内容の誤り（A）と問題の不備（B）が、どちらも 0 になったものの数
      cleanAB: judged.every((row) => row.classFinal) ? judged.filter((row) => row.classFinal.A + row.classFinal.B === 0).length : null,
    }
  }
  const summary = {}
  for (const kind of kinds) {
    const mine = rows.filter((row) => row.kind === kind)
    if (mine.length) summary[kind] = digest(mine)
  }
  // 参考書（講義・網羅）と問題集（3 水準）を、教科ごとにまとめる
  const bySubject = {}
  for (const subject of [...new Set(rows.map((row) => `${SHORT[row.school]}・${row.subject}`))]) {
    const mine = rows.filter((row) => `${SHORT[row.school]}・${row.subject}` === subject)
    const docs = mine.filter((row) => !isDrill(row.kind) && row.classFirst && row.classFinal)
    const drills = mine.filter((row) => isDrill(row.kind) && row.classFirst && row.classFinal)
    bySubject[subject] = {
      units: [...new Set(mine.map((row) => row.title))].join('、'),
      docs: docs.length ? { first: classSum(docs.map((row) => row.classFirst)), final: classSum(docs.map((row) => row.classFinal)) } : null,
      drills: drills.length ? { problems: sum(drills.map((row) => row.final), 'problems'), first: classSum(drills.map((row) => row.classFirst)), final: classSum(drills.map((row) => row.classFinal)) } : null,
    }
  }
  writeJson(join(outDir, `results${suffix}.json`), { at: new Date().toISOString(), model, effort, judgeModel, classifyModel, classes: CLASSES, summary, bySubject, rows })
  console.log(JSON.stringify(summary, null, 1))
  const cls = (c) => (c ? Object.entries(c).map(([k, v]) => `${k}${v}`).join(' ') : '—')
  console.log('\n教科ごと（指摘の重さ: A 内容の誤り・B 問題の不備・C 言い落とし・D 表現。書いたまま → のせる版）')
  for (const [subject, x] of Object.entries(bySubject)) console.log(`${subject}（${x.units}）  参考書: ${cls(x.docs?.first)} → ${cls(x.docs?.final)}   問題集（${x.drills?.problems ?? '—'} 問）: ${cls(x.drills?.first)} → ${cls(x.drills?.final)}`)
  console.log('\n単元ごと（書いたまま → 直したあと。* は、直した版を使わなかったもの）')
  for (const t of targets) {
    console.log(`■ ${t.key} ${t.course.title}・${t.unit.title}`)
    for (const row of rows.filter((r) => r.unit === t.key)) {
      const show = (x) => (!x ? '—' : isDrill(row.kind) ? `誤答 ${x.answer}・不備 ${x.flawed}・解説 ${x.explanation}（${x.problems} 問）${x.verdict}` : `誤り ${x.wrong}・言い落とし ${x.rigor}・疑い ${x.unsure}・範囲外 ${x.overScope} ${x.verdict}`)
      console.log(`  ${KINDS[row.kind].short.padEnd(6, '　')} ${row.seconds} 秒 ${row.chars} 字 $${row.cost.toFixed(3)}  ${show(row.first)} [${cls(row.classFirst)}]${row.second ? ` → ${show(row.second)}${row.used === 1 ? '*' : ''} [${cls(row.classSecond)}]` : ''}${row.third ? ` → ${show(row.third)}${row.used < 3 ? '*' : ''} [${cls(row.used === 3 ? row.classFinal : null)}]` : ''}${row.errors.length ? `  検査 ${row.errors.length}` : ''}`)
    }
  }
}
