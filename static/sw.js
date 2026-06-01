/* Melbourne Karaoke — service worker (PWA offline shell). */
const CACHE = "mk-v2";
const SHELL = [
  "/tablet",
  "/static/css/style.css",
  "/static/js/common.js",
  "/static/js/tablet.js",
  "/static/img/logo.png",
  "/static/manifest.webmanifest",
  "/static/img/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Live data (queue/state/songs) must never be served stale.
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response("[]", {
      headers: { "Content-Type": "application/json" },
    })));
    return;
  }

  // Static shell: cache-first, fall back to network and cache it.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        if (res.ok && url.origin === location.origin) {
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match("/tablet"))
    )
  );
});
