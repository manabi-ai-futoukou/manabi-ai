// 訳した授業の「読み直し → 指摘を添えた訳し直し → 訳し直した分の読み直し → どちらを残すかの決定」を、最後まで通しで流す。
//
//   node tools/review-pipeline.mjs [--lang en] [--five 0.85] [--week 0.86] [--rounds 2] [--concurrency 12]
//        [--older-than 時刻] [--kinds general,japanese,english] [--max-fixes 回数]
//
// - 使用割合が --five・--week を超えたら自分で休み、回復したら続ける（1 時間ごとに 1 件だけ試して確かめる）。
// - 途中で止めても、もう一度実行すれば続きから進む（どの段も、済んだ分は飛ばす）。
// - 進み具合は <データ置き場>/i18n/<言語>/pipeline.json、読み直しの細かい進み具合は review-progress.json、訳し直しは progress.json。
// - もう一度はじめから読ませるとき（2 回めの読み直し）は、--older-than に「いまの時刻」を書く（はじめの段だけに効く。くわしくは review-translations.mjs）。
//   前の回で訳し直した授業も直せるように、--max-fixes を「前の回までの回数 + --rounds」にする（例: 2 回めなら 4）。
// - 軽い問題（言い回しなど）は直さない。重い問題が見つかった授業だけを、指摘を添えて訳し直す（1 つの授業につき --rounds 回まで）。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
const limits = ['--five', opt('five', '0.85'), '--week', opt('week', '0.86')]
const rounds = Number(opt('rounds', 2))
const stateFile = join(dataDir, 'i18n', lang, 'pipeline.json')

const review = ['tools/review-translations.mjs', '--lang', lang, '--all', '--wait', '--concurrency', opt('concurrency', '12'), ...limits]
const again = [...(opt('older-than', '') ? ['--older-than', opt('older-than', '')] : []), ...(opt('kinds', '') ? ['--kinds', opt('kinds', '')] : [])]
const maxFixes = opt('max-fixes', String(rounds))
const steps = [['全部の授業を読み直す', [...review, ...again]]]
for (let round = 1; round <= rounds; round++) {
  steps.push([`重い問題のあった授業を訳し直す（${round} 回め）`, ['tools/translate-lessons.mjs', '--lang', lang, '--from-review', '--max-fixes', maxFixes, ...limits]])
  steps.push([`訳し直した授業を読み直す（${round} 回め）`, review])
  steps.push([`訳し直す前とあとをくらべて、残すほうを決める（${round} 回め）`, ['tools/settle-review.mjs', '--lang', lang]])
}
steps.push(['授業の題と、人物の名前の表をそろえる', ['tools/translate-data.mjs', '--lang', lang, '--names', '--titles']])
steps.push(['まとめを出す', ['tools/review-translations.mjs', '--lang', lang, '--all', '--report']])

const started = new Date().toISOString()
const save = (step, name, state) => writeFileSync(stateFile, JSON.stringify({ step, of: steps.length, name, state, pid: process.pid, started, at: new Date().toISOString() }, null, 1), 'utf8')
const run = (script) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ['--no-warnings', ...script], { cwd: root, stdio: 'inherit', windowsHide: true })
    child.on('exit', (code) => done(code ?? 1))
    child.on('error', () => done(1))
  })

for (const [i, [name, script]] of steps.entries()) {
  console.log(`\n===== ${i + 1} / ${steps.length}: ${name}（${new Date().toLocaleString('ja-JP')}）`)
  save(i + 1, name, '進行中')
  const code = await run(script)
  if (code !== 0) {
    save(i + 1, name, '失敗')
    console.log(`この段が失敗しました（終了コード ${code}）。直してから、もう一度実行してください（続きから進みます）`)
    process.exit(1)
  }
}
save(steps.length, 'まとめを出す', '終わり')
console.log(`\nすべて終わりました（${new Date().toLocaleString('ja-JP')}）`)
