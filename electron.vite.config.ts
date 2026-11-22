import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve('src/shared') }

/** 配布用ビルドにだけ CSP を入れる（開発時は Vite の HMR がインラインスクリプトを使うため）。 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // 動画（試作）のせりふの音声は、メインプロセスから data: の形で受け取る
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join('; ')
  return {
    name: 'manabi-csp',
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html
      return html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`)
    },
  }
}

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [react(), contentSecurityPolicy()],
  },
})
