/**
 * Geometry — funzioni di utilità geometrica per box e regioni.
 *
 * Tutte le funzioni sono pure (nessun side-effect, nessun import da servizi).
 */
import {
  SMALL_BOX_MIN_W_RATIO,
  SMALL_BOX_MIN_H_RATIO,
  OVERLAP_MERGE_IOU,
  OVERLAP_MERGE_OVERLAP,
  VERTICAL_GAP_THRESHOLD,
  VERTICAL_X_OVERLAP_RATIO,
  CROP_MAX_W,
  CROP_MIN_H,
} from '../config/pipeline.js';
import { IS_MOBILE } from '../config/device.js';
import { trackCanvasCreated, trackCanvasReleased } from '../app/diagnostics.js';

/**
 * Mediana di un array di numeri.
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Centro di un box.
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @returns {{ x: number, y: number }}
 */
export function centerOf(box) {
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
}

/**
 * Union box di un insieme di box.
 * @param {{ x1: number, y1: number, x2: number, y2: number, score?: number, cls?: number, _fallback?: boolean }[]} items
 * @returns {{ x1: number, y1: number, x2: number, y2: number, score: number, cls: number, _fallback: boolean }}
 */
export function unionBoxes(items) {
  return items.reduce((acc, b) => ({
    x1: Math.min(acc.x1, b.x1),
    y1: Math.min(acc.y1, b.y1),
    x2: Math.max(acc.x2, b.x2),
    y2: Math.max(acc.y2, b.y2),
    score: Math.max(acc.score, b.score ?? 0),
    cls: b.cls ?? acc.cls ?? 0,
    _fallback: acc._fallback && !!b._fallback,
  }), {
    x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity,
    score: 0, cls: 0, _fallback: true,
  });
}

/**
 * Intersezione orizzontale tra un box e un intervallo x.
 * @param {{ x1: number, x2: number }} box
 * @param {{ x1: number, x2: number }} interval
 * @returns {number}
 */
export function horizontalOverlap(box, interval) {
  return Math.max(0, Math.min(box.x2, interval.x2) - Math.max(box.x1, interval.x1));
}

/**
 * Area di un box (w × h).
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @returns {number}
 */
export function boxArea(box) {
  return (box.x2 - box.x1) * (box.y2 - box.y1);
}

/**
 * Larghezza di un box.
 * @param {{ x1: number, x2: number }} box
 * @returns {number}
 */
export function boxWidth(box) {
  return box.x2 - box.x1;
}

/**
 * Altezza di un box.
 * @param {{ y1: number, y2: number }} box
 * @returns {number}
 */
export function boxHeight(box) {
  return box.y2 - box.y1;
}

/**
 * Aspect ratio di un box (w/h).
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @returns {number}
 */
export function aspectRatio(box) {
  const h = boxHeight(box);
  return h > 0 ? boxWidth(box) / h : 0;
}

/**
 * Intersezione di due box.
 * @param {{ x1: number, y1: number, x2: number, y2: number }} a
 * @param {{ x1: number, y1: number, x2: number, y2: number }} b
 * @returns {{ x1: number, y1: number, x2: number, y2: number } | null}
 */
export function intersection(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x1 < x2 && y1 < y2) return { x1, y1, x2, y2 };
  return null;
}

/**
 * IOU (Intersection Over Union) tra due box.
 * @param {{ x1: number, y1: number, x2: number, y2: number }} a
 * @param {{ x1: number, y1: number, x2: number, y2: number }} b
 * @returns {number}
 */
export function iou(a, b) {
  const inter = intersection(a, b);
  if (!inter) return 0;
  const interArea = boxArea(inter);
  const unionArea = boxArea(a) + boxArea(b) - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Filtra box YOLO molto piccoli (rumore).
 * Le soglie sono proporzionali alla dimensione della pagina.
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} boxes
 * @param {number} pageW
 * @param {number} pageH
 * @returns {Array}
 */
export function filterSmallBoxes(boxes, pageW, pageH) {
  const minW = Math.max(10, Math.round(pageW * SMALL_BOX_MIN_W_RATIO));
  const minH = Math.max(10, Math.round(pageH * SMALL_BOX_MIN_H_RATIO));
  const minArea = minW * minH;
  return boxes.filter(b => {
    const w = boxWidth(b);
    const h = boxHeight(b);
    return w >= minW && h >= minH && w * h >= minArea;
  });
}

/**
 * Merge iterativo di box con IOU o overlap ratio superiore alla soglia.
 * @param {{ x1: number, y1: number, x2: number, y2: number, score?: number, cls?: number }[]} boxes
 * @param {number} [iouThresh=0.5]
 * @param {number} [overlapThresh=0.7]
 * @returns {Array}
 */
export function mergeOverlappingBoxes(boxes, iouThresh = OVERLAP_MERGE_IOU, overlapThresh = OVERLAP_MERGE_OVERLAP) {
  if (boxes.length <= 1) return boxes;
  let result = boxes.slice();
  let dirty = true;
  while (dirty) {
    dirty = false;
    const newResult = [];
    const used = new Array(result.length).fill(false);
    for (let i = 0; i < result.length; i++) {
      if (used[i]) continue;
      const cur = {
        x1: result[i].x1, y1: result[i].y1, x2: result[i].x2, y2: result[i].y2,
        score: result[i].score, cls: result[i].cls,
      };
      for (let j = i + 1; j < result.length; j++) {
        if (used[j]) continue;
        const other = result[j];
        const inter = intersection(cur, other);
        if (inter) {
          const interArea = boxArea(inter);
          const unionArea = boxArea(cur) + boxArea(other) - interArea;
          const overlapRatio = interArea / Math.min(boxArea(cur), boxArea(other));
          if (interArea / unionArea > iouThresh || overlapRatio > overlapThresh) {
            cur.x1 = Math.min(cur.x1, other.x1); cur.y1 = Math.min(cur.y1, other.y1);
            cur.x2 = Math.max(cur.x2, other.x2); cur.y2 = Math.max(cur.y2, other.y2);
            cur.score = Math.max(cur.score, other.score);
            used[j] = true; dirty = true;
          }
        }
      }
      newResult.push(cur);
    }
    result = newResult;
  }
  return result;
}

/**
 * Unisce due regioni se si toccano verticalmente:
 * x-range si sovrappongono E gap y ≤ soglia.
 * Opera iterativamente fino a stabilizzazione.
 * @param {{ x1: number, y1: number, x2: number, y2: number, items?: Array, sourceCount?: number, score?: number, _fallback?: boolean }[]} regions
 * @returns {Array}
 */
export function mergeVerticalTouchingBlocks(regions) {
  if (regions.length < 2) return regions;
  let merged = [...regions];
  let changed = true;

  while (changed) {
    changed = false;
    const newRegions = [];
    const used = new Array(merged.length).fill(false);
    const sorted = merged
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.y1 - b.r.y1);

    for (let si = 0; si < sorted.length; si++) {
      if (used[sorted[si].i]) continue;
      let current = merged[sorted[si].i];
      used[sorted[si].i] = true;

      for (let sj = si + 1; sj < sorted.length; sj++) {
        if (used[sorted[sj].i]) continue;
        const next = merged[sorted[sj].i];
        const xOverlap = Math.min(current.x2, next.x2) - Math.max(current.x1, next.x1);
        if (xOverlap <= 0) continue;
        const curW = boxWidth(current);
        const nextW = boxWidth(next);
        const minW = Math.min(curW, nextW);
        if (minW > 0 && xOverlap / minW < VERTICAL_X_OVERLAP_RATIO) continue;

        const yGap = next.y1 - current.y2;
        if (yGap > VERTICAL_GAP_THRESHOLD) break;

        current = {
          ...unionBoxes([current, next]),
          items: [...(current.items || []), ...(next.items || [])],
          sourceCount: (current.sourceCount || 1) + (next.sourceCount || 1),
          score: Math.max(current.score || 0, next.score || 0),
          _fallback: (current._fallback && next._fallback) || false,
        };
        used[sorted[sj].i] = true;
        changed = true;
      }
      newRegions.push(current);
    }
    merged = newRegions;
  }

  merged.forEach((r, idx) => { r.readingOrder = idx; });
  return merged;
}

/**
 * Versione leggera del merge per elementi misti (regioni + uncovered YOLO).
 * @param {{ x1: number, y1: number, x2: number, y2: number, items?: Array, sourceCount?: number, score?: number, _fallback?: boolean }[]} elements
 * @returns {Array}
 */
export function mergeAllElements(elements) {
  if (elements.length < 2) return elements;
  let merged = elements.map((el, i) => ({ ...el, _mergeIdx: i }));
  let changed = true;

  while (changed) {
    changed = false;
    const newList = [];
    const used = new Array(merged.length).fill(false);
    const sorted = merged
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.y1 - b.r.y1);

    for (let si = 0; si < sorted.length; si++) {
      if (used[sorted[si].i]) continue;
      let cur = merged[sorted[si].i];
      used[sorted[si].i] = true;

      for (let sj = si + 1; sj < sorted.length; sj++) {
        if (used[sorted[sj].i]) continue;
        const next = merged[sorted[sj].i];
        const xOverlap = Math.min(cur.x2, next.x2) - Math.max(cur.x1, next.x1);
        if (xOverlap <= 0) continue;
        const minW = Math.min(boxWidth(cur), boxWidth(next));
        if (minW > 0 && xOverlap / minW < VERTICAL_X_OVERLAP_RATIO) continue;

        const yGap = next.y1 - cur.y2;
        if (yGap > VERTICAL_GAP_THRESHOLD) break;

        cur = {
          ...unionBoxes([cur, next]),
          items: [...(cur.items || []), ...(next.items || [])],
          containedYOLOs: [...(cur.containedYOLOs || []), ...(next.containedYOLOs || [])],
          sourceCount: (cur.sourceCount || 1) + (next.sourceCount || 1),
          score: Math.max(cur.score || 0, next.score || 0),
          _fallback: !!(cur._fallback && next._fallback),
          _mergeIdx: cur._mergeIdx,
        };
        used[sorted[sj].i] = true;
        changed = true;
      }
      newList.push(cur);
    }
    merged = newList;
  }

  merged.forEach((r, idx) => { r.readingOrder = idx; delete r._mergeIdx; });
  return merged;
}

/**
 * Ridimensiona un canvas di crop per l'OCR.
 *
 * Il modello rec di PaddleOCR normalizza l'altezza del crop a 48px:
 * un crop largo 2000px con testo da 80px viene comunque rimpicciolito
 * dal motore OCR — i pixel in più sono solo memoria.
 *
 * Su mobile i crop vengono sempre ridotti a ≤ CROP_MAX_W px di larghezza;
 * su desktop solo se richiesto esplicitamente (force=true, es. i crop di
 * riga v5, che si accumulano per tutte le pagine durante la fase YOLO),
 * purché il testo risultante resti ≥ CROP_MIN_H px (sotto quella soglia
 * il testo è piccolo e il downscale costerebbe accuratezza).
 *
 * Effetto: memoria dei canvas fino a −75%, qualità OCR praticamente
 * invariata.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} [maxW=CROP_MAX_W] — larghezza massima
 * @param {boolean} [force=false] — applica anche su desktop
 * @returns {HTMLCanvasElement} — lo stesso canvas se non serve ridurre
 */
export function downscaleForOcr(canvas, maxW = CROP_MAX_W, force = false) {
  if (!canvas) return canvas;
  if (!force && !IS_MOBILE) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  if (w <= maxW) return canvas;
  const s = maxW / w;
  const nh = h * s;
  if (nh < CROP_MIN_H) return canvas; // testo troppo piccolo: mantieni risoluzione
  const c = document.createElement('canvas');
  c.width = maxW;
  c.height = Math.max(1, Math.round(nh));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  // Il canvas originale non serve più: libera la bitmap e storna il
  // conteggio (l'oggetto originale non passerà mai da releaseCanvas)
  trackCanvasReleased(canvas);
  canvas.width = 0;
  canvas.height = 0;
  trackCanvasCreated(c);
  return c;
}

/**
 * Ritaglia un canvas in base a un box, con padding opzionale.
 * @param {HTMLCanvasElement} srcCanvas
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @param {number} [padding=2]
 * @returns {HTMLCanvasElement|null}
 */
export function extractCropCanvas(srcCanvas, box, padding = 2) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const x1 = Math.max(0, Math.round(box.x1)), y1 = Math.max(0, Math.round(box.y1));
  const x2 = Math.min(w - 1, Math.round(box.x2)), y2 = Math.min(h - 1, Math.round(box.y2));
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return null;
  if (x2 - x1 < 3 || y2 - y1 < 3) return null;

  if (padding > 0) {
    const sx1 = Math.max(0, x1 - padding);
    const sy1 = Math.max(0, y1 - padding);
    const sx2 = Math.min(w, x2 + padding);
    const sy2 = Math.min(h, y2 + padding);
    const c = document.createElement('canvas');
    c.width = sx2 - sx1;
    c.height = sy2 - sy1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(srcCanvas, sx1, sy1, sx2 - sx1, sy2 - sy1, 0, 0, c.width, c.height);
    trackCanvasCreated(c);
    return downscaleForOcr(c);
  }

  const c = document.createElement('canvas');
  c.width = x2 - x1; c.height = y2 - y1;
  c.getContext('2d').drawImage(srcCanvas, x1, y1, x2 - x1, y2 - y1, 0, 0, x2 - x1, y2 - y1);
  trackCanvasCreated(c);
  return downscaleForOcr(c);
}

/**
 * Parametri del crop "deskewed" (shear verticale affine) per un box
 * su una pagina inclinata.
 *
 * Su una pagina ruotata di poco, la riga di testo ha equazione
 * y = s·x + c (s = tan θ). Il transform
 *
 *   (x, y) → (x + dx, y − s·x + dy)   con  dx = −(x1−pad), dy = s·x0 − minY
 *
 * appiattisce la riga (la pipeline usa la stessa correzione per
 * l'ordinamento: y1d = y1 − s·cx). Il rettangolo di origine
 * [x1-pad, x2+pad]·[y1-pad, y2+pad] diventa un parallelogramma
 * che copre solo la propria riga: le porzioni di testo delle righe
 * superiori/inferiori (estremità diagonali del rettangolo axis-aligned)
 * vengono escluse dal ritaglio.
 *
 * Se viene fornito `quad` (i vertici del quadrilatero della detection
 * PP-OCR — il testo vero, piu stretto del bbox), il crop viene tagliato
 * sui vertici del quad: il rettangolo normalizzato risultante ha come
 * estremi verticali i vertici del quad (il piu lontano da basso/sinistra
 * e quello piu lontano da alto/destra del box normalizzato), quindi
 * l'altezza ≈ solo il testo — le righe sopra/sotto vengono eliminate.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @param {number} [slope=0] — pendenza (dy/dx) della riga
 * @param {number} [padding=2] — margine extra (px, stesso sistema del box)
 * @param {{ quad?: Array<[number, number]>, bandQuad?: boolean }} [opts]
 *   quad — 4 vertici del quadrilatero; bandQuad — x dal box, banda y dal quad
 * @returns {{ s: number, dx: number, dy: number, x0: number, minY: number, w: number, h: number, quad: boolean } | null}
 */
export function deskewCropParams(box, slope = 0, padding = 2, opts = null) {
  const s = (Number.isFinite(slope) && Math.abs(slope) < 0.6) ? slope : 0;
  const quad = (opts && Array.isArray(opts.quad) && opts.quad.length >= 2) ? opts.quad : null;
  const bandQuad = !!(opts && opts.bandQuad && quad);

  // Modalita' quad: estremi calcolati sul quadrilatero (shear y′ = y − s·x):
  // l'altezza del ritaglio ≈ spessore del testo, le righe adiacenti zero.
  if (quad) {
    let minX = bandQuad ? box.x1 : Infinity;
    let maxX = bandQuad ? box.x2 : -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < quad.length; i++) {
      const qx = quad[i][0], qy = quad[i][1];
      if (!Number.isFinite(qx) || !Number.isFinite(qy)) return null;
      const Y = qy - s * qx;
      if (!bandQuad) { if (qx < minX) minX = qx; if (qx > maxX) maxX = qx; }
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    const w = maxX - minX;
    const h = maxY - minY;
    if (!(w > 0) || !(h > 0)) return null;
    return {
      s, dx: padding - minX, dy: padding - minY, x0: 0, minY,
      w: Math.max(1, w + 2 * padding),
      h: Math.max(1, h + 2 * padding),
      quad: true,
    };
  }

  const w = box.x2 - box.x1;
  const hbox = box.y2 - box.y1;
  if (!Number.isFinite(w) || !Number.isFinite(hbox) || w < 3 || hbox < 3) return null;

  const px1 = box.x1 - padding;
  const px2 = box.x2 + padding;
  const py1 = box.y1 - padding;
  const py2 = box.y2 + padding;
  const x0 = (px1 + px2) / 2;
  const Y = (x, y) => y - s * (x - x0);

  const ys = [Y(px1, py1), Y(px1, py2), Y(px2, py1), Y(px2, py2)];
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // No-trim: canvas ALTO QUANTO IL BOX (+padding), non quanto il
  // parallelogramma shearato. I margini bianchi attorno al testo inclinato
  // riducono la perdita di inchiostro ai bordi e migliorano il
  // riconoscimento (valutato su dataset: CER 0.111 → 0.105, EM 42% → 52%).
  const dyExtra = (hbox - (maxY - minY)) / 2;

  // transform matrice (canvas setTransform): x' = x + dx ; y' = −s·x + y + dy
  return {
    s,
    dx: -px1,
    dy: s * x0 - minY + dyExtra,
    x0,
    minY,
    w: Math.max(1, px2 - px1),
    h: Math.max(1, hbox),
    quad: false,
  };
}

/**
 * Ritaglia un box da un canvas applicando il deskew della riga:
 * il parallelogram risultante contiene solo la riga interessata,
 * niente porzioni delle righe adiacenti.
 *
 * @param {HTMLCanvasElement} srcCanvas
 * @param {{ x1: number, y1: number, x2: number, y2: number }} box
 * @param {number} [slope=0] — pendenza della riga (dy/dx)
 * @param {number} [padding=2]
 * @param {{ quad?: Array<[number, number]>, bandQuad?: boolean }} [opts]
 * @returns {HTMLCanvasElement|null}
 */
export function extractDeskewedCropCanvas(srcCanvas, box, slope = 0, padding = 2, opts = null) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const x1 = Math.max(0, Math.round(box.x1)), y1 = Math.max(0, Math.round(box.y1));
  const x2 = Math.min(w - 1, Math.round(box.x2)), y2 = Math.min(h - 1, Math.round(box.y2));
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return null;
  if (x2 - x1 < 3 || y2 - y1 < 3) return null;

  const p = deskewCropParams({ x1, y1, x2, y2 }, slope, padding, opts);
  if (!p) return null;

  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(p.w));
  c.height = Math.max(1, Math.ceil(p.h));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(1, -p.s, 0, 1, p.dx, p.dy);
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  trackCanvasCreated(c);
  return downscaleForOcr(c);
}
