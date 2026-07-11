const CACHE = 'hone-mobile-v3'
const PRECACHE = ['/', '/manifest.json']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE).map(key => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone()
          void caches.open(CACHE).then(cache => cache.put(event.request, copy))
        }
        return response
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))),
  )
})
