/* QORVYNA Service Worker — Real Offline Shell + Safe Cache Refresh.
 * - Pre-caches /offline, manifest, and first-party brand artwork.
 * - Never intercepts or caches /api/* requests, mutations, or auth payloads.
 * - Network-first for HTML navigations, falling back to cache or /offline.
 * - Stale-while-revalidate for static assets (_next/static, icons, fonts).
 */

const CACHE_VERSION = "qorvyna-cache-v1.2.0-b3";
const STATIC_SHELL = [
  "/offline",
  "/site.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await Promise.allSettled(STATIC_SHELL.map((url) => cache.add(url)));
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE_VERSION)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname === "/site.webmanifest") return true;
  return /\.(?:png|ico|svg|webp|woff2|css)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache dynamic API endpoints, streaming, or HMR channels.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/webpack-hmr")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, networkResponse.clone()).catch(() => {});
          }
          return networkResponse;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offlinePage = await caches.match("/offline");
          if (offlinePage) return offlinePage;
          return new Response(
            "<!doctype html><html><body style='background:#070B1E;color:#fff;font-family:sans-serif;padding:32px;text-align:center'><h1>QORVYNA is offline</h1><p>Check your internet connection and reload.</p></body></html>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  if (isCacheableStatic(url)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }
        const net = await networkFetch;
        return net || new Response("", { status: 504 });
      }),
    );
  }
});
