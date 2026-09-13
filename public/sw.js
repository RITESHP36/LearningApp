const CACHE_NAME = "learningapp-v1";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
];

// Install: cache the app shell
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for page images, network-first for app shell
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Page images: cache-first (they never change)
  if (url.pathname.includes("/pages/")) {
    e.respondWith(
      caches.match(e.request).then(
        (cached) =>
          cached ||
          fetch(e.request).then((resp) => {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            return resp;
          })
      )
    );
    return;
  }

  // App shell: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
