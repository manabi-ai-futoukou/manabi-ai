import { BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { dataDir } from './paths'
import { t } from '@shared/i18n'

/** ノートに貼れる画像と、開ける動画の種類 */
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv']
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const ATTACHMENT_ID = /^[0-9a-f-]{36}\.(png|jpg|jpeg|gif|webp)$/

const extensionOf = (file: string) => extname(file).slice(1).toLowerCase()

async function pickFile(owner: BrowserWindow | null, title: string, name: string, extensions: string[]): Promise<string | null> {
  const options = { title, properties: ['openFile' as const], filters: [{ name, extensions }] }
  const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return picked.canceled ? null : (picked.filePaths[0] ?? null)
}

/**
 * 画像ファイルを選んでもらい、アプリのデータ置き場へコピーする。
 * （元のファイルを動かしたり消したりしても、ノートの画像が消えないようにするため）
 */
export async function pickImage(owner: BrowserWindow | null): Promise<{ attachmentId: string; name: string; width: number; height: number } | null> {
  // 自動確認では、ファイルを選ぶ画面を出さずに指定の画像を使う
  const file = process.env['MANABI_PICK_IMAGE'] || (await pickFile(owner, t('画像を選ぶ'), t('画像'), Object.keys(IMAGE_TYPES)))
  if (!file) return null
  const extension = extensionOf(file)
  if (!IMAGE_TYPES[extension]) throw new Error(t('この種類の画像は貼れません（PNG・JPEG・GIF・WebP に対応しています）。'))
  if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error(t('画像が大きすぎます（20MB まで）。'))
  const size = nativeImage.createFromPath(file).getSize()
  if (!size.width || !size.height) throw new Error(t('画像を読みこめませんでした。'))
  const attachmentId = `${randomUUID()}.${extension}`
  await copyFile(file, join(dataDir('attachments'), attachmentId))
  return { attachmentId, name: basename(file), width: size.width, height: size.height }
}

/** 取りこんだ画像を、画面で表示できる形（data URL）で返す */
export function attachmentDataUrl(attachmentId: string): string | null {
  if (!ATTACHMENT_ID.test(attachmentId)) return null
  const file = join(dataDir('attachments'), attachmentId)
  if (!existsSync(file)) return null
  return `data:${IMAGE_TYPES[extensionOf(file)]};base64,${readFileSync(file).toString('base64')}`
}

/** 動画ファイルを選んでもらう。動画は大きいのでコピーせず、場所だけを覚える。 */
export async function pickVideo(owner: BrowserWindow | null): Promise<{ path: string; name: string } | null> {
  const file = await pickFile(owner, t('動画を選ぶ'), t('動画'), VIDEO_EXTENSIONS)
  return file ? { path: file, name: basename(file) } : null
}

/**
 * ノートに貼ったリンクや動画を開く。
 * ノートのデータに書かれた場所をそのまま開くと危ないので、Web は http(s) だけ、
 * ファイルは動画の拡張子のものだけに限る。
 */
export async function openTarget(kind: 'link' | 'video', target: string): Promise<void> {
  if (kind === 'link') {
    if (!/^https?:\/\//i.test(target)) throw new Error(t('http または https で始まるリンクだけ開けます。'))
    await shell.openExternal(target)
    return
  }
  if (!VIDEO_EXTENSIONS.includes(extensionOf(target))) throw new Error(t('この種類のファイルは開けません。'))
  if (!existsSync(target)) throw new Error(t('動画ファイルが見つかりません。場所が変わった可能性があります。'))
  const failure = await shell.openPath(target)
  if (failure) throw new Error(t('動画を開けませんでした。{0}', failure))
}
