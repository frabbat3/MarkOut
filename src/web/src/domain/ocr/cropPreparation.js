/**
 * Crop Preparation — preparazione dei frammenti YOLO per l'OCR.
 *
 * Pipeline (configurazione "v4", validata su un dataset di 112 crop con
 * trascrizione umana di riferimento — CER 0.111 → 0.057, EM 42% → 68%):
 *
 *   1. Color compensation: canale max(R,G,B) + stretch percentili 1–99.
 *      Rimuove la tinta dell'evidenziatore senza binarizzare (funziona su
 *      qualunque colore/lingua; costo: una passata sui pixel).
 *   2. Upscale dei crop bassi (h < 56px) di fattore ×2 o più: più dettaglio
 *      per il riconoscimento dei caratteri piccoli.
 *   3. Padding bianco per altezza minima (MIN_OCR_HEIGHT, come prima).
 *   4. Split dei frammenti larghi (> MAX_OCR_WIDTH) in corrispondenza delle
 *      colonne vuote tra parole (wsplit). Il taglio non spezza le parole →
 *      niente errori al seam. Se non esiste una colonna bianca adatta,
 *      fallback allo split storico a 2 metà con overlap (OCR_OVERLAP).
 *      Fino a 1600px → 2 segmenti, oltre → 3.
 */
import { MAX_OCR_WIDTH, MIN_OCR_HEIGHT, OCR_OVERLAP } from '../../config/pipeline.js';

/** Crop con altezza sotto questa soglia vengono ingranditi (×2 o più). */
const UPSCALE_MIN_H = 56;
/** Soglia di "scurità" per contare i pixel di testo in una colonna. */
const TEXT_GRAY = 150;

/**
 * Percentile con interpolazione lineare (equivalente a numpy.percentile)
 * calcolato dall'istogramma dei livelli di grigio.
 * @param {Uint32Array} hist — istogramma 256 bin
 * @param {number} total — numero di pixel
 * @param {number} q — quantile 0..1
 * @returns {number}
 */
function percentileFromHist(hist, total, q) {
  const idx = (total - 1) * q;
  const i = Math.floor(idx);
  const f = idx - i;
  let cum = 0;
  let vA = -1;
  let vB = -1;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (vA === -1 && cum >= i + 1) vA = v;
    if (cum >= i + 2) { vB = v; break; }
  }
  if (vB === -1) vB = 255;
  return vA + f * (vB - vA);
}

/**
 * Color compensation: canale max(R,G,B) + stretch 1–99 percentile.
 * Neutro rispetto alla lingua; rimuove la tinta dell'evidenziatore
 * (giallo/rosa/arancio/...) e aumenta il contrasto del testo.
 *
 * @param {HTMLCanvasElement} canvas — modificato in place
 * @returns {HTMLCanvasElement}
 */
export function applyColorCompensation(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return canvas;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const total = w * h;
  const hist = new Uint32Array(256);
  const gray = new Float32Array(total);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    // max channel (equivalente a np.max(axis=2) su BGR)
    const g = (d[i] > d[i + 1])
      ? (d[i] > d[i + 2] ? d[i] : d[i + 2])
      : (d[i + 1] > d[i + 2] ? d[i + 1] : d[i + 2]);
    gray[p] = g;
    hist[Math.min(255, Math.round(g))]++;
  }
  const lo = percentileFromHist(hist, total, 0.01);
  const hi = percentileFromHist(hist, total, 0.99);
  if (hi - lo <= 20) return canvas; // poco contrasto: lascia com'è

  const scale = 255 / (hi - lo);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.min(255, Math.max(0, Math.round((gray[p] - lo) * scale)));
    d[i] = g;
    d[i + 1] = g;
    d[i + 2] = g;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Upscale dei crop bassi (h < UPSCALE_MIN_H) di fattore ×2 o più
 * (interpolazione bicubica del browser).
 * @param {HTMLCanvasElement} canvas
 * @returns {HTMLCanvasElement}
 */
function upscaleIfSmall(canvas) {
  const h = canvas.height;
  if (h >= UPSCALE_MIN_H) return canvas;
  const f = Math.max(2, Math.ceil(UPSCALE_MIN_H / h));
  const c = document.createElement('canvas');
  c.width = canvas.width * f;
  c.height = h * f;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

/** Padding bianco per altezza minima (come la versione storica). */
function padMinHeight(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (h >= MIN_OCR_HEIGHT) return canvas;
  const addTop = Math.floor((MIN_OCR_HEIGHT - h) / 2);
  const addBot = MIN_OCR_HEIGHT - h - addTop;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = MIN_OCR_HEIGHT;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, addTop);
  return c;
}

/**
 * Split storico del sito: 2 metà con overlap.
 * @param {HTMLCanvasElement} canvas — larghezza > MAX_OCR_WIDTH
 * @returns {HTMLCanvasElement[]}
 */
function splitSiteFallback(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const mid = w / 2;
  const lw = Math.min(w, mid + OCR_OVERLAP);
  const left = document.createElement('canvas');
  left.width = Math.round(lw);
  left.height = h;
  left.getContext('2d').drawImage(canvas, 0, 0, lw, h, 0, 0, lw, h);

  const rx = Math.max(0, mid - OCR_OVERLAP);
  const rw = w - rx;
  const right = document.createElement('canvas');
  right.width = Math.round(rw);
  right.height = h;
  right.getContext('2d').drawImage(canvas, rx, 0, rw, h, 0, 0, rw, h);
  return [left, right];
}

/**
 * Split in corrispondenza delle colonne quasi vuote (gap tra parole):
 * - colonna di testo = conteggio pixel con grigio < TEXT_GRAY
 * - cerca il minimo locale di testo vicino a w·i/n (finestra ±12%)
 * - richiede colonna (quasi) vuota: score ≤ max(2, h·0.02)
 * - segmenti ≥ 200px ciascuno
 * Fallback: split storico a 2 metà quando non trova colonne valide.
 *
 * @param {HTMLCanvasElement} canvas — larghezza > MAX_OCR_WIDTH
 * @returns {HTMLCanvasElement[]}
 */
function splitWhitespace(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h).data;

  // testo per colonna (canale max, come in valutazione: gray = max(R,G,B))
  const textCols = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < h; y++) {
      const off = (y * w + x) * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const mx = (r > g) ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < TEXT_GRAY) cnt++;
    }
    textCols[x] = cnt;
  }

  const nSegments = w <= 1600 ? 2 : 3;
  const starts = [0];
  let used = false;
  for (let i = 1; i < nSegments; i++) {
    const target = (w * i) / nSegments;
    const lo = Math.max(1, Math.trunc(target - w * 0.12));
    const hi = Math.min(w - 1, Math.trunc(target + w * 0.12));
    let best = Infinity;
    let bestX = -1;
    for (let x = lo; x < hi; x++) {
      const x0 = Math.max(0, x - 2);
      const x1 = Math.min(w - 1, x + 2);
      let score = 0;
      for (let xx = x0; xx <= x1; xx++) score += textCols[xx];
      if (score < best) {
        best = score;
        bestX = x;
        if (score === 0) break;
      }
    }
    const last = starts[starts.length - 1];
    if (bestX >= 0 && best <= Math.max(2, h * 0.02)
        && bestX - last >= 200 && w - bestX >= 200) {
      starts.push(bestX);
      used = true;
    }
  }
  starts.push(w);

  if (!used) return splitSiteFallback(canvas);

  const out = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const s = starts[i];
    const e = starts[i + 1];
    const c = document.createElement('canvas');
    c.width = e - s;
    c.height = h;
    c.getContext('2d').drawImage(canvas, s, 0, e - s, h, 0, 0, e - s, h);
    out.push(c);
  }
  return out;
}

/**
 * Prepara un frammento YOLO per OCR (pipeline "v4"):
 * color-comp → upscale → padding → split.
 *
 * @param {HTMLCanvasElement} canvas — il canvas da preparare
 * @returns {{ subCanvases: HTMLCanvasElement[], split: boolean }}
 */
export function prepareCropForOCR(canvas) {
  const entry = { subCanvases: [], split: false };

  let base = applyColorCompensation(canvas);
  base = upscaleIfSmall(base);
  base = padMinHeight(base);

  if (base.width > MAX_OCR_WIDTH) {
    const subs = splitWhitespace(base);
    entry.split = subs.length > 1;
    entry.subCanvases = subs;
  } else {
    entry.subCanvases = [base];
  }

  return entry;
}

/**
 * Prepara il crop della RIGA det per OCR (v5): color-comp → upscale →
 * padding, ma SENZA split: la riga intera è il contesto che migliora il
 * recognition (il modello supporta larghezze fino a ~3200; la cucitura
 * degli split degrada il testo — validato sul dataset: con split 6
 * migliori/9 peggiori, senza split 15/0).
 *
 * @param {HTMLCanvasElement} canvas — crop della riga (deskewed)
 * @returns {{ subCanvases: HTMLCanvasElement[], split: boolean }}
 */
export function prepareRowForOCR(canvas) {
  let base = applyColorCompensation(canvas);
  base = upscaleIfSmall(base);
  base = padMinHeight(base);
  return { subCanvases: [base], split: false };
}

/**
 * Prepara un batch di frammenti per OCR.
 *
 * @param {Array} batch — array di frammenti con .canvas (e .rowCanvas per v5)
 * @returns {Array} — subMap con { fragIndex, subCanvases, rowCanvases, split }
 */
export function prepareBatchForOCR(batch) {
  // Il crop della riga è CONDIVISO tra i frammenti dello stesso item
  // (stesso oggetto canvas): la preparazione va fatta UNA volta per riga.
  const rowCache = new Map();
  return batch.map((f, idx) => {
    const prepared = prepareCropForOCR(f.canvas);
    // v5: anche il crop della riga intera (preparazione dedicata, niente split)
    let rowCanvases = [];
    if (f.rowCanvas) {
      let cached = rowCache.get(f.rowCanvas);
      if (!cached) {
        cached = prepareRowForOCR(f.rowCanvas).subCanvases;
        rowCache.set(f.rowCanvas, cached);
      }
      rowCanvases = cached;
    }
    return { fragIndex: idx, ...prepared, rowCanvases };
  });
}