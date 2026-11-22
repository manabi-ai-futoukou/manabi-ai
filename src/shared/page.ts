/** ノートのページ寸法。座標の 1 単位は 0.1mm（B5 判: 182mm × 257mm）。 */
export const PAGE_W = 1820
export const PAGE_H = 2570

/** 1mm あたりの座標単位 */
export const MM = 10

/** 罫線を引き始める上端の余白と、左右・下の余白 */
export const MARGIN_TOP = 18 * MM
export const MARGIN_SIDE = 10 * MM
export const MARGIN_BOTTOM = 12 * MM

/** 罫線の y 座標（横罫・方眼どちらでも使う） */
export function ruleLines(spacingMm: number): number[] {
  const step = spacingMm * MM
  const lines: number[] = []
  for (let y = MARGIN_TOP; y <= PAGE_H - MARGIN_BOTTOM + 0.5; y += step) lines.push(y)
  return lines
}

/** 見開き番号（0 始まり）→ 左右のページ番号（0 始まり） */
export function spreadPages(spread: number): [number, number] {
  return [spread * 2, spread * 2 + 1]
}
