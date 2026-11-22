// キャラクターシートから、追加の表情差分シートを、codex CLI の画像生成で作る。
//
//   生徒: node tools/gen-expressions.mjs <シートのフォルダ> <ID の開始番号 - 1>
//         例: node tools/gen-expressions.mjs "C:\path\to\男子生徒" 10   （…-1.png が s11、…-10.png が s20 になる）
//         1 人につき 1 枚（眠そう・考え中・困り顔・驚き）を作る。
//   先生: node tools/gen-expressions.mjs --teacher <シートのファイル>
//         出番が多いので 2 枚（上の 4 つと、ウインク・ほめる・見守る・まじめ）を作る。
//
// できた画像は assets-src/<ID>_expressions.png（先生の 2 枚目は sensei_expressions2.png）に置く。
// すでにあるものは飛ばすので、途中で止まっても再実行すれば続きから進む。
// このあと `npm run characters`（tools/cut_characters.py）で切り抜く。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outDir = resolve(import.meta.dirname, '..', 'assets-src')
const workRoot = join(tmpdir(), 'manabi-expressions')
mkdirSync(outDir, { recursive: true })

/** who: だれのシートか、cells: 4 つのますに何を描くか */
const promptFor = (who, cells) =>
  `添付のキャラクターシート（${who}）と同一人物・同一の絵柄・同一の髪型と服装（眼鏡や髪留めがあればそれも同じ）で、新しい表情差分シートを組み込みの画像生成機能で1枚生成してください。` +
  '条件: 純白の背景、横長の画像、胸から上のバストアップを2行×2列で計4つ、互いに重ならないよう十分な余白を空けて配置。' +
  cells +
  '文字・ラベル・枠線は入れないでください。コードで描画や合成をするのではなく、必ず画像生成機能を使ってください。' +
  '生成した画像は作業ディレクトリ直下に expressions.png という名前で保存し、最後に保存先のパスを報告してください。'

const BASIC_CELLS = '左上=眠そうな表情（半目で小さくあくび）、右上=考え中（あごに手を当て視線を斜め上に）、左下=困り顔（眉を下げて苦笑い、汗マーク）、右下=驚き（目を見開いて口を開ける）。'
const TEACHER_CELLS =
  '左上=ウインク（片目を閉じて、口を開けてにっこり）、右上=ほめる（目を細めた満面の笑みで、胸の前で小さく拍手をしている）、' +
  '左下=やさしく見守る（口を閉じておだやかにほほえみ、片手を胸に当てている）、右下=まじめな表情（口を閉じ、まっすぐ前を見た、落ち着いた真剣な顔。怒ってはいない）。'

const STUDENT = '中学生の生徒キャラクター'
const TEACHER = '学習アプリで先生の役をする、大人の女性のキャラクター'

/** 1 枚作る。できたら true */
function generate(id, sheet, target, prompt) {
  if (existsSync(target)) {
    console.log(id, 'すでにあります')
    return true
  }
  // codex の作業フォルダは、日本語をふくまない場所にする
  const dir = join(workRoot, `${id}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  copyFileSync(sheet, join(dir, 'sheet.png'))
  const started = Date.now()
  const run = spawnSync(
    'codex',
    ['exec', prompt, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', join(dir, 'last.txt'), '-i', join(dir, 'sheet.png')],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: 300000 },
  )
  const made = join(dir, 'expressions.png')
  const ok = existsSync(made)
  if (ok) copyFileSync(made, target)
  console.log(id, `exit=${run.status}`, ok ? 'できました' : '失敗', `${Math.round((Date.now() - started) / 1000)} 秒`)
  return ok
}

const args = process.argv.slice(2)
if (args[0] === '--teacher') {
  const sheet = args[1]
  if (!sheet || !existsSync(sheet)) throw new Error('先生のキャラクターシートのファイルを指定してください。')
  generate('sensei', sheet, join(outDir, 'sensei_expressions.png'), promptFor(TEACHER, BASIC_CELLS))
  generate('sensei-2', sheet, join(outDir, 'sensei_expressions2.png'), promptFor(TEACHER, TEACHER_CELLS))
} else {
  const [sheetDir, offsetArg = '0'] = args
  if (!sheetDir) throw new Error('キャラクターシートのフォルダを指定してください。')
  const offset = Number(offsetArg) || 0
  const sheets = readdirSync(sheetDir)
    .map((name) => ({ name, n: Number(/-(\d+)\.png$/.exec(name)?.[1]) }))
    .filter((s) => s.n)
    .sort((a, b) => a.n - b.n)

  let fails = 0
  for (const sheet of sheets) {
    const id = `s${String(sheet.n + offset).padStart(2, '0')}`
    const ok = generate(id, join(sheetDir, sheet.name), join(outDir, `${id}_expressions.png`), promptFor(STUDENT, BASIC_CELLS))
    if (!ok && ++fails >= 2) {
      // 2 人続けて失敗したら、利用上限などの可能性があるので止める
      console.log('2 回失敗したので止めます。')
      break
    }
  }
}
console.log('終わり')
