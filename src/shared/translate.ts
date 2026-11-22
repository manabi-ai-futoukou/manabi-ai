/**
 * 授業の本文を外国語に訳すときの決まり（AI への指示文と、訳の形の確かめ方）。
 * アプリ（src/main/translate.ts）と、まとめて訳す道具（tools/translate-lessons.mjs）の両方から使う。
 *
 * 元の授業（日本語）は書きかえない。訳は、元の授業から作り直せる「写し」として、言語ごとに別の場所に置く。
 * 訳のあとで、見出し・ブロック・掛け合いの話し手・挿絵の ID・図のタグが元と同じかを機械的に確かめ、
 * ID や数値、話し手と表情は、訳がどう書いてあっても元のものにもどす。
 */

/** 訳せる言語（name は、指示文の中で使う英語での呼び名。teacher は、先生の呼び方） */
export const TRANSLATION_LANGS: Record<string, { name: string; teacher: string }> = {
  en: { name: 'English', teacher: 'Ms. Minori' },
}

/** 掛け合いに出る人たちの、名前の読み（せりふの中で名前を呼ぶときに使う） */
export const CAST: Record<string, string> = {
  s01: 'Hinata', s02: 'Tsumugi', s03: 'Akari', s04: 'Koharu', s05: 'Mio', s06: 'Kotone', s07: 'Hikaru', s08: 'Shizuku', s09: 'Madoka', s10: 'Shiori',
  s11: 'Haruto', s12: 'Sota', s13: 'Daichi', s14: 'Yuma', s15: 'Riku', s16: 'Aoi', s17: 'Kakeru', s18: 'Ren', s19: 'Keito', s20: 'Koki',
}

/** 訳し方を分ける、授業の種類（general: ふつうの教科 / japanese: 国語・書道 / english: 英語） */
export type LessonKind = 'general' | 'japanese' | 'english'

/** 訳すのに要る、科目の情報 */
export interface TranslationCourse {
  id: string
  school: string
  subject: string
  subjectLabel: string
  label: string
  /** 授業づくりの手引きの名前（「industry+english」のように、英語を教える専門科目には english が入る） */
  guide?: string
}

export function lessonKind(course: TranslationCourse | null | undefined): LessonKind {
  if (course?.subject === 'japanese' || /shodo/.test(course?.id ?? '')) return 'japanese'
  // 「工業技術英語」のように、教科は別でも英語を教える科目は、英語の授業として訳す
  if (course?.subject === 'english' || /english/.test(course?.guide ?? '')) return 'english'
  return 'general'
}

// ───────── 指示文 ─────────

const common = (lang: string) => {
  const { name, teacher } = TRANSLATION_LANGS[lang]
  return `You translate one lesson of a Japanese school textbook app into ${name}. The reader is a student of the same grade as the original; the user message tells you the school level. Write the way a good textbook for that grade is written in ${name}: natural, clear, and warm, with vocabulary that grade can read. Translate the meaning faithfully. Do not add, drop, summarize, or "improve" content.

Output only the translated lesson, starting with its first heading. Write it once, from top to bottom. Never comment on your own work, never restart, and never leave a part untranslated to fix later. No preface, no notes, no code fence around the whole lesson.

STRUCTURE — the lesson is Markdown; keep its structure exactly:
- The same headings in the same order at the same levels, the same lists, tables, block quotes, and bold marks. Do not merge, split, or reorder sections.
- Math between $...$ or $$...$$ keeps its numbers, symbols, and LaTeX commands exactly. Japanese words and units inside math must be translated too, inside \\text{...} — for example $$利益 = 売上 - 費用$$ → $$\\text{profit} = \\text{sales} - \\text{costs}$$, 500\\ 円 → 500\\ \\text{yen}, 3\\ 個 → 3\\ \\text{pieces}, (固) → (s). No Japanese characters may remain inside math. The only exception is a lesson that teaches the Japanese number words 万, 億, 兆 themselves.
- Numbers, years, and formulas stay as they are. Keep the units, the currency (amounts stay in yen), and the school grades of Japan, but write them in ${name}: 円 → yen, and amounts written with 万 or 億 as ordinary numbers of the same value (3万円 → 30,000 yen; 2億人 → 200 million people).
- Choice labels ア, イ, ウ, エ become A, B, C, D (use (a), (b), (c), (d) instead if the lesson already uses A, B, C for something else). Keep ①②③ and (1)(2)(3).
- Use exactly these translations for the standard headings: この授業のねらい → "Goals of This Lesson"; 前の授業を思い出しましょう (and similar) → "Review of the Last Lesson"; 例題 / れいだい → "Worked Example"; 例文 → "Example Sentences"; 基本文 → "Key Sentences"; 新出の語句 (and similar) → "New Words"; やってみましょう → "Try It"; 資料から考える → "Thinking from Sources"; 安全のために → "For Your Safety"; つまずきやすいところ → "Common Stumbling Points"; 確かめ問題 / たしかめもんだい → "Check Your Understanding"; 答え / こたえ → "Answers"; 考え方 → "How to Think About It"; ノートに書いてみましょう (any spelling) → "Write in Your Notebook"; お話 → "Story"; 考えてみましょう → "Let's Think"; 考えるヒント → "Hints for Thinking". In the text, 問1 → "Q1", 問 / 問い / 問題 → "Question", 答え / 解答 → "Answer".

FENCED BLOCKS — keep every block, in the same place, with the same fence name:
- \`\`\`talk: each line is "speaker(expression): what they say". Translate what they say; this is part of the lesson and must be translated like everything else. Keep the same number of lines in the same order, and keep "speaker(expression)" unchanged when the speaker is "sensei" or "s01"–"s20". When the speaker is a historical person's name written in Japanese, write that person's usual English name as the speaker (for example "聖徳太子:" → "Prince Shōtoku:").
  Do not add a name to a line that does not address anyone by name in the original (よいところに気づきましたね。 → "Good observation." — no name). When the original line does address someone by name, use these names: sensei is ${teacher}; ${Object.entries(CAST).map(([id, given]) => `${id} ${given}`).join(', ')}. Drop "-san" and similar.
- \`\`\`picture, \`\`\`sim, \`\`\`plot, \`\`\`numberline: one JSON object. Translate only the human-readable text values ("caption", "task", "label", "title", and the like). Keep "id", "kind", all numbers, and all keys unchanged. Keep it valid JSON, on one line if it was on one line.
- \`\`\`figure: SVG. Translate only the text inside <text>…</text>, and keep each label as short as you can. If a longer label would run outside the picture, you may change that <text>'s x, text-anchor, or font-size so it still fits; change nothing else — every other tag and attribute stays exactly as it is.
- Program code and pseudo-code (python, sql, html, c, a block with no name, …): keep the logic, the syntax, and identifiers written in Latin letters unchanged. Translate the comments, and translate the Japanese text in the code as well: string literals and messages, sample data, Japanese table and column names, and the Japanese keywords of pseudo-code (もし〜ならば → if … then, 表示する(x) → display(x), 〜の間繰り返す → repeat while …). Be consistent, so that the code, its expected output, and the explanation around it use the same words. Keep Japanese text in code only when the lesson is about handling Japanese text itself (for example character codes).

JAPAN-SPECIFIC CONTENT:
- For Japanese people, places, eras, works, laws, and institutions, use the usual English name, and add the original Japanese in parentheses the first time it appears — for example "Prince Shōtoku (聖徳太子)". After that, use the English name only. If you are not sure how a person's name is read, keep the kanji in parentheses anyway so the reader can look it up.
- When the lesson quotes a Japanese or classical Chinese text, keep the original quotation and add an English translation right after it.
- Lessons for the lower grades are written mostly in hiragana with spaces between words. Read them carefully (for example さらに may mean "on the plate", not "furthermore").`
}

const GENERAL = `
- This lesson is not about the Japanese language. So when a sentence only explains how something is said or written in Japanese (the order in which a fraction is read aloud, Japanese note names such as ハ・ニ・ホ, counter words, how a kanji term got its name), say how it works in English instead, so that nothing in the lesson is false for an English reader; you may mention the Japanese way in a short parenthesis when it helps. Everything else stays a faithful translation.
- Apart from the parenthesized originals of proper nouns and quoted texts, no Japanese should remain in your output.`

const JAPANESE = `
- THIS LESSON TEACHES THE JAPANESE LANGUAGE (kokugo: reading, writing, grammar, kanji, classical Japanese, or classical Chinese). The English version is for a student who studies Japanese as a subject and reads the explanations in English.
- Keep in Japanese everything that is the object of study: example words and sentences, kanji, kana, passages being read, classical texts, and answers that are Japanese words. Where it helps, add a reading in rōmaji and an English meaning in parentheses, for example 山 (yama, "mountain").
- Translate the explanations, instructions, questions, and the talk lines into English (inside talk lines, the Japanese examples being discussed stay in Japanese too).`

const ENGLISH = `
- THIS LESSON TEACHES ENGLISH to Japanese-speaking students. In the English version, explain everything in English.
- Keep the English example words and sentences exactly as they are. Where the original gives a Japanese translation of an English example only as a gloss, drop the gloss. Where the point is the contrast between English and Japanese (word order, sounds that Japanese lacks, false friends), keep the Japanese example and add a rōmaji reading and an English gloss.
- Advice written for Japanese speakers (for example about katakana pronunciation) stays, addressed to "speakers of Japanese".
- EXERCISES THAT ASK FOR AN ENGLISH SENTENCE. When a question, a worked example, a word-reordering task, or a fill-in-the-blank task gives a Japanese sentence and the student must produce the English for it, the finished English sentence is the answer, so it must never appear in the question — not as a translation, not as a gloss in parentheses. Give the meaning as an indirect instruction in English that does not use the target sentence, and keep the hints: 「わたしは肉を食べません。」を英語にしましょう → "Say in English that you do not eat meat."; 「あなたは泳げますか。」を英語で書きなさい → "Ask a friend whether he or she is able to swim. Use can."; 「私は、明日は晴れると思います。」(sunny を使う) → "Say what you think about tomorrow's weather: you expect a clear sky. Use that and sunny." The answers section still gives the English sentences, as in the original.`

/** 訳すときの、AI への指示文（kind ごとに同じ文になるので、まとめて訳すときに使い回せる） */
export function translationSystem(kind: LessonKind, lang: string): string {
  return common(lang) + (kind === 'japanese' ? JAPANESE : kind === 'english' ? ENGLISH : GENERAL)
}

const SCHOOL: Record<string, string> = { es: 'elementary school', jhs: 'junior high school (ages 12–15)', hs: 'high school (ages 15–18)', hsp: 'a specialized (vocational) high school course (ages 15–18)' }

/** だれに向けた授業か（key は、授業の保存名。「.deep」が付くものは学び直し向け） */
function audience(key: string, course: TranslationCourse | null | undefined): string {
  if (!course) return 'school students in Japan'
  const grades = course.school === 'es' ? (course.id.match(/^es(\d+)/)?.[1] ?? '') : ''
  const grade = grades ? ` grade${grades.length > 1 ? 's' : ''} ${[...grades].join('–')}` : ''
  const deep = /\.deep$/.test(key) ? ' This is the "relearning" version: it is read by an older student who is going back over elementary content, so it explains the reasons in more depth.' : ''
  return `${SCHOOL[course.school] ?? 'school'}${grade}; the course is 「${course.subjectLabel}${course.label === course.subjectLabel ? '' : ` ${course.label}`}」.${deep}`
}

/** 訳すときに AI に渡す文（授業の本文つき） */
export function translationUser(key: string, course: TranslationCourse | null | undefined, body: string, lang: string, hint = ''): string {
  return `Audience: ${audience(key, course)}\n\nTranslate the following lesson into ${TRANSLATION_LANGS[lang].name} as instructed.${hint ? `\n\n${hint}` : ''}\n\n---\n\n${body}\n`
}

/** 訳が「日本語が残っている」という理由で使えなかったか（日本語そのものを扱う授業では、残すのが正しいことがある） */
export const isLeftover = (why: string): boolean => /日本語が多く残っている|せりふが訳されていない|の中に日本語が残っている/.test(why)

/**
 * 訳し直すときに、AI に渡す文に足す注意。前の訳が形の確かめでどう落ちたか（why）に合わせて、元の授業の形を具体的に伝える。
 * 足すことが無いときは、空の文字列。
 */
export function retryHint(source: string, why: string): string {
  const notes: string[] = []
  if (/見出し|題（/.test(why)) {
    const heads = withoutBlocks(source).split('\n').filter((l) => /^#{1,4} /.test(l))
    notes.push(`The lesson has exactly these ${heads.length} heading lines, in this order: ${heads.map((h) => `"${h.trim()}"`).join(', ')}. Translate each of them and write no other heading line. Never turn a sentence into a heading (a sentence that introduces a word list or a table stays a plain sentence), never add a heading of your own, and never drop one.`)
  }
  if (/ブロック/.test(why)) {
    const blocks = blocksOf(source)
    notes.push(`The lesson has exactly ${blocks.length} fenced block${blocks.length === 1 ? '' : 's'}${blocks.length ? ` (${blocks.map((b) => '```' + b.kind).join(', ')}, in this order)` : ''}. Keep each one in its place and never put any other text (a poem, a passage, an example) inside a new fenced block.`)
  }
  if (/表の行数/.test(why)) notes.push(`Outside fenced blocks the lesson has exactly ${tableRows(source)} table lines (lines that start with "|"). Keep every one of them as a table line, and do not add, merge, or drop rows.`)
  if (/図の文字/.test(why)) notes.push('In every ```figure block keep exactly the same <text> elements as the original: the same number of them, in the same order. Never add, remove, split, or merge a <text> element; only translate the words inside each one.')
  if (/掛け合いの行/.test(why)) notes.push('In every ```talk block keep exactly the same number of lines as the original: one translated line for each original line, each starting with the same "speaker(expression):".')
  if (/別の言語の文字/.test(why)) notes.push('Write in English only. A word in another script (Russian, Korean, Arabic, …) slipped into an earlier attempt; every word that is not a Japanese original in parentheses must be English.')
  if (/訳者のメモ/.test(why)) notes.push('Do not add notes about the translation or about the original ("Note: in the original …"). Adapt the text silently.')
  if (/作業の言葉/.test(why)) notes.push('Output the translated lesson only, once, from its "# " heading to its end, with no remark about your own work anywhere.')
  if (/JSON|の中身の数|の形がちがう|の文字が訳されていない/.test(why)) notes.push('In every ```picture, ```sim, ```plot, and ```numberline block keep the JSON exactly as it is (same keys, same arrays with the same number of items, same numbers) and translate only its Japanese text values.')
  const leaked = /問題文に答えの英文が出ている（(.+?)）/.exec(why)?.[1]
  if (leaked) notes.push(`The answer sentence "${leaked}" could be read in a question (before the answers section), so the exercise gave its own answer away. In every exercise that asks the student to produce an English sentence, the question must not contain that sentence in any form — no translation of the Japanese prompt, no gloss in parentheses, no quotation. Describe what to say indirectly instead ("Say in English that …", "Ask a friend whether …"), and check every question of the lesson for this. A run of four or more words of the answer must not appear in the question. When the meaning cannot be described without the answer's own wording, change the form of the question: describe the situation ("You want to know if your friend swims. What do you ask?"), or give only the base words to build the sentence from ("she / write / this letter — make a sentence in the passive").`)
  if (/数式の中に日本語/.test(why)) notes.push('Inside math ($...$ and $$...$$) translate every Japanese word and unit into English inside \\text{...} (利益 → \\text{profit}, 円 → \\text{yen}, 個 → \\text{pieces}); leave no Japanese characters inside a formula.')
  if (/問題文の中に日本語/.test(why)) notes.push('In the worked example and the questions, a Japanese sentence was left for the student to put into English, with no way for a reader of English to know what it says. Replace each such sentence by an indirect instruction in English ("Politely ask someone to close the window. (Use close.)"), without giving the answer sentence itself.')
  if (/名前を言い直す/.test(why)) notes.push('In a talk line, never correct yourself about a name ("Good thinking, Koki... no, Haruto."). Each line is spoken to the student whose line came just before; if you are not sure of the name, leave the name out.')
  if (/プログラムの中に日本語/.test(why)) notes.push('In program code and pseudo-code translate the Japanese strings, comments, sample data, and pseudo-code keywords into English, consistently with the explanation around the code; keep the logic unchanged.')
  if (/日本語が多く残っている|せりふが訳されていない/.test(why)) notes.push('Translate every explanation, instruction, question, and talk line. Japanese may remain only where the Japanese wording itself is what the lesson is about (for example model sentences in a lesson on polite Japanese), and then with an English gloss.')
  if (/数式の \$/.test(why)) notes.push('Every piece of math must be closed: each "$" that opens a formula needs its closing "$" (write $A$, never $A alone), and do not use "$" for anything else.')
  if (/< > で囲んだ/.test(why)) notes.push('Outside ```figure blocks never put a word between "<" and ">" (it would be read as an HTML tag and disappear); write a placeholder as [word] instead.')
  if (/長さが不自然/.test(why)) notes.push('Translate the whole lesson from top to bottom, without shortening, summarizing, or repeating any part.')
  return notes.length ? `IMPORTANT — an earlier attempt at this lesson could not be used. ${notes.join(' ')}` : ''
}

// ───────── 訳の形を確かめて、ととのえる ─────────

/** 訳が使えないとき（形が元とちがう、訳されていない所がある、など）に投げる */
export class Mismatch extends Error {}

const JA = /[぀-ヿ㐀-鿿]/
const KANA = /[぀-ヿ]/g
const FENCE = /^```(\w*)\n([\s\S]*?)\n```$/gm
const blocksOf = (body: string) => [...body.matchAll(FENCE)].map((m) => ({ kind: m[1] || 'code', text: m[2] }))
const withoutBlocks = (body: string) => body.replace(FENCE, '')
const headingsOf = (body: string) =>
  withoutBlocks(body)
    .split('\n')
    .filter((l) => /^#{1,4} /.test(l))
    .map((l) => l.match(/^#+/)![0].length)
const SPEAKER = /^(sensei|s\d\d)\s*(\([A-Za-z]+\))?\s*[:：]/
const TALK_LINE = /^([^:：]{1,40}?)\s*(\([A-Za-z]+\))?\s*[:：]\s*(\S.*)$/
const kanaCount = (text: string) => (text.match(KANA) ?? []).length
const tableRows = (body: string) => withoutBlocks(body).split('\n').filter((l) => /^\|/.test(l)).length

/** 掛け合い: 話し手と表情は元のものにもどし、せりふだけを訳から取る。歴史上の人物の名前の訳は people に集める */
function fixTalk(source: string, target: string, kind: LessonKind, people: Record<string, string>, lenient: boolean): string {
  const a = source.split('\n').filter((l) => l.trim())
  const b = target.split('\n').filter((l) => l.trim())
  if (a.length !== b.length) throw new Mismatch(`掛け合いの行数がちがう（${a.length} → ${b.length}）`)
  return a
    .map((line, i) => {
      const from = TALK_LINE.exec(line.trim())
      const to = TALK_LINE.exec(b[i].trim())
      if (!from) return b[i]
      if (!to) throw new Mismatch('掛け合いの行を読み取れない')
      const said = to[3].trim()
      // ゆるい確かめ（lenient）では、せりふの半分より多くが日本語のときだけ落とす（日本語の言い回しを引いて話す授業があるため）
      if (kind === 'general' && kanaCount(said) > 12 && (!lenient || kanaCount(said) * 2 > said.replace(/\s/g, '').length)) throw new Mismatch('掛け合いのせりふが訳されていない')
      // 国語の授業: 例として引いた言葉は日本語のままでよいが、話し言葉そのものは訳す。
      // 「…」や（…）の外に、かなが多く、英語がほとんど無いせりふ（日本語のせりふがそのまま残ったもの）だけを落とす
      const spoken = said.replace(/「[^」]*」|『[^』]*』|（[^）]*）|\([^)]*\)|"[^"]*"|“[^”]*”/g, '')
      if (kind === 'japanese' && !lenient && kanaCount(spoken) > 10 && (spoken.match(/[A-Za-z]/g) ?? []).length < kanaCount(spoken) * 1.5) throw new Mismatch('掛け合いのせりふが訳されていない')
      if (!SPEAKER.test(line.trim())) {
        // 歴史上の人物など。話し手は元の名前のままにして（絵を名前で引くため）、訳した名前は別に覚える
        const name = to[1].trim()
        if (name && !JA.test(name)) people[from[1].trim()] = name.slice(0, 60)
      }
      return `${from[1].trim()}${from[2] ?? ''}: ${said}`
    })
    .join('\n')
}

/** JSON のブロック: 元の形を保ち、日本語の文字列だけを訳のものに入れかえる */
function fixJson(source: string, target: string, blockKind: string): string {
  let from: unknown
  let to: unknown
  try {
    from = JSON.parse(source)
  } catch {
    return source // 元がこわれているものは、そのまま（検査の対象は元の授業）
  }
  try {
    to = JSON.parse(target)
  } catch {
    throw new Mismatch(`${blockKind} の JSON を読み取れない`)
  }
  const merge = (x: unknown, y: unknown, key: string): unknown => {
    if (typeof x === 'string') {
      if (key === 'id' || key === 'kind' || !JA.test(x)) return x
      if (typeof y !== 'string' || !y.trim()) throw new Mismatch(`${blockKind} の文字が訳されていない`)
      return y
    }
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || y.length !== x.length) throw new Mismatch(`${blockKind} の中身の数がちがう`)
      return x.map((item, i) => merge(item, y[i], key))
    }
    if (x && typeof x === 'object') {
      if (!y || typeof y !== 'object') throw new Mismatch(`${blockKind} の形がちがう`)
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, merge(v, (y as Record<string, unknown>)[k], k)]))
    }
    return x
  }
  const merged = merge(from, to, '')
  return source.includes('\n') ? JSON.stringify(merged, null, 1) : JSON.stringify(merged)
}

const TEXT_TAG = /<text\b([^>]*)>([^<]*)<\/text>/g
const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1]
/** 文字の幅の見積もり（1 文字の幅 ÷ 文字の大きさ） */
const widthOf = (text: string) => [...text].reduce((sum, ch) => sum + (JA.test(ch) || /[＀-￯]/.test(ch) ? 1 : ch === ' ' ? 0.3 : /[A-Z]/.test(ch) ? 0.66 : /[iljtf.,:;'()|!]/.test(ch) ? 0.32 : 0.55), 0)

/** 図: タグと属性は元のまま（文字の位置と大きさだけは変えてよい）。はみ出しそうな文字は小さくする */
function fixFigure(source: string, target: string): string {
  const skeleton = (svg: string) => svg.replace(TEXT_TAG, (_m, attrs: string) => `<text${attrs.replace(/\s(x|text-anchor|font-size)="[^"]*"/g, '')}></text>`).replace(/\s+/g, ' ').trim()
  const labels = [...target.matchAll(TEXT_TAG)].map((m) => m[2])
  const count = [...source.matchAll(TEXT_TAG)].length
  let svg: string
  if (skeleton(source) === skeleton(target)) svg = target
  else if (labels.length === count) {
    // タグや属性が変わっていたら、元の図に、訳した文字だけを入れる
    let i = 0
    svg = source.replace(TEXT_TAG, (_m, attrs: string) => `<text${attrs}>${labels[i++]}</text>`)
  } else throw new Mismatch(`図の文字の数がちがう（${count} → ${labels.length}）`)
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg)
  const width = box ? Number(box[1]) : 0
  if (!width) return svg
  return svg.replace(TEXT_TAG, (whole, attrs: string, text: string) => {
    const label = text.trim()
    if (!label || /\stransform=/.test(attrs)) return whole
    const x = Number(attr(attrs, 'x') ?? 0)
    const size = Number(attr(attrs, 'font-size') ?? 14)
    const anchor = attr(attrs, 'text-anchor') ?? 'start'
    const room = anchor === 'middle' ? 2 * Math.min(x, width - x) - 4 : anchor === 'end' ? x - 2 : width - x - 3
    const need = widthOf(label) * size
    if (!(room > 0) || need <= room) return whole
    const next = Math.max(8, Math.floor((size * room) / need))
    return `<text${attrs.replace(/\sfont-size="[^"]*"/, '')} font-size="${next}">${text}</text>`
  })
}

const ENGLISH_SENTENCE = /[A-Z][A-Za-z']*(?:[ ,]+[A-Za-z',-]+){2,}[.?!]/g
const timesIn = (whole: string, part: string) => (part ? whole.split(part).length - 1 : 0)

/**
 * 英語の授業で、問題文に答えの英文が出ていないかを確かめる。
 * 「次の日本語を英語にしましょう」という問題は、日本語の文を英語に訳してしまうと、答えがそのまま問題文に出る。
 * 元の授業で答え（「答え」の見出しのあと、または「答え:」の行）にある英文が、答えの見出しより前に、元より多く出ていたら、その英文を返す。
 */
function leakedAnswer(source: string, text: string): string | null {
  // start 番めの見出しから at 番めの見出し（答え）の前までが「問題のあるところ」、そのあと次の大きな見出しまでが「答え」
  const split = (body: string, start: number, at: number) => {
    const lines = withoutBlocks(body).split('\n')
    const places: number[] = []
    lines.forEach((l, i) => {
      if (/^#{1,4} /.test(l)) places.push(i)
    })
    if (places[at] === undefined) return null
    const rest = lines.slice(places[at] + 1)
    const end = rest.findIndex((l) => /^#{1,2} /.test(l))
    return { before: lines.slice(places[start] ?? 0, places[at]).join('\n'), answers: (end < 0 ? rest : rest.slice(0, end)).join('\n') }
  }
  const heads = withoutBlocks(source).split('\n').filter((l) => /^#{1,4} /.test(l))
  // 答えの見出し（「答え」「こたえ」「解答」で始まるもの。「答え方」「答える」のような説明の見出しは別）。いちばん後ろのものを使う
  const at = heads.findLastIndex((l) => /^#{2,4}\s*(答え|こたえ|解答)(?![方るよまて])/.test(l))
  if (at < 0) return null
  // 説明のところでは、同じ英文を訳がくり返しても問題ではない。例題（無ければ確かめ問題）から答えの前までだけを見る
  const example = heads.findIndex((l) => /例題|れいだい/.test(l))
  const check = heads.findIndex((l) => /確かめ|たしかめ|問題|やってみ/.test(l))
  const start = example >= 0 && example < at ? example : check >= 0 && check < at ? check : 0
  const from = split(source, start, at)
  const to = split(text, start, at)
  if (!from || !to) return null
  // 問題文に、読みも意味も付いていない日本語の文が残っていないか（英語で読む人には、何を英語にするのかが分からない）
  // 「(Use interesting.)」「(Hint: turn off)」のような指示は、意味の説明ではないので、付いていても「意味が付いている」とは数えない
  const glossed = (l: string) => (l.match(/\(([^)]*)\)/g) ?? []).some((p) => !/^\((Use|Hint|Words?|Begin|Start)\b/i.test(p) && (p.match(/[A-Za-z]/g) ?? []).length >= 12)
  const stranded = to.before.split('\n').find((l) => kanaCount(l) >= 5 && !glossed(l))
  if (stranded) return `JA:${stranded.trim()}`
  // 答えにある英文（確かめ問題の答えと、例題の「答え:」の行）
  const answers = [...(from.answers.match(ENGLISH_SENTENCE) ?? []), ...from.before.split('\n').filter((l) => /^[\s>*-]*\**(答え|こたえ|解答|正解|答[:：])/.test(l)).flatMap((l) => l.match(ENGLISH_SENTENCE) ?? [])]
  const wordsOf = (t: string) => t.toLowerCase().replace(/’/g, "'").match(/[a-z][a-z']*/g) ?? []
  const before = ` ${wordsOf(from.before).join(' ')} `
  const after = ` ${wordsOf(to.before).join(' ')} `
  // 引用符の中（英文をそのまま示しているところ）だけを集めたもの
  const quoted = ` ${(to.before.match(/"[^"\n]*"|“[^”\n]*”/g) ?? []).map((q) => wordsOf(q).join(' ')).join(' | ')} `
  // 答えの語のひと続き（size 語）が、元の授業より多く出ているか。ありふれた語だけのひと続きは、説明の文にも出るので見ない
  const shown = (words: string[], size: number, where: string) => {
    for (let i = 0; i + size <= words.length; i++) {
      const part = words.slice(i, i + size)
      const rare = part.filter((w) => !COMMON_WORDS.has(w))
      if (rare.length < (size === words.length ? 1 : 2) || part.join('').length < 9) continue
      const key = ` ${part.join(' ')} `
      if (timesIn(where, key) > timesIn(before, key)) return true
    }
    return false
  }
  for (const sentence of new Set(answers)) {
    const words = wordsOf(sentence)
    if (words.length < 3) continue
    // 短い答え（4 語まで）は、文の全体が出ていたら「見えている」。
    // 長い答えは、引用符の中なら 6 割、地の文なら 4 分の 3 より長いひと続き（4 語以上）が出ていたら「見えている」
    // （「8 時に学校へ行くことを英語で言いましょう」のような間接的な言い方は、答えと重なる語があっても通す）
    if (words.length <= 4 ? shown(words, words.length, after) : shown(words, Math.max(4, Math.ceil(words.length * 0.6)), quoted) || shown(words, Math.max(4, Math.ceil(words.length * 0.75)), after)) return sentence
  }
  return null
}

/** ラテン文字と見分けにくいキリル文字（и は、ローマ字の i の代わりに出ることがある） */
const LOOKALIKE: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', и: 'i', к: 'k', м: 'm', т: 't', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' }

const COMMON_WORDS = new Set(
  "i you he she it we they me my your his her our their a an the is am are was were be been do does did don't doesn't didn't not no yes to of in on at for with and or but that this these those there can will would have has had what how where when who which very so too by from as if i'm it's".split(' '),
)

/**
 * 訳を元の授業と突き合わせ、ととのえた本文を返す。使えないときは Mismatch を投げる。
 * people には、掛け合いに出た人物の名前の訳（元の名前 → 訳）を入れる。
 * lenient を true にすると、残った日本語の確かめをゆるくする。ふつうの教科でも、日本語の言い回しそのものを扱う授業
 * （敬語の使い方、日本の音階の名前など）は日本語を残すのが正しいので、「日本語が残っている」で続けて落ちたときに使う。
 */
export function settleTranslation(source: string, raw: string, kind: LessonKind, people: Record<string, string>, lenient = false): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  text = text.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1').trim()
  if (!/^# /.test(text)) throw new Mismatch('題（# の見出し）から始まっていない')
  if (/^(Wait —|Wait,|I need to correct|I can't translate|I cannot translate|Here is the (full|complete|proper|corrected|translated))/m.test(withoutBlocks(text))) throw new Mismatch('訳ではない文（作業の言葉）が混ざっている')
  // ローマ字の中に、形の似たキリル文字が混ざることがある（Untokoshо の о など。見た目は同じでも、検索や読み上げで困る）。ラテン文字にもどす
  text = text.replace(/[Ѐ-ӿ]/g, (ch, at: number) => (/[A-Za-zāīūēōâîûêô*]/.test(text[at - 1] ?? '') || /[A-Za-zāīūēōâîûêô]/.test(text[at + 1] ?? '') ? (LOOKALIKE[ch] ?? ch) : ch))
  // ほかの言語の文字（キリル文字の語、ハングル、アラビア文字など）。元の授業に無ければ、訳すときに混ざったもの
  const foreign = (t: string) => /[Ѐ-ӿ]{2,}|[֐-ۿऀ-ॿ฀-๿가-힯]/.test(t)
  if (foreign(text) && !foreign(source)) throw new Mismatch('別の言語の文字が混ざっている')
  // 訳者のメモ（「Note: in the original …」）。国語の授業では「原文」の話をするので見ない
  if (kind !== 'japanese' && /\(Note: in the original|as given in the original note|\b[Tt]ranslator'?s? note\b|^\s*Note: (rewrite|translate|rephrase) the instruction/m.test(text)) throw new Mismatch('訳ではない文（訳者のメモ）が混ざっている')
  // 掛け合いの中で、呼びかける名前を言い直しているもの（「Koki... no, Haruto.」「Hinata... I mean, Sota.」。訳すときの迷いが、せりふに出たもの）
  const renamed = text.split('\n').find((l) => /^(sensei|s\d\d)\b/.test(l) && /[A-Z][a-z]+(\.\.\.|…|\?|,) ?(oh, |wait, |no, |sorry, )*(I mean,? |[Nn]o, )[A-Z][a-z]+[.,!]|Wait, let me say (it|that)|let me say (it|that) (properly|again|correctly|plainly)/.test(l))
  if (renamed) throw new Mismatch('掛け合いで名前を言い直すせりふがある')
  // 名前を呼びかけてから言い直すもの（「Good point, Hinata... I mean, good thinking!」「Hinata. No wait, I mean …」）。
  // 元のせりふが本当に言い直しているとき（「ことねさん…じゃなくて、うち！」）は、その数までは認める
  const talkLines = (t: string) => t.split('\n').filter((l) => /^(sensei|s\d\d)\b/.test(l))
  const restated = talkLines(text).filter((l) => /[A-Z][a-z]+(\.\.\.|…|—|\.|,|\?) ?(([Oo]h|[Ww]ait|[Nn]o,? wait|sorry),? )*(I mean|or rather)\b|[—-] ?I mean,? [A-Z]/.test(l)).length
  if (restated > talkLines(source).filter((l) => /じゃなくて|じゃなかった|ではなくて|ではなく、|まちがえ|間違え/.test(l)).length) throw new Mismatch('掛け合いで名前を言い直すせりふがある')
  const a = headingsOf(source)
  const b = headingsOf(text)
  if (a.join() !== b.join()) throw new Mismatch(`見出しの並びがちがう（${a.length} → ${b.length}）`)
  const from = blocksOf(source)
  const to = blocksOf(text)
  if (from.map((x) => x.kind).join() !== to.map((x) => x.kind).join()) throw new Mismatch(`ブロックの並びがちがう（${from.length} → ${to.length}）`)
  if (tableRows(source) !== tableRows(text)) throw new Mismatch(`表の行数がちがう（${tableRows(source)} → ${tableRows(text)}）`)
  // 数式の中の % に \ が付いていないと、そこから先が消えて式を組めない（\text{…} の中でも同じ）。\ を付ける
  const escapePercent = (part: string) => part.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, (math) => math.replace(/(^|[^\\])%/g, '$1\\%'))
  let escaped = ''
  let last = 0
  for (const block of text.matchAll(FENCE)) {
    escaped += escapePercent(text.slice(last, block.index)) + block[0]
    last = block.index + block[0].length
  }
  text = escaped + escapePercent(text.slice(last))
  // 数式の $ の閉じ忘れと、< > で囲んだ語（HTML のタグとして消えてしまう）。元の授業に無いものだけを見る
  const dollars = (t: string) => (withoutBlocks(t).match(/\$/g) ?? []).length
  if (dollars(source) % 2 === 0 && dollars(text) % 2) throw new Mismatch('数式の $ が閉じていない')
  const tags = (t: string) => (withoutBlocks(t).match(/<[a-z][^<>\n]*>/gi) ?? []).length
  if (!tags(source) && tags(text)) throw new Mismatch('< > で囲んだ語がある')
  // 数式の中に残った日本語（式の中の言葉や単位は、読めないと式そのものが分からない）。国語の授業と、ゆるい確かめでは見ない
  const strict = kind !== 'japanese' && !lenient
  if (strict && (withoutBlocks(text).match(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g) ?? []).some((m) => JA.test(m))) throw new Mismatch('数式の中に日本語が残っている')
  if (kind === 'english') {
    const leaked = leakedAnswer(source, text)
    if (leaked?.startsWith('JA:')) {
      if (!lenient) throw new Mismatch('問題文の中に日本語が残っている')
    } else if (leaked) throw new Mismatch(`問題文に答えの英文が出ている（${leaked.slice(0, 80)}）`)
  }
  let i = 0
  text = text.replace(FENCE, (_whole, name: string, inner: string) => {
    const original = from[i++]
    let fixed = inner
    if (original.kind === 'talk') fixed = fixTalk(original.text, inner, kind, people, lenient)
    else if (['picture', 'sim', 'plot', 'numberline'].includes(original.kind)) fixed = fixJson(original.text, inner, original.kind)
    else if (original.kind === 'figure') fixed = fixFigure(original.text, inner)
    // プログラムや擬似コードに残った日本語（文字列・コメント・データ・擬似コードの言葉）
    else if (original.kind !== 'talk' && strict && JA.test(inner)) throw new Mismatch('プログラムの中に日本語が残っている')
    return '```' + name + '\n' + fixed + '\n```'
  })
  // 訳されずに残った日本語（かな）。国語の授業は、学ぶ対象として日本語を残すので見ない
  const kana = kanaCount(withoutBlocks(text))
  const sourceKana = kanaCount(withoutBlocks(source))
  if (kind === 'general' && kana > (lenient ? Math.max(80, sourceKana * 0.25) : Math.max(40, sourceKana * 0.04))) throw new Mismatch(`日本語が多く残っている（かな ${kana} 字）`)
  if (kind === 'english' && kana > Math.max(80, sourceKana * (lenient ? 0.5 : 0.25))) throw new Mismatch(`日本語が多く残っている（かな ${kana} 字）`)
  // 長さは、図・コード・数式をのぞいた文章でくらべる
  const prose = (t: string) => withoutBlocks(t).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, '').replace(/[\s|\-#*>]/g, '').length
  const ratio = prose(text) / Math.max(1, prose(source))
  if (ratio < (kind === 'japanese' ? 0.6 : 0.9) || ratio > 6) throw new Mismatch(`長さが不自然（文章が元の ${ratio.toFixed(2)} 倍）`)
  return text + '\n'
}

/** 元の本文の指紋を作るときにそろえる形（改行をそろえ、前後の空白を落とす） */
export const normalizeSource = (body: string) => body.replace(/\r\n/g, '\n').trim()
