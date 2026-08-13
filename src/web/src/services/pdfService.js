/**
 * PDF Service — rendering delle pagine PDF su canvas.
 *
 * Utilizza pdf.js (npm, self-hosted, niente CDN) per caricare
 * e renderizzare pagine PDF. Il worker viene servito come asset
 * statico da Vite (?url) — nessuna dipendenza da reti esterne.
 */
import { DPI, MAX_DIM } from '../config/pipeline.js';

// pdfjs-dist (≈8 MB) viene caricato SOLO al primo upload, non all'avvio:
// il bundle iniziale resta leggero (Performance / Lighthouse).
let _pdfjsPromise = null;

/**
 * Carica pdfjs-dist al primo utilizzo e configura il worker (module worker).
 * @returns {Promise<typeof import('pdfjs-dist')>}
 */
export function getPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      const [mod, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    })();
  }
  return _pdfjsPromise;
}

/**
 * Renderizza una pagina PDF su un canvas HTML.
 *
 * @param {PDFDocumentProxy} pdf — documento PDF caricato con pdf.js
 * @param {number} pageNum — numero pagina (1-based)
 * @returns {Promise<HTMLCanvasElement>}
 */
export function renderPageToCanvas(pdf, pageNum) {
  return pdf.getPage(pageNum).then(page => {
    const vp = page.getViewport({ scale: 1 });
    let zoom = DPI / 72;
    const longPx = Math.max(vp.width, vp.height) * zoom;
    if (longPx > MAX_DIM) zoom *= (MAX_DIM / longPx);

    const canvas = document.createElement('canvas');
    const scaled = page.getViewport({ scale: zoom });
    canvas.width = Math.round(scaled.width);
    canvas.height = Math.round(scaled.height);
    const ctx = canvas.getContext('2d');

    return page.render({ canvasContext: ctx, viewport: scaled }).promise.then(() => {
      page.cleanup();
      return canvas;
    });
  });
}
