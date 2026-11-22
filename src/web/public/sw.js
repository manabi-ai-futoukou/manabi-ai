// 学びアイ（Web 版）のサービスワーカー。
// - アプリの本体（HTML・JS・CSS）と、教材の文字のもの（授業・単元表・科目表・フォルダの中身の一覧）は、
//   つながるときは新しいものを取り、つながらないときは前に取ったものを使う（書き直された授業が、すぐに出るように）
// - 教材の画像や音（data/media/ と、res/ の画像）は、前に取ったものをすぐ返し、裏で新しいものに取りかえる
// - AI や、サインインの通信（api/・auth/）には手を出さない
const VERSION = 'manabi-web-v2'
const APP = `${VERSION}-app`
const CONTENT = `${VERSION}-content`

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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length)
  if (path.startsWith('api/') || path.startsWith('auth/')) return

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
  if (path.startsWith('res/') || path.startsWith('data/')) return event.respondWith(networkFirst(request, CONTENT))
  event.respondWith(networkFirst(request, APP, './'))
})
