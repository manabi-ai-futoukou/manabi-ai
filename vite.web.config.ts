// Web 版（PWA・試作）を作るための設定。Electron 版（electron.vite.config.ts）とは別に、ブラウザだけで動く形にまとめる。
//
//   npx vite build --config vite.web.config.ts   → dist-web/ にできる
//   node web/server.mjs                           → http://127.0.0.1:5273/ で開く（教材と AI の取りつぎも、このサーバーが行う）
//
// 画面（src/renderer）と本体側（src/main）は、Electron 版と同じものを使う。ちがうのは次の 2 つ。
// - Node と Electron の部品（fs・path・crypto・child_process・electron など）を、ブラウザ用の代わり（src/web/shims）に差しかえる
// - AI を呼ぶところ（src/main/ai/claude.ts・codex.ts）を、通信で呼ぶもの（src/web/ai）に差しかえる
import { cpSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const shim = (name: string) => resolve('src/web/shims', name)
/** できあがりの置き場。確かめ用に、別の場所へ作るときは MANABI_WEB_OUT で指定する（ふだんは dist-web/） */
const OUT = resolve(process.env['MANABI_WEB_OUT'] ?? 'dist-web')

function webAi(): Plugin {
  return {
    name: 'manabi-web-ai',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const target = resolve(dirname(importer), source).replaceAll('\\', '/')
      const found = /\/src\/main\/ai\/(claude|codex)(?:\.ts)?$/.exec(target)
      return found ? resolve('src/web/ai', `${found[1]}.ts`) : null
    },
  }
}

/** 画面側の置きもの（登場人物の絵など。src/renderer/public）も、できあがりに写す */
function rendererPublic(): Plugin {
  return {
    name: 'manabi-renderer-public',
    apply: 'build',
    closeBundle() {
      cpSync(resolve('src/renderer/public'), OUT, { recursive: true })
    },
  }
}

/**
 * ワーカーの入口のファイルを、ワーカーの中のほかのファイルが読みこむ形になっていないかを確かめる。
 * その形だと、Safari 26（iPhone・iPad）で入口が 2 回動き、画面からの要求がすべて捨てられる（src/web/backend/worker.ts の説明を参照）。
 */
function workerEntryGuard(): Plugin {
  return {
    name: 'manabi-worker-entry-guard',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
      const entries = new Set(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName))
      for (const chunk of chunks) {
        const bad = [...chunk.imports, ...chunk.dynamicImports].filter((name) => entries.has(name))
        if (bad.length) this.error(`ワーカーの入口（${bad.join('、')}）を、${chunk.fileName} が読みこんでいます。Safari 26 で動かなくなるので、入口（worker.ts）には共通の部品を置かないでください。`)
      }
    },
  }
}

const alias = [
  { find: /^@shared\//, replacement: `${resolve('src/shared')}/` },
  { find: /^@\//, replacement: `${resolve('src/renderer/src')}/` },
  { find: /^node:fs\/promises$/, replacement: shim('fs-promises.ts') },
  { find: /^node:fs$/, replacement: shim('fs.ts') },
  { find: /^node:path$/, replacement: shim('path.ts') },
  { find: /^node:crypto$/, replacement: shim('crypto.ts') },
  { find: /^node:(child_process|zlib|readline|os|net|events)$/, replacement: shim('misc.ts') },
  { find: /^electron$/, replacement: shim('electron.ts') },
]

export default defineConfig({
  root: resolve('src/web'),
  base: './',
  publicDir: resolve('src/web/public'),
  resolve: { alias },
  // AI のつなぎ方。配る版は「自分の API キー」だけ。MANABI_WEB_ROUTES=all で作ると、開発用の方式（この PC のコマンド・運営者のキー・Sign in with ChatGPT）も出る
  define: { __MANABI_WEB_ROUTES__: JSON.stringify(process.env['MANABI_WEB_ROUTES'] === 'all' ? ['relay', 'own-key', 'server-key', 'siwc'] : ['own-key']) },
  plugins: [webAi(), react(), rendererPublic()],
  worker: { format: 'es', plugins: () => [webAi(), workerEntryGuard()] },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { index: resolve('src/web/index.html'), view: resolve('src/web/view.html') } },
  },
})
