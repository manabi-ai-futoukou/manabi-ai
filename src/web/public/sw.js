// 学びアイ（Web 版）のサービスワーカー。
// - アプリの本体（HTML・JS・CSS）は、つながるときは新しいものを取り、つながらないときは前に取ったものを使う
// - 教材の文字のもの（授業・単元表・科目表・フォルダの中身の一覧）は、
//     配っているサイトでは … 前に取ったものを、すぐ返す（速い）。教材の版（data/pack.json）が変わったら、前に取ったものを全部捨てて、取り直す
//     この PC の開発用のサーバーでは … いつも新しいものを取る（書き直した授業が、すぐに出るように）
// - 教材の画像や音（data/media/ と、res/ の画像）は、前に取ったものをすぐ返し、裏で新しいものに取りかえる
// - AI や、サインインの通信（api/・auth/）には手を出さない
const VERSION = 'manabi-web-v3'
const APP = `${VERSION}-app`
const CONTENT = `${VERSION}-content`
const META = `${VERSION}-meta`
/** 配っているサイトか（この PC で動かしている開発用のサーバーではないか） */
const PUBLISHED = !['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

const MEDIA = /\.(png|jpe?g|webp|gif|svg|mp3|m4a|ogg|wav|mp4|webm|woff2?)$/i

/** つながるときは新しいものを取って、写しを残す。つながらないときは、前の写しを返す */
function networkFirst(request, cacheName, fallback) {
  return fetch(request)
    .then((response) => {
      // 写しは、返事を画面へ渡す前に取っておく（渡したあとでは、もう写せない）
      const copy = response.ok ? response.clone() : null
      if (copy) void caches.open(cacheName).then((cache) => cache.put(request, copy))
      return response
    })
    .catch(async () => (await caches.match(request)) ?? (fallback ? await caches.match(fallback) : undefined) ?? Response.error())
}

/** 前に取ったものがあれば、それを返す。無ければ取りに行って、写しを残す */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) void cache.put(request, response.clone())
  return response
}

/**
 * 教材の版を確かめる（ページを開くたびに 1 回）。版が変わっていたら、前に取った教材を全部捨てる。
 * 新しい版と古い版のファイルが混ざると、単元表と授業の本文が食いちがうので、混ぜない。
 */
let checked = null
/** 返すのは、「前に取ったものを、そのまま使ってよいか」（教材の版の印が無いサイトでは、使わずに、いつも新しいものを取る） */
function contentVersionChecked() {
  if (checked) return checked
  checked = (async () => {
    try {
      const response = await fetch(new URL('data/pack.json', self.registration.scope), { cache: 'no-store' })
      if (!response.ok) return false
      const now = await response.text()
      const meta = await caches.open(META)
      const before = await meta.match('pack').then((found) => (found ? found.text() : null))
      if (before !== now) {
        await caches.delete(CONTENT)
        await meta.put('pack', new Response(now))
      }
      return true
    } catch {
      // つながらないときは、前に取ったものを、そのまま使う
      return true
    }
  })()
  return checked
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length)
  if (path.startsWith('api/') || path.startsWith('auth/')) return

  // ページそのものを開いた（開き直した）ときに、教材の版を確かめ直す
  if (request.mode === 'navigate' && request.destination === 'document') checked = null

  if ((path.startsWith('res/') || path.startsWith('data/')) && MEDIA.test(path)) {
    event.respondWith(
      caches.open(CONTENT).then(async (cache) => {
        const cached = await cache.match(request)
        const fresh = fetch(request)
          .then((response) => {
            if (response.ok) void cache.put(request, response.clone())
            return response
          })
          .catch(() => cached ?? Response.error())
        return cached ?? fresh
      }),
    )
    return
  }
  if (path.startsWith('res/') || path.startsWith('data/')) {
    event.respondWith(PUBLISHED ? contentVersionChecked().then((usable) => (usable ? cacheFirst(request, CONTENT) : networkFirst(request, CONTENT))) : networkFirst(request, CONTENT))
    return
  }
  event.respondWith(networkFirst(request, APP, './'))
})
