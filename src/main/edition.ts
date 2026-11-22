/**
 * 開発用の版か、配る版か。
 *
 * 配る版（インストーラーで入れたもの）では、次のものを出さない。
 *   - 教材づくり（単元表と授業を、AI にまとめて作らせる画面）
 *   - 教科書の「掛け合い」「動く図解」を、AI に足させる・作り直させるボタン
 *   - この PC の claude・codex のコマンドで AI を動かす方式（src/main/ai/link.ts）
 *
 * 開発中（パッケージしていないとき）は、全部出る。確かめのために、切りかえることもできる。
 *   MANABI_AI_PUBLIC=1 … 開発中でも、配る版の形で開く（動作確認のテストが使う）
 *   MANABI_AI_CLI=1    … 配る版でも、開発用の形で開く
 */
import { app } from 'electron'

export const isDevEdition = (): boolean => (!app.isPackaged || process.env['MANABI_AI_CLI'] === '1') && process.env['MANABI_AI_PUBLIC'] !== '1'
