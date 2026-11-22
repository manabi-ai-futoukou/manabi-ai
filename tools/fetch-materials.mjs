// 授業に添える「実物の資料」の画像（肖像画・写真、考古資料、遺跡、建造物、文化財、仏像、記録写真、当時の社会の様子、文書など）を、
// ウィキメディア・コモンズから、権利の条件を 1 件ずつ確かめたうえで取り寄せる。
//
//   node tools/fetch-materials.mjs <科目の ID> […] [--concurrency <数>]
//
// 流れ（授業ごと）:
//   1. codex に授業の本文を読ませ、添えるとよい資料を 0〜2 点えらばせる（ウィキペディア日本語版の記事名つき）
//   2. その記事とウィキデータから、画像の候補を集める
//   3. 候補ごとに、コモンズの権利の情報を確かめ、下の条件に合うものだけを残す
//   4. 残った候補を取り寄せて codex に見せ、資料としてふさわしいものを 1 つ選ばせ、説明文を書かせる
//
// 使ってよいと判断する条件（すべて満たすものだけ）:
//   - コモンズにあり、ライセンスが パブリックドメイン・CC0・CC BY（表示）のどれか（継承 SA・非営利 NC・改変禁止 ND は使わない）
//   - パブリックドメインの場合は、その理由が次のどれかであること:
//       作者の没後 70 年以上（PD-old 系）、日本の古い写真（PD-Japan-oldphoto）、日本の団体名義などの保護期間満了（PD-Japan）、
//       アメリカ政府の著作物（PD-USGov 系）、撮影者・作者自身による放棄（PD-self・PD-user・PD-author）、作者不明で保護期間満了（PD-anon 系）
//     （アメリカでだけ保護期間が終わっているもの、理由がはっきりしないものは使わない）
//   - 利用上の制限（Restrictions）が付いていないこと、削除の審議中でないこと
//   - CC BY の場合は、作者名が分かること（表示に使う）
//
// 置き場所: assets-src/media/public/plan/<授業の ID>.json（えらんだ資料）、items/<授業の ID>-<番号>.json（取り寄せた資料と権利の記録）、
//           files/<画像>.jpg・.png、記録は public/fetch.log。すでにあるものは飛ばす。
// このあと `node scripts/install-media.mjs` で、アプリのデータ置き場に入れる（出典つきで表示される）。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outRoot = join(root, 'assets-src', 'media', 'public')
const workRoot = join(tmpdir(), 'manabi-materials')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
for (const dir of ['plan', 'items', 'files']) mkdirSync(join(outRoot, dir), { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--concurrency')
const CONCURRENCY = at >= 0 ? Number(args.splice(at, 2)[1]) : 3
const UA = { 'User-Agent': 'manabi-materials-tool/0.1 (educational content tool; no contact address)' }
/** 絵にしない・資料にしない題材（姿を描くこと自体が、信仰をもつ人を傷つけることがある） */
const NO_IMAGE = /ムハンマド|マホメット|アッラー/

const log = (text) => {
  const line = `${new Date().toLocaleTimeString('ja-JP')} ${text}`
  console.log(line)
  appendFileSync(join(outRoot, 'fetch.log'), line + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (file) => {
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

/** 提供元への問い合わせは、間をあけて 1 つずつ行う（相手に負担をかけないため） */
let queue = Promise.resolve()
function polite(work) {
  const next = queue.then(async () => {
    await sleep(1300)
    return work()
  })
  queue = next.catch(() => undefined)
  return next
}
/** 断られたとき（混雑や、問い合わせが多すぎるとき）は、相手の指示した時間か、だんだん長く待ってからやり直す */
async function wait(response, attempt) {
  const asked = Number(response.headers.get('retry-after'))
  await sleep(Math.min(300000, (Number.isFinite(asked) && asked > 0 ? asked * 1000 : 0) + 15000 * (attempt + 1)))
}
async function api(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await polite(() => fetch(url, { headers: UA }))
    if (response.ok) {
      const body = await response.text()
      if (body.startsWith('{')) return JSON.parse(body)
    }
    await wait(response, attempt)
  }
  throw new Error(`問い合わせに失敗しました: ${url.slice(0, 100)}`)
}
async function download(url, target) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await polite(() => fetch(url, { headers: UA }))
    if (response.ok && (response.headers.get('content-type') ?? '').startsWith('image/')) {
      writeFileSync(target, Buffer.from(await response.arrayBuffer()))
      return true
    }
    await wait(response, attempt)
  }
  throw new Error(`画像を取り寄せられませんでした: ${url.slice(0, 100)}`)
}

function codex(dir, prompt, images, timeoutMs) {
  return new Promise((done) => {
    const child = spawn('codex', ['exec', prompt, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', join(dir, 'last.txt'), ...images.flatMap((image) => ['-i', image])], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => (clearTimeout(timer), done(code)))
    child.on('error', () => (clearTimeout(timer), done('spawn')))
  })
}

const text = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim()

/** パブリックドメインの理由として認めるテンプレート（世界のどこでも、または日本で、保護期間が終わっていると言えるもの） */
// 「PD-old-text」のような、ほかの表示に付いてくる補助の部品は、根拠として数えない
const PD_REASON = /^(PD-old(-(\d+|auto|X|assumed))?(-expired|-1923|-1996)?|PD-Japan-oldphoto|PD-Japan(-organization|-film)?|PD-USGov[^/]*|PD-self|PD-user[^/]*|PD-author|PD-anon-(expired|1923|\d+[^/]*)|Cc-zero)$/
const BAD_TEMPLATE = /^(Delete|Deletion|Copyvio|No license|No permission|No source|Disputed|Non-free|Personality rights|Trademarked|Insignia)/i
const FREE_BY = /^cc-by-\d(\.\d)?(-[a-z]{2,4})?$/

/** コモンズのファイル 1 つについて、権利の情報を読み、使ってよいかを判断する */
async function inspect(name) {
  const data = await api(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo|templates&tllimit=500&iiprop=url|size|mime|extmetadata&iiurlwidth=1200&titles=${encodeURIComponent(`File:${name}`)}`)
  const page = Object.values(data.query?.pages ?? {})[0]
  let info = page?.imageinfo?.[0]
  if (!page || page.missing !== undefined || !info) return { name, ok: false, why: 'コモンズに無い' }
  // 提供元は、縮小していない元の画像の取り寄せを強く制限している。元の画像が小さくて縮小版にならなかったときは、
  // 元より小さい決まった大きさ（960・500 画素）の縮小版をたのむ
  if (!String(info.thumburl ?? '').includes('/thumb/') && !String(info.thumburl ?? '').includes('thumb.wikimedia.org')) {
    const step = [960, 500].find((w) => w < info.width)
    if (step) {
      const again = await api(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=${step}&titles=${encodeURIComponent(`File:${name}`)}`)
      const smaller = Object.values(again.query?.pages ?? {})[0]?.imageinfo?.[0]
      if (smaller?.thumburl) info = { ...info, thumburl: smaller.thumburl, thumbwidth: smaller.thumbwidth, thumbheight: smaller.thumbheight }
    }
  }
  const meta = info.extmetadata ?? {}
  const license = text(meta.License?.value).toLowerCase()
  const templates = (page.templates ?? []).map((t) => t.title.replace(/^Template:/, ''))
  const reasons = templates.filter((t) => PD_REASON.test(t))
  const artist = text(meta.Artist?.value).slice(0, 80)
  const record = {
    name,
    title: page.title,
    page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    url: info.thumburl ?? info.url,
    width: info.thumbwidth ?? info.width,
    height: info.thumbheight ?? info.height,
    originalWidth: info.width,
    mime: info.mime,
    license,
    licenseShort: text(meta.LicenseShortName?.value),
    licenseUrl: text(meta.LicenseUrl?.value),
    artist,
    date: text(meta.DateTimeOriginal?.value).slice(0, 60),
    object: text(meta.ObjectName?.value).slice(0, 120),
    description: text(meta.ImageDescription?.value).slice(0, 400),
    credit: text(meta.Credit?.value).slice(0, 200),
    reasons,
  }
  const fail = (why) => ({ ...record, ok: false, why })
  if (!/^image\/(jpeg|png)$/.test(info.mime)) return fail(`画像の種類が合わない（${info.mime}）`)
  if (info.width < 480) return fail('小さすぎる')
  if (text(meta.Restrictions?.value)) return fail(`利用上の制限がある（${text(meta.Restrictions.value)}）`)
  if (templates.some((t) => BAD_TEMPLATE.test(t))) return fail('削除の審議中、または権利に注意書きがある')
  if (license === 'cc0') return { ...record, ok: true, basis: 'CC0（権利の放棄）' }
  // 立体物の写真では「物: 保護期間が終わっている／写真: CC BY-SA」のように表示が 2 つ並び、要約がパブリックドメインになることがある
  const photoBad = templates.filter((t) => /^(Cc-by-sa|Cc-by-nc|Cc-by-nd|Cc-sa|GFDL|FAL|Art Libre)/i.test(t) && !t.includes('/'))
  if (license === 'pd' && photoBad.length && !templates.some((t) => /^(Cc-by-\d|Cc-zero|PD-self|PD-Self|PD-user|PD-author)/.test(t))) return fail(`写真のほうに、使えない条件が付いている（${photoBad[0]}）`)
  if (license === 'pd') return reasons.length ? { ...record, ok: true, basis: `パブリックドメイン（${reasons.slice(0, 3).join('、')}）` } : fail('パブリックドメインの理由を確かめられない')
  if (FREE_BY.test(license)) return artist ? { ...record, ok: true, basis: `${record.licenseShort}（作者の表示が必要）` } : fail('CC BY だが、作者名が分からない')
  return fail(`使えるライセンスでない（${record.licenseShort || license || '不明'}）`)
}

const JUNK = /icon|logo|flag|symbol|commons|wiki|disambig|stub|question|folder|ambox|padlock|crystal|nuvola|edit-|\bmap\b|location|locator|blank|increase|decrease|arrow|star|medal|coat[ _]of[ _]arms|emblem|signature|sound|\.svg$/i

/** 資料の候補（コモンズのファイル名）を、ウィキデータの代表画像 → 記事の代表画像 → 記事の中の画像 の順に集める */
async function candidates(article) {
  const data = await api(`https://ja.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages|pageprops|images&piprop=name&ppprop=wikibase_item&imlimit=40&titles=${encodeURIComponent(article)}`)
  const page = Object.values(data.query?.pages ?? {})[0]
  if (!page || page.missing !== undefined) return []
  const names = []
  const item = page.pageprops?.wikibase_item
  if (item) {
    const claims = await api(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&entity=${item}&property=P18`)
    for (const claim of claims.claims?.P18 ?? []) names.push(String(claim.mainsnak?.datavalue?.value ?? ''))
  }
  if (page.pageimage) names.push(page.pageimage)
  for (const image of page.images ?? []) names.push(image.title.replace(/^(ファイル|File|画像):/, ''))
  return [...new Set(names.map((n) => n.replace(/_/g, ' ').trim()).filter((n) => n && /\.(jpe?g|png)$/i.test(n) && !JUNK.test(n)))]
}

const planPrompt = (title) =>
  `作業ディレクトリの lesson.md は、学習アプリの授業「${title}」の本文です。この授業に、実物の資料の画像を 0〜2 点添えるとしたら何がよいかを選び、materials.json に保存してください。画像そのものは探さなくてかまいません（インターネットは使いません）。` +
  '【資料の種類】人物の肖像画や写真、考古資料（土器・石器・銅鐸など）、遺跡、建造物、文化財（絵巻・屏風・工芸品など）、仏像、歴史的なできごとを記録した写真や絵、当時の社会・生活・産業の様子を写した写真や絵、政治・外交の文書や写真。' +
  '【選び方】本文が中心的に扱っているものだけを選びます。ウィキペディア日本語版に記事があり、その記事に、資料そのものの画像（人物なら肖像、遺跡や建物ならその写真、できごとならそれを記録した絵や写真）が載っていそうなものにします。' +
  '存命の人物や、亡くなってから 70 年たっていない人物の肖像は選びません。ムハンマドなど、姿を描くことが信仰のうえで問題になる人物は選びません。遺体・処刑・けがなど、子どもが見て強い衝撃を受ける題材は選びません。' +
  'ふさわしいものが無い授業では、materials を空の配列にします。' +
  '【形式】{"materials": [{"subject": "資料の名前（例: 織田信長、吉野ヶ里遺跡、法隆寺、銅鐸、大日本帝国憲法の発布）", "kind": "人物・考古資料・遺跡・建造物・文化財・仏像・記録・社会と生活・文書 のどれか", "article": "ウィキペディア日本語版の記事名（正確に）", "after": "資料を置く節の見出し（lesson.md の「## 」で始まる見出しのうち 1 つを文字どおりに。## は付けない。「この授業のねらい」「確かめ問題」「ノートに書いてみましょう」は選ばない）"}]}'

const choosePrompt = (title, subject, count) =>
  `作業ディレクトリの lesson.md は、学習アプリの授業「${title}」の本文です。この授業に、資料「${subject}」の画像を添えます。添付の画像 ${count} 枚が候補で、candidates.json に、それぞれの番号（number）・ファイル名・題名・説明・作者・年代などが書かれています（添付の順も、番号の順です）。` +
  '候補の中から、この授業の資料としていちばんふさわしいものを 1 つ選んでください。ふさわしいものが無ければ、選びません。' +
  `【ふさわしくないもの】「${subject}」そのものが写っていない・描かれていないもの。花押や署名、家紋、墓、銅像の一部、記念切手、地図や図表だけのもの。画質が悪すぎるもの。遺体・処刑・けが・裸体など、子どもが見て強い衝撃を受けるもの。ムハンマドの姿を描いたもの。` +
  '【説明文】caption は、何の資料かが分かる短い説明（50 字以内）です。candidates.json に書かれている事実（題名、作者、年代、所蔵先）だけを使い、書かれていないことは足しません。人物なら「織田信長像（狩野宗秀 筆、1583 年）」、遺跡や建物なら「吉野ヶ里遺跡（佐賀県）」のような形にします。本文と同じ読み手に合わせた言葉にします。' +
  '答えは、次の形の JSON だけにしてください（前置きや説明は書かない）: {"choice": 選んだ候補の番号（0 から。選ばないときは -1）, "caption": "説明文", "alt": "画像に写っているものの説明（80 字以内）", "reason": "選んだ、または選ばなかった理由（短く）"}'

const lessonFile = (key) => join(dataDir, 'lessons', `${key}.md`)
const titleOf = (file) => /^# (?:\d+-\d+[ 　]+)?(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
function lessonsOf(courseId) {
  const curriculum = readJson(join(dataDir, 'curricula', `${courseId}.json`))
  if (!curriculum) throw new Error(`${courseId}: 単元表がありません`)
  return curriculum.units.flatMap((unit, u) => unit.lessons.map((_l, l) => `${courseId}-${u + 1}-${l + 1}`)).filter((key) => existsSync(lessonFile(key)))
}

/** 同じ資料（記事）は、何度も調べ直さない */
const inspected = new Map()
const lookedUp = new Map()

async function handle(key) {
  const title = titleOf(lessonFile(key))
  const planFile = join(outRoot, 'plan', `${key}.json`)
  if (!existsSync(planFile)) {
    const dir = join(workRoot, `plan-${key}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    copyFileSync(lessonFile(key), join(dir, 'lesson.md'))
    await codex(dir, planPrompt(title), [], 240000)
    const plan = readJson(join(dir, 'materials.json'))
    if (!plan || !Array.isArray(plan.materials)) return '資料えらびに失敗'
    writeFileSync(planFile, JSON.stringify({ materials: plan.materials.slice(0, 2) }), 'utf8')
  }
  const materials = readJson(planFile)?.materials ?? []
  const results = []
  for (const [n, material] of materials.entries()) {
    const itemFile = join(outRoot, 'items', `${key}-${n + 1}.json`)
    if (existsSync(itemFile)) {
      results.push(readJson(itemFile)?.status ?? '済み')
      continue
    }
    const subject = String(material.subject ?? '').trim()
    const article = String(material.article ?? subject).trim()
    const save = (record) => writeFileSync(itemFile, JSON.stringify({ key, n: n + 1, subject, kind: material.kind, article, after: material.after, ...record }, null, 1), 'utf8')
    if (!subject || NO_IMAGE.test(subject + article)) {
      save({ status: '対象外' })
      results.push('対象外')
      continue
    }
    // 問い合わせに失敗したときは、結果を残さずに投げる（次に実行したときに、やり直せるように）
    if (!lookedUp.has(article)) lookedUp.set(article, candidates(article))
    const names = (await lookedUp.get(article)).slice(0, 8)
    const usable = []
    const rejected = []
    for (const name of names) {
      if (!inspected.has(name)) inspected.set(name, inspect(name))
      const record = await inspected.get(name)
      if (record.ok) usable.push(record)
      else rejected.push(`${name}: ${record.why}`)
      if (usable.length >= 4) break
    }
    if (!usable.length) {
      save({ status: names.length ? '使える画像なし' : '記事か画像が見つからない', rejected: rejected.slice(0, 8) })
      results.push('使える画像なし')
      continue
    }
    const dir = join(workRoot, `pick-${key}-${n}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    copyFileSync(lessonFile(key), join(dir, 'lesson.md'))
    const local = []
    for (const [i, record] of usable.entries()) {
      const file = join(outRoot, 'files', `${createHash('sha1').update(record.title).digest('hex').slice(0, 16)}.${record.mime === 'image/png' ? 'png' : 'jpg'}`)
      // 取り寄せられない候補が 1 つあっても、授業ごと失敗にはしない（ほかの候補から選ぶ）
      if (!existsSync(file)) {
        try {
          await download(record.url, file)
        } catch {
          log(`${key}: 候補の画像を取り寄せられなかったので、ほかの候補から選びます（${record.title.slice(0, 60)}）`)
          continue
        }
      }
      const name = `c${local.length}.${record.mime === 'image/png' ? 'png' : 'jpg'}`
      copyFileSync(file, join(dir, name))
      local.push({ record, file, name, index: i })
    }
    if (!local.length) {
      save({ status: '取り寄せに失敗' })
      results.push('取り寄せに失敗')
      continue
    }
    writeFileSync(join(dir, 'candidates.json'), JSON.stringify(local.map(({ record, name }, i) => ({ number: i, file: name, title: record.object || record.name, description: record.description, artist: record.artist, date: record.date, credit: record.credit })), null, 1), 'utf8')
    await codex(dir, choosePrompt(title, subject, local.length), local.map(({ name }) => join(dir, name)), 240000)
    const picked = readJson(join(dir, 'last.txt'))
    const choice = Number(picked?.choice)
    if (!picked || !Number.isInteger(choice) || choice < 0 || choice >= local.length || !String(picked.caption ?? '').trim()) {
      save({ status: 'ふさわしい画像なし', reason: String(picked?.reason ?? '').slice(0, 200), considered: local.map(({ record }) => record.title) })
      results.push('ふさわしい画像なし')
      continue
    }
    const { record, file } = local[choice]
    save({
      status: '取り寄せた',
      caption: String(picked.caption).replace(/\s+/g, ' ').trim().slice(0, 80),
      alt: String(picked.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      reason: String(picked.reason ?? '').slice(0, 200),
      file,
      source: { title: record.title, page: record.page, license: record.licenseShort, licenseUrl: record.licenseUrl, basis: record.basis, artist: record.artist, date: record.date, credit: record.credit, reasons: record.reasons },
    })
    results.push(`取り寄せた（${record.basis}）`)
  }
  return materials.length ? results.join('、') : '添える資料なし'
}

// 科目の ID のほか、授業の ID（<科目>-<単元>-<授業>）も指定できる
const keys = args.flatMap((arg) => (/-\d+-\d+$/.test(arg) ? [arg] : lessonsOf(arg)))
log(`はじめます: ${keys.length} 件の授業（同時に ${CONCURRENCY}）`)
let next = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++]
      const result = await handle(key).catch((error) => `失敗（${String(error).slice(0, 100)}）`)
      log(`${key}: ${result}［${next}/${keys.length}］`)
    }
  }),
)
log('終わり')
