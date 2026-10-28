/**
 * coi-serviceworker.js — cross-origin isolation for static hosts (GitHub Pages, a CDN, `python -m http.server`) that
 * cannot send the COOP/COEP headers WebAssembly threads need (SharedArrayBuffer). The same file is both the page side
 * and the worker: included by index.html, it registers itself when the page is not isolated yet, the worker then adds
 * the two headers to every response of its scope, and the page reloads once. Nothing happens on a server that sends
 * the headers (scripts/serve.mjs, nginx with deploy/nginx-qgis.conf).
 */
if (typeof window === 'undefined') {
  // --- the service worker
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
    event.respondWith(fetch(request).then((response) => {
      if (response.status === 0 || response.type === 'opaque') return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }));
  });
} else {
  // --- the page
  (function () {
    const KEY = 'qgis-wasm.coi-reloaded';
    if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    if (sessionStorage.getItem(KEY)) { sessionStorage.removeItem(KEY); return; } // reloaded once already and still not isolated: the preflight explains
    const src = document.currentScript && document.currentScript.src;
    if (!src) return;
    window.qgisCoiPending = true; // index.html's preflight shows "enabling cross-origin isolation" instead of the unsupported page
    const reload = () => { sessionStorage.setItem(KEY, '1'); location.reload(); };
    navigator.serviceWorker.register(src).then((registration) => {
      if (registration.active && !navigator.serviceWorker.controller) return reload();
      const watch = (worker) => worker && worker.addEventListener('statechange', () => { if (worker.state === 'activated') reload(); });
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      if (navigator.serviceWorker.controller) setTimeout(reload, 50); // controlled already (a previous visit): headers come from the next load
    }).catch((e) => { window.qgisCoiPending = false; console.warn('coi-serviceworker: registration failed', e); });
  })();
}
