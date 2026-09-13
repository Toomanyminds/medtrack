const CACHE = "medtrack-shell-v1";
const SHELL = ["./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Only cache the app shell. Everything else (Drive API, Gemini API, Google auth)
// always goes to the network — this app's data lives in your Drive, not on the device.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let API calls pass straight through
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
