import { useEffect, useState } from 'react'

/**
 * 文章の読み上げ。PC に入っている音声を使うので、通信もデータの追加も要らない。
 *
 * まず画面側の読み上げ（speechSynthesis）を使う。ただし、これが使えるのは Windows の新しい系統の音声だけで、
 * 日本語版の Windows には英語の音声が入っていないことが多い。そのときは、メインプロセス経由で
 * 従来の系統（SAPI）の英語の音声を使う。
 */

const synth: SpeechSynthesis | undefined = window.speechSynthesis
// 音声の一覧は、最初の問い合わせのあとで届く。先に 1 回たずねておく
synth?.getVoices()

/** 従来の系統に、英語の音声があるか（問い合わせが済むまでは null） */
let systemEnglish: boolean | null = null
const waiting = new Set<() => void>()
void window.manabi.tts.status().then((ok) => {
  systemEnglish = ok
  waiting.forEach((update) => update())
})

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = synth?.getVoices() ?? []
  const wanted = lang.toLowerCase()
  const same = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === wanted)
  const near = voices.filter((v) => v.lang.toLowerCase().startsWith(wanted.slice(0, 2)))
  // 自然な声（Natural）があれば、それを優先する
  return same.find((v) => /natural/i.test(v.name)) ?? same[0] ?? near.find((v) => /natural/i.test(v.name)) ?? near[0]
}

const viaSystem = (lang: string) => lang.toLowerCase().startsWith('en') && systemEnglish === true

/** その言語を読み上げる音声が、この PC に入っているか */
export function canSpeak(lang = 'en-US'): boolean {
  return !!pickVoice(lang) || viaSystem(lang)
}

/** 読み上げる。前の読み上げが残っていれば止めてから始める。 */
export function speak(text: string, lang = 'en-US', rate = 0.92): Promise<void> {
  return new Promise((resolve) => {
    if (!text.trim()) return resolve()
    const voice = pickVoice(lang)
    if (synth && voice) {
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = lang
      utterance.rate = rate
      utterance.voice = voice
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      synth.speak(utterance)
      return
    }
    // その言語の音声がどこにも無いときは読まない（日本語の声で英語を読むと、まちがった発音の手本になってしまう）
    if (viaSystem(lang)) void window.manabi.tts.speak(text)
    resolve()
  })
}

export function stopSpeaking(): void {
  synth?.cancel()
  if (systemEnglish) void window.manabi.tts.stop()
}

/** その言語を読み上げられるか。音声の一覧はあとから届くことがあるので、届いたら画面を更新する */
export function useCanSpeak(lang = 'en-US'): boolean {
  const [able, setAble] = useState(() => canSpeak(lang))
  useEffect(() => {
    const update = () => setAble(canSpeak(lang))
    update()
    waiting.add(update)
    synth?.addEventListener('voiceschanged', update)
    return () => {
      waiting.delete(update)
      synth?.removeEventListener('voiceschanged', update)
    }
  }, [lang])
  return able
}
