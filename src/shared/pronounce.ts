/**
 * 英会話モードの発音チェック。
 * 「言うはずだった英文」と「音声認識が聞き取った英文」を単語ごとに照らし合わせ、どれだけ伝わったかを出す。
 * 音声認識が正しく聞き取れた単語は、相手にも伝わる発音だった、と考える。
 */

export interface PronunciationResult {
  /** 伝わった単語の割合（0〜1） */
  score: number
  pass: boolean
  /** 言うはずだった英文の単語ごとに、伝わったかどうか */
  words: { text: string; ok: boolean }[]
  /** 聞き取れた英文 */
  heard: string
}

/** これ以上伝われば合格とする割合 */
export const PASS_SCORE = 0.8

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']

const CONTRACTIONS: Record<string, string> = {
  "i'm": 'i am', "you're": 'you are', "he's": 'he is', "she's": 'she is', "it's": 'it is', "we're": 'we are', "they're": 'they are',
  "that's": 'that is', "there's": 'there is', "what's": 'what is', "where's": 'where is', "who's": 'who is', "how's": 'how is', "let's": 'let us',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'can not', cannot: 'can not', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "wouldn't": 'would not', "shouldn't": 'should not', "couldn't": 'could not', "mustn't": 'must not',
  "i'll": 'i will', "you'll": 'you will', "he'll": 'he will', "she'll": 'she will', "it'll": 'it will', "we'll": 'we will', "they'll": 'they will',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have', "i'd": 'i would', "you'd": 'you would',
  gonna: 'going to', wanna: 'want to',
}

/** 同じ発音の単語は、どれに聞き取られても同じとみなす */
const HOMOPHONES = [
  ['to', 'too', 'two'], ['their', 'there'], ['for', 'four'], ['by', 'buy', 'bye'], ['hear', 'here'], ['know', 'no'], ['right', 'write'],
  ['see', 'sea'], ['son', 'sun'], ['one', 'won'], ['our', 'hour'], ['meet', 'meat'], ['week', 'weak'], ['wear', 'where'], ['ate', 'eight'],
  ['new', 'knew'], ['would', 'wood'], ['whole', 'hole'], ['peace', 'piece'], ['wait', 'weight'], ['weather', 'whether'], ['ok', 'okay'],
]
const CANONICAL = new Map<string, string>()
for (const group of HOMOPHONES) for (const word of group) CANONICAL.set(word, group[0])

/** 1 つの単語を、くらべるための形にする（短縮形は 2 語に分かれる） */
function normalizeWord(raw: string): string[] {
  const word = raw
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  if (!word) return []
  const expanded = CONTRACTIONS[word] ?? word
  return expanded
    .split(/[\s-]+/)
    .map((part) => part.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) && Number(part) <= 20 ? NUMBERS[Number(part)] : part))
    .map((part) => CANONICAL.get(part) ?? part)
}

export function comparePronunciation(target: string, heard: string): PronunciationResult {
  const display = target.trim().split(/\s+/).filter(Boolean)
  // 言うはずだった英文: 単語ごとの部品と、その部品がどの単語のものか
  const wanted: { token: string; word: number }[] = []
  display.forEach((text, word) => normalizeWord(text).forEach((token) => wanted.push({ token, word })))
  const got = heard.split(/\s+/).flatMap(normalizeWord)

  // 順番を保ったまま、いちばん多く一致する組み合わせを探す（最長共通部分列）
  const rows = wanted.length + 1
  const cols = got.length + 1
  const table = Array.from({ length: rows }, () => new Uint16Array(cols))
  for (let i = wanted.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      table[i][j] = wanted[i].token === got[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const matched = new Array<boolean>(wanted.length).fill(false)
  for (let i = 0, j = 0; i < wanted.length && j < got.length; ) {
    if (wanted[i].token === got[j]) {
      matched[i] = true
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }

  const words = display.map((text, word) => {
    const parts = wanted.map((w, i) => ({ w, i })).filter(({ w }) => w.word === word)
    // 記号だけの「単語」は、言えたものとして扱う
    return { text, ok: parts.length === 0 || parts.every(({ i }) => matched[i]) }
  })
  const score = wanted.length ? matched.filter(Boolean).length / wanted.length : 0
  return { score, pass: wanted.length > 0 && score >= PASS_SCORE, words, heard: heard.trim() }
}
