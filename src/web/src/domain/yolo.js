/**
 * YOLO — preprocessamento immagine e decodifica output del modello.
 *
 * Funzioni pure, lavorano su Float32Array/Array.
 */
import { MODEL_SIZE } from '../config/pipeline.js';

// Buffer riutilizzabile per il tensor CHW (3×1024²×4B = 12.5MB; il modello
// ONNX ha shape fissa 1024, identica su desktop e mobile). La pipeline
// preprocessa una pagina alla volta in modo sincrono (session.run viene
// atteso prima della pagina successiva), quindi il riuso è sicuro e
// evita un'allocazione + GC di ~12.5MB per ogni pagina.
let _tensorPool = null;

function tensorPool() {
  if (!_tensorPool) _tensorPool = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  return _tensorPool;
}

/**
 * Preprocessa un canvas per l'inferenza YOLO:
 * - Ridimensiona mantenendo aspect ratio (letterbox)
 * - Normalizza a [0, 1]
 * - Restituisce tensor CHW float32
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{ tensorArr: Float32Array, scale: number, padX: number, padY: number }}
 */
export function preprocessYOLO(canvas) {
  const w = canvas.width, h = canvas.height;
  const r = Math.min(MODEL_SIZE / w, MODEL_SIZE / h);
  const nw = Math.round(w * r), nh = Math.round(h * r);
  const padX = Math.round((MODEL_SIZE - nw) / 2);
  const padY = Math.round((MODEL_SIZE - nh) / 2);

  const lb = document.createElement('canvas');
  lb.width = MODEL_SIZE; lb.height = MODEL_SIZE;
  const ctx = lb.getContext('2d');
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.drawImage(canvas, padX, padY, nw, nh);

  const imgData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const arr = tensorPool();
  const stride = MODEL_SIZE * MODEL_SIZE;
  const r0 = 0, g0 = stride, b0 = 2 * stride;
  // Loop a 3 canali separati: usa accessi sequenziali (migliore cache locality)
  // e fino a 4 pixel per iterazione con `imgData` indicizzato linearmente.
  let i = 0;
  for (let y = 0; y < MODEL_SIZE; y++) {
    let base = y * MODEL_SIZE;
    for (let x = 0; x < MODEL_SIZE; x++) {
      const idx = i << 2;
      arr[r0 + base + x] = imgData[idx] * (1 / 255);
      arr[g0 + base + x] = imgData[idx + 1] * (1 / 255);
      arr[b0 + base + x] = imgData[idx + 2] * (1 / 255);
      i++;
    }
  }
  return { tensorArr: arr, scale: r, padX, padY };
}

/**
 * Decodifica l'output YOLO in box [{ x1, y1, x2, y2, score, cls }].
 * Ogni detection ha 6 float: x1, y1, x2, y2, score, class_id.
 *
 * @param {Float32Array} data — output tensor flat
 * @param {number} confThres — soglia di confidenza
 * @param {number} [maxDetections=300] — numero massimo di detection
 * @returns {{ x1: number, y1: number, x2: number, y2: number, score: number, cls: number }[]}
 */
export function decodeYOLO(data, confThres, maxDetections = 300) {
  const dets = [];
  for (let i = 0; i < maxDetections; i++) {
    const off = i * 6;
    const score = data[off + 4];
    if (score >= confThres) {
      dets.push({
        x1: data[off],
        y1: data[off + 1],
        x2: data[off + 2],
        y2: data[off + 3],
        score,
        cls: Math.round(data[off + 5]),
      });
    }
  }
  return dets;
}

/**
 * Riporta i box dalle coordinate preprocessate (letterbox) alle
 * coordinate originali della pagina.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number, score: number, cls: number }[]} dets
 * @param {number} scale — fattore di scala da preprocessYOLO
 * @param {number} padX — padding x da preprocessYOLO
 * @param {number} padY — padding y da preprocessYOLO
 * @returns {Array}
 */
export function boxesToOrig(dets, scale, padX, padY) {
  return dets.map(d => ({
    x1: (d.x1 - padX) / scale,
    y1: (d.y1 - padY) / scale,
    x2: (d.x2 - padX) / scale,
    y2: (d.y2 - padY) / scale,
    score: d.score,
    cls: d.cls,
  }));
}
