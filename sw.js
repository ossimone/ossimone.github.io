/* PDF Stüdyo — çevrimdışı önbellek */
const VERSION = 'pdfstudio-v16c6';
const CORE = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/core.js',
  'js/render.js',
  'js/tools.js',
  'js/textedit.js',
  'js/fonts.js',
  'js/organizer.js',
  'js/export.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/pdf-lib.min.js',
  'vendor/fontkit.umd.js',
  'vendor/fonts/LiberationSans-Regular.ttf',
  'vendor/fonts/LiberationSans-Bold.ttf',
  'vendor/fonts/LiberationSans-Italic.ttf',
  'vendor/fonts/Tinos-Regular.ttf',
  'vendor/fonts/Tinos-Bold.ttf',
  'vendor/fonts/Tinos-Italic.ttf',
  'vendor/fonts/Cousine-Regular.ttf',
  'vendor/fonts/Cousine-Bold.ttf',
  'vendor/fonts/DejaVuSans.ttf',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});
