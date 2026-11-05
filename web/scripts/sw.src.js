/* Seventh House service worker: offline app shell + deck cache.
 * Plain script, no bundler. Source lives in scripts/sw.src.js; scripts/make-sw.mjs stamps
 * __BUILD_ID__ and writes public/sw.js at prebuild, so each deploy gets its own cache and
 * activate() purges the previous one.
 * Only same-origin GETs are ever handled; the API lives on another origin and is never
 * cached, nor is any same-origin /api path.
 */
const CACHE = "sh-__BUILD_ID__";
const SHELL = "/";
const PRECACHE = [
  SHELL,
  "/journal/",
  "/chart/",
  "/deck/back.webp",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
];

/** Routing decision for one request: "bypass" | "cache-first" | "navigate" | "network-first". */
function strategyFor(request, origin) {
  if (request.method !== "GET") return "bypass";
  // Cache.put rejects 206 partial responses; let range requests go straight to the network.
  if (request.headers && request.headers.has("range")) return "bypass";
  const url = new URL(request.url);
  if (url.origin !== origin) return "bypass";
  const p = url.pathname;
  if (p === "/api" || p.startsWith("/api/")) return "bypass";
  if (p.startsWith("/deck/") || p.startsWith("/_next/static/")) return "cache-first";
  if (request.mode === "navigate") return "navigate";
  return "network-first";
}

/** Only successful, non-opaque responses are worth keeping. */
function cacheable(response) {
  return Boolean(response && response.ok && response.type !== "opaque");
}

async function putIfCacheable(request, response) {
  if (!cacheable(response)) return;
  const cache = await self.caches.open(CACHE);
  await cache.put(request, response);
}

/** Store a copy off the response path: a quota or 206 rejection must never fail the fetch. */
function storeInBackground(event, response) {
  if (!cacheable(response)) return;
  const { request } = event;
  event.waitUntil(
    putIfCacheable(request, response.clone()).catch((err) =>
      console.warn("sw cache put failed", request.url, err),
    ),
  );
}

async function cacheFirst(event) {
  const { request } = event;
  const hit = await self.caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  storeInBackground(event, res);
  return res;
}

async function networkFirst(event, fallbackToShell) {
  const { request } = event;
  try {
    const res = await fetch(request);
    storeInBackground(event, res);
    return res;
  } catch (err) {
    const hit = await self.caches.match(request);
    if (hit) return hit;
    if (fallbackToShell) {
      const shell = await self.caches.match(SHELL);
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(CACHE);
      // Best-effort per URL: one missing asset must not block installation.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (cacheable(res)) await cache.put(url, res);
            else console.warn("sw precache skipped", url, res && res.status);
          } catch (err) {
            console.warn("sw precache failed", url, err);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await self.caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("sh-") && k !== CACHE).map((k) => self.caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const strategy = strategyFor(event.request, self.location.origin);
  if (strategy === "bypass") return;
  if (strategy === "cache-first") event.respondWith(cacheFirst(event));
  else event.respondWith(networkFirst(event, strategy === "navigate"));
});

// Exposed for unit tests, which evaluate this file in a sandbox.
self.__sh = { CACHE, PRECACHE, strategyFor, cacheable, cacheFirst, networkFirst };
