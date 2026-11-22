// アプリを実際に起動して、授業の流れ（教科書 → ノート → 評価 → ディベート）と、
// テスト・成績・おしゃべりの各モードを一周させる確認スクリプト。
//
//   npm run build && npm run smoke              画面の確認だけ（AI は呼ばない）
//   npm run build && npm run smoke -- --ai      AI も実際に呼ぶ（ログイン済みの claude / codex を使う）
//   npm run build && npm run smoke -- --ai --codex   AI を codex に切り替えて確認する
//   npm run build && npm run smoke -- --generate     未作成の授業を AI に書かせる確認も行う
//
// データは .smoke/ 以下に作り、ふだんのノートや設定には触れない。画面の写真も .smoke/ に保存する。
import electronPath from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const withAi = process.argv.includes('--ai')
const useCodex = process.argv.includes('--codex')
const withGenerate = process.argv.includes('--generate')
const root = resolve(import.meta.dirname, '..')
const outDir = join(root, '.smoke')
const dataDir = join(outDir, 'data')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const pdfPath = join(outDir, 'note.pdf')
// 先生役を入れ替える前（エレン先生のころ）の設定と会話の記録を置いておき、起動時に新しい先生へ引きつがれるかを確かめる
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({ characterId: 'ellen', characterOverrides: { ellen: { name: '前の先生' } }, ...(useCodex ? { ai: { provider: 'codex', model: '', effort: 'low' } } : {}) }),
)
mkdirSync(join(dataDir, 'chats', 'hsp-shogyo-boki-2-1'), { recursive: true })
writeFileSync(
  join(dataDir, 'chats', 'hsp-shogyo-boki-2-1', 'ellen.json'),
  JSON.stringify({ lessonId: 'hsp-shogyo-boki-2-1', characterId: 'ellen', messages: [{ id: 'old-1', role: 'user', text: '前の先生への質問', at: 1 }] }),
)
// 先週の水曜日に 30 分学習した記録を置いておき、起動時に「先週の評価」が確定するかを確かめる。
// 継続力は 学習した日 1 日（10 点）+ 合計 30 分（5 点）= 15 点、好感度は総合 5 点につき 1 なので全員 +3 になるはず。
const lastWednesday = new Date()
lastWednesday.setDate(lastWednesday.getDate() - ((lastWednesday.getDay() + 6) % 7) - 5)
const dayKey = `${lastWednesday.getFullYear()}-${String(lastWednesday.getMonth() + 1).padStart(2, '0')}-${String(lastWednesday.getDate()).padStart(2, '0')}`
writeFileSync(join(dataDir, 'usage.json'), JSON.stringify({ [dayKey]: { 'jhs1-math': 30 * 60 } }))
// グラフと図の表示を確かめるための授業（1-5）。図には、通してはいけない要素や属性もわざと混ぜてある
mkdirSync(join(dataDir, 'lessons'), { recursive: true })
writeFileSync(
  join(dataDir, 'lessons', 'jhs1-math-1-5.md'),
  [
    '# 図の表示の確認',
    '',
    '```plot',
    '{"xMin": -5, "xMax": 5, "yMin": -5, "yMax": 5, "functions": [{"expr": "2*x+1", "label": "y=2x+1"}, {"expr": "6/x", "label": "y=6/x"}], "points": [{"x": 1, "y": 3, "label": "A"}]}',
    '```',
    '',
    '```figure',
    '<svg viewBox="0 0 200 120"><polygon points="20,100 180,100 100,20" fill="none" stroke="#2c2a35" stroke-width="2"/><text x="100" y="115" font-size="12" text-anchor="middle">底辺</text><script>window.hacked = true</script><rect x="0" y="0" width="10" height="10" onclick="window.hacked = true" fill="url(javascript:alert(1))"/><image href="https://example.com/x.png"/></svg>',
    '```',
  ].join('\n'),
)

// 高校の専門教科（商業の簿記）の単元表と授業を 1 つ置いておく（科目の名前と、注意書きの表示を確かめる）
mkdirSync(join(dataDir, 'curricula'), { recursive: true })
writeFileSync(
  join(dataDir, 'curricula', 'hsp-shogyo-boki.json'),
  JSON.stringify({
    units: [
      { domain: '簿記の原理', title: '簿記のしくみ', summary: '簿記の目的と、取引を記録する流れを学ぶ。', lessons: [{ title: '簿記とは', summary: '簿記の目的、資産・負債・純資産' }, { title: '仕訳と転記', summary: '取引を仕訳し、総勘定元帳に転記する' }] },
      { domain: '決算', title: '決算', summary: '1 年間の記録をまとめる。', lessons: [{ title: '決算の流れ', summary: '試算表、決算整理、財務諸表' }] },
    ],
  }),
)
writeFileSync(
  join(dataDir, 'lessons', 'hsp-shogyo-boki-1-1.md'),
  [
    '# 簿記とは',
    '',
    '## この授業のねらい',
    '- 簿記の目的を説明できる。',
    '',
    // 掛け合い: 先生、同級生（持っていない表情を指定 → ふだんの表情になる）、登場人物でない名前（札で表す）
    '```talk',
    'sensei(point): 今日は、**簿記**の入り口です。',
    's03(nothing): 簿記って、おこづかい帳みたいなもの？',
    '渋沢栄一: 記録は、信用のもとですぞ。',
    'ナポレオン: わたしの辞書にも、帳簿はある。',
    '```',
    '',
    '## 簿記の目的',
    '**簿記**は、会社のお金やものの動きを、決まった方法で記録するしくみです。',
    '',
  ].join('\n'),
)

// 動く図解（10 種類すべて）と挿絵の表示を確かめるための授業（1-2）。値は、範囲の外のものもわざと混ぜてある（範囲の中に丸められる）
const simBlocks = [
  { kind: 'fraction', values: { n1: 1, d1: 2, n2: 2, d2: 4 }, task: '分母がちがっても、同じ大きさになる分数をさがしましょう。' },
  { kind: 'graph', expr: 'a*x^2+b*x+c', label: 'y = ax^2 + bx + c', range: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, values: { a: 1, b: 0, c: -2 }, task: '$a$ の値を変えると、グラフの開き方はどうなるでしょうか。' },
  { kind: 'dice', choices: { event: 'one' }, task: '投げる回数を増やすと、1 の目が出る割合はどうなるでしょうか。' },
  { kind: 'unitcircle', values: { angle: 30 }, task: '角を大きくすると、sin と cos の値はどう変わるでしょうか。' },
  { kind: 'pendulum', values: { length: 50, angle: 20, mass: 50 }, task: 'ふりこの長さを変えると、1 往復の時間はどうなるでしょうか。' },
  { kind: 'lever', values: { leftWeight: 30, leftArm: 4, rightWeight: 20, rightArm: 6 }, task: 'つり合うのは、どんなときでしょうか。' },
  { kind: 'spring', values: { weights: 3, stretch: 5 }, task: 'おもりを 2 倍にすると、ばねののびはどうなるでしょうか。' },
  { kind: 'circuit', values: { voltage: 6, r1: 10, r2: 20 }, choices: { wiring: 'series' }, task: 'つなぎ方を変えると、電流はどうなるでしょうか。' },
  { kind: 'lens', values: { focal: 10, distance: 30 }, task: '物体をレンズに近づけると、像はどうなるでしょうか。' },
  { kind: 'moon', values: { position: 90, extra: 999 }, task: '月の位置を変えると、形はどう見えるでしょうか。' },
]
writeFileSync(
  join(dataDir, 'lessons', 'hsp-shogyo-boki-1-2.md'),
  ['# 図解と挿絵の表示の確認', '', '## この授業のねらい', '- 表示を確かめる。', '', '## 動く図解', '', ...simBlocks.flatMap((spec) => ['```sim', JSON.stringify(spec), '```', '']), '## 挿絵', '', '```picture', '{"id": "smoke-picture", "caption": "確認用の挿絵"}', '```', '', '```picture', '{"id": "missing", "caption": "画像が無い挿絵（何も出ない）"}', '```', '', '```picture', '{"id": "smoke-public", "caption": "確認用の資料"}', '```', '', '```picture', '{"id": "smoke-unsafe", "caption": "あやしい行き先の資料"}', '```', ''].join('\n'),
)
// 挿絵と、歴史上の人物の絵（画像は、先生の顔で代用する）
mkdirSync(join(dataDir, 'media'), { recursive: true })
copyFileSync(join(root, 'src', 'renderer', 'public', 'characters', 'sensei', 'face1.png'), join(dataDir, 'media', 'smoke.png'))
writeFileSync(
  join(dataDir, 'media', 'media.json'),
  JSON.stringify({ pictures: { 'smoke-picture': { file: 'smoke.png', kind: 'generated', alt: '確認用の絵' }, 'smoke-public': { file: 'smoke.png', kind: 'public', credit: '確認用の作者／確認用の提供元（パブリックドメイン）', source: 'https://example.org/page' }, 'smoke-unsafe': { file: 'smoke.png', kind: 'public', credit: '確認用の出典', source: 'javascript:alert(1)' } }, people: { 渋沢栄一: { file: 'smoke.png', kind: 'public', credit: '確認用の出典' } } }),
)

// 動画（試作）の確認用: 台本と、短い無音の音声を置いておく（AI と読み上げソフトは呼ばない）
{
  const say = (speaker, text, more = {}) => ({ speaker, expression: 'smile', text, say: text, show: 0, set: {}, ...more })
  const videoScript = {
    checked: true,
    scenes: [
      { kind: 'title', heading: '動画の確認', items: ['確認用の副題'], ref: '', lines: [say('sensei', 'はじめのせりふです。')] },
      { kind: 'board', heading: '板書の確認', items: ['一つ目の項目', '二つ目の **項目**'], ref: '', lines: [say('sensei', '一つ目を見せます。', { show: 1 }), say('s01', '二つ目も出ました。', { show: 2 })] },
      { kind: 'sim', heading: '図解の確認', items: [], ref: '', lines: [say('sensei', '分数を動かします。', { set: { n1: 3, d1: 4 } })] },
      { kind: 'picture', heading: '挿絵の確認', items: [], ref: 'smoke-picture', lines: [say('sensei', '最後のせりふです。')] },
    ],
  }
  const videoDir = join(dataDir, 'videos', 'hsp-shogyo-boki-1-2')
  mkdirSync(join(videoDir, 'audio'), { recursive: true })
  writeFileSync(join(videoDir, 'script.json'), JSON.stringify(videoScript))
  // 0.25 秒の無音（8000 Hz・16 ビット・モノラル）
  const samples = 2000
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  const count = videoScript.scenes.flatMap((scene) => scene.lines).length
  for (let i = 0; i < count; i++) writeFileSync(join(videoDir, 'audio', String(i).padStart(3, '0') + '.wav'), wav)
  writeFileSync(join(videoDir, 'audio.json'), JSON.stringify({ voice: '確認用の声', lines: Array.from({ length: count }, () => ({ hash: 'smoke', seconds: 0.25, kana: '' })) }))
}

// 語彙力特訓の言葉を先に置いておく（AI に作らせると 1 分ほどかかるため）。言葉ごとに、合格するはずの書きこみも決めておく
const vocabWords = [
  ['把握', 'はあく', 'ものごとの様子や内容を、しっかりとつかんで理解すること。', ['先生は、クラス全員の様子を把握している。', '問題の内容を正しく把握してから、解きはじめる。']],
  ['根拠', 'こんきょ', '考えや判断のもとになる理由や事実。', ['意見を言うときは、根拠を示すことが大切だ。', 'そのうわさには、はっきりした根拠がない。']],
  ['過程', 'かてい', 'ものごとが進んでいく途中の道すじ。', ['結果だけでなく、過程も大切にしたい。', '植物が育つ過程を観察する。']],
  ['維持', 'いじ', 'いまの状態を、そのまま保ちつづけること。', ['健康を維持するために、毎日歩いている。', 'チームは首位を維持した。']],
  ['影響', 'えいきょう', 'あるものごとが、ほかのものごとに変化をあたえること。', ['天気は、野菜の値段に影響する。', '友だちの影響で、本を読むようになった。']],
  ['工夫', 'くふう', 'よい方法を、いろいろと考えること。', ['ノートの取り方を工夫する。', '少ない材料でも、工夫すればおいしく作れる。']],
].map(([word, reading, meaning, examples], i) => ({ id: `w${i + 1}`, word, reading, pos: '名詞', meaning, examples: examples.map((text) => ({ text, translation: '' })) }))
mkdirSync(join(dataDir, 'vocab'), { recursive: true })
writeFileSync(join(dataDir, 'vocab', 'ja-jhs.json'), JSON.stringify({ words: vocabWords, cleared: [], skipped: [] }))

// 漢字特訓の言葉と例文を先に置いておく（習う順のはじめの 6 字ぶん）
const kanjiWords = Object.fromEntries(
  [
    ['一', [['一つ', 'ひとつ'], ['一月', 'いちがつ'], ['一年', 'いちねん']], ['りんごを一つ食べる。', '一月は冬です。']],
    ['右', [['右手', 'みぎて'], ['右がわ', 'みぎがわ'], ['左右', 'さゆう']], ['右手をあげる。', '道の右がわを歩く。']],
    ['雨', [['雨', 'あめ'], ['大雨', 'おおあめ'], ['雨天', 'うてん']], ['雨がふってきた。', '大雨で川の水がふえる。']],
    ['円', [['百円', 'ひゃくえん'], ['円い', 'まるい'], ['円', 'えん']], ['百円玉を一まいもらう。', '円いおさらをならべる。']],
    ['王', [['王さま', 'おうさま'], ['王子', 'おうじ'], ['女王', 'じょおう']], ['王さまのおしろを見る。', '王子が馬にのる。']],
    ['音', [['音', 'おと'], ['音楽', 'おんがく'], ['足音', 'あしおと']], ['大きな音が聞こえる。', '音楽の時間が楽しみだ。']],
  ].map(([char, words, sentences]) => [char, { words: words.map(([word, reading]) => ({ word, reading, meaning: '（確認用）' })), sentences }]),
)
mkdirSync(join(dataDir, 'kanji'), { recursive: true })
writeFileSync(join(dataDir, 'kanji', 'words.json'), JSON.stringify(kanjiWords))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const app = await electron.launch({
  executablePath: electronPath,
  args: [root],
  env: {
    ...process.env,
    MANABI_DATA_DIR: dataDir,
    MANABI_PDF_PATH: pdfPath,
    // 画像を選ぶ画面を出さずに、この画像を貼る
    MANABI_PICK_IMAGE: join(root, 'src', 'renderer', 'public', 'characters', 'sensei', 'face1.png'),
    // 学習時間の記録を短い間隔で行い、自動操作でも「操作している」とみなす
    MANABI_USAGE_TICK_MS: '1000',
    MANABI_IDLE_LIMIT_S: '999999',
    // AI に見せる画像を書き出す。AI を使わない確認では、AI を呼ぶ手前で止める
    MANABI_DUMP_DIR: outDir,
    MANABI_NO_AI: withAi ? '' : '1',
  },
})
const errors = []
const watch = (win, label) => {
  win.on('pageerror', (e) => errors.push(`${label}: ${e.message}`))
  win.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`))
}
const shot = (win, name) => win.screenshot({ path: join(outDir, `${name}.png`) })
/** 教科書といっしょに自動で開くノートのウィンドウか（ボタンで開いたウィンドウとは別に、あとから出てくる） */
const isCompanion = async (win) => {
  await win.waitForLoadState('domcontentloaded').catch(() => {})
  const found = await win.evaluate(() => window.manabi.view.get()).catch(() => null)
  return found?.view === 'note' && !!found.params?.beside
}
const notCompanion = { predicate: async (win) => !(await isCompanion(win)) }
/** ボタンを押して開いた新しいウィンドウを受け取る */
const opened = async (action, label) => {
  const [win] = await Promise.all([app.waitForEvent('window', notCompanion), action()])
  await win.waitForLoadState('domcontentloaded')
  watch(win, label)
  return win
}

/** もう開いているウィンドウの中から、画面の種類（と、授業の番号の終わり）で探す。教科書で授業を開くと、その授業のノートも自動で開くので、ノートはこれで受け取る */
const watched = new Set()
const windowOf = async (view, label, lessonEnds = '', timeout = 20000) => {
  const until = Date.now() + timeout
  for (;;) {
    for (const win of app.windows().slice().reverse()) {
      const found = await win.evaluate(() => window.manabi.view.get()).catch(() => null)
      if (found?.view !== view || (lessonEnds && !String(found.params?.lessonId ?? '').endsWith(lessonEnds))) continue
      await win.waitForLoadState('domcontentloaded')
      if (!watched.has(win)) watch(win, label)
      watched.add(win)
      return win
    }
    if (Date.now() > until) throw new Error(view + ' の画面が開いていません')
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * OS が実際に表示している画面から、アプリのウィンドウの部分だけを取り込み、黒い画素の割合を返す。
 *
 * win.screenshot() で撮れるのは画面合成の前の絵なので、表示の段階で起きる不具合
 * （例: 低遅延描画を指定した層が、実際の画面では真っ黒に表示される）は写らない。
 * そこで、最終的に画面へ出ている絵を別途取り込んで確かめる。取り込めなかった場合は null。
 */
async function realScreen(titlePart, name) {
  const result = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, titlePart) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(titlePart))
    if (!win) return null
    win.moveTop()
    await new Promise((r) => setTimeout(r, 600))
    const bounds = win.getContentBounds()
    const display = screen.getDisplayMatching(bounds)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) return null
    const full = source.thumbnail.getSize()
    const scale = full.width / display.bounds.width
    const x = Math.max(0, Math.round((bounds.x - display.bounds.x) * scale))
    const y = Math.max(0, Math.round((bounds.y - display.bounds.y) * scale))
    const width = Math.min(full.width - x, Math.round(bounds.width * scale))
    const height = Math.min(full.height - y, Math.round(bounds.height * scale))
    if (width < 50 || height < 50) return null
    // ほかのウィンドウが写りこまないよう、このアプリの部分だけを切り出す
    const image = source.thumbnail.crop({ x, y, width, height })
    const pixels = image.toBitmap()
    let dark = 0
    let total = 0
    for (let i = 0; i < pixels.length; i += 16) {
      total++
      if (pixels[i] < 16 && pixels[i + 1] < 16 && pixels[i + 2] < 16) dark++
    }
    return { png: image.toPNG().toString('base64'), dark: dark / total }
  }, titlePart)
  if (!result) return null
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.png, 'base64'))
  return result.dark
}

/** 筆圧つきのペン入力を再現する。points は [横位置, 縦位置, 筆圧]（位置はページに対する 0〜1 の割合） */
async function penStroke(win, pageIndex, points, { eraser = false } = {}) {
  await win.evaluate(
    async ({ pageIndex, points, eraser }) => {
      // ノートは 1 ページずつ見せるので、見開きの右ページ（1）を指していても、いま見えているページに書く
      const pages = document.querySelectorAll('.note-page')
      const el = pages[Math.min(pageIndex, pages.length - 1)]
      const rect = el.getBoundingClientRect()
      const fire = (type, [x, y, pressure], buttons) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 11, pointerType: 'pen', isPrimary: true,
            clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height,
            pressure, tiltX: 24, tiltY: -12,
            button: type === 'pointermove' ? -1 : eraser ? 5 : 0, buttons,
          }),
        )
      const down = eraser ? 32 : 1
      fire('pointerdown', points[0], down)
      for (const point of points.slice(1)) {
        fire('pointermove', point, down)
        await new Promise((r) => setTimeout(r, 3))
      }
      const last = points[points.length - 1]
      fire('pointerup', [last[0], last[1], 0], 0)
    },
    { pageIndex, points, eraser },
  )
}
const line = (x0, y0, x1, y1, pressure = 0.5, steps = 24) =>
  Array.from({ length: steps + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, pressure])
/** 返答が出そろう（送信ボタンが「送る」にもどる）まで待つ */
const replied = async (win) => {
  await win.waitForSelector('.bubble-assistant .md', { timeout: 120000 })
  await win.getByRole('button', { name: '送る' }).waitFor({ timeout: 120000 })
}

try {
  // ───────── ホーム ─────────
  const home = await app.firstWindow()
  watch(home, 'home')
  await home.waitForSelector('.lesson-row')
  check('ホーム: 単元と授業の一覧が出る', (await home.locator('.unit').count()) === 7)
  check('ホーム: なかまが 21 人（先生と、同級生 20 人）表示される', (await home.locator('.people li').count()) === 21)
  // 先生は みのり先生。顔の画像が、全員ぶん読みこめている
  await home.waitForFunction(() => [...document.querySelectorAll('.portrait img')].every((img) => img.complete))
  const teacherName = await home.locator('.home-hello strong').innerText()
  const brokenFaces = await home.evaluate(() => [...document.querySelectorAll('.portrait img')].filter((img) => img.naturalWidth === 0).length)
  check('ホーム: 先生は「みのり先生」で、全員の顔の画像が表示される', teacherName === 'みのり先生' && brokenFaces === 0, `${teacherName} / 読めない画像 ${brokenFaces}`)
  const cast = JSON.parse(readFileSync(join(root, 'resources', 'content', 'characters.json'), 'utf8'))
  const missingFaces = cast.flatMap((c) => [...Object.values(c.expressions), c.full].filter((f) => !existsSync(join(root, 'src', 'renderer', 'public', 'characters', c.id, f))).map((f) => `${c.id}/${f}`))
  check('登場人物: 表情と立ち絵の画像がすべてそろっている（先生は表情 11 種類）', missingFaces.length === 0 && cast[0].id === 'sensei' && Object.keys(cast[0].expressions).length === 11, missingFaces.join('、'))
  const movedSettings = await home.evaluate(() => window.manabi.settings.get())
  const movedChat = join(dataDir, 'chats', 'hsp-shogyo-boki-2-1')
  check(
    '先生の入れ替え: 前の先生の設定と会話の記録が、新しい先生に引きつがれる',
    movedSettings.characterId === 'sensei' && !('ellen' in movedSettings.characterOverrides) && existsSync(join(movedChat, 'sensei.json')) && !existsSync(join(movedChat, 'ellen.json')),
    JSON.stringify(movedSettings.characterId),
  )
  // 掛け合いの差しこみと取りのぞき（本文には手を入れない）
  const { insertTalk, stripTalk, parseTalk } = await import('../src/shared/talk.ts')
  const plain = ['# 題', '', '## この授業のねらい', '- ねらい', '', '## 本文', '説明', '', '```figure', '## 図の中の行', '```', '', '## 例題', '例', '', '## 確かめ問題', '1. 問い', ''].join('\n')
  const withTalk = insertTalk(plain, { intro: [{ speaker: 'sensei', expression: 'smile', text: 'はじめます。' }, { speaker: 's01', expression: '', text: 'はい！' }], check: [{ speaker: 's01', expression: 'thinking', text: 'ここ、まちがえそう。' }, { speaker: 'sensei', expression: 'point', text: 'いいところに気がつきましたね。' }] })
  const talkAt = withTalk.split('\n').flatMap((l, i) => (l === '```talk' ? [i] : []))
  const linesOf = withTalk.split('\n')
  check(
    '掛け合い: 導入は本文の最初の見出しの前、確認は「確かめ問題」の前に入り、取りのぞくと元の本文にもどる',
    talkAt.length === 2 && linesOf[talkAt[0] + 5] === '## 本文' && linesOf[talkAt[1] + 5] === '## 確かめ問題' && stripTalk(withTalk) === plain && parseTalk('sensei(point): あ\ns01: い：う').length === 2,
    JSON.stringify(talkAt),
  )
  await home.waitForTimeout(400)
  await shot(home, '1-home')

  // ───────── 教科書 ─────────
  const textbook = await opened(() => home.locator('.lesson-row').nth(2).getByRole('button', { name: '教科書' }).click(), 'textbook')
  await textbook.waitForSelector('.md h1')
  check('教科書: 本文が表示される', (await textbook.locator('.md h1').innerText()) === '加法')
  check('教科書: 数直線の図が描かれる', (await textbook.locator('.numberline svg').count()) === 3)
  check('教科書: 数式が組まれる', (await textbook.locator('.md .katex').count()) > 20)
  await textbook.waitForTimeout(500)
  await shot(textbook, '2-textbook')

  // まだ用意されていない授業は、AI に作ってもらう案内が出る
  await textbook.getByRole('button', { name: '1-4 減法', exact: true }).click()
  await textbook.waitForSelector('.paper-empty')
  check('教科書: 未作成の授業に生成ボタンが出る', await textbook.getByRole('button', { name: 'AI に教科書を作ってもらう' }).isVisible())
  // グラフと図: 式から曲線が描かれ、図は使ってよい要素と属性だけが残る
  await textbook.getByRole('button', { name: '1-5 加法と減法の混じった計算', exact: true }).click()
  await textbook.waitForSelector('.plot svg')
  const drawn = await textbook.evaluate(() => ({
    curves: document.querySelectorAll('.plot svg g path').length,
    polygon: document.querySelectorAll('.figure svg polygon').length,
    script: document.querySelectorAll('.figure script, .figure image').length,
    onclick: document.querySelector('.figure rect')?.hasAttribute('onclick'),
    fill: document.querySelector('.figure rect')?.getAttribute('fill'),
    hacked: window.hacked === true,
  }))
  check('教科書: 式から関数のグラフが描かれる', drawn.curves === 2)
  check('教科書: 図は安全な要素と属性だけが表示される', drawn.polygon === 1 && drawn.script === 0 && drawn.onclick === false && drawn.fill === null && !drawn.hacked, JSON.stringify(drawn))
  await textbook.waitForTimeout(300)
  await shot(textbook, '2-textbook-plot')
  await textbook.getByRole('button', { name: '1-3 加法', exact: true }).click()
  await textbook.waitForSelector('.md h1')

  // ───────── ノート ─────────
  // 教科書で授業（1-3）を開いたので、そのノートは、もう利き手の側（右）に開いている
  const note = await windowOf('note', 'note', '-1-3')
  check('教科書: 授業を開くと、その授業のノートも開く', !!note)
  await note.bringToFront()
  await note.waitForSelector('.note-page canvas')
  await note.waitForTimeout(400)
  check('ノート: 1 ページずつ出る', (await note.locator('.spread > .note-page').count()) === 1)
  check('ノート: 道具の列が、利き手の側（右）に縦に出る', await note.evaluate(() => { const bar = document.querySelector('.note-bar').getBoundingClientRect(); return bar.height > bar.width * 3 && bar.left > innerWidth / 2 }))

  // キーボードで文字を入力する
  await note.getByRole('button', { name: '文字', exact: true }).click()
  const typeAt = async (pageIndex, x, y, text) => {
    const box = await note.locator('.note-page').first().boundingBox()
    await note.mouse.click(box.x + box.width * x, box.y + box.height * y)
    await note.keyboard.type(text)
    await note.locator('.note-bar').click({ position: { x: 5, y: 5 } })
  }
  await typeAt(0, 0.08, 0.085, '加法（たし算）のまとめ')
  await typeAt(0, 0.08, 0.16, '正の数をたす＝数直線を右へ進む。負の数をたす＝左へ進む。スタートはいつも 0。')
  await typeAt(0, 0.08, 0.27, '同じ符号どうし → 進む向きが同じなので、きょりを合わせて、同じ符号をつける。')
  await typeAt(0, 0.08, 0.38, 'ちがう符号どうし → 行って戻るので、きょりの差。遠くまで進んだほうの符号になる。')
  await typeAt(0, 0.08, 0.49, '自分の例：バスケの試合。前半 +3 点差、後半 −5 点差なら (+3)+(−5)=−2 で 2 点負け。')
  await typeAt(0, 0.08, 0.6, '気づき：理科の気温も同じ。朝 −2℃ から 5℃ 上がると (−2)+(+5)=+3℃。社会の時差にも使えそう。')
  check('ノート: 入力した文字が残る', (await note.locator('.note-text').count()) === 6)

  // ペンで数直線と矢印を書く（筆圧を変えながら）
  await note.getByRole('button', { name: 'ペン', exact: true }).click()
  await penStroke(note, 1, line(0.1, 0.2, 0.9, 0.2, 0.55, 40))
  for (let i = 0; i <= 8; i++) await penStroke(note, 1, line(0.1 + i * 0.1, 0.19, 0.1 + i * 0.1, 0.21, 0.5, 4))
  await note.getByRole('button', { name: '赤' }).click()
  await penStroke(note, 1, [...line(0.5, 0.16, 0.8, 0.16, 0.6, 20), [0.78, 0.15, 0.6], [0.8, 0.16, 0.6], [0.78, 0.17, 0.6]])
  await note.getByRole('button', { name: '青' }).click()
  await penStroke(note, 1, [...line(0.8, 0.13, 0.3, 0.13, 0.6, 30), [0.32, 0.12, 0.6], [0.3, 0.13, 0.6], [0.32, 0.14, 0.6]])
  // 筆圧の確認用: 弱い → 強い → 弱い の波線
  await note.getByRole('button', { name: '黒' }).click()
  const wave = Array.from({ length: 81 }, (_, i) => [0.1 + i * 0.01, 0.34 + Math.sin(i / 6) * 0.025, 0.05 + 0.95 * Math.sin((Math.PI * i) / 80)])
  await penStroke(note, 1, wave)
  await note.getByRole('button', { name: 'マーカー' }).click()
  await penStroke(note, 1, line(0.1, 0.44, 0.6, 0.44, 0.5, 20))
  // 消される線を 1 本書いて、ペンの後ろ側（消しゴム）で消す
  await note.getByRole('button', { name: 'ペン', exact: true }).click()
  await penStroke(note, 1, line(0.1, 0.6, 0.9, 0.6, 0.5, 20))
  await penStroke(note, 1, line(0.5, 0.55, 0.5, 0.65, 0.5, 10), { eraser: true })

  await note.evaluate(() => window.__manabiFlush?.())
  check('ノート: 自動で保存される', (await note.locator('.save-state').innerText()) === '保存済み')
  await shot(note, '3-note')

  // 線を書いたあと、実際の画面でページが白いままか（黒く塗りつぶされていないか）
  const dark = await realScreen('ノート', '3-note-real-screen')
  if (dark === null) console.log('--   ノート: 実際の画面は取り込めなかったため、この確認は省きました')
  else check('ノート: 実際の画面でもページが黒くならない', dark < 0.08, `黒い画素 ${(dark * 100).toFixed(1)}%`)

  // 元に戻す・やり直す
  await note.getByRole('button', { name: '戻す', exact: true }).click()
  await note.getByRole('button', { name: 'やり直す' }).click()

  // ペン診断
  await note.getByRole('button', { name: 'ペン診断' }).click()
  await note.waitForTimeout(400)
  const verdict = await note.locator('.pen-diag-verdict').innerText()
  check('ノート: ペン診断が筆圧を検知する', verdict.includes('筆圧を検知できています'), verdict.slice(0, 30))
  check('ノート: ペンの消しゴム側を認識する', (await note.locator('.pen-diag dd').last().innerText()) === '認識しました')
  await shot(note, '3-note-pen')

  // 罫線の切り替え、ページの追加、検索
  await note.getByRole('button', { name: '罫線' }).click()
  await note.getByRole('button', { name: '方眼' }).click()
  await note.getByRole('button', { name: '5mm', exact: true }).click()
  await note.getByRole('button', { name: '横罫' }).click()
  check('ノート: 罫線の間隔に、大きいもの（20mm まで）を選べる', (await note.getByRole('button', { name: '20mm' }).count()) === 1)
  await note.getByRole('button', { name: '7mm' }).click()
  await note.getByRole('button', { name: '閉じる' }).first().click()
  await note.getByRole('button', { name: '＋ ページを追加' }).click()
  check('ノート: ページを追加できる', (await note.locator('.pager-now').innerText()).startsWith('3 / 4'))

  // ───────── ノートの部品（図形・表・座標平面・画像・リンク） ─────────
  // 追加した 2 ページ（3・4 ページめ）で試す。ノートは 1 ページずつ見せるので、書く前に、そのページを出す（0 = 3 ページめ、1 = 4 ページめ）
  const showAdded = async (pageIndex) => {
    for (let i = 0; i < 3 && !(await note.locator('.pager-now').innerText()).startsWith((3 + pageIndex) + ' / 4'); i += 1) {
      await note.getByRole('button', { name: pageIndex ? '次へ ›' : '‹ 前へ' }).click()
      await note.waitForTimeout(200)
    }
  }
  const dragOn = async (pageIndex, from, to) => {
    await showAdded(pageIndex)
    const box = await note.locator('.note-page').first().boundingBox()
    await note.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
    await note.mouse.down()
    await note.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 })
    await note.mouse.up()
  }
  await note.getByRole('button', { name: '図形' }).click()
  await note.getByRole('button', { name: '矢印' }).click()
  await dragOn(1, [0.2, 0.15], [0.75, 0.24])
  await note.getByRole('button', { name: '四角' }).click()
  await dragOn(1, [0.2, 0.34], [0.62, 0.5])
  await note.getByRole('button', { name: '円', exact: true }).click()
  await dragOn(1, [0.3, 0.58], [0.7, 0.8])
  // 表・座標平面・画像・リンクは、3 ページめに入れる
  await showAdded(0)

  const openInsert = () => note.getByRole('button', { name: '挿入' }).click()
  await openInsert()
  await note.getByRole('button', { name: '表を入れる' }).click()
  await note.locator('.note-table-cells input').nth(0).fill('x')
  await note.locator('.note-table-cells input').nth(1).fill('−2')
  await note.locator('.note-table-cells input').nth(2).fill('3')
  await note.locator('.note-table-cells input').nth(3).fill('y')
  await note.keyboard.press('Tab')
  await note.getByRole('button', { name: '行＋' }).click()
  const grew = await note
    .waitForFunction(() => document.querySelectorAll('.note-table-cells input').length === 12, null, { timeout: 3000 })
    .then(() => true, () => false)
  check('ノート: 表を入れて、文字を書き、行を増やせる', grew)
  await openInsert()
  await note.getByRole('button', { name: '座標平面を入れる' }).click()
  await openInsert()
  await note.getByLabel('リンクのアドレス').fill('https://www.mext.go.jp/')
  await note.getByLabel('リンクの見出し').fill('文部科学省')
  await note.getByRole('button', { name: '入れる', exact: true }).click()
  // つまみをつかんで、リンクを少し右へ動かす
  const grip = await note.locator('.note-select-grip').boundingBox()
  await note.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await note.mouse.down()
  await note.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2, { steps: 5 })
  await note.mouse.up()
  await openInsert()
  await note.getByRole('button', { name: '画像を選ぶ' }).click()
  await note.waitForSelector('.note-select[data-kind="image"]')

  // 部品の上からペンで書きこむ
  await note.getByRole('button', { name: 'ペン', exact: true }).click()
  await note.getByRole('button', { name: '赤' }).click()
  await penStroke(note, 0, line(0.3, 0.62, 0.7, 0.42, 0.6, 30))
  await note.evaluate(() => window.__manabiFlush?.())
  await shot(note, '3-note-objects')

  const readNote = () =>
    note.evaluate(async () => {
      const { params } = await window.manabi.view.get()
      return window.manabi.notes.get(params.notebookId)
    })
  let placed = (await readNote()).pages.flatMap((p) => p.objects ?? [])
  const kinds = placed.map((o) => (o.type === 'shape' ? o.kind : o.type === 'link' ? o.kind : o.type)).sort().join(',')
  check('ノート: 図形・表・座標平面・画像・リンクが保存される', kinds === 'arrow,ellipse,graph,image,link,rect,table', kinds)
  check('ノート: 表に書いた文字が保存される', placed.find((o) => o.type === 'table')?.cells[0].join('|') === 'x|−2|3')
  check('ノート: 部品を動かせる', placed.find((o) => o.type === 'link')?.x > (1820 - 1000) / 2 + 20)

  const darkObjects = await realScreen('ノート', '3-note-objects-real-screen')
  if (darkObjects !== null) check('ノート: 部品を置いても、実際の画面で正しく表示される', darkObjects < 0.08, `黒い画素 ${(darkObjects * 100).toFixed(1)}%`)

  // 選んで消す
  await note.getByRole('button', { name: '選択' }).click()
  const imageBox = await note.locator('.note-page').nth(0).boundingBox()
  const image = placed.find((o) => o.type === 'image')
  await note.mouse.click(imageBox.x + (imageBox.width * (image.x + image.w / 2)) / 1820, imageBox.y + (imageBox.height * (image.y + image.h / 2)) / 2570)
  await note.getByRole('button', { name: '消す' }).click()
  await note.evaluate(() => window.__manabiFlush?.())
  placed = (await readNote()).pages.flatMap((p) => p.objects ?? [])
  check('ノート: 選んだ部品を消せる', !placed.some((o) => o.type === 'image') && placed.length === 6, `${placed.length} 個`)

  // 範囲選択: M キーで選択に切りかえ、右ページ（図形 3 つ）を四角で囲んで Delete で消す
  await note.locator('.note-bar').click({ position: { x: 5, y: 5 } })
  await note.keyboard.press('m')
  await dragOn(1, [0.05, 0.05], [0.95, 0.9])
  const grouped = await note.waitForSelector('.note-group', { timeout: 3000 }).then(() => true, () => false)
  await note.keyboard.press('Delete')
  await note.evaluate(() => window.__manabiFlush?.())
  placed = (await readNote()).pages.flatMap((p) => p.objects ?? [])
  check('ノート: 範囲を選んで、その中だけを消せる', grouped && placed.length === 3, `${placed.length} 個残り`)

  // Delete キー: 触れたページの書きこみを全部消す → Ctrl + Z で元に戻す
  await showAdded(0)
  const left = await note.locator('.note-page').nth(0).boundingBox()
  await note.mouse.click(left.x + left.width * 0.92, left.y + left.height * 0.95)
  await note.keyboard.press('Delete')
  await note.evaluate(() => window.__manabiFlush?.())
  const cleared = (await readNote()).pages[2]
  await note.keyboard.press('Control+z')
  await note.evaluate(() => window.__manabiFlush?.())
  const restored = (await readNote()).pages[2]
  check('ノート: Delete でページの書きこみを全部消し、元に戻せる', cleared.strokes.length + (cleared.objects ?? []).length === 0 && (restored.objects ?? []).length === 3)

  // ← → でページを移動する
  await note.keyboard.press('ArrowLeft')
  const onFirst = (await note.locator('.pager-now').innerText()).startsWith('2 / 4')
  await note.keyboard.press('ArrowRight')
  check('ノート: ← → でページを移動できる', onFirst && (await note.locator('.pager-now').innerText()).startsWith('3 / 4'))

  // スペース + ドラッグでページをつかんで動かす
  const stage = await note.locator('.note-stage').boundingBox()
  await note.keyboard.down(' ')
  await note.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await note.mouse.down()
  await note.mouse.move(stage.x + stage.width / 2 + 120, stage.y + stage.height / 2 + 60, { steps: 5 })
  await note.mouse.up()
  await note.keyboard.up(' ')
  check('ノート: スペース + ドラッグでページを動かせる', /translate\(1[12]\dpx, [56]\dpx\)/.test(await note.locator('.spread').getAttribute('style')))
  await note.getByRole('button', { name: '位置をもどす' }).click()

  // Ctrl + Shift + スペース + ドラッグ: 右上へ動かすとページが大きく、左下へ動かすと小さくなる
  const zoomValue = async () => Number((await note.locator('.page-zoom-value').innerText()).replace('%', ''))
  const zoomDrag = async (dx, dy) => {
    for (const key of ['Control', 'Shift', ' ']) await note.keyboard.down(key)
    await note.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
    await note.mouse.down()
    await note.mouse.move(stage.x + stage.width / 2 + dx, stage.y + stage.height / 2 + dy, { steps: 6 })
    await note.mouse.up()
    for (const key of [' ', 'Shift', 'Control']) await note.keyboard.up(key)
    await note.waitForTimeout(200)
  }
  await zoomDrag(150, -150)
  const enlarged = await zoomValue()
  await zoomDrag(-60, 60)
  const reduced = await zoomValue()
  check('ノート: Ctrl + Shift + スペース + ドラッグで、ページを拡大・縮小できる', enlarged > 250 && enlarged <= 400 && reduced < enlarged && reduced > 100, `100% → ${enlarged}% → ${reduced}%`)
  await shot(note, '3-note-zoomed')
  await note.locator('.page-zoom-value').click()
  await note.locator('.page-zoom input').fill('400')
  const maxed = await zoomValue()
  await note.locator('.page-zoom-value').click()
  check('ノート: ページの拡大率を 100%〜400% の間で変えられる', maxed === 400 && (await zoomValue()) === 100)
  await note.getByRole('button', { name: 'ペン', exact: true }).click()
  check('ノート: ペンの太さに、細いもの（極細・細め）がある', (await note.locator('.size').count()) === 5)

  // タイピングモード: 罫線に沿って入力し、縦書きと英語の 4 線に切りかえる
  await note.getByRole('button', { name: '手書き', exact: true }).click()
  await showAdded(1)
  await note.locator('.note-typed').first().click()
  await note.keyboard.type('タイピングの確認です。罫線に沿って文字が並びます。')
  await note.locator('.note-bar').click({ position: { x: 5, y: 5 } })
  await note.evaluate(() => window.__manabiFlush?.())
  check('ノート: タイピングモードで入力した文章が保存される', ((await readNote()).pages[3].typed ?? '').includes('タイピングの確認'))
  // 保存は、保存のボタンを押したときと、閉じるときだけ（書いただけでは、保存しない）
  const typedOnDisk = () => note.evaluate(async () => (await window.manabi.notes.get((await window.manabi.view.get()).params.notebookId)).pages[3].typed ?? '')
  await note.locator('.note-typed').first().click()
  await note.keyboard.press('Control+End')
  await note.keyboard.type('あとから足した文。')
  await note.locator('.note-bar').click({ position: { x: 5, y: 5 } })
  await note.waitForTimeout(2600)
  const notYet = await typedOnDisk()
  const label = await note.locator('.save-state').innerText()
  await note.getByRole('button', { name: '保存する' }).click()
  await note.waitForFunction(() => document.querySelector('.save-state')?.getAttribute('data-state') === 'saved')
  check('ノート: 自動では保存せず、保存のボタンを押すと保存する', !notYet.includes('あとから足した文') && label === '未保存' && (await typedOnDisk()).includes('あとから足した文'), label)
  await note.getByRole('button', { name: '罫線' }).click()
  await note.getByLabel('縦書き（罫線を縦にする）').check()
  const vertical = (await note.locator('.note-typed').first().getAttribute('data-vertical')) === 'true'
  await shot(note, '3-note-vertical')
  await note.getByRole('button', { name: '英語 4 線' }).click()
  await note.waitForTimeout(300)
  await shot(note, '3-note-english')
  const english = (await readNote().then(() => note.evaluate(() => window.manabi.settings.get()))).ruling.kind === 'english'
  check('ノート: 縦書きと、英語の 4 線に切りかえられる', vertical && english)
  await note.getByRole('button', { name: '横罫' }).click()
  await note.getByLabel('縦書き（罫線を縦にする）').uncheck()
  await note.getByRole('button', { name: '閉じる' }).first().click()
  await note.getByRole('button', { name: 'タイピング', exact: true }).click()
  await note.getByRole('button', { name: '検索' }).click()
  await note.locator('.search input').fill('バスケ')
  await note.locator('.search li button').first().click()
  check('ノート: 検索結果から該当ページへ移動する', (await note.locator('.pager-now').innerText()).startsWith('1 / 4'))

  // PDF
  await note.getByRole('button', { name: 'PDF' }).click()
  await note.waitForSelector('.toast')
  check('ノート: PDF を書き出せる', existsSync(pdfPath) && statSync(pdfPath).size > 20000, existsSync(pdfPath) ? `${Math.round(statSync(pdfPath).size / 1024)} KB` : '')

  if (withAi) {
    // ───────── ノートの評価（AI） ─────────
    await note.getByRole('button', { name: /に見てもらう$/ }).first().click()
    const startButton = note.locator('.evaluation .btn-wide')
    if (await startButton.isVisible()) await startButton.click()
    const started = Date.now()
    await note.waitForSelector('.scores, .evaluation > .form-error', { timeout: 240000 })
    const scores = await note.locator('.score-number').allInnerTexts()
    check('評価: 3 つの観点の点数が返る', scores.length === 3, `${scores.join(' / ').replace(/\n/g, '')}（${Math.round((Date.now() - started) / 1000)} 秒）`)
    await note.waitForTimeout(600)
    await shot(note, '4-evaluation')
    await note.getByRole('button', { name: '検索' }).click()
    await note.locator('.search input').fill('図')
    await note.waitForTimeout(300)
    check('評価: 手書きの読み取りが検索に使える', (await note.locator('.search li small', { hasText: '手書き' }).count()) > 0)

    // ───────── ディベート（AI） ─────────
    const debate = await opened(() => textbook.getByRole('button', { name: '質問する', exact: true }).click(), 'chat')
    await debate.waitForSelector('.starter')
    const sent = Date.now()
    await debate.locator('.starter').first().click()
    await debate.waitForSelector('.bubble-assistant .md', { timeout: 120000 })
    const firstText = Date.now() - sent
    await replied(debate)
    const reply = await debate.locator('.bubble-assistant .md').last().innerText()
    check('チャット: 先生から返答が届く', reply.length > 30, `最初の文字まで ${(firstText / 1000).toFixed(1)} 秒 ／ ${reply.length} 字`)
    check('チャット: 表情タグが本文に残らない', !reply.includes('[表情'))
    await debate.locator('.composer textarea').fill('(+3)+(−5) がどうして −2 になるのか、まだピンときません。')
    await debate.keyboard.press('Enter')
    await debate.waitForTimeout(500)
    await debate.getByRole('button', { name: '送る' }).waitFor({ timeout: 120000 })
    check('チャット: 続けて質問できる', (await debate.locator('.message-assistant').count()) === 2)
    await debate.waitForTimeout(400)
    await shot(debate, '5-debate')

    // 相手を同級生に切り替える
    await debate.locator('.person', { hasText: '黒川 しずく' }).click()
    await debate.locator('.starter').nth(2).click()
    await replied(debate)
    const friend = await debate.locator('.bubble-assistant .md').last().innerText()
    check('チャット: 同級生に切り替えて話せる', friend.length > 20, friend.slice(0, 60).replace(/\n/g, ' '))
    await shot(debate, '5-debate-classmate')
  }

  if (withGenerate) {
    // ───────── 授業の生成（AI） ─────────
    await textbook.getByRole('button', { name: '1-4 減法', exact: true }).click()
    const began = Date.now()
    await textbook.getByRole('button', { name: 'AI に教科書を作ってもらう' }).click()
    await textbook.waitForSelector('.paper .md h1, .paper-empty .form-error', { timeout: 300000 })
    const made = await textbook.locator('.paper .md').count()
    const length = made ? (await textbook.locator('.paper .md').innerText()).length : 0
    check('教科書: 未作成の授業を AI が作成する', length > 600, `${length} 字（${Math.round((Date.now() - began) / 1000)} 秒）`)
    await textbook.waitForTimeout(500)
    await shot(textbook, '6-generated')
  }

  // ───────── 科目の切り替えと教材づくり ─────────
  const library = await opened(() => home.getByRole('button', { name: '教材づくりを開く' }).click(), 'library')
  await library.waitForSelector('.library-table')
  check('教材づくり: 全科目が一覧に出る', (await library.locator('.library-table tbody tr').count()) === JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8')).courses.filter((c) => !['univ', 'grad'].includes(c.school)).length, '大学・大学院は、いまは出さない')
  await shot(library, '6-library')

  // 休み方: 5 時間あたりの上限 100% と、同時に作る数 30 を選べる（確かめたら、もとの値に戻す）
  const librarySelects = library.locator('.library-options select')
  await librarySelects.nth(0).selectOption('1')
  await librarySelects.nth(1).selectOption('30')
  await library.getByText('上限に達するまで作りつづけます').waitFor()
  await library.getByText('最大で 30 回ぶん').waitFor()
  const libraryOptions = await library.evaluate(() => window.manabi.library.get().then((s) => s.options))
  check('教材づくり: 5 時間あたりの上限 100% と、同時に作る数 30 を選べる', libraryOptions.pauseAt === 1 && libraryOptions.concurrency === 30, JSON.stringify(libraryOptions))
  await shot(library, '6-library-options')
  // 上限（30）より大きい数を渡されても、30 までにおさえる
  const clamped = await library.evaluate(() => window.manabi.library.setOptions({ concurrency: 99 }).then(() => window.manabi.library.get()).then((s) => s.options.concurrency))
  check('教材づくり: 同時に作る数は 30 までにおさえる', clamped === 30, String(clamped))
  await librarySelects.nth(0).selectOption('0.8')
  await librarySelects.nth(1).selectOption('2')
  await library.waitForFunction(() => document.querySelectorAll('.library-options select')[1].value === '2')

  // 高校の専門教科: 4 つめの学校として選べ、職業に関する科目では注意書きが出る
  await home.locator('.course-picker').getByRole('button', { name: '高校（専門）' }).click()
  await home.waitForSelector('.course-picker select option[value="hsp-shogyo-boki"]', { state: 'attached' })
  await home.locator('.course-picker select').selectOption('hsp-shogyo-boki')
  await home.waitForSelector('.notice-field')
  const proSchool = await home.locator('.course-picker .segmented button[aria-pressed="true"]').innerText()
  const proGroups = await home.locator('.course-picker select optgroup').evaluateAll((groups) => groups.map((g) => `${g.label} ${g.children.length}`).join('、'))
  check(
    '専門教科: 「高校（専門）」から選べ、教科ごとにまとまっている',
    proSchool === '高校（専門）' &&
      (await home.locator('.home-course .section-title').innerText()) === '高校 商業（簿記）' &&
      proGroups === '農業 30、工業 59、商業 20、水産 22、家庭 21、看護 13、情報 12、福祉 9、理数 7、体育 8、音楽 8、美術 13、英語 7',
    proGroups,
  )
  await shot(home, '6-home-senmon')
  await home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-1' }))
  await textbook.waitForSelector('.paper .notice-field')
  check(
    '専門教科: 教科書に「実習や資格の勉強の代わりにはならない」と出る',
    (await textbook.locator('.paper .notice-field').innerText()).includes('資格をとるための勉強の代わりにはなりません') && (await textbook.locator('.view-header-title small').innerText()).startsWith('高校 商業（簿記）'),
  )
  await shot(textbook, '6-textbook-senmon')
  // 掛け合い: 先生と同級生は顔つき。登場人物でない名前は、絵があれば絵（出典つき）、無ければ札で出る。先生は左、次の人は右
  await textbook.waitForSelector('.kakeai-line')
  await textbook.waitForFunction(() => [...document.querySelectorAll('.kakeai .portrait img')].every((img) => img.complete))
  const kakeai = await textbook.evaluate(() => ({
    names: [...document.querySelectorAll('.kakeai-say > small')].map((el) => el.textContent),
    sides: [...document.querySelectorAll('.kakeai-line')].map((el) => el.dataset.side),
    faces: [...document.querySelectorAll('.kakeai .portrait:not(.kakeai-guest) img')].map((img) => (img.naturalWidth > 0 ? img.getAttribute('src') : 'x')),
    badge: document.querySelector('.kakeai-badge')?.textContent,
    guest: [...document.querySelectorAll('.kakeai-guest img')].map((img) => (img.naturalWidth > 0 ? img.getAttribute('alt') : 'x')).join('、'),
    bold: document.querySelector('.kakeai-bubble strong')?.textContent,
    note: document.querySelector('.kakeai-note')?.textContent ?? '',
    order: [...document.querySelectorAll('.paper > .md > *')].map((el) => (el.classList.contains('kakeai') ? 'talk' : el.tagName)).join(' '),
  }))
  check(
    '掛け合い: 教科書の本文の中に、顔と吹き出しで表示される',
    kakeai.names.join('、') === 'みのり先生、高尾 あかり、渋沢栄一、ナポレオン' &&
      kakeai.sides.join(' ') === 'left right left right' &&
      kakeai.faces.join(' ') === './characters/sensei/face3.png ./characters/s03/face1.png' &&
      kakeai.guest === '渋沢栄一の絵' &&
      kakeai.badge === 'ナ' &&
      kakeai.bold === '簿記' &&
      kakeai.note.includes('想像して書いたもの') &&
      kakeai.note.includes('絵の出典: 確認用の出典') &&
      kakeai.order === 'H1 H2 UL talk H2 P',
    JSON.stringify(kakeai),
  )
  check('掛け合い: 教科書に「掛け合いを作り直す」ボタンが出る', await textbook.getByRole('button', { name: '掛け合いを作り直す' }).isVisible())

  // ───────── 動く図解と挿絵 ─────────
  {
  const sims = await import('../src/shared/sims.ts')
  const blocks = await import('../src/shared/blocks.ts')
  const simClamped = sims.normalizeSim({ kind: 'pendulum', values: { length: 999, angle: 12, mass: 'x' }, task: 'a\nb' })
  const quadratic = sims.compileGraph('ax^2+bx+c', { a: 2, b: -3, c: 1 })
  const lensFar = sims.lensImage(10, 30)
  const lensNear = sims.lensImage(10, 5)
  const series = sims.circuitValues(6, 10, 20, 'series')
  const parallel = sims.circuitValues(6, 10, 20, 'parallel')
  check(
    '動く図解: 値は範囲の中に丸められ、式・レンズ・回路・ふりこの計算が正しい',
    simClamped.values.length === 150 && simClamped.values.angle === 10 && simClamped.values.mass === 50 && simClamped.task === 'a b' &&
      sims.normalizeSim({ kind: 'graph', expr: 'm*x', values: {} }) === null && sims.normalizeSim({ kind: 'unknown' }) === null &&
      quadratic(2) === 3 && sims.graphLetters('a*(x-p)^2+q').join('') === 'apq' &&
      lensFar.kind === 'real' && Math.abs(lensFar.image - 15) < 1e-9 && lensNear.kind === 'virtual' && Math.abs(lensNear.image + 10) < 1e-9 && sims.lensImage(10, 10).kind === 'none' &&
      Math.abs(series.total - 0.2) < 1e-9 && Math.abs(series.v2 - 4) < 1e-9 && Math.abs(parallel.total - 0.9) < 1e-9 &&
      Math.abs(sims.pendulumPeriod(100) - 2.007) < 0.001 && sims.simsFor({ school: 'es', guide: 'science' }).join(' ') === 'pendulum lever moon' && sims.simsFor({ school: 'jhs', guide: 'social' }).length === 0,
    JSON.stringify(simClamped?.values),
  )
  const sectioned = ['# 題', '', '## この授業のねらい', '- a', '', '## 説明', '本文', '', '## 例題', '例', '', '```talk', 'sensei: あ', 's01: い', '```', '', '## 確かめ問題', '1. 問い', ''].join('\n')
  const placed = blocks.insertAfterSection(sectioned, '説明', '```sim\n{}\n```')
  const beforeTalk = blocks.insertAfterSection(sectioned, '例題', '```picture\n{}\n```')
  const fallback = blocks.insertAfterSection(sectioned, '無い見出し', '```sim\n{}\n```')
  const at = (text, line) => text.split('\n').indexOf(line)
  check(
    '動く図解・挿絵: 指定した節の終わり（掛け合いがあればその前）に入り、取りのぞくと元の本文にもどる',
    at(placed, '```sim') === at(placed, '## 例題') - 4 &&
      at(beforeTalk, '```picture') < at(beforeTalk, '```talk') && at(beforeTalk, '```picture') > at(beforeTalk, '例') &&
      at(fallback, '```sim') < at(fallback, '## 例題') && at(fallback, '```sim') > at(fallback, '本文') &&
      blocks.insertAfterSection(sectioned, 'この授業のねらい', 'x') !== null && blocks.insertAfterSection('# 題\n本文だけ', '説明', 'x') === null &&
      blocks.stripBlocks(placed, 'sim') === sectioned && blocks.stripBlocks(beforeTalk, 'picture') === sectioned && blocks.hasBlock(placed, 'sim') && !blocks.hasBlock(placed, 'picture'),
  )

  await home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-2' }))
  await textbook.waitForSelector('.sim[data-kind="moon"] svg')
  await textbook.waitForSelector('.picture img')
  await textbook.waitForFunction(() => [...document.querySelectorAll('.picture img')].every((img) => img.complete))
  const simText = (kind) => textbook.locator(`.sim[data-kind="${kind}"] .sim-readout`).innerText()
  const slide = async (kind, index, value) => {
    await textbook.locator(`.sim[data-kind="${kind}"] input[type="range"]`).nth(index).fill(String(value))
  }
  const simDrawn = await textbook.evaluate(() => ({
    kinds: [...document.querySelectorAll('.sim')].map((el) => el.dataset.kind).join(' '),
    svgs: [...document.querySelectorAll('.sim')].filter((el) => el.querySelector('.sim-stage svg')).length,
    errors: document.querySelectorAll('.figure-error').length,
    tasks: document.querySelectorAll('.sim-task').length,
    math: document.querySelectorAll('.sim .katex').length,
    pictures: [...document.querySelectorAll('.picture img')].filter((img) => img.naturalWidth > 0).length,
    caption: document.querySelector('.picture figcaption')?.textContent ?? '',
    publicNotes: [...document.querySelectorAll('.picture[data-kind="public"] figcaption')].map((el) => el.textContent ?? ''),
    sourceButtons: [...document.querySelectorAll('.picture[data-kind="public"]')].map((el) => el.querySelectorAll('.picture-source').length).join(' '),
  }))
  check(
    '動く図解: 10 種類すべてが、図と課題つきで表示される',
    simDrawn.kinds === 'fraction graph dice unitcircle pendulum lever spring circuit lens moon' && simDrawn.svgs === 10 && simDrawn.errors === 0 && simDrawn.tasks === 10 && simDrawn.math >= 2,
    JSON.stringify(simDrawn),
  )
  check('挿絵: 画像と説明が出て、AI が描いた絵には「イメージ」と添えられる（画像が無いものは出ない）', simDrawn.pictures === 3 && simDrawn.caption.includes('確認用の挿絵') && simDrawn.caption.includes('AI が描いたイメージ'), simDrawn.caption)
  check(
    '資料画像: 出典が添えられ、もとのページを開くボタンは https の行き先があるときだけ出る',
    simDrawn.publicNotes.length === 2 && simDrawn.publicNotes[0].includes('出典: 確認用の作者／確認用の提供元（パブリックドメイン）') && !simDrawn.publicNotes[0].includes('AI が描いた') && simDrawn.sourceButtons === '1 0',
    JSON.stringify([simDrawn.publicNotes, simDrawn.sourceButtons]),
  )
  const first = {
    fraction: await simText('fraction'),
    unit: await simText('unitcircle'),
    pendulum: await simText('pendulum'),
    lever: await simText('lever'),
    spring: await simText('spring'),
    circuit: await simText('circuit'),
    lens: await simText('lens'),
    moon: await simText('moon'),
  }
  check(
    '動く図解: はじめの値で、正しい数値が出る',
    first.fraction.includes('＝') && first.unit.includes('1/2 = 0.5') && first.unit.includes('√3/2 ≒ 0.866') && first.pendulum.includes('1.42 秒') && first.lever.includes('つり合います') &&
      first.spring.includes('3 cm') && first.circuit.includes('200 mA') && first.circuit.includes('30 Ω') && first.lens.includes('実像') && first.lens.includes('15 cm') && first.lens.includes('0.5 倍') && first.moon.includes('上弦の月'),
    JSON.stringify(first).slice(0, 400),
  )
  await slide('pendulum', 0, 100)
  await slide('fraction', 2, 3)
  await slide('unitcircle', 0, 135)
  await slide('lever', 3, 5)
  await slide('lens', 1, 5)
  await slide('moon', 0, 180)
  await slide('graph', 0, 2)
  await textbook.locator('.sim[data-kind="circuit"] select').selectOption('parallel')
  await textbook.locator('.sim[data-kind="dice"]').getByRole('button', { name: '100 回投げる' }).click()
  await textbook.locator('.sim[data-kind="pendulum"]').getByRole('button', { name: '動かす' }).click()
  await textbook.waitForFunction(() => /動かしてから [1-9]/.test(document.querySelector('.sim[data-kind="pendulum"] .sim-readout')?.textContent ?? '') || /0\.[1-9] 秒、/.test(document.querySelector('.sim[data-kind="pendulum"] .sim-readout')?.textContent ?? ''))
  await textbook.locator('.sim[data-kind="pendulum"]').getByRole('button', { name: '止める' }).click()
  const moved = {
    fraction: await simText('fraction'),
    unit: await simText('unitcircle'),
    pendulum: await simText('pendulum'),
    lever: await simText('lever'),
    circuit: await simText('circuit'),
    lens: await simText('lens'),
    moon: await simText('moon'),
    dice: await simText('dice'),
    graph: await simText('graph'),
    dashed: await textbook.locator('.sim[data-kind="graph"] svg path[stroke-dasharray]').count(),
    reset: await textbook.locator('.sim-reset').count(),
  }
  check(
    '動く図解: スライダーや選択を動かすと、図と数値が計算しなおされる',
    moved.fraction.includes('＜') && moved.unit.includes('−√2/2 ≒ −0.707') && moved.pendulum.includes('2.01 秒') && moved.lever.includes('左にかたむきます') &&
      moved.circuit.includes('900 mA') && moved.lens.includes('虚像') && moved.lens.includes('10 cm') && moved.moon.includes('満月') && /投げた回数\s*100/.test(moved.dice) &&
      moved.graph.includes('a = 2') && moved.dashed === 1 && moved.reset >= 7,
    JSON.stringify(moved).slice(0, 500),
  )
  await textbook.locator('.sim[data-kind="pendulum"] .sim-reset').click()
  check('動く図解: 「はじめの値にもどす」で、もとの値にもどる', (await simText('pendulum')).includes('1.42 秒'))
  await textbook.locator('.sim[data-kind="circuit"] select').selectOption('single')
  const singleText = await simText('circuit')
  check('動く図解: 回路は「抵抗 1 つ」に切りかえられ、使わない抵抗のスライダーは隠れる', singleText.includes('電流 = 電圧 ÷ 抵抗') && singleText.includes('600 mA') && (await textbook.locator('.sim[data-kind="circuit"] input[type="range"]').count()) === 2, singleText.slice(0, 80))
  for (const kind of ['fraction', 'graph', 'dice', 'unitcircle', 'pendulum', 'lever', 'spring', 'circuit', 'lens', 'moon']) {
    await textbook.locator(`.sim[data-kind="${kind}"]`).scrollIntoViewIfNeeded()
    await textbook.locator(`.sim[data-kind="${kind}"]`).screenshot({ path: join(outDir, `7-sim-${kind}.png`) })
  }
  await textbook.locator('.picture').first().screenshot({ path: join(outDir, '7-picture.png') })
  // ───────── 動画（試作） ─────────
  {
    const videos = await import('../src/shared/video.ts')
    const roles = [{ id: 'sensei', expressions: ['smile', 'point'], teacher: true }, { id: 's01', expressions: ['smile'], teacher: false }]
    const line = (speaker, more = {}) => ({ speaker, expression: 'point', text: '確認用のせりふです。', say: '', show: 0, set: [], ...more })
    const draft = () => ({
      scenes: [
        { kind: 'title', heading: '題', items: ['副題', '余分'], ref: 'x', lines: [line('sensei'), line('s01')] },
        { kind: 'board', heading: '板書', items: ['一', '二', '三'], ref: '', lines: [line('sensei', { show: 2 }), line('s01', { show: 1 }), line('sensei', { show: 2 })] },
        { kind: 'figure', heading: '図', items: [], ref: '1', lines: [line('sensei'), line('sensei')] },
        { kind: 'sim', heading: '図解', items: [], ref: '', lines: [line('sensei', { set: [{ name: 'distance', value: 999 }, { name: 'nothing', value: 1 }] }), line('s01'), line('sensei')] },
      ],
    })
    const lens = videos.parseSim('{"kind":"lens","values":{"focal":10,"distance":30},"task":"確認"}')
    const cleaned = videos.cleanVideoScript(draft(), roles, 1, [], lens)
    const throws = (change) => {
      const script = draft()
      change(script)
      try {
        videos.cleanVideoScript(script, roles, 1, [], lens)
        return false
      } catch {
        return true
      }
    }
    check(
      '動画の台本: 決まった形に整えられる（板書は出したら出したまま・最後に全部出る、図解の値は範囲の中に丸める、読み上げ用の文を補う）',
      cleaned.scenes[0].items.length === 1 && cleaned.scenes[0].ref === '' && cleaned.scenes[1].lines.map((l) => l.show).join(' ') === '2 2 3' &&
        cleaned.scenes[3].lines[0].set.distance === 60 && !('nothing' in cleaned.scenes[3].lines[0].set) && cleaned.scenes[0].lines[0].say === '確認用のせりふです。' && cleaned.scenes[0].lines[0].expression === 'point' && cleaned.scenes[0].lines[1].expression === '',
      JSON.stringify(cleaned.scenes[1].lines.map((l) => l.show)),
    )
    check(
      '動画の台本: 登場人物でない人・本文に無い図や挿絵・同級生がほとんど話さない台本は、使わない',
      throws((s) => (s.scenes[0].lines[0].speaker = 's99')) && throws((s) => (s.scenes[2].ref = '2')) && throws((s) => (s.scenes[2].kind = 'picture')) && throws((s) => s.scenes.forEach((scene) => scene.lines.forEach((l) => (l.speaker = 'sensei')))) && throws((s) => (s.scenes = s.scenes.slice(0, 2))),
    )
    check(
      '読みの点検: 読みまちがい（「光」をコウと読む）は大きなちがいとして拾い、書き方のゆれ（のばす音・助詞）は同じとみなす',
      videos.soundDistance('ヘエコオナ ヒカリワ', 'ヘエコオナコオハ') >= 2 && videos.soundDistance('ショウテン', 'ショオテン') === 0 && videos.soundDistance('へいこうに すすむ', 'ヘエコオニ, ススム.') === 0 && videos.soundDistance('ブッタイハ スクリーンヘ', 'ブッタイワ スクリインエ') === 0,
      String(videos.soundDistance('ヘエコオナ ヒカリワ', 'ヘエコオナコオハ')),
    )

    await home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-2' }))
    await textbook.waitForSelector('.textbook-video button')
    const video = await opened(() => textbook.locator('.textbook-video button').click(), '動画')
    await video.waitForSelector('.video-stage[data-kind="title"]')
    await video.waitForFunction(() => document.querySelector('.video-play')?.textContent === '再生')
    const titleScene = await video.evaluate(() => ({ heading: document.querySelector('.vs-title h1')?.textContent, people: document.querySelectorAll('.vs-people figure').length, speaking: document.querySelector('.vs-people figure[data-speaking="true"] figcaption')?.textContent, caption: document.querySelector('.vs-caption')?.textContent }))
    check('動画: 題の場面に、題・話している人・字幕が出る', titleScene.heading === '動画の確認' && titleScene.people === 2 && titleScene.speaking === 'みのり先生' && titleScene.caption === 'はじめのせりふです。', JSON.stringify(titleScene))
    await video.getByRole('button', { name: '次の場面' }).click()
    await video.waitForSelector('.video-stage[data-kind="board"]')
    const boardFirst = await video.evaluate(() => [...document.querySelectorAll('.vs-board li')].map((li) => li.dataset.shown).join(' '))
    await video.locator('.video-seek').fill('2')
    const boardSecond = await video.evaluate(() => ({ shown: [...document.querySelectorAll('.vs-board li')].map((li) => li.dataset.shown).join(' '), speaking: document.querySelector('.vs-people figure[data-speaking="true"]')?.dataset.role, role: document.querySelector('.vs-caption')?.dataset.role }))
    check('動画: 板書は、せりふに合わせて 1 つずつ出て、話す人が切りかわる', boardFirst === 'true false' && boardSecond.shown === 'true true' && boardSecond.speaking === 'classmate' && boardSecond.role === 'classmate', JSON.stringify([boardFirst, boardSecond]))
    await video.getByRole('button', { name: '次の場面' }).click()
    await video.waitForSelector('.vs-sim svg')
    await video.waitForFunction(() => /左の分子\s*3/.test(document.querySelector('.vs-sim-values')?.textContent ?? '') && /左の分母\s*4/.test(document.querySelector('.vs-sim-values')?.textContent ?? ''), null, { timeout: 8000 })
    check('動画: 動く図解は、台本で決めた値まで動く', true)
    await shot(video, '8-video-sim')
    await video.getByRole('button', { name: '次の場面' }).click()
    await video.waitForSelector('.vs-figure .picture img')
    await video.locator('.video-seek').fill('0')
    await video.locator('.video-play').click()
    await video.waitForFunction(() => document.querySelector('.video-seek')?.value === '4' && document.querySelector('.video-play')?.textContent === '再生', null, { timeout: 20000 })
    check('動画: 再生すると、最後のせりふまで進んで止まる', true)
    await video.close()
  }

  await home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-1' }))
  await textbook.waitForSelector('.kakeai-line')
  }
  // すでに掛け合いが入っている授業は、AI を呼ばずに記録だけを付ける
  await textbook.evaluate(() => window.manabi.content.talk('hsp-shogyo-boki-1-1'))
  // （チェックの状態は、設定が保存されてから画面に反映される）
  await library.getByLabel(/「掛け合い」を足す/).click()
  await library.waitForSelector('.library-talks')
  const talkState = await library.evaluate(() => window.manabi.library.get())
  check(
    '教材づくり: 「掛け合いを足す」を選べ、掛け合いの入った授業の数が出る',
    talkState.options.talk === true && talkState.totals.talks === 1 && talkState.totals.talkTargets >= 2 && /掛け合いは 1 \/ \d+ 回ぶん/.test(await library.locator('.library-talks').innerText()),
    JSON.stringify(talkState.totals),
  )
  await shot(library, '6-library-talk')
  await library.getByLabel(/「動く図解」があれば足す/).click()
  await library.waitForFunction(() => window.manabi.library.get().then((state) => state.options.sims))
  const simState = await library.evaluate(() => window.manabi.library.get())
  check('教材づくり: 「動く図解を足す」を選べる（商業の授業は、調べる対象にならない）', simState.options.sims === true && simState.totals.simTargets === 1 && simState.totals.sims === 0, JSON.stringify(simState.totals))
  await library.getByLabel(/「動く図解」があれば足す/).click()
  await library.waitForFunction(() => window.manabi.library.get().then((state) => !state.options.sims))
  await library.getByLabel(/「掛け合い」を足す/).click()
  await library.waitForFunction(() => window.manabi.library.get().then((state) => !state.options.talk))
  await home.locator('.course-picker select').selectOption('hsp-risu-sugaku1')
  await home.waitForSelector('.home-empty')
  check('専門教科: 理数や英語（職業に関する教科でないもの）には、注意書きを出さない', (await home.locator('.notice-field').count()) === 0 && (await home.locator('.home-course .section-title').innerText()) === '高校 理数（理数数学 I）')
  // 看護には、体の具合が気になるときの案内を足す。体育・音楽・美術（実技が中心の教科）には、実技は学べないことを出す
  await home.locator('.course-picker select').selectOption('hsp-kango-kiso')
  await home.waitForFunction(() => document.querySelector('.home-course .section-title')?.textContent === '高校 看護（基礎看護）')
  const nursingNote = await home.locator('.notice-field').innerText()
  await home.locator('.course-picker select').selectOption('hsp-taiiku-sports6')
  await home.waitForFunction(() => document.querySelector('.home-course .section-title')?.textContent === '高校 体育（スポーツ VI）')
  const skillNote = await home.locator('.notice-field').innerText()
  check(
    '専門教科: 看護には受診の案内、体育・音楽・美術には「実技は学べない」と出る',
    nursingNote.includes('資格をとるための勉強の代わりにはなりません') && nursingNote.includes('医療機関に相談してください') && skillNote.includes('このアプリでは学べません') && !skillNote.includes('資格'),
    `${nursingNote.slice(-30)} / ${skillNote.slice(0, 30)}`,
  )
  await shot(home, '6-home-senmon-skill')
  await home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'jhs1-math-1-3' }))
  await textbook.waitForFunction(() => document.querySelector('.md h1')?.textContent === '加法')
  await home.locator('.course-picker').getByRole('button', { name: '中学校' }).click()
  await home.waitForSelector('.course-picker select option[value="jhs2-math"]', { state: 'attached' })

  await home.locator('.course-picker select').selectOption('jhs2-math')
  await home.waitForSelector('.home-empty')
  check('ホーム: 科目を切り替えられ、単元表が無い科目では作成を案内する', (await home.locator('.home-course .section-title').innerText()) === '中学 2 年 数学')
  if (withAi) {
    // 単元表を AI に作らせる
    let began = Date.now()
    await home.getByRole('button', { name: 'この科目の単元表を作る' }).click()
    await home.waitForSelector('.unit, .home-empty .form-error', { timeout: 240000 })
    const unitCount = await home.locator('.unit').count()
    const lessonCount = await home.evaluate(() => window.manabi.content.curriculum('jhs2-math').then((c) => c?.units.flatMap((u) => u.lessons).length ?? 0))
    check('教材づくり: AI が単元表を作る', unitCount >= 5 && lessonCount >= 30, `${unitCount} 単元・${lessonCount} 授業（${Math.round((Date.now() - began) / 1000)} 秒）`)
    await shot(home, '6-home-jhs2')

    // まとめて作る: 中 2 数学を先に指定して始め、最初の 1 つができたら止める
    began = Date.now()
    await library.locator('tr', { hasText: '中学 2 年 数学' }).getByRole('button', { name: '先に作る' }).click()
    await library.getByRole('button', { name: '作成を始める' }).click()
    await library.waitForSelector('.library-log li[data-ok="true"], .library-log li[data-ok="false"]', { timeout: 300000 })
    await library.getByRole('button', { name: '作成を止める' }).click()
    const first = await library.locator('.library-log li').last().innerText()
    const usage = await library.locator('.meter-figure').first().innerText()
    check('教材づくり: まとめて作る処理が、指定した科目の授業から作りはじめる', /中学 2 年 数学 1-\d/.test(first), `${first.replace(/\n/g, ' ')}（${Math.round((Date.now() - began) / 1000)} 秒、5 時間あたりの使用量 ${usage}）`)
    await library.waitForTimeout(1500)
    await shot(library, '6-library-running')

    const made = await opened(() => home.locator('.lesson-row').first().getByRole('button', { name: '教科書' }).click(), 'textbook2').catch(() => null)
    const page = made ?? textbook
    await page.waitForSelector('.paper .md h1', { timeout: 20000 })
    const body = await page.locator('.paper .md').innerText()
    check('教材づくり: 作られた授業を教科書で読める（点検つき）', body.length > 600 && (await page.locator('.notice').innerText()).includes('点検'), `${body.length} 字`)
    await shot(page, '6-generated-lesson')
  }
  await home.locator('.course-picker select').selectOption('jhs1-math')
  await home.waitForSelector('.unit')

  // ───────── ディベート ─────────
  const arena = await opened(() => home.getByRole('button', { name: 'ディベート', exact: true }).click(), 'debate')
  await arena.waitForSelector('.test-setup')
  const opponents = await arena.locator('.opponents .person img').evaluateAll((images) => images.filter((img) => img.complete && img.naturalWidth > 0).length)
  check('ディベート: 準備の画面で、相手に同級生 20 人を選べる（全員の画像が出る）', (await arena.locator('.opponents .person').count()) === 20 && opponents === 20, `画像 ${opponents} 人ぶん`)
  await shot(arena, '7-debate-setup')
  if (withAi) {
    let began = Date.now()
    await arena.getByRole('button', { name: 'AI に論題を決めてもらう' }).click()
    await arena.waitForFunction(() => document.querySelector('.test-setup textarea').value.length > 5, null, { timeout: 120000 })
    const topic = await arena.locator('.test-setup textarea').inputValue()
    check('ディベート: AI が論題を決める', topic.length > 8, `${topic}（${Math.round((Date.now() - began) / 1000)} 秒）`)
    // 否定側を選ぶ → 肯定側の同級生が先に立論する
    await arena.getByRole('button', { name: '否定側', exact: true }).click()
    await arena.getByRole('button', { name: 'ディベートを始める' }).click()
    began = Date.now()
    await arena.waitForSelector('.turn[data-speaker="opponent"]', { timeout: 120000 })
    check('ディベート: 相手が肯定側の立論を述べる', (await arena.locator('.turn').first().innerText()).includes('肯定側'), `${Math.round((Date.now() - began) / 1000)} 秒`)

    // 先生に相談する
    await arena.locator('.arena-coach textarea').fill('否定側の立論では、何から書けばいいですか？')
    await arena.locator('.arena-coach textarea').press('Enter')
    await arena.waitForSelector('.arena-coach .bubble-assistant .md', { timeout: 120000 })
    await arena.locator('.arena-coach').getByRole('button', { name: '送る' }).waitFor({ timeout: 120000 })
    check('ディベート: 途中で先生に相談できる', (await arena.locator('.arena-coach .bubble-assistant .md').innerText()).length > 30)

    // 自分の番（立論 → 反対尋問 → 反駁 → 最終弁論）を順に発言する
    const speeches = [
      'この論題には反対です。理由は二つあります。第一に、一律に決めてしまうと、一人ひとりの事情に合わせられなくなるからです。たとえば家庭の状況や体調は人によってちがいます。第二に、決まりを守らせるための手間や費用が新しくかかるからです。',
      '肯定側に質問します。主張の根拠として挙げた例は、すべての人に当てはまるのでしょうか。当てはまらない人が不利益を受ける場合、どのように対応するのですか。また、その効果を示す具体的な事実はありますか。',
      'ご質問にお答えします。費用については、いまある仕組みを使えば新しくかかる分は小さいという指摘でしたが、だれが負担するのかが示されていません。事情のちがう人への対応が後回しになる点も、解決されていないと考えます。',
      'これまでの議論をまとめます。肯定側は効果を主張しましたが、事情のちがう人への対応と、費用の負担者という二つの争点に、具体的な答えがありませんでした。否定側は、一律に決めることの不利益を具体例で示しました。以上から、否定側の立場がすぐれていると考えます。',
    ]
    for (const speech of speeches) {
      await arena.locator('.arena-main .composer textarea').waitFor({ timeout: 240000 })
      await arena.locator('.arena-main .composer textarea').fill(speech)
      await arena.locator('.arena-main .composer').getByRole('button', { name: '送る' }).click()
      await arena.waitForTimeout(800)
    }
    began = Date.now()
    await arena.waitForSelector('.verdict', { timeout: 300000 })
    const turns = await arena.locator('.turn').count()
    const heading = await arena.locator('.verdict h2').innerText()
    check('ディベート: 立論から最終弁論まで交代で進み、ジャッジが判定する', turns === 8 && /判定/.test(heading), `${turns} 発言 ／ ${heading.replace(/\n/g, ' ')}`)
    await arena.locator('.arena-turns').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await arena.waitForTimeout(400)
    await shot(arena, '7-debate-verdict')
  }

  // ───────── 表示倍率とショートカットの設定 ─────────
  const factors = () => app.evaluate(({ BrowserWindow }) => Object.fromEntries(BrowserWindow.getAllWindows().map((w) => [w.getTitle().split(' — ')[0], Math.round(w.webContents.getZoomFactor() * 100)])))
  await home.keyboard.press('Control+;')
  await home.waitForSelector('.zoom-chip')
  const stepped = (await factors())['学びアイ']
  const chip = await home.locator('.zoom-chip').innerText()
  await home.evaluate(() => window.manabi.zoom.set('textbook', 2))
  await home.waitForTimeout(300)
  const mixed = await factors()
  check('表示倍率: ショートカットで変えられ、画面（モード）ごとに別々の倍率になる', stepped === 110 && chip.includes('110%') && mixed['教科書'] === 200 && mixed['学びアイ'] === 110 && mixed['ノート'] === 100, JSON.stringify(mixed))
  await shot(textbook, '13-textbook-200')
  await home.evaluate(() => window.manabi.zoom.set('textbook', 4))
  await home.waitForTimeout(400)
  await shot(textbook, '13-textbook-400')
  await home.evaluate(() => window.manabi.zoom.set('textbook', 1))
  await home.keyboard.press('Control+0')
  await home.waitForTimeout(300)

  const prefs = await opened(() => home.getByRole('button', { name: '設定を開く' }).click(), 'settings')
  await prefs.waitForSelector('.key-list')
  const rows = await prefs.locator('.key-list li').count()
  await prefs.locator('.zoom-list li').nth(4).locator('input').fill('150')
  await prefs.waitForTimeout(300)
  const viaSettings = (await factors())['ノート']
  await prefs.locator('.zoom-list li').nth(4).getByRole('button', { name: '100%' }).click()
  check('設定: 画面ごとの表示倍率を変えられ、ショートカットの一覧が出る', rows === 17 && viaSettings === 150 && (await prefs.locator('.zoom-list li').count()) === 20, `操作 ${rows} 個`)
  // 「選択の道具に切りかえる」を M から S に変えると、ノートで S が効くようになる
  const selectRow = prefs.locator('.key-list li').filter({ hasText: '選択の道具に切りかえる' })
  await selectRow.getByRole('button', { name: '変更' }).click()
  await prefs.keyboard.press('s')
  await prefs.waitForFunction(() => [...document.querySelectorAll('.key-list li')].some((li) => li.textContent.includes('選択の道具') && li.querySelector('kbd').textContent.trim() === 'S'), null, { timeout: 5000 }).catch(() => {})
  await shot(prefs, '13-settings')
  // 教科書でほかの授業へ移ると、前の授業のノートは閉じるので、ここで開き直す
  await home.evaluate(() => window.manabi.view.open('note', { lessonId: 'jhs1-math-1-3' }))
  const keyNote = await windowOf('note', 'note', '-1-3')
  await keyNote.waitForSelector('.note-bar')
  await keyNote.bringToFront()
  await keyNote.getByRole('button', { name: 'ペン', exact: true }).click()
  await keyNote.locator('.note-bar').click({ position: { x: 5, y: 5 } })
  await keyNote.keyboard.press('m')
  const afterOld = await keyNote.getByRole('button', { name: '選択', exact: true }).getAttribute('aria-pressed')
  await keyNote.keyboard.press('s')
  const afterNew = await keyNote.getByRole('button', { name: '選択', exact: true }).getAttribute('aria-pressed')
  check('設定: 変えたショートカットが、ノートですぐに使える', afterOld === 'false' && afterNew === 'true')
  await selectRow.getByRole('button', { name: 'はじめにもどす' }).click()
  await prefs.close()
  // ノートは、閉じるときに、書きかけを保存する
  {
    const id = await keyNote.evaluate(async () => (await window.manabi.view.get()).params.notebookId)
    await keyNote.getByRole('button', { name: '手書き', exact: true }).click()
    await keyNote.locator('.note-typed').first().click()
    await keyNote.keyboard.type('閉じる前に書いた文。')
    await keyNote.locator('.note-bar').click({ position: { x: 5, y: 5 } })
    const before = await home.evaluate((key) => window.manabi.notes.get(key).then((n) => n.pages.some((p) => (p.typed ?? '').includes('閉じる前に書いた文'))), id)
    await keyNote.evaluate(() => window.close()).catch(() => {})
    await home.waitForTimeout(1500)
    const after = await home.evaluate((key) => window.manabi.notes.get(key).then((n) => n.pages.some((p) => (p.typed ?? '').includes('閉じる前に書いた文'))), id)
    check('ノート: 閉じるときに、書きかけを保存する', !before && after && keyNote.isClosed())
  }

  // ───────── 英会話 ─────────
  const eikaiwa = await opened(() => home.getByRole('button', { name: '英会話', exact: true }).click(), 'eikaiwa')
  await eikaiwa.waitForSelector('.composer textarea')
  check('英会話: 英語の授業をまだ進めていないので、会話のレベルは入門になる', (await eikaiwa.locator('.eikaiwa-level').innerText()).includes('習いはじめ'))
  const voices = await eikaiwa.evaluate(
    () => new Promise((resolve) => {
      const read = () => speechSynthesis.getVoices().map((v) => v.lang)
      if (read().length) return resolve(read())
      speechSynthesis.onvoiceschanged = () => resolve(read())
      setTimeout(() => resolve(read()), 3000)
    }),
  )
  // 画面側の音声に英語が無くても、Windows の従来の系統（SAPI）に英語の音声があれば読み上げられる
  const systemVoice = await eikaiwa.evaluate(() => window.manabi.tts.status())
  const hasEnglishVoice = voices.some((lang) => lang.startsWith('en')) || systemVoice
  check(
    '英会話: 英語の読み上げ音声が PC に無いときは、入れ方を案内する（あるときは案内を出さない）',
    ((await eikaiwa.locator('.voice-missing').count()) === 1) === !hasEnglishVoice,
    `画面側の音声: ${[...new Set(voices)].join(', ')} ／ 従来の系統の英語音声: ${systemVoice ? 'あり' : 'なし'}`,
  )
  await eikaiwa.locator('.composer textarea').fill('I like music. Do you like music?')
  await eikaiwa.getByRole('button', { name: '次へ' }).click()
  await eikaiwa.waitForSelector('.say-target')
  check(
    '英会話: 書いた英文を声に出す段階へ進み、音声認識が未準備なら、準備の案内ととばすボタンが出る',
    (await eikaiwa.locator('.say-target span').count()) === 7 && (await eikaiwa.getByRole('button', { name: '発音の確認をとばして送る' }).count()) === 1 && (await eikaiwa.locator('.say .speech-setup').count()) === 1,
  )
  await shot(eikaiwa, '11-eikaiwa-say')
  if (withAi) {
    let began = Date.now()
    await eikaiwa.getByRole('button', { name: '発音の確認をとばして送る' }).click()
    await eikaiwa.waitForSelector('.reply-ja', { timeout: 120000 })
    await eikaiwa.locator('.composer textarea').waitFor({ timeout: 120000 })
    const en = await eikaiwa.locator('.reply-en').first().innerText()
    const ja = await eikaiwa.locator('.reply-ja').first().innerText()
    const english = (await eikaiwa.evaluate(() => window.manabi.skills.get())).values.english
    check('英会話: 相手が英語と日本語訳で返事をし、英会話力が上がる', /[a-z]{2,}/i.test(en) && !/[ぁ-ん]/.test(en) && /[ぁ-ん]/.test(ja) && english > 0, `${en.replace(/\n/g, ' ')} ／ ${ja.replace(/\n/g, ' ').slice(0, 60)}（${Math.round((Date.now() - began) / 1000)} 秒）`)
    began = Date.now()
    await eikaiwa.locator('.composer textarea').fill('好きな食べ物はカレーです。')
    await eikaiwa.getByRole('button', { name: '英語にする' }).click()
    await eikaiwa.waitForSelector('.say-target', { timeout: 120000 })
    const translated = await eikaiwa.locator('.say-target').innerText()
    check('英会話: 日本語で書いた文が、英語に直される', /curry/i.test(translated) && !/[ぁ-ん]/.test(translated), `${translated.replace(/\n/g, ' ')}（${Math.round((Date.now() - began) / 1000)} 秒）`)
    await shot(eikaiwa, '11-eikaiwa')
  }
  await eikaiwa.close()

  // ───────── 語彙力特訓 ─────────
  const vocab = await opened(() => home.getByRole('button', { name: '語彙力特訓' }).click(), 'vocab')
  await vocab.waitForSelector('.test-setup')
  const jaLevels = await vocab.locator('.field').nth(1).locator('.segmented button').count()
  await vocab.getByRole('button', { name: '英単語' }).click()
  const enLevels = await vocab.locator('.field').nth(1).locator('.segmented button').count()
  check('語彙力特訓: 日本語と英語を選べ、それぞれにレベルがある', jaLevels === 4 && enLevels === 5)
  await vocab.getByRole('button', { name: '日本語の言葉' }).click()
  await vocab.getByRole('button', { name: '中学校', exact: true }).click()
  await vocab.getByRole('button', { name: '書き写してよい' }).click()
  await vocab.waitForFunction(() => document.querySelector('.test-setup')?.textContent.includes('そのまま書き写しても'), null, { timeout: 5000 }).catch(() => {})
  check('語彙力特訓: 例文を「自分で考える」か「書き写してよい」かを選べる', (await vocab.locator('.test-setup').innerText()).includes('そのまま書き写しても'))
  await vocab.getByRole('button', { name: '自分で考える' }).click()
  await shot(vocab, '10-vocab-setup')
  const drillNote = await opened(() => vocab.getByRole('button', { name: '特訓を始める' }).click(), 'vocab-note')
  await drillNote.waitForSelector('.note-page canvas')
  await vocab.waitForSelector('.drill-word')
  check(
    '語彙力特訓: 言葉・意味・例文が出て、練習用のノートがもう 1 つのウィンドウに開く',
    (await vocab.locator('.drill-word').innerText()) === '把握' && (await vocab.locator('.drill-examples li').count()) === 2 && (await drillNote.locator('.drill-now').innerText()).includes('把握'),
  )
  check('語彙力特訓: 練習用のノートには、先生の評価ではなく「書けた！」が出る', (await drillNote.getByRole('button', { name: '書けた！' }).count()) === 1 && (await drillNote.getByRole('button', { name: /に見てもらう$/ }).count()) === 0)
  // ノートに、言葉を 5 回と例文を 2 文、タイピングで書く。手書きの線も 1 本入れる
  await drillNote.getByRole('button', { name: '手書き', exact: true }).click()
  await drillNote.locator('.note-typed').first().click()
  for (const line of ['把握　把握　把握　把握　把握', '駅までの道を、地図を見て把握した。', '部長は、部員ひとりひとりの得意なことを把握している。']) {
    await drillNote.keyboard.type(line)
    await drillNote.keyboard.press('Enter')
  }
  await drillNote.getByRole('button', { name: 'タイピング', exact: true }).click()
  await drillNote.getByRole('button', { name: 'ペン', exact: true }).click()
  await penStroke(drillNote, 0, [[0.2, 0.5, 0.4], [0.4, 0.52, 0.7], [0.6, 0.5, 0.5]])
  await drillNote.waitForTimeout(400)
  await shot(drillNote, '10-vocab-note')
  await drillNote.getByRole('button', { name: '書けた！' }).click()
  if (withAi) {
    const began = Date.now()
    await vocab.waitForSelector('.check-result', { timeout: 240000 })
    const passed = (await vocab.locator('.check-result').getAttribute('data-ok')) === 'true'
    const skill = (await vocab.evaluate(() => window.manabi.skills.get())).values.vocabJa
    check('語彙力特訓: AI がノートを読んで合格にし、次の言葉へ進んで語彙力が上がる', passed && (await vocab.locator('.drill-word').innerText()) === '根拠' && skill > 0, `語彙力 ${skill} 点（${Math.round((Date.now() - began) / 1000)} 秒）`)
  } else {
    await drillNote.waitForSelector('.toast[data-kind="error"]', { timeout: 15000 })
    check('語彙力特訓: 「書けた！」で、ノートのページが画像として AI に渡される', existsSync(join(outDir, 'vocab-check-1.png')) && statSync(join(outDir, 'vocab-check-1.png')).size > 20000)
  }
  await vocab.waitForTimeout(300)
  await shot(vocab, '10-vocab')
  await vocab.getByRole('button', { name: 'この言葉をとばす' }).click()
  await vocab.waitForFunction((before) => document.querySelector('.drill-word')?.textContent !== before, withAi ? '根拠' : '把握', { timeout: 10000 })
  check('語彙力特訓: 言葉をとばせる', true)
  await vocab.getByRole('button', { name: 'やめる' }).click()
  await vocab.waitForSelector('.test-setup')
  await drillNote.close()
  await vocab.close()

  // ───────── 漢字特訓 ─────────
  const kanji = await opened(() => home.getByRole('button', { name: '漢字特訓' }).click(), 'kanji')
  await kanji.waitForSelector('.test-setup')
  const counted = (pattern) => kanji.waitForFunction((source) => new RegExp(source).test(document.querySelector('.test-setup')?.textContent ?? ''), pattern, { timeout: 15000 }).then(() => true, () => false)
  const joyo = await counted('2,136 字')
  await kanji.getByRole('button', { name: '小学 1 年' }).click()
  check('漢字特訓: 常用漢字 2,136 字が対象になり、範囲を小学 1 年（80 字）にしぼれる', joyo && (await counted('漢字: 80 字')))
  await shot(kanji, '12-kanji-setup')
  const windowsBefore = app.windows().length
  await kanji.getByRole('button', { name: '特訓を始める' }).click()
  await kanji.waitForSelector('.kanji-char')
  /** 開いているウィンドウの中から、その部品を持つものを探す */
  const windowWith = async (selector) => {
    for (let i = 0; i < 80; i++) {
      for (const win of app.windows()) if (await win.locator(selector).count().catch(() => 0)) return win
      await kanji.waitForTimeout(150)
    }
    return null
  }
  const order = await windowWith('.kanji-order-stage svg')
  const sheet = await windowWith('.kanji-grid')
  for (const [win, label] of [[order, 'kanji-order'], [sheet, 'kanji-note']]) if (win) watch(win, label)
  check('漢字特訓: 漢字・書き順・ノートの 3 つのウィンドウが開く', !!order && !!sheet && app.windows().length === windowsBefore + 2 && (await kanji.locator('.kanji-char').innerText()) === '一')
  check(
    '漢字特訓: 読みと、その漢字を使う言葉・例文が出る',
    (await kanji.locator('.kanji-facts').innerText()).includes('イチ') && (await kanji.locator('.kanji-words li').count()) === 3 && (await kanji.locator('.kanji-sentences li').count()) === 2,
  )
  check('漢字特訓: 書き順のウィンドウに、画数ぶんの線と番号が出る', (await order.locator('.kanji-ink').count()) === 1 && (await order.locator('.kanji-number').count()) === 1)

  /** いま書くマスに、線を 1 本書く（位置はマスに対する 0〜1 の割合） */
  const drawInBox = async (from, to) => {
    const box = await sheet.locator('.kanji-box[data-status="active"] canvas').boundingBox()
    await sheet.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
    await sheet.mouse.down()
    await sheet.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 })
    await sheet.mouse.up()
    await sheet.waitForTimeout(80)
  }
  const doneBoxes = () => sheet.locator('.kanji-box[data-status="done"]').count()
  // 「一」を右から左へ書くと、向きが逆だと知らされて、マスは埋まらない
  await drawInBox([0.9, 0.47], [0.1, 0.5])
  check('漢字特訓: 向きが逆の線は受けつけず、手がかりを出す', (await sheet.locator('.kanji-message').innerText()).includes('向き') && (await doneBoxes()) === 0)
  for (let i = 0; i < 10; i++) await drawInBox([0.1, 0.5], [0.9, 0.47])
  await kanji.waitForFunction(() => document.querySelector('.kanji-step b')?.textContent?.replace(/\s/g, '') === '10/10', null, { timeout: 5000 }).catch(() => {})
  check('漢字特訓: 正しい書き順で 10 回書くと、10 マスが埋まり、漢字のウィンドウにも伝わる', (await doneBoxes()) === 10 && (await kanji.locator('.kanji-step').getAttribute('data-done')) === 'true')
  const finish = sheet.getByRole('button', { name: '書けた！' })
  const lockedBeforeCopy = await finish.isDisabled()
  // 言葉と例文を、右のページにタイピングで書き写す
  await sheet.getByRole('button', { name: 'タイピング' }).click()
  await sheet.locator('.note-typed').click()
  for (const line of ['一つ　一月　一年', 'りんごを一つ食べる。', '一月は冬です。']) {
    await sheet.keyboard.type(line)
    await sheet.keyboard.press('Enter')
  }
  await sheet.locator('.kanji-note-title').click()
  await sheet.waitForFunction(() => !document.querySelector('.kanji-note-bar .btn-primary').disabled, null, { timeout: 5000 }).catch(() => {})
  check('漢字特訓: 言葉と例文を書き写すまでは進めず、書き写すと進める', lockedBeforeCopy && !(await finish.isDisabled()))
  await shot(sheet, '12-kanji-note')
  await shot(kanji, '12-kanji-card')
  await shot(order, '12-kanji-order')
  await finish.click()
  await kanji.waitForFunction(() => document.querySelector('.kanji-char')?.textContent === '右', null, { timeout: 8000 }).catch(() => {})
  await sheet.waitForFunction(() => document.querySelector('.kanji-note-title strong')?.textContent === '右', null, { timeout: 8000 }).catch(() => {})
  const kanjiSkill = (await kanji.evaluate(() => window.manabi.skills.get())).values.kanji
  check('漢字特訓: クリアすると漢字力が上がり、習う順の次の字（右）へ進む', (await kanji.locator('.kanji-char').innerText()) === '右' && kanjiSkill > 0 && (await doneBoxes()) === 0, `漢字力 ${kanjiSkill} 点`)
  // 「右」は 1 画目が左はらい。先に横線（2 画目）を書くと、書き順がちがうと知らされる
  await sheet.getByRole('button', { name: '手書き' }).click()
  await drawInBox([13 / 109, 42 / 109], [97 / 109, 37 / 109])
  const orderMessage = await sheet.locator('.kanji-message').innerText()
  await drawInBox([53.5 / 109, 21.5 / 109], [25.25 / 109, 74.25 / 109])
  check('漢字特訓: 書き順がちがう線は受けつけず、正しい 1 画目は受けつける', orderMessage.includes('書き順') && (await sheet.locator('.kanji-message').innerText()).includes('2 画目'), orderMessage)
  await shot(sheet, '12-kanji-note-2')
  await kanji.getByRole('button', { name: 'やめる' }).click()
  await kanji.waitForSelector('.test-setup')
  await kanji.waitForTimeout(500)
  check('漢字特訓: やめると、書き順とノートのウィンドウが閉じる', app.windows().length === windowsBefore)
  if (withAi) {
    // 言葉と例文がまだ無い字（常用外をランダムに）で始めて、AI が用意するのを待つ
    const began = Date.now()
    await kanji.getByRole('button', { name: 'ランダム' }).click()
    await kanji.getByRole('button', { name: '常用外のみ' }).click()
    await kanji.getByRole('button', { name: '特訓を始める' }).click()
    await kanji.waitForSelector('.kanji-char')
    const rare = await kanji.locator('.kanji-char').innerText()
    await kanji.waitForSelector('.kanji-words li, .kanji-sentences li, .kanji-card .form-error', { timeout: 240000 })
    const made = (await kanji.locator('.kanji-words li').count()) + (await kanji.locator('.kanji-sentences li').count())
    check('漢字特訓: 言葉と例文が無い字は、AI が用意する', made > 0, `「${rare}」 言葉と例文 ${made} 件（${Math.round((Date.now() - began) / 1000)} 秒）`)
    await shot(kanji, '12-kanji-ai')
    await kanji.getByRole('button', { name: 'やめる' }).click()
    await kanji.waitForSelector('.test-setup')
  }
  await kanji.close()

  // ───────── 成績 ─────────
  const report = await opened(() => home.getByRole('button', { name: '成績を見る' }).click(), 'report')
  await report.waitForSelector('.meter-list')
  check('成績: 5 つの観点と学習時間のグラフが出る', (await report.locator('.meter-list').first().locator('li').count()) === 5 && (await report.locator('.chart svg').count()) === 1)
  check('成績: 特訓とディベートで育つ 5 つの力が出る', (await report.locator('.meter-list').nth(1).locator('li').count()) === 5)
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const seconds = JSON.parse(readFileSync(join(dataDir, 'usage.json'), 'utf8'))[todayKey]?.['jhs-math'] ?? 0
  check('成績: 学習用のウィンドウを使った時間が記録される', seconds >= 3, `${seconds} 秒`)

  // 先週の評価が起動時に確定し、好感度が配られている
  check('成績: 終わった週の評価が確定して選べる', (await report.locator('.report-week select').last().locator('option').count()) === 2)
  await report.locator('.report-week select').last().selectOption({ index: 1 })
  await report.waitForTimeout(300)
  const lastWeek = await report.locator('.meter-list li').nth(4).locator('.meter-figure').innerText()
  check('成績: 先週の継続力が、学習した日数と時間から計算される', lastWeek.replace(/\D/g, '') === '15', lastWeek.replace(/\n/g, ''))
  // 棒グラフの見た目を確かめられるよう、上までもどし、水曜の棒にマウスを重ねた状態で撮る
  await report.locator('.report-scroll').evaluate((el) => el.scrollTo(0, 0))
  await report.locator('.chart rect').nth(2).hover()
  await report.waitForTimeout(300)
  check('成績: 棒に重ねると、その日の時間が表示される', (await report.locator('.chart-tooltip').innerText()).includes('30 分'))
  await shot(report, '8-report-last-week')
  await report.mouse.move(5, 5)
  await report.locator('.report-week select').last().selectOption({ index: 0 })
  if (withAi) {
    const understanding = await report.locator('.meter-list li').first().locator('.meter-figure').innerText()
    check('成績: ノートの評価が今週の理解力に反映される', /\d/.test(understanding), understanding.replace(/\n/g, ''))
    await report.getByRole('button', { name: '講評を書いてもらう' }).click()
    await report.waitForSelector('.report-comment .bubble', { timeout: 120000 })
    check('成績: 先生の講評が届く', (await report.locator('.report-comment .bubble').innerText()).length > 30)
  }
  await report.waitForTimeout(300)
  await shot(report, '8-report')

  // ───────── テスト ─────────
  const test = await opened(() => home.getByRole('button', { name: 'テストを受ける' }).click(), 'test')
  await test.waitForSelector('.test-setup .check')
  check('テスト: 準備の画面に、教科書がある授業だけが並ぶ', (await test.locator('.test-setup .check').count()) === 4 + (withGenerate ? 1 : 0))
  await shot(test, '9-test-setup')
  if (withAi) {
    const began = Date.now()
    await test.getByRole('button', { name: 'テストを始める' }).click()
    await test.waitForSelector('.question, .test-setup .form-error', { timeout: 240000 })
    const count = await test.locator('.question').count()
    check('テスト: AI が問題を作る', count === 5, `${count} 問（${Math.round((Date.now() - began) / 1000)} 秒）`)
    await test.waitForTimeout(500)
    check('テスト: 始まると、ほかのウィンドウが閉じる', app.windows().length === 1, `開いているウィンドウ ${app.windows().length} 枚`)
    // テスト中に教科書を開こうとしても、開かない
    await test.evaluate(() => window.manabi.view.open('textbook', {}))
    await test.waitForTimeout(600)
    check('テスト: テスト中は教科書を開けない', app.windows().length === 1)
    await test.evaluate(() => window.manabi.notes.list().then((l) => window.manabi.notes.get(l.find((n) => n.kind === 'lesson').id))).then(
      () => check('テスト: テスト中は過去のノートを読めない', false),
      () => check('テスト: テスト中は過去のノートを読めない', true),
    )
    await shot(test, '9-test-taking')

    // 計算用ノートは開ける
    const scratch = await opened(() => test.getByRole('button', { name: '計算用ノート' }).click(), 'test-note')
    await scratch.waitForSelector('.note-page canvas')
    check('テスト: 専用のノートは開けて、評価のボタンは出ない', (await scratch.getByRole('button', { name: /に見てもらう$/ }).count()) === 0)

    // 解答する: 選択は 1 つ目、短答は「-2」、記述は短い説明
    for (const question of await test.locator('.question').all()) {
      if (await question.locator('.choice').count()) await question.locator('.choice').first().click()
      else if (await question.locator('input.answer').count()) await question.locator('input.answer').fill('-2')
      else await question.locator('textarea.answer').fill('数直線の上で、正の数は右へ、負の数は左へ動くと考えるからです。')
    }
    const graded = Date.now()
    await test.getByRole('button', { name: '提出する' }).click()
    await test.waitForSelector('.test-score, .test-scroll > .form-error', { timeout: 240000 })
    const score = await test.locator('.hero-figure strong').innerText()
    check('テスト: 採点されて点数が出る', /^\d+$/.test(score), `${score} 点（${Math.round((Date.now() - graded) / 1000)} 秒）`)
    check('テスト: 問題ごとに正誤と正しい答えが出る', (await test.locator('.result-mark').count()) === 5 && (await test.locator('.answer-review').count()) === 5)
    await test.waitForTimeout(400)
    await shot(test, '9-test-result')

    // テストが終われば、また開けるようになる
    const after = await opened(() => test.getByRole('button', { name: '成績を見る' }).click(), 'report-after')
    await after.waitForSelector('.meter-list')
    const memory = await after.locator('.meter-list li').nth(3).locator('.meter-figure').innerText()
    check('成績: テストの点が記憶力に反映される', memory.replace(/\D/g, '') === score, memory.replace(/\n/g, ''))
    await after.waitForTimeout(300)
    await shot(after, '8-report-after')
  }
} catch (error) {
  check('途中で止まった', false, String(error).slice(0, 400))
  for (const [i, win] of app.windows().entries()) await win.screenshot({ path: join(outDir, `error-${i}.png`) }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

// ───────── 言語の切りかえ（英語の表示） ─────────
// 別のデータ置き場で、表示の言語を英語にしてアプリを開き直す。訳した教材の読みこみと、日本語のときだけの操作の案内を確かめる（AI は呼ばない）。
{
  const { spawnSync } = await import('node:child_process')
  const dict = spawnSync(process.execPath, ['--no-warnings', join(root, 'tools', 'i18n-dict.mjs')], { encoding: 'utf8' })
  check('言語: 画面の文言に、訳が足りないものや {0} の数が合わないものが無い', dict.status === 0, dict.stdout.trim().split('\n').pop())

  const enDir = join(outDir, 'data-en')
  const put = (path, text) => {
    mkdirSync(join(enDir, ...path.slice(0, -1)), { recursive: true })
    writeFileSync(join(enDir, ...path), typeof text === 'string' ? text : JSON.stringify(text), 'utf8')
  }
  put(['settings.json'], { language: 'en', courseId: 'hsp-shogyo-boki' })
  put(['curricula', 'hsp-shogyo-boki.json'], { units: [{ domain: '簿記の原理', title: '簿記のしくみ', summary: '簿記の目的を学ぶ。', lessons: [{ title: '簿記とは', summary: '簿記の目的' }, { title: '取引と仕訳', summary: '仕訳のしかた' }] }] })
  put(['i18n', 'en', 'curricula', 'hsp-shogyo-boki.json'], { units: [{ domain: 'Principles of Bookkeeping', title: 'How Bookkeeping Works', summary: 'Learn the purpose of bookkeeping.', lessons: [{ title: 'What is bookkeeping?', summary: 'The purpose of bookkeeping' }, { title: 'Transactions and journal entries', summary: 'How to make journal entries' }] }] })
  const talk = (lines) => ['```talk', ...lines, '```'].join('\n')
  put(['lessons', 'hsp-shogyo-boki-1-1.md'], ['# 簿記とは', '', '## この授業のねらい', '- 簿記の目的を説明できる。', '', talk(['sensei(smile): きょうは簿記の話です。', '福沢諭吉: わたしが、西洋の簿記を日本に紹介した。']), '', '## 簿記の目的', '簿記は、お金や物の出入りを記録するしくみです。'].join('\n'))
  put(['i18n', 'en', 'lessons', 'hsp-shogyo-boki-1-1.md'], ['# What Is Bookkeeping?', '', '## Goals of This Lesson', '- You can explain the purpose of bookkeeping.', '', talk(['sensei(smile): Today we talk about bookkeeping.', '福沢諭吉: I introduced Western bookkeeping to Japan.']), '', '## The Purpose of Bookkeeping', 'Bookkeeping is a system for recording money and goods coming in and going out.'].join('\n'))
  put(['i18n', 'en', 'people.json'], { 福沢諭吉: 'Fukuzawa Yukichi' })
  put(['lessons', 'hsp-shogyo-boki-1-2.md'], ['# 取引と仕訳', '', '## この授業のねらい', '- 仕訳のしかたがわかる。'].join('\n'))

  const en = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: enDir, MANABI_NO_AI: '1', MANABI_NO_RELAUNCH: '1' } })
  try {
    const home = await en.firstWindow()
    watch(home, 'home-en')
    await home.waitForSelector('.home-hello')
    check('言語: 英語にすると、ホームの文言と先生の名前が英語になる', (await home.locator('.home-brand h1').innerText()) === 'Manabi-Ai' && (await home.locator('.home-hello strong').innerText()) === 'Ms. Minori' && (await home.evaluate(() => document.documentElement.lang)) === 'en')
    const courses = await home.evaluate(() => window.manabi.content.courses())
    check('言語: 科目の名前が、訳した科目表のものになる', courses.find((c) => c.id === 'jhs1-math')?.title === 'Junior High Math, Year 1', courses.find((c) => c.id === 'jhs1-math')?.title)
    check('言語: 単元表の題が、訳したものになる', (await home.locator('.unit-heading strong').first().innerText()) === 'How Bookkeeping Works')
    await shot(home, 'en-1-home')

    const openIn = async (view, params, label) => {
      const [win] = await Promise.all([en.waitForEvent('window', notCompanion), home.evaluate(([v, p]) => window.manabi.view.open(v, p), [view, params])])
      await win.waitForLoadState('domcontentloaded')
      watch(win, label)
      return win
    }
    const book = await openIn('textbook', { lessonId: 'hsp-shogyo-boki-1-1' }, 'textbook-en')
    await book.waitForSelector('.paper h1')
    check('言語: 訳した授業の本文が出る', (await book.locator('.paper h1').innerText()) === 'What Is Bookkeeping?' && (await book.locator('.paper .notice button').count()) === 0)
    const names = await book.locator('.kakeai-say small').allInnerTexts()
    check('言語: 掛け合いの歴史上の人物の名前が、訳した名前で出る', names.includes('Fukuzawa Yukichi') && names.includes('Ms. Minori'), names.join(' / '))
    await shot(book, 'en-2-textbook')
    await book.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-2' }))
    await book.waitForFunction(() => document.querySelector('.paper h1')?.textContent === '取引と仕訳')
    check('言語: 訳がまだ無い授業は、日本語のまま出して、訳すボタンを出す', (await book.locator('.paper .notice button').count()) === 1, await book.locator('.paper .notice').last().innerText())
    check('言語: 日本語のときだけの操作（掛け合いを足す など）は出さない', (await book.locator('.paper-footer .btn-quiet').count()) === 0)
    const refused = await book.evaluate(() => window.manabi.content.talk('hsp-shogyo-boki-1-2').then(() => '', (e) => String(e.message)))
    check('言語: 英語の表示では、原本を書きかえる操作を受けつけない', /displayed in Japanese/.test(refused), refused.slice(-90))

    const settings = await openIn('settings', {}, 'settings-en')
    await settings.waitForSelector('.settings-language')
    check('言語: 設定に、言語の切りかえが出る', (await settings.locator('.settings-language button').allInnerTexts()).join('/') === '日本語/English' && (await settings.locator('.settings-language button[aria-pressed="true"]').innerText()) === 'English')
    await shot(settings, 'en-3-settings')
    const closed = en.waitForEvent('close', { timeout: 20000 }).then(() => true, () => false)
    await settings.locator('.settings-language button', { hasText: '日本語' }).click()
    await settings.locator('.settings-language-confirm .btn-primary').click()
    check('言語: 切りかえると、設定に書いてアプリを閉じる（ふだんは開き直す）', (await closed) && JSON.parse(readFileSync(join(enDir, 'settings.json'), 'utf8')).language === 'ja')
  } catch (error) {
    check('言語: 途中で止まった', false, String(error).slice(0, 400))
  } finally {
    await en.close().catch(() => {})
  }
}

// ───────── AI のつなぎ方（配る版の形） ─────────
// 配る版と同じ形（MANABI_AI_PUBLIC=1）で開き、選べる方式が「API キー」と「Sign in with ChatGPT」だけになること、
// キーを入れていなければ、AI を呼ぶ前に、わけを言って止まることを確かめる（外へは何も送らない。サインインもしない）。
{
  const pub = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: join(outDir, 'data-en'), MANABI_AI_PUBLIC: '1', MANABI_NO_RELAUNCH: '1' } })
  try {
    const home = await pub.firstWindow()
    watch(home, 'home-public')
    await home.waitForSelector('.home-hello')
    const link = await home.evaluate(() => window.manabi.ai.link.get())
    check('AI のつなぎ方: 配る版では、API キーと Sign in with ChatGPT だけが選べる', link.routes.join('/') === 'own-key/siwc' && link.route === 'own-key' && !link.anthropicKey && !link.siwc.signedIn, `${link.routes.join('/')}・いま ${link.route}`)
    const status = await home.evaluate(() => window.manabi.ai.status())
    await home.waitForSelector('.ai-settings-warning', { timeout: 5000 }).catch(() => {})
    check('AI のつなぎ方: キーを入れるまでは、AI は「まだ使えない」と出る', status.route === 'own-key' && !status.claude && !status.codex && (await home.locator('.ai-settings-warning').count()) === 1)
    const refused = await home.evaluate(() => window.manabi.chat.send('hsp-shogyo-boki-1-1', 'sensei', 'テスト').then(() => '', (e) => String(e.message)))
    check('AI のつなぎ方: キーが無ければ、AI を呼ぶ前に、わけを言って止まる', /API キーが設定されていません/.test(refused), refused.slice(-60))
    check('配る版: ホームに「教材づくり」が出ない', (await home.locator('.home-library').count()) === 0 && (await home.getByRole('button', { name: '教材づくりを開く' }).count()) === 0)
    await home.evaluate(() => window.manabi.view.open('library'))
    await home.waitForTimeout(800)
    const views = await Promise.all(pub.windows().map((win) => win.evaluate(() => window.manabi.view.get()).then((v) => v.view, () => '')))
    check('配る版: 教材づくりの画面は開かない', !views.includes('library'), views.join('/'))
    const [pubBook] = await Promise.all([pub.waitForEvent('window', notCompanion), home.evaluate(() => window.manabi.view.open('textbook', { lessonId: 'hsp-shogyo-boki-1-1' }))])
    await pubBook.waitForLoadState('domcontentloaded')
    watch(pubBook, 'textbook-public')
    await pubBook.waitForSelector('.paper h1')
    check('配る版: 教科書に、掛け合い・動く図解を作り直すボタンが出ない', (await pubBook.locator('.paper-footer .btn-quiet').count()) === 0 && (await pubBook.locator('.paper-footer .btn-mode').count()) === 3)
    const [settings] = await Promise.all([pub.waitForEvent('window', notCompanion), home.evaluate(() => window.manabi.view.open('settings', {}))])
    await settings.waitForLoadState('domcontentloaded')
    watch(settings, 'settings-public')
    await settings.waitForSelector('.ai-link')
    check('設定: 「AI のつなぎ方」に、2 つの方式と、キーを入れる欄が出る', (await settings.locator('.ai-link-route').count()) === 2 && (await settings.locator('.ai-link-detail input[type="password"]').count()) === 2)
    await shot(settings, 'ai-link-key')
    await settings.locator('.ai-link-route', { hasText: 'Sign in with ChatGPT' }).click()
    await settings.getByRole('button', { name: 'Continue with ChatGPT' }).waitFor()
    const after = await home.evaluate(() => Promise.all([window.manabi.ai.link.get(), window.manabi.settings.get()]))
    check('設定: Sign in with ChatGPT を選ぶと、AI が OpenAI（Codex）の側に切りかわる', after[0].route === 'siwc' && after[1].ai.provider === 'codex' && (await settings.locator('.ai-link-detail .btn-primary').innerText()) === 'Continue with ChatGPT')
    await shot(settings, 'ai-link-siwc')
  } catch (error) {
    check('AI のつなぎ方: 途中で止まった', false, String(error).slice(0, 400))
  } finally {
    await pub.close().catch(() => {})
  }
}

if (errors.length) console.log('\n画面で出たエラー:\n' + [...new Set(errors)].join('\n'))
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed} / ${checks.length} 項目が通りました。写真: ${outDir}`)
process.exit(failed || errors.length ? 1 : 0)
