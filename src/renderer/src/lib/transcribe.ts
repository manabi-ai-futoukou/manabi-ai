import { inkStamp, type Notebook, type NotePage } from '@shared/types'
import { renderPageImage } from '../note/render'
import { api } from './hooks'

/** 一度に AI へ渡すページ数（本体側の上限と同じ） */
export const TRANSCRIBE_BATCH = 4

/** いまの手書きを、まだ文字起こししていないページか（書き足した・消したあとも真になる） */
export const needsTranscript = (page: NotePage): boolean => page.strokes.length > 0 && page.transcriptStamp !== inkStamp(page)

export interface TranscriptOfPage {
  pageId: string
  /** ページ番号（0 始まり） */
  index: number
  /** 文字起こしに使った時点の、手書きの線の目印 */
  stamp: string
  text: string
}

/**
 * ノートの指定したページの手書きを、AI に文字起こししてもらう（評価はしない）。
 * AI に見せるのは、手書きの線だけを描いた画像（タイピングした文字は、もう文字なので入れない）。
 * @param onProgress 何ページ終わったかを知らせる
 */
export async function transcribePages(notebook: Notebook, indexes: number[], onProgress?: (done: number) => void, shouldStop?: () => boolean): Promise<TranscriptOfPage[]> {
  const targets = indexes.filter((i) => notebook.pages[i]?.strokes.length)
  const results: TranscriptOfPage[] = []
  for (let at = 0; at < targets.length; at += TRANSCRIBE_BATCH) {
    if (shouldStop?.()) break
    const batch = targets.slice(at, at + TRANSCRIBE_BATCH).map((index) => ({ index, page: notebook.pages[index], stamp: inkStamp(notebook.pages[index]) }))
    const pages = await Promise.all(batch.map(async ({ index, page }) => ({ page: index + 1, image: await renderPageImage(page, notebook.ruling, 1100, { inkOnly: true }) })))
    const texts = await api.notes.transcribe({ notebookId: notebook.id, pages })
    for (const { index, page, stamp } of batch) results.push({ pageId: page.id, index, stamp, text: texts[index + 1] ?? '' })
    onProgress?.(Math.min(targets.length, at + batch.length))
  }
  return results
}
