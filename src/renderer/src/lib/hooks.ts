import { useCallback, useEffect, useRef, useState } from 'react'

export const api = window.manabi

/** メインプロセスから返るエラーの前置き（"Error invoking remote method ..."）を取り除く */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/**
 * データを読み込む。topics に挙げた種類の変更がほかのウィンドウから通知されたら読み直す。
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], topics: string[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const reload = useCallback(() => {
    let cancelled = false
    loaderRef
      .current()
      .then((value) => {
        if (cancelled) return
        setData(value)
        setError(null)
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])

  // 読み込みの条件（deps）が変わったら読み直す
  useEffect(() => reload(), deps)

  const topicKey = topics.join(',')
  useEffect(() => {
    if (!topicKey) return
    const wanted = topicKey.split(',')
    return api.onChanged((topic) => {
      if (wanted.includes(topic)) reload()
    })
  }, [topicKey, reload])

  return { data, error, reload, setData }
}

/**
 * スマートフォン（iPhone など、はばのせまい画面）向けの表示か。
 * Web 版の親のページが、画面のはばを見て <html data-phone> を付ける。PC・iPad・Chromebook では、いつも偽。
 */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => document.documentElement.hasAttribute('data-phone'))
  useEffect(() => {
    const update = () => setPhone(document.documentElement.hasAttribute('data-phone'))
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-phone'] })
    update()
    return () => observer.disconnect()
  }, [])
  return phone
}

/**
 * 指で書く場所で、指の動きの「既定の動き」（画面のスクロールや拡大）を止める。
 * iPhone の Safari では、画面（iframe）の中だと、CSS の touch-action: none だけでは止まらないことがあり、
 * 書いている途中で入力が打ち切られて、線が一瞬だけ出て消える。文字を入れる欄やボタンの上では、止めない。
 */
export function useNoTouchScroll(ref: { current: HTMLElement | null }, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const stop = (event: TouchEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('textarea, input, select, button, a')) return
      if (event.cancelable) event.preventDefault()
    }
    el.addEventListener('touchstart', stop, { passive: false })
    el.addEventListener('touchmove', stop, { passive: false })
    return () => {
      el.removeEventListener('touchstart', stop)
      el.removeEventListener('touchmove', stop)
    }
  }, [ref, enabled])
}

/** 少しのあいだ表示して消えるお知らせ */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null)
  const timer = useRef<number>(undefined)
  const show = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    window.clearTimeout(timer.current)
    setToast({ text, kind })
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 7000 : 3200)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { toast, show }
}
