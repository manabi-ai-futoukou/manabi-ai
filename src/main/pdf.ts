import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { PAGE_H, PAGE_W } from '@shared/page'
import { t } from '@shared/i18n'

/** 0.1mm 単位のページ寸法を PDF の単位（ポイント）に直す */
const toPoints = (units: number) => (units / 10 / 25.4) * 72

/**
 * ノートを PDF に書き出す。各ページは画面側で画像にしてあり、それを B5 判のページに貼る。
 * （手書きの線をそのままの見た目で残すため、文字も含めて画像として出力する）
 */
export async function exportPdf(
  owner: BrowserWindow | null,
  title: string,
  images: string[],
): Promise<{ saved: boolean; path?: string }> {
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_')
  const options = {
    title: t('ノートを PDF で保存'),
    defaultPath: `${safeTitle}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
  const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { saved: false }

  await writeFile(picked.filePath, await buildPdf(title, images))
  return { saved: true, path: picked.filePath }
}

export async function buildPdf(title: string, images: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator(t('学びアイ'))
  const width = toPoints(PAGE_W)
  const height = toPoints(PAGE_H)
  for (const dataUrl of images) {
    const png = await pdf.embedPng(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
    pdf.addPage([width, height]).drawImage(png, { x: 0, y: 0, width, height })
  }
  return pdf.save()
}
