/* Service Worker — Reproductor AP
   Estrategia:
   - HTML/CSS/JS: network-first con fallback a caché
   - Portadas/iconos: cache-first
   - CANCIONES: NO se interceptan nunca (el navegador gestiona Range/streaming)
*/

const CACHE_VERSION = "reprodap-v11";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=11",
  "./script.js?v=11",
  "./tracks.js?v=11",
  "./manifest.json",
  "./assets/reprod.png",
  "./assets/default-cover.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Solo mismo origen
  if (url.origin !== self.location.origin) return;

  // -------------------------------------------------------------
  // 1) CANCIONES: dejar pasar al navegador SIN interceptar.
  //    El navegador necesita manejar Range (206) nativo para
  //    hacer streaming/seek/ID3 y para que iOS reproduzca bien.
  // -------------------------------------------------------------
  if (url.pathname.includes("/songs/")) {
    return;
  }

  // -------------------------------------------------------------
  // 2) Portadas e iconos: cache-first
  // -------------------------------------------------------------
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // -------------------------------------------------------------
  // 3) App shell (HTML/CSS/JS/manifest): network-first
  // -------------------------------------------------------------
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});