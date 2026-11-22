// ふだんのデータの写しを使い、表示の言語を切りかえた状態でアプリを開いて、全部の画面を見てまわる（ふだんのデータは書きかえない）。
//
//   node scripts/try-language.mjs [--lang en] [--ai] [--lessons 授業の ID,…] [--keep]
//
// - 画面ごとの写真を .try/lang/<言語>/ に出し、画面に残っている日本語（訳されていない文言）と、
//   訳して長くなったせいで、はみ出して隠れているボタンなどを一覧にする。
// - --ai を付けると、AI を呼ぶ機能（チャット・テストの作問）も 1 回ずつ試す（付けなければ AI は呼ばない）。
// - 写しは .try/lang-copy に作る（--keep で、前回の写しをそのまま使う）。
import electronPath from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const lang = opt('lang', 'en')
const root = resolve(import.meta.dirname, '..')
const source = process.env['MANABI_SOURCE_DIR'] ?? join(process.env['APPDATA'], '学びアイ', 'data')
const copy = join(root, '.try', 'lang-copy')
const shots = join(root, '.try', 'lang', lang)
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
if (!has('keep') || !existsSync(copy)) {
  rmSync(copy, { recursive: true, force: true })
  mkdirSync(copy, { recursive: true })
  for (const name of ['lessons', 'curricula', 'media', 'lessons-index.json', 'i18n']) if (existsSync(join(source, name))) cpSync(join(source, name), join(copy, name), { recursive: true })
}
// 試し訳（.try/translate/final-test）があれば、まだ訳が届いていない授業の代わりに使う
const trial = join(root, '.try', 'translate', 'final-test', 'lessons')
if (lang === 'en' && existsSync(trial)) {
  mkdirSync(join(copy, 'i18n', lang, 'lessons'), { recursive: true })
  for (const file of readdirSync(trial)) if (!existsSync(join(copy, 'i18n', lang, 'lessons', file))) cpSync(join(trial, file), join(copy, 'i18n', lang, 'lessons', file))
}
writeFileSync(join(copy, 'settings.json'), JSON.stringify({ language: lang, courseId: 'jhs-history' }), 'utf8')
// 教材づくりは止めておく（設定は、ふだんのものをそのまま使う）
const library = existsSync(join(source, 'library.json')) ? JSON.parse(readFileSync(join(source, 'library.json'), 'utf8')) : {}
writeFileSync(join(copy, 'library.json'), JSON.stringify({ ...library, enabled: false }), 'utf8')

const translated = new Set(readdirSync(join(copy, 'i18n', lang, 'lessons')).map((f) => f.slice(0, -3)))
const wanted = opt('lessons', 'jhs-history-3-1,es3-math-5-1,es1-math-1-4,hs-mathc-6-3,es3-japanese-4-4,jhs1-english-1-1').split(',')
const lessons = wanted.filter((id) => translated.has(id))
const untranslated = readdirSync(join(copy, 'lessons')).map((f) => f.slice(0, -3)).find((id) => !translated.has(id) && !id.endsWith('.deep'))

const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: copy, MANABI_NO_RELAUNCH: '1', ...(has('ai') ? {} : { MANABI_NO_AI: '1' }) } })
const errors = []
const leftovers = {}
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 200)}`))
}
/** 画面に残っている日本語（授業の本文の中はのぞく） */
const japaneseOn = (page) =>
  page.evaluate(() => {
    const JA = /[぀-ヿ㐀-鿿]/
    const out = new Set()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent.trim()
      if (!text || !JA.test(text)) continue
      if (node.parentElement?.closest('.paper .markdown, .kakeai, .textbook-article .paper, .bubble, script, style')) continue
      out.add(text.slice(0, 90))
    }
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]'))
      for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
        const value = el.getAttribute(name)
        if (value && JA.test(value) && !el.closest('.paper .markdown, .textbook-article .paper')) out.add(`@${name}: ${value.slice(0, 90)}`)
      }
    return [...out]
  })
/** はみ出して隠れている操作の部品（訳して長くなった文言が、幅に収まらずに切れているもの） */
const clippedOn = (page) =>
  page.evaluate(() => {
    const out = new Set()
    for (const el of document.querySelectorAll('button, a[href], select, [role="tab"], label, summary, th')) {
      const box = el.getBoundingClientRect()
      if (!box.width || !box.height) continue
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50)
      // 自分の中の文字が、自分の幅からはみ出して切れている
      const own = getComputedStyle(el)
      if (el.tagName !== 'SELECT' && own.overflowX === 'hidden' && own.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) out.add(`文字が切れている: ${text}`)
      // 親のわくからはみ出して、見えない（横に送れないわくだけを見る）
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue
        const frame = parent.getBoundingClientRect()
        if (box.right > frame.right + 2 || box.left < frame.left - 2) out.add(`わくからはみ出している: ${text}（${parent.className.toString().slice(0, 40)}）`)
        break
      }
    }
    return [...out]
  })
const clipped = {}
const snap = async (page, name, wait = 700) => {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: join(shots, `${name}.png`) })
  leftovers[name] = await japaneseOn(page)
  clipped[name] = await clippedOn(page)
}
const open = async (from, view, params = {}) => {
  const [page] = await Promise.all([app.waitForEvent('window'), from.evaluate(([v, p]) => window.manabi.view.open(v, p), [view, params])])
  watch(page, view)
  await page.waitForSelector('#root > *')
  return page
}

const home = await app.firstWindow()
watch(home, 'home')
await home.waitForSelector('.home-hello')
await home.setViewportSize({ width: 1180, height: 1400 })
await snap(home, 'home')
console.log(`表示の言語: ${await home.evaluate(() => window.manabi.lang)}、<html lang="${await home.evaluate(() => document.documentElement.lang)}">`)

// 教科書: 訳した授業をいくつかと、訳がまだ無い授業
const textbook = await open(home, 'textbook', { lessonId: lessons[0] ?? untranslated })
await textbook.setViewportSize({ width: 1180, height: 1000 })
const seen = {}
for (const id of lessons) {
  await textbook.evaluate((lessonId) => window.manabi.view.open('textbook', { lessonId }), id)
  await textbook.waitForFunction((lessonId) => document.querySelector('.nav-item-active') && document.querySelector('.paper h1'), id)
  await textbook.waitForFunction(() => [...document.querySelectorAll('.paper img')].every((img) => img.complete))
  await snap(textbook, `textbook-${id}`, 900)
  seen[id] = await textbook.evaluate(() => ({
    title: document.querySelector('.paper h1')?.textContent?.slice(0, 60),
    header: document.querySelector('.view-header-title')?.textContent?.slice(0, 100),
    talks: document.querySelectorAll('.paper .kakeai').length,
    guests: [...document.querySelectorAll('.paper .kakeai-say small')].map((el) => el.textContent).filter((name, i, all) => all.indexOf(name) === i).slice(0, 6),
    pictures: [...document.querySelectorAll('.paper .picture')].map((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 110)),
    sims: document.querySelectorAll('.paper .sim').length,
    figures: document.querySelectorAll('.paper svg').length,
    broken: document.querySelectorAll('.paper .figure-error').length,
    untranslatedNotice: !!document.querySelector('.paper .notice button'),
  }))
  // 掛け合い・挿絵・図があれば、その部分の写真も撮る
  for (const [selector, part] of [['.paper .kakeai', 'talk'], ['.paper .picture', 'picture'], ['.paper .sim', 'sim'], ['.paper .figure, .paper figure svg, .paper svg', 'figure']]) {
    const target = textbook.locator(selector).first()
    if (await target.count()) {
      await target.scrollIntoViewIfNeeded()
      await textbook.waitForTimeout(250)
      await target.screenshot({ path: join(shots, `textbook-${id}-${part}.png`) }).catch(() => undefined)
    }
  }
}
if (untranslated) {
  await textbook.evaluate((lessonId) => window.manabi.view.open('textbook', { lessonId }), untranslated)
  await textbook.waitForFunction(() => document.querySelector('.paper h1'))
  await snap(textbook, 'textbook-untranslated', 900)
  seen[`${untranslated}（訳なし）`] = await textbook.evaluate(() => ({ notice: document.querySelector('.paper .notice')?.textContent?.slice(0, 160) }))
}

// ほかの画面
const lessonId = lessons[0] ?? untranslated
const views = [
  ['chat', { lessonId }],
  ['note', { lessonId }],
  ['test', {}],
  ['debate', {}],
  ['eikaiwa', {}],
  ['vocab', {}],
  ['kanji', {}],
  ['report', {}],
  ['library', {}],
  ['settings', {}],
]
const pages = {}
for (const [view, params] of views) {
  try {
    const page = await open(home, view, params)
    pages[view] = page
    await page.setViewportSize({ width: 1180, height: 1000 }).catch(() => undefined)
    await snap(page, view, 1200)
  } catch (error) {
    errors.push(`${view}: 開けませんでした（${String(error.message).slice(0, 120)}）`)
  }
}

// AI を呼ぶ機能（--ai のときだけ）
const ai = {}
if (has('ai') && pages.chat) {
  const chat = pages.chat
  const before = await chat.evaluate(() => document.querySelectorAll('.bubble').length)
  await chat.locator('textarea').first().fill('Could you tell me the most important point of this lesson in two sentences?')
  await chat.keyboard.press('Enter')
  await chat.waitForFunction((n) => document.querySelectorAll('.bubble').length >= n + 2 && !document.querySelector('.typing, .bubble-typing'), before, { timeout: 120000 }).catch(() => undefined)
  await chat.waitForTimeout(6000)
  await snap(chat, 'chat-reply', 500)
  ai.chat = await chat.evaluate((id) => window.manabi.chat.load(id, 'sensei').then((log) => log.messages.slice(-1)[0]?.text?.slice(0, 500)), lessonId)
}
// テストの作問（決められた形で返す問い合わせ）。テストを始めるとほかのウィンドウは閉じられるので、最後に、テストの画面から呼ぶ
if (has('ai') && pages.test && lessonId) {
  const courseId = lessonId.replace(/-\d+-\d+$/, '')
  const unitId = `${courseId}-u${lessonId.match(/-(\d+)-\d+$/)[1]}`
  try {
    const session = await pages.test.evaluate((setup) => window.manabi.test.start(setup), { courseId, unitId, lessonIds: [lessonId], questionCount: 3, timeLimitMin: null })
    ai.test = { unit: session.unitTitle, questions: session.questions.map((q) => ({ kind: q.kind, prompt: q.prompt.slice(0, 200), choices: q.choices.map((c) => c.slice(0, 60)) })) }
    await pages.test.waitForTimeout(1500)
    await pages.test.screenshot({ path: join(shots, 'test-questions.png') })
    leftovers['test-questions'] = await japaneseOn(pages.test)
    await pages.test.evaluate(() => window.manabi.test.abort())
  } catch (error) {
    errors.push(`テストの作問: ${String(error.message).slice(0, 200)}`)
  }
}

writeFileSync(join(shots, 'report.json'), JSON.stringify({ seen, leftovers, clipped, errors, ai }, null, 1), 'utf8')
await app.close()
console.log('教科書:', JSON.stringify(seen, null, 1))
const all = Object.entries(leftovers).flatMap(([view, list]) => list.map((text) => `${view}\t${text}`))
console.log(`\n画面に残っている日本語: ${all.length} 個`)
for (const line of all) console.log(line)
const cut = Object.entries(clipped).flatMap(([view, list]) => list.map((text) => `${view}\t${text}`))
console.log(`\nはみ出して隠れている部品: ${cut.length} 個`)
for (const line of cut) console.log(line)
if (has('ai')) console.log('\nAI の返事:', JSON.stringify(ai, null, 1))
console.log(errors.length ? `\nエラー ${errors.length} 件:\n${errors.join('\n')}` : '\nエラーはありません')
