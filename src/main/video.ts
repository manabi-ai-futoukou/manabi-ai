import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSim } from '@shared/sims'
import type { CharacterDef, LessonVariant } from '@shared/types'
import { cleanVideoScript, lessonFigures, lessonPictures, lessonSim, soundDistance, videoLines, type VideoInfo, type VideoProgress, type VideoScript } from '@shared/video'
import { askStructured } from './ai/ask'
import { VIDEO_SCHEMA, videoSystemPrompt, videoUserPrompt, type VideoMaterial } from './ai/authoring'
import { findLessonMeta, getCharacters, getLesson } from './content'
import { castFor } from './library'
import { dataDir } from './paths'
import { getSettings, lessonKey } from './store'

/**
 * 授業の動画（試作）。
 *
 *   1. 台本: 授業の本文を AI に読ませ、場面とせりふの並びを書かせる（videos/<授業>/script.json）
 *   2. 声:   せりふを 1 つずつ、この PC で動いている読み上げソフト（AivisSpeech）で音声にする（videos/<授業>/audio/）
 *   3. 再生: 画面（views/Video.tsx）が、台本と音声を合わせて再生する
 *   4. 書き出し: 再生している画面を録画して、動画ファイルにする（ffmpeg があれば MP4 にする）
 */

// ───────── 読み上げソフト ─────────

/** 読み上げソフト（VOICEVOX と同じ作りの入り口をもつもの）の場所。この PC の中だけで動かす */
const ENGINE = process.env['MANABI_VOICE_ENGINE'] || 'http://127.0.0.1:10101'
/** 使う声と、役ごとの話し方。先生は落ち着いた調子、同級生はふだんの調子 */
const SPEAKER = 'まお'
const STYLES = { teacher: 'おちつき', classmate: 'ふつー' }
const SPEED = { teacher: 1.0, classmate: 1.06 }
/** いまの声（女性の声 1 種類）で話させられる同級生。同級生の一覧の前半が女子 */
const voiced = (c: CharacterDef) => c.role === 'teacher' || /^s(0\d|10)$/.test(c.id)

async function engine<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENGINE}${path}`, { ...init, signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`読み上げソフトが応じませんでした（${response.status}）`)
  return (path.startsWith('/synthesis') ? Buffer.from(await response.arrayBuffer()) : await response.json()) as T
}

/** 役ごとの声の番号。読み上げソフトが動いていない・声が入っていないときは null */
async function voiceStyles(): Promise<Record<keyof typeof STYLES, number> | null> {
  try {
    const speakers = await engine<{ name: string; styles: { name: string; id: number }[] }[]>('/speakers')
    const styles = speakers.find((s) => s.name === SPEAKER)?.styles ?? []
    const id = (name: string) => styles.find((s) => s.name === name)?.id ?? styles[0]?.id
    const teacher = id(STYLES.teacher)
    const classmate = id(STYLES.classmate)
    return teacher === undefined || classmate === undefined ? null : { teacher, classmate }
  } catch {
    return null
  }
}

export async function voiceStatus(): Promise<{ ready: boolean; voice: string }> {
  return { ready: !!(await voiceStyles()), voice: `AivisSpeech: ${SPEAKER}` }
}

/** 読み上げソフトが決めた読み方（カタカナ）。読みまちがいが無いかを、あとで確かめるために残す */
function readingOf(query: Record<string, unknown>): string {
  const phrases = (query['accent_phrases'] ?? []) as { moras?: { text?: string }[]; pause_mora?: unknown }[]
  return phrases.map((phrase) => (phrase.moras ?? []).map((mora) => mora.text ?? '').join('') + (phrase.pause_mora ? '、' : '')).join(' ')
}

/** WAV の長さ（秒） */
function wavSeconds(wav: Buffer): number {
  let at = 12
  let byteRate = 0
  while (at + 8 <= wav.length) {
    const id = wav.toString('latin1', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'fmt ') byteRate = wav.readUInt32LE(at + 16)
    if (id === 'data') return byteRate ? Math.min(size, wav.length - at - 8) / byteRate : 0
    at += 8 + size + (size % 2)
  }
  return 0
}

// ───────── 置き場所 ─────────

const keyOf = (lessonId: string, variant: LessonVariant) => lessonKey(lessonId, variant)
const dirOf = (key: string) => dataDir('videos', key)
const scriptFile = (key: string) => join(dirOf(key), 'script.json')
const audioIndex = (key: string) => join(dirOf(key), 'audio.json')
const audioFile = (key: string, index: number) => join(dataDir('videos', key, 'audio'), `${String(index).padStart(3, '0')}.wav`)

interface AudioIndex {
  voice: string
  lines: { hash: string; seconds: number; kana: string }[]
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function videoFile(key: string): string {
  return ['mp4', 'webm'].map((ext) => join(dirOf(key), `video.${ext}`)).find((file) => existsSync(file) && statSync(file).size > 0) ?? ''
}

// ───────── 台本 ─────────

/** 動画に出る人: 先生と、いまの声で話させられる同級生 1 人（その単元の掛け合いに出る人から選ぶ） */
function videoCast(unitId: string): CharacterDef[] {
  const cast = castFor(unitId)
  const teacher = cast.find((c) => c.role === 'teacher')
  const mate = cast.find((c) => c.role === 'classmate' && voiced(c))
  return [teacher, mate].filter((c): c is CharacterDef => !!c)
}

function figureHint(block: string): string {
  if (block.startsWith('```plot')) return `グラフ（${block.split('\n').slice(1, -1).join(' ').slice(0, 80)}）`
  const labels = [...block.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].trim()).filter(Boolean)
  return `図（図の中の言葉: ${labels.slice(0, 12).join('、') || 'なし'}）`
}

async function writeScript(lessonId: string, variant: LessonVariant): Promise<VideoScript> {
  const found = findLessonMeta(lessonId)
  const lesson = getLesson(lessonId, variant)
  if (!found || !lesson) throw new Error('この授業の教科書がまだ用意されていません。')
  const { course, unit } = found
  const cast = videoCast(unit.id)
  const figures = lessonFigures(lesson.body)
  const pictures = lessonPictures(lesson.body)
  const sim = parseSim(lessonSim(lesson.body))
  const material: VideoMaterial = { figures: figures.map(figureHint), sim: sim ? { kind: sim.kind, values: sim.values, task: sim.task } : null, pictures }
  const roles = cast.map((c) => ({ id: c.id, expressions: Object.keys(c.expressions), teacher: c.role === 'teacher' }))
  let problem = ''
  // 決まりに合わないものが返ってきたら、わけを伝えて 1 回だけ書き直させる
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await askStructured<unknown>(getSettings().ai, videoSystemPrompt(course, variant, cast), videoUserPrompt(course, unit, found.lesson, lesson.body, material, problem), VIDEO_SCHEMA)
    try {
      return cleanVideoScript(output, roles, figures.length, pictures.map((p) => p.id), sim)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`動画の台本を作れませんでした（${problem}）`)
}

// ───────── 読みの点検 ─────────
//
// 読み上げソフトは、ときどき漢字を読みまちがえる（「平行な光」の「光」を「コウ」と読む、など）。
// 声を作る前に、読み上げソフトが決めた読み（カタカナ）を点検して、まちがいがあれば、読み上げ用の文を書きかえる。
//   1. AI に、文と読み上げソフトの読みを見せ、AI 自身の読みも書かせたうえで、まちがいを直させる
//   2. AI が「まちがい無し」としたせりふも、AI の読みと読み上げソフトの読みを機械的に突き合わせ、
//      ちがいが大きいものは、ちがっていることを伝えて、もう一度確かめさせる（AI の見落としを拾う）
//   3. 直したせりふは、もう一度読ませて確かめる

const READING_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'number' }, reading: { type: 'string' }, wrong: { type: 'string' }, say: { type: 'string' } },
        required: ['index', 'reading', 'wrong', 'say'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
}

const READING_SYSTEM = `あなたは、読み上げソフトの読みまちがいを見つける校正者です。動画のせりふと、読み上げソフトがその文をどう読むか（カタカナ）の一覧を渡します。読みまちがいを見つけて、正しく読ませるための書きかえを返します。

# 読みの書き方について
- 読みは、発音どおりのカタカナです。のばす音は「ショオテン（焦点）」「ヘエコオ（平行）」のように書かれ、助詞の「は」は「ワ」、「へ」は「エ」、「を」は「オ」と書かれます。これらは正しい読みです。
- 空白や「,」は、息つぎや区切りの位置です。位置そのものは気にしません。

# 見つけるもの
- 漢字の読みまちがい。音読みと訓読みの取りちがえに気をつけます（例: 「平行な光は」を「ヘエコオナコオハ」と読んでいる。ここでの「光」は「ヒカリ」で、正しくは「ヘエコオナ ヒカリワ」）
- 言葉の区切りをまちがえて、別の言葉になっているもの（例: 「実像と虚像」を「ジツゾ ウトキヨゾウ」と読んでいる）
- 数字・記号・アルファベットの読みが不自然なもの、読まれずに抜けている言葉

# 進め方
- せりふを 1 つずつ見ます。まず、その文を人が声に出して読むときの正しい読みを、自分で書きます（reading）。次に、それを読み上げソフトの読みと、前から順に突き合わせます。
- 「注意」が付いているせりふは、前の点検で、あなたの読みと読み上げソフトの読みがちがっていたものです。どこがちがうのかを見て、読み上げソフトのほうがまちがっていれば、かならず直します。

# 直し方
- まちがって読まれた言葉を、ひらがな（外来語はカタカナ）で書きます。区切りのまちがいは、読点「、」を入れるか、ひらがなで書いて直します。
- 言葉や意味は変えません。書きかえるのは、読みまちがいのある部分だけです。

# 出力
lines に、渡されたせりふを 1 つ残らず、番号の順に返します。
- index: せりふの番号
- reading: あなたが正しいと考える、その文の読み（読み上げソフトと同じ書き方のカタカナ）
- wrong: 読み上げソフトがまちがって読んでいる部分（文の中の言葉と、まちがった読み）。まちがいが無ければ、空文字
- say: まちがいがあるときだけ、書きかえた読み上げ用の文（そのせりふ全体）。まちがいが無ければ、空文字`

/** 読み上げソフトの読みを点検して、読みまちがいのあるせりふの「読み上げ用の文」を直す。直した数を返す */
async function checkReadings(key: string, script: VideoScript, styles: Record<keyof typeof STYLES, number>, progress: (p: VideoProgress) => void): Promise<number> {
  const lines = videoLines(script)
  let targets = lines.map((_line, i) => i)
  /** 前の点検で、AI の読みと読み上げソフトの読みがちがっていたせりふ（番号 → AI の読み） */
  let doubts = new Map<number, string>()
  const changed = new Set<number>()
  for (let round = 0; round < 3 && targets.length; round++) {
    const heard = new Map<number, string>()
    const listed: string[] = []
    for (const [n, i] of targets.entries()) {
      progress({ step: 'reading', done: n, total: targets.length })
      const query = await engine<Record<string, unknown>>(`/audio_query?speaker=${styles.teacher}&text=${encodeURIComponent(lines[i].data.say)}`, { method: 'POST' })
      heard.set(i, readingOf(query))
      const doubt = doubts.get(i)
      listed.push(`[${i}] 文: ${lines[i].data.say}\n    読み: ${heard.get(i)}${doubt ? `\n    注意: 前の点検でのあなたの読みは「${doubt}」で、読み上げソフトの読みとちがっています。` : ''}`)
    }
    const output = await askStructured<{ lines: { index: number; reading: string; wrong: string; say: string }[] }>(getSettings().ai, READING_SYSTEM, `次のせりふの読みを点検してください。\n\n${listed.join('\n')}`, READING_SCHEMA)
    // 点検の記録を残す（どこを読みまちがいと判断したかを、あとで見られるように）
    writeFileSync(join(dirOf(key), `reading-check-${round + 1}.json`), JSON.stringify({ asked: listed, answered: output }, null, 1), 'utf8')
    const next: number[] = []
    const doubted = new Map<number, string>()
    for (const answer of Array.isArray(output.lines) ? output.lines : []) {
      const index = Math.round(Number(answer.index))
      if (!targets.includes(index)) continue
      const say = String(answer.say ?? '').replace(/\s+/g, ' ').trim().slice(0, 260)
      if (say && say !== lines[index].data.say) {
        lines[index].data.say = say
        changed.add(index)
        next.push(index)
      } else if (!doubts.has(index) && soundDistance(String(answer.reading ?? ''), heard.get(index) ?? '') >= 2) {
        // AI は「まちがい無し」としたが、AI 自身の読みとは 2 文字ぶん以上ちがう。見落としかもしれないので、もう一度確かめさせる
        doubted.set(index, String(answer.reading).slice(0, 300))
        next.push(index)
      }
    }
    doubts = doubted
    targets = next
  }
  return changed.size
}

// ───────── 声 ─────────

async function speak(key: string, script: VideoScript, progress: (p: VideoProgress) => void): Promise<void> {
  const styles = await voiceStyles()
  if (!styles) throw new Error('読み上げソフト（AivisSpeech）が動いていないか、使う声が入っていません。AivisSpeech を起動してから、もう一度ためしてください。')
  if (!script.checked) {
    await checkReadings(key, script, styles, progress)
    script.checked = true
    writeFileSync(scriptFile(key), JSON.stringify(script, null, 1), 'utf8')
  }
  const cast = Object.fromEntries(getCharacters().map((c) => [c.id, c.role]))
  const lines = videoLines(script)
  const before = readJson<AudioIndex>(audioIndex(key))?.lines ?? []
  const index: AudioIndex = { voice: `AivisSpeech: ${SPEAKER}`, lines: [] }
  for (const [i, { data }] of lines.entries()) {
    progress({ step: 'voice', done: i, total: lines.length })
    const role = cast[data.speaker] === 'teacher' ? 'teacher' : 'classmate'
    const hash = createHash('sha1').update(`2|${data.say}|${SPEAKER}|${STYLES[role]}|${SPEED[role]}`).digest('hex').slice(0, 16)
    const file = audioFile(key, i)
    // せりふも声も前と同じなら、作り直さない
    if (before[i]?.hash === hash && existsSync(file)) {
      index.lines.push(before[i])
      continue
    }
    const query = await engine<Record<string, unknown>>(`/audio_query?speaker=${styles[role]}&text=${encodeURIComponent(data.say)}`, { method: 'POST' })
    Object.assign(query, { speedScale: SPEED[role], prePhonemeLength: 0.08, postPhonemeLength: 0.12 })
    const wav = await engine<Buffer>(`/synthesis?speaker=${styles[role]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) })
    writeFileSync(file, wav)
    index.lines.push({ hash, seconds: Math.round(wavSeconds(wav) * 1000) / 1000, kana: readingOf(query) })
    writeFileSync(audioIndex(key), JSON.stringify(index), 'utf8')
  }
  writeFileSync(audioIndex(key), JSON.stringify(index), 'utf8')
}

// ───────── 画面から ─────────

/** その授業の動画（台本と、音声の長さ）。まだ無ければ null */
export function getVideo(lessonId: string, variant: LessonVariant): VideoInfo | null {
  const key = keyOf(lessonId, variant)
  const script = readJson<VideoScript>(scriptFile(key))
  const found = findLessonMeta(lessonId)
  const lesson = getLesson(lessonId, variant)
  if (!script || !found || !lesson) return null
  const audio = readJson<AudioIndex>(audioIndex(key))
  const count = videoLines(script).length
  const ready = audio?.lines.length === count && audio.lines.every((_line, i) => existsSync(audioFile(key, i)))
  return {
    lessonId,
    variant,
    title: `${found.lesson.number} ${found.lesson.title}`,
    courseTitle: found.course.title,
    script,
    figures: lessonFigures(lesson.body),
    sim: lessonSim(lesson.body),
    durations: ready ? audio!.lines.map((line) => line.seconds) : [],
    voice: audio?.voice ?? '',
    file: videoFile(key),
  }
}

const making = new Map<string, Promise<VideoInfo>>()

/** 動画を作る（台本 → 声）。redo が真なら、台本から作り直す */
export function makeVideo(lessonId: string, variant: LessonVariant, redo: boolean, progress: (p: VideoProgress) => void): Promise<VideoInfo> {
  const key = keyOf(lessonId, variant)
  const running = making.get(key)
  if (running) return running
  const work = (async () => {
    let script = redo ? null : readJson<VideoScript>(scriptFile(key))
    if (!script) {
      progress({ step: 'script', done: 0, total: 1 })
      script = await writeScript(lessonId, variant)
      writeFileSync(scriptFile(key), JSON.stringify(script, null, 1), 'utf8')
      // 台本が変わったら、前に書き出した動画は合わなくなる
      for (const ext of ['mp4', 'webm']) rmSync(join(dirOf(key), `video.${ext}`), { force: true })
    }
    await speak(key, script, progress)
    progress({ step: 'done', done: 1, total: 1 })
    return getVideo(lessonId, variant)!
  })().finally(() => making.delete(key))
  making.set(key, work)
  return work
}

/** せりふ 1 つぶんの音声（画面で再生できる形） */
export function videoAudio(lessonId: string, variant: LessonVariant, index: number): string {
  const file = audioFile(keyOf(lessonId, variant), Math.max(0, Math.round(index)))
  return existsSync(file) ? `data:audio/wav;base64,${readFileSync(file).toString('base64')}` : ''
}

// ───────── 動画ファイルへの書き出し ─────────

const run = (command: string, args: string[]) =>
  new Promise<boolean>((resolve) => execFile(command, args, { windowsHide: true, timeout: 600000 }, (error) => resolve(!error)))

/**
 * 録画したデータを受け取って、動画ファイルにする。
 * start で空のファイルを作り、chunk で順に書き足し、end で閉じる。ffmpeg があれば、どの再生ソフトでも開ける MP4 に直す。
 * 戻り値は、できた動画ファイルの場所（end のとき）。
 */
export async function recordVideo(lessonId: string, variant: LessonVariant, action: 'start' | 'chunk' | 'end' | 'cancel', chunk?: ArrayBuffer): Promise<string> {
  const key = keyOf(lessonId, variant)
  const raw = join(dirOf(key), 'record.webm')
  if (action === 'start') {
    writeFileSync(raw, Buffer.alloc(0))
    return ''
  }
  if (action === 'chunk') {
    if (chunk) appendFileSync(raw, Buffer.from(chunk))
    return ''
  }
  if (action === 'cancel') {
    rmSync(raw, { force: true })
    return ''
  }
  for (const ext of ['mp4', 'webm']) rmSync(join(dirOf(key), `video.${ext}`), { force: true })
  const mp4 = join(dirOf(key), 'video.mp4')
  // 録画したままのデータは、長さの情報が入っておらず、再生ソフトによっては早送りできない。作り直して整える
  if (await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', mp4])) {
    rmSync(raw, { force: true })
    return mp4
  }
  rmSync(mp4, { force: true })
  const webm = join(dirOf(key), 'video.webm')
  writeFileSync(webm, readFileSync(raw))
  rmSync(raw, { force: true })
  return webm
}
