import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '@shared/i18n'

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ユーザーのデータ（ノート、会話、設定）の保存先。テスト時は MANABI_DATA_DIR で差し替える。 */
export function dataDir(...sub: string[]): string {
  const root = process.env['MANABI_DATA_DIR'] || join(app.getPath('userData'), 'data')
  return ensure(join(root, ...sub))
}

/** アプリに同梱する教材・キャラクター定義 */
export function resourcesDir(...sub: string[]): string {
  return join(app.getAppPath(), 'resources', ...sub)
}

/**
 * AI の CLI を動かす作業フォルダ。中身は空にしておく。
 * （CLI はカレントフォルダの設定ファイルや資料を読み込むため、アプリの資料と混ざらないようにする）
 */
export function aiWorkDir(): string {
  return dataDir('ai-workdir')
}

/** AI に渡す一時ファイル（画像、指示文）の置き場 */
export function aiTempDir(): string {
  return dataDir('ai-temp')
}

/** ファイル名に使う ID を検証する（パスの混入を防ぐ） */
export function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(t('不正な ID です: {0}', String(id)))
  return id
}
