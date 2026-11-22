// 取り寄せた資料画像について、コモンズのページに付いている「権利の表示」をすべて読み直して、控えておく。
//   node tools/photo-layer.mjs
//
// 彫刻・出土品・建物など立体物の写真には、「写っている物」と「写真そのもの」の 2 つの権利がある。
// コモンズのページには「物: 保護期間が終わっている（PD-old）／写真: CC BY-SA」のように 2 つの表示が並ぶことがあり、
// 機械向けの要約（License）は「パブリックドメイン」とだけ返すことがある。写真のほうの条件を見落とさないよう、
// ページに付いている表示（テンプレート）を全部読んで、assets-src/media/public/templates.json（コモンズの題 → 表示の一覧）に控える。
// audit-materials.mjs は、この控えを見て、写真のほうに「継承（SA）・非営利（NC）・改変禁止（ND）・GFDL」などが付いているものを見送る。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outRoot = join(root, 'assets-src', 'media', 'public')
const cacheFile = join(outRoot, 'templates.json')
const UA = { 'User-Agent': 'manabi-materials-tool/0.1 (educational content tool; no contact address)' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/** 権利にかかわる表示だけを残す（言語ごとの部品などは捨てる） */
const KEEP = /^(Cc-|CC-|GFDL|FAL|Art Libre|PD-|PD$|Licensed-|Attribution|Copyrighted|Self$|KOGL|OGL|GODL|Beerware|WTFPL|MIT|BSD|Flickr|BArch-License|Bundesarchiv)/

async function api(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { headers: UA })
    const body = await response.text()
    try {
      return JSON.parse(body)
    } catch {
      // 「問い合わせが多すぎる」と言われたら、間をあけてやり直す
      await sleep(15000 * (attempt + 1))
    }
  }
  throw new Error('コモンズに問い合わせできませんでした')
}

const cache = (existsSync(cacheFile) && readJson(cacheFile)) || {}
const titles = [
  ...new Set(
    readdirSync(join(outRoot, 'items'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(outRoot, 'items', f)))
      .filter((item) => item?.status === '取り寄せた' && item.source?.title)
      .map((item) => item.source.title),
  ),
].filter((title) => !cache[title])

console.log(`これから調べるのは ${titles.length} 件`)
for (let i = 0; i < titles.length; i += 20) {
  const batch = titles.slice(i, i + 20)
  const found = Object.fromEntries(batch.map((t) => [t, []]))
  /** コモンズが題を書きかえて返すことがある（空白や大文字）ので、もとの題に戻す表 */
  const back = {}
  let more = ''
  for (let page = 0; page < 40; page++) {
    const data = await api(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=templates&tllimit=500&tlnamespace=10&titles=${encodeURIComponent(batch.join('|'))}${more}`)
    for (const n of data.query?.normalized ?? []) back[n.to] = n.from
    for (const p of Object.values(data.query?.pages ?? {})) {
      const key = back[p.title] ?? p.title
      if (!found[key]) continue
      for (const t of p.templates ?? []) {
        const name = t.title.replace(/^Template:/, '')
        if (KEEP.test(name) && !name.includes('/')) found[key].push(name)
      }
    }
    if (!data.continue?.tlcontinue) break
    more = `&tlcontinue=${encodeURIComponent(data.continue.tlcontinue)}`
    await sleep(1200)
  }
  for (const [title, list] of Object.entries(found)) cache[title] = [...new Set(list)].sort()
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1), 'utf8')
  console.log(`${Math.min(i + 20, titles.length)}/${titles.length}`)
  await sleep(1500)
}
console.log(`控えた数: ${Object.keys(cache).length}`)
