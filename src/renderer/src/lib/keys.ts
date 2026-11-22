import { useEffect, useState } from 'react'
import { comboLabel, resolveKeys, type KeyMap } from '@shared/keys'
import { api, useLoad } from './hooks'

/** いまのショートカットの割り当て（設定を変えると、すぐに反映される） */
export function useKeys(): KeyMap {
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  return resolveKeys(settings.data?.keys)
}

interface LayoutMap {
  get(code: string): string | undefined
}

/** 組み合わせを画面に出す形にする関数。使っているキーボードの配列に合わせて、記号のキーを表示する */
export function useComboLabel(): (value: string) => string {
  const [layout, setLayout] = useState<LayoutMap>()
  useEffect(() => {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<LayoutMap> } }).keyboard
    void keyboard
      ?.getLayoutMap()
      .then(setLayout)
      .catch(() => undefined)
  }, [])
  return (value) => comboLabel(value, layout)
}
