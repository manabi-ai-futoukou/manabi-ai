// 取り寄せた資料画像の点検（権利の二重確認）。fetch-materials.mjs のあとに実行する。
//   node tools/audit-materials.mjs [--concurrency 3] [--redo]
//
// コモンズのライセンスは「その写真・その画像ファイル」についての表示なので、写っている物の権利は別に確かめる。
//   1. 作者がはっきりしないもの（コモンズが「作者の表示を機械で読めない／推定」としているもの）は使わない
//   2. 作品そのものの保護期間が終わっているもの（PD-old 系・PD-Japan 系・PD-USGov 系・PD-anon 系）は、そのまま通す
//   3. 撮影した人・作った人が権利を手放した、または表示を条件に許しているだけのもの（PD-self・PD-user・PD-author・CC0・CC BY）は、
//      画像を codex に見せて、写っている物を分類させ、A・B・F だけを通す
//        A 建物・遺跡・町なみ・風景（建物は、日本の著作権法 46 条で写真の利用が自由。風景や遺跡は著作物でない）
//        B 古い物（作られてから 100 年以上たつことが明らかな、考古資料・古文書・古い絵や彫刻・仏像・道具・武具など）
//        C 近現代の創作物や図柄が主役（彫刻・絵・イラスト・復元画・説明パネル・ポスター・人形や模型・硬貨・紙幣・切手・ロゴ・本や新聞の紙面・画面の写し）
//        D 屋外に置かれた近現代の像・記念碑（日本では利用できることが多いが、確かめきれないので見送る）
//        E 判断できない
//        F 創作物でない実用品や自然物（農具・工具・機械・乗り物・日用品・動植物・鉱物。著作物に当たらない）
//        G 実在の人物や、人びとの様子を写した記録写真（人物が主役）。撮影が 1975 年より前と分かるものだけを通す（いま生きている人の肖像を避けるため）
//   4. 人が目で見て外した画像（assets-src/media/public/rejected.json に、コモンズの題 → 理由 で書く）は、どの授業でも使わない
//   5. アメリカ政府の写真（PD-USGov 系）は新しいものもあるので、1975 年以降か、年が分からないものは、3 と同じように中身を点検する
//   6. 「PD-old-text」のように、ほかの表示に付いてくる補助の部品しか記録に無いもの（その国だけの表示など）は、根拠を確かめられないので通さない
//   7. 「作者の没後 ○ 年」だけが根拠で、作られたのが 1900 年以降のものは、作者の没年を記録から確かめられるときだけ通す
//   8. 6・7 に当たるものでも、人がコモンズの記載を読んで確かめたもの（assets-src/media/public/confirmed.json に、コモンズの題 → 確かめた内容 で書く）は通す
//   9. 立体物（彫刻・出土品など）の写真には、「物」と「写真」の 2 つの権利がある。コモンズのページに付いている表示を全部読み直した控え
//      （templates.json。先に node tools/photo-layer.mjs で作る）を見て、要約は「パブリックドメイン」でも、写真のほうに
//      継承（SA）・非営利（NC）・改変禁止（ND）・GFDL しか付いていないものは見送る
//   --redo-unsure を付けると、前に「判断できない」になったものだけを点検し直す
// 結果は、それぞれの記録（assets-src/media/public/items/*.json）の audit に書く。install-media.mjs は、audit.ok が true のものだけを入れる。
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outRoot = join(root, 'assets-src', 'media', 'public')
const workRoot = join(tmpdir(), 'manabi-materials-audit')
const args = process.argv.slice(2)
const at = args.indexOf('--concurrency')
const CONCURRENCY = at >= 0 ? Number(args.splice(at, 2)[1]) : 3
const redo = args.includes('--redo')
const redoUnsure = args.includes('--redo-unsure')

const log = (text) => {
  const line = `${new Date().toLocaleTimeString('ja-JP')} ${text}`
  console.log(line)
  appendFileSync(join(outRoot, 'audit.log'), line + '\n')
}
const readJson = (file) => {
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

function codex(dir, prompt, images, timeoutMs) {
  return new Promise((done) => {
    const child = spawn('codex', ['exec', prompt, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', join(dir, 'last.txt'), ...images.flatMap((image) => ['-i', image])], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => (clearTimeout(timer), done(code)))
    child.on('error', () => (clearTimeout(timer), done('spawn')))
  })
}

/** 人が目で見て外した画像（コモンズの題 → 理由） */
const rejected = readJson(join(outRoot, 'rejected.json')) ?? {}
/** 人がコモンズの記載を読んで、権利に問題が無いと確かめた画像（コモンズの題 → 確かめた内容） */
const confirmed = readJson(join(outRoot, 'confirmed.json')) ?? {}
/** コモンズのページに付いている権利の表示の控え（コモンズの題 → 表示の一覧）。tools/photo-layer.mjs が作る */
const pageTemplates = readJson(join(outRoot, 'templates.json')) ?? {}
/** 写真（複製）のほうに付いていると使えない表示 */
const PHOTO_BAD = /^(Cc-by-sa|Cc-by-nc|Cc-by-nd|Cc-sa|GFDL|FAL|Art Libre)/i
/** 写真（複製）を自由に使ってよいという表示（これが並んでいれば、そちらを選べる） */
const PHOTO_FREE = /^(Cc-by-\d|Cc-zero|PD-self|PD-Self|PD-user|PD-author)/
const yearOf = (text) => Number((String(text).match(/(1[5-9]|20)\d\d/) ?? [])[0])

/** 作品そのものの保護期間が終わっていることを示すテンプレート */
const WORK_PD = /^(PD-old(-(\d+|auto|X|assumed))?(-expired|-1923|-1996)?|PD-Japan-oldphoto|PD-Japan(-organization|-film)?|PD-USGov[^/]*|PD-anon-(expired|1923|\d+[^/]*))$/
/** 「作者が亡くなってから ○ 年」だけを根拠にする表示（作者の没年が分からないと、確かめられない） */
const LIFE_BASED = /^PD-old(-\d+|-auto)?$/
/** 撮った人・作った人が権利を手放した、という表示 */
const SELF_RELEASED = /^(PD-self|PD-user[^/]*|PD-author|Cc-zero)$/
/** 画像を見ずに、記録だけで決まる結果（決まりを変えたら、点検し直す） */
const BY_RECORD = ['作品', '根拠', '没年', '確認', '写真']
const UNSURE_AUTHOR = /No machine-readable author|assumed \(based on copyright claims\)/i

const PROMPT =
  '添付した画像を見て、写っている「主役」が何かを判断し、次の A〜G のどれに当たるかを答えてください。権利の確認のための分類です。迷ったら、きびしい側（C・D・E）にしてください。' +
  ' A: 建物・遺跡・町なみ・風景・自然（復元された建物をふくむ。屋外の様子）。' +
  ' B: 古い物（作られてから 100 年以上たつことが明らかな、土器・石器・青銅器などの考古資料、古文書、古い絵や版画、古い彫刻や仏像、昔の道具・武具・衣服）。' +
  ' C: 近現代に作られた創作物や図柄が主役のもの（彫刻・絵・イラスト・復元想像図・博物館の説明パネルやジオラマ・ポスター・人形や模型・硬貨・紙幣・切手・ロゴ・本や新聞の紙面・画面の写し）。' +
  ' D: 屋外に置かれた、近現代の像や記念碑。' +
  ' E: 判断できない。' +
  ' G: 実在の人物や、人びとの様子を写した写真（人物が主役の肖像写真や記録写真）。' +
  ' F: 創作物でない実用品や自然物（農具・工具・機械・乗り物・日用品、動植物、鉱物など。飾りや図柄が主役でないもの）。' +
  ' 画像についての覚え書き（題・説明・日付）は、参考として下に付けます。覚え書きより、画像に見えるものを優先してください。' +
  ' 答えは、次の形の JSON だけにしてください（前置きや説明は書かない）: {"class": "A〜G のどれか 1 文字", "what": "写っている主な物（40 字以内）", "reason": "そう判断した理由（60 字以内）"}'

async function audit(name) {
  const file = join(outRoot, 'items', `${name}.json`)
  const item = readJson(file)
  if (!item || item.status !== '取り寄せた') return null
  const byEye = rejected[item.source?.title]
  const sure = confirmed[item.source?.title]
  if (item.audit && !redo && !BY_RECORD.includes(item.audit.class) && !(redoUnsure && item.audit.class === 'E') && !(byEye && item.audit.class !== '目視') && !sure) return null
  const save = (result) => {
    // 取り寄せの道具が同じ記録を書きかえていることがあるので、書く直前に読み直す
    const fresh = readJson(file) ?? item
    // 前と同じ結果なら、何もしない
    if (fresh.audit && fresh.audit.ok === result.ok && fresh.audit.class === result.class && fresh.audit.why === result.why) return null
    writeFileSync(file, JSON.stringify({ ...fresh, audit: { ...result, at: new Date().toISOString() } }, null, 1), 'utf8')
    log(`${name}（${item.subject}）: ${result.ok ? '通しました' : '見送ります'} — ${result.why}`)
    return result.ok
  }
  const source = item.source ?? {}
  if (byEye) return save({ ok: false, class: '目視', why: `目で見て外した（${byEye}）` })
  if (UNSURE_AUTHOR.test(`${source.artist} ${source.credit}`)) return save({ ok: false, class: '作者', why: '作者がはっきりしない（コモンズの記録が推定）' })
  const reasons = Array.isArray(source.reasons) ? source.reasons : []
  const old = reasons.filter((r) => WORK_PD.test(r))
  const pd = /^public domain$/i.test(source.license)
  if (pd && sure) return save({ ok: true, class: '確認', why: `コモンズの記載を読んで確かめた（${sure}）` })
  const shown = pageTemplates[source.title]
  if (!shown) {
    log(`${name}（${item.subject}）: コモンズの表示の控えがありません（先に node tools/photo-layer.mjs を実行します）`)
    return null
  }
  const photoBad = shown.filter((t) => PHOTO_BAD.test(t))
  if (pd && photoBad.length && !shown.some((t) => PHOTO_FREE.test(t))) return save({ ok: false, class: '写真', why: `物の保護期間は終わっているが、写真のほうに使えない条件が付いている（${photoBad.slice(0, 2).join('、')}）` })
  if (pd && !old.length && !reasons.some((r) => SELF_RELEASED.test(r))) return save({ ok: false, class: '根拠', why: 'パブリックドメインの理由を、記録から確かめられない' })
  if (pd && old.length && old.every((r) => LIFE_BASED.test(r)) && yearOf(source.date) >= 1900) {
    const death = Number((String(source.artist).match(/[（(]\s*\d{4}\s*[-–〜~]\s*(\d{4})\s*[)）]/) ?? [])[1])
    if (!(death > 0 && death <= new Date().getFullYear() - 71)) return save({ ok: false, class: '没年', why: `作者の没年を、記録から確かめられない（日付は ${yearOf(source.date)} 年）` })
  }
  const recentGov = old.length > 0 && old.every((r) => r.startsWith('PD-USGov')) && !(yearOf(source.date) > 0 && yearOf(source.date) < 1975)
  if (pd && old.length && !recentGov) return save({ ok: true, class: '作品', why: `作品そのものの保護期間が終わっている（${reasons.filter((r) => WORK_PD.test(r)).slice(0, 2).join('、')}）` })
  if (!existsSync(item.file)) return save({ ok: false, class: 'E', why: '画像のファイルが無い' })

  const dir = join(workRoot, name)
  mkdirSync(dir, { recursive: true })
  const image = join(dir, `image${extname(item.file) || '.jpg'}`)
  copyFileSync(item.file, image)
  const note = `【覚え書き】題: ${source.title} ／ 説明に使う言葉: ${item.subject} ／ 日付: ${source.date || '不明'} ／ 作者（撮影者）: ${source.artist || '不明'}`
  for (let attempt = 0; attempt < 2; attempt++) {
    await codex(dir, `${PROMPT}\n${note}`, [image], 240000)
    const answer = readJson(join(dir, 'last.txt'))
    const cls = String(answer?.class ?? '').trim().toUpperCase().slice(0, 1)
    if (!'ABCDEFG'.includes(cls) || !cls) continue
    const what = String(answer.what ?? '').slice(0, 60)
    const reason = String(answer.reason ?? '').slice(0, 100)
    const year = yearOf(source.date)
    const record = cls === 'G' && year > 0 && year < 1975
    return save({ ok: cls === 'A' || cls === 'B' || cls === 'F' || record, class: cls, what, why: `${{ A: '建物・遺跡・風景', B: '古い物', C: '近現代の創作物・図柄', D: '屋外の近現代の像・記念碑', E: '判断できない', F: '実用品・自然物', G: record ? `${year} 年の記録写真` : '人物の写真（撮影の年が新しいか、分からない）' }[cls]}: ${what}（${reason}）` })
  }
  return save({ ok: false, class: 'E', why: '点検の答えを読み取れなかった' })
}

const names = readdirSync(join(outRoot, 'items')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
const count = { ok: 0, no: 0 }
let next = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < names.length) {
      const name = names[next++]
      try {
        const result = await audit(name)
        if (result !== null) count[result ? 'ok' : 'no'] += 1
      } catch (error) {
        log(`${name}: 点検に失敗しました（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }),
)
const all = names.map((name) => readJson(join(outRoot, 'items', `${name}.json`))).filter((item) => item?.status === '取り寄せた')
log(`今回: 通した ${count.ok}、見送り ${count.no} ／ 全体: 取り寄せた ${all.length}、通っている ${all.filter((i) => i.audit?.ok).length}、見送り ${all.filter((i) => i.audit && !i.audit.ok).length}、まだ ${all.filter((i) => !i.audit).length}`)
