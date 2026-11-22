// 参考書と問題集の見本を読むページ（試作）を作るための設定。
//
//   npx vite build --config vite.books.config.ts          → ひとつ上のフォルダの「参考書と問題集の見本」にできる
//   node --no-warnings tools/book-trial.mjs --export      → 同じフォルダに、見本の中身（data.js）を書く
//
// できたフォルダの index.html を開けば、サーバーなしで読める（ファイルを直接開いても動くよう、スクリプトを 1 本にまとめ、
// type="module" と crossorigin を外す。どちらも、ファイルを直接開いたときには読みこみが止められるため）。
// 本文の表示には、アプリの教科書と同じ部品（src/renderer/src/components/Markdown.tsx）を使う。
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function openFromFile(): Plugin {
  return {
    name: 'manabi-open-from-file',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module" crossorigin src=/g, '<script defer src=').replace(/ crossorigin(?=[ >])/g, ''),
    },
  }
}

export default defineConfig({
  root: resolve('tools/book-viewer'),
  base: './',
  publicDir: false,
  resolve: {
    alias: [
      { find: /^@shared\//, replacement: `${resolve('src/shared')}/` },
      { find: /^@\//, replacement: `${resolve('src/renderer/src')}/` },
    ],
  },
  plugins: [react(), openFromFile()],
  build: {
    outDir: resolve('..', '参考書と問題集の見本'),
    // 見本の中身（data.js）は別の道具が書くので、作り直しのときに消さない
    emptyOutDir: false,
    target: 'es2022',
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/viewer.js', assetFileNames: 'assets/[name][extname]' } },
  },
})
