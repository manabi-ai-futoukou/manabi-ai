/**
 * 教科書の本文に埋めこむ「掛け合い」（```talk）の決まり。
 *
 *   ```talk
 *   sensei(point): きょうは「割合」の話です。
 *   s01(troubled): 割合って、パーセントのこと？
 *   織田信長: わしの話も聞いてくれ。
 *   ```
 *
 * 1 行が 1 つのせりふ。「話し手(表情): せりふ」の形で、話し手は登場人物の ID。
 * 登場人物に無い名前（歴史上の人物など）は、そのまま名前として表示する。表情は省ける。
 */

export interface TalkLine {
  /** 登場人物の ID、または、そのまま表示する名前 */
  speaker: string
  /** 表情の名前。指定が無いときは空文字 */
  expression: string
  text: string
}

/** 授業に入れる掛け合い。intro: 本文の前に置く導入 / check: 確かめ問題の前に置く、つまずきやすい所の確認 */
export interface LessonTalk {
  intro: TalkLine[]
  check: TalkLine[]
}

const LINE = /^([^\s()（）:：、。「」]{1,16})\s*(?:[（(]\s*([A-Za-z]{1,16})\s*[)）])?\s*[:：]\s*(\S.*)$/

export function parseTalk(source: string): TalkLine[] {
  const lines: TalkLine[] = []
  for (const raw of source.split('\n')) {
    const found = LINE.exec(raw.trim())
    if (found) lines.push({ speaker: found[1], expression: found[2] ?? '', text: found[3].trim() })
    // 話し手の無い行は、前のせりふの続きとして読む
    else if (raw.trim() && lines.length) lines[lines.length - 1].text += ` ${raw.trim()}`
  }
  return lines
}

export function formatTalk(lines: TalkLine[]): string {
  const body = lines.map((l) => `${l.speaker}${l.expression ? `(${l.expression})` : ''}: ${l.text.replace(/\s*\n\s*/g, ' ')}`).join('\n')
  return '```talk\n' + body + '\n```'
}

/** 本文に、掛け合いのブロックがすでにあるか */
export const hasTalk = (body: string) => /^```talk\s*$/m.test(body)

/** 本文から掛け合いのブロックを取り除く（insertTalk で差しこむ前の本文にもどる） */
export function stripTalk(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/^```talk\n[\s\S]*?\n```\n\n?/gm, '')
}

/**
 * 本文に掛け合いを差しこむ。本文そのものには手を加えない。
 *   intro … 「この授業のねらい」のあと、本文の最初の見出しの前
 *   check … 「確かめ問題」の見出しの前（その見出しが無い授業には入れない）
 */
export function insertTalk(body: string, talk: LessonTalk): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  // コードブロック（図など）の中の行は、見出しとして数えない
  const headings: number[] = []
  let fenced = false
  lines.forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced
    else if (!fenced && /^## /.test(line)) headings.push(i)
  })
  const block = (talkLines: TalkLine[]) => [formatTalk(talkLines), '']
  const inserts: { at: number; lines: string[] }[] = []

  if (talk.check.length) {
    const at = headings.find((i) => /確かめ問題/.test(lines[i]))
    if (at !== undefined) inserts.push({ at, lines: block(talk.check) })
  }
  if (talk.intro.length) {
    const first = headings[0]
    let at: number
    if (first === undefined) at = Math.min(lines.length, 1)
    else if (/ねらい/.test(lines[first])) at = headings[1] ?? lines.length
    else at = first
    inserts.push({ at, lines: at === lines.length ? ['', ...block(talk.intro)] : block(talk.intro) })
  }
  // うしろから差しこむ（前の位置がずれないように）
  for (const insert of inserts.sort((a, b) => b.at - a.at)) lines.splice(insert.at, 0, ...insert.lines)
  return lines.join('\n')
}
