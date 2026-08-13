/**
 * MarkOut — Service Worker.
 *
 * Obiettivo: il modello ONNX (5 MB) e i WASM di ONNX Runtime (decine di MB)
 * vengono scaricati UNA volta e poi serviti dalla Cache Storage del browser.
 * Quando torni sulla Home i modelli non vengono riscaricati: l'inizializzazione
 * WebGPU riparte dai byte locali (molto più veloce).
 *
 * Strategie:
 * - Navigazioni (HTML): network-first con fallback cache (aggiornamenti sempre visibili)
 * - Modello ONNX: NETWORK-FIRST con validazione dei byte (un modello corrotto
 *   o troncato in cache renderebbe la session inutilizzabile: "protobuf
 *   parsing failed"). In più yoloService scarica il modello con
 *   cache:'reload' (bypassa del tutto la cache del SW)
 * - Asset statici (js/css/wasm/tar/png…): cache-first (i nomi hashati da Vite
 *   sono immutabili; i .tar hanno nome fisso ma non cambiano quasi mai)
 *
 * Nota: il contesto WebGPU vive per singola pagina (architettura multi-pagina):
 * la session va ricreata a ogni load, ma senza download il costo è minimo.
 */
const CACHE = 'markout-cache-v2';
const CACHEABLE_EXT = /\.(js|css|wasm|onnx|tar|png|svg|ico|webp|woff2?|json)$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Richieste con cache:'reload' o 'no-store' (es. il modello ONNX scaricato
  // esplicitamente da yoloService): NON intercettare — vanno in rete.
  if (req.cache === 'reload' || req.cache === 'no-store') return;

  // HTML / navigazioni: rete prima, cache come fallback (es. offline)
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      } catch {
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Modello ONNX: network-first CON validazione (mai salvare o servire
  // byte non-protobuf: un modello corrotto blocca WebGPU e WASM)
  if (/\\.onnx$/i.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const buf = await res.clone().arrayBuffer();
          if (buf.byteLength > 1000 && new Uint8Array(buf)[0] === 0x08) {
            caches.open(CACHE).then(c => c.put(req, new Response(buf, res))).catch(() => {});
            return new Response(buf, res);
          }
        }
      } catch { /* rete giù: prova la cache */ }
      const hit = await caches.match(req);
      return hit || Response.error();
    })());
    return;
  }

  // Asset statici: cache-first, poi rete + salvataggio in cache
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && CACHEABLE_EXT.test(url.pathname)) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  })());
});
