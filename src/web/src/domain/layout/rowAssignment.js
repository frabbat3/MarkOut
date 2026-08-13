/**
 * Row Assignment — assegnazione box YOLO ↔ righe di detection (debug).
 *
 * Condivisa tra le tab di debug (resultRenderer) e il debug report:
 * replica ESATTAMENTE il criterio della pipeline (assignFragsToRows):
 * ogni box va esclusivamente alla riga con la maggiore area contenuta
 * (xOv·yOv nel piano deskewed della riga); a parità di area (entro il
 * 5% dell'area del box) vince la riga col centro più vicino; fallback
 * alla riga più vicina entro 1.5×lineHeight.
 *
 * Effetto collaterale voluto: ogni box YOLO riceve `_yIdx` (il suo
 * indice nell'array merged = l'ID Y# usato in tutta la UI di debug).
 */
import { median, deskewCropParams } from '../geometry.js';
import { assignFragsToRows } from './clusterHighlights.js';

/**
 * Altezza riga di riferimento: mediana delle altezze delle detection
 * valide, come il calcolo `lh` della pipeline (clusterAndOrderBoxes).
 *
 * @param {Array} detRects
 * @returns {number}
 */
export function detLineHeight(detRects) {
  return median(detRects.map(d => d.y2 - d.y1).filter(h => Number.isFinite(h) && h > 0)) || 12;
}

/**
 * Chiave stabile di una detection (coordinate arrotondate).
 * Usata per ricondurre region.detItems (copie) alle D# di detRects.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} d
 * @returns {string}
 */
export function keyOfDet(d) {
  return `(${Math.round(d.x1)},${Math.round(d.y1)},${Math.round(d.x2)},${Math.round(d.y2)})`;
}

/**
 * Preparazione di tutte le righe di detection: parametri del crop
 * deskewed (pbox/quad/cropP) — gli stessi usati dalle card delle tab
 * e dal debug report.
 *
 * @param {Array} detRects — righe di detection (coordinate pagina piena)
 * @param {HTMLCanvasElement|null} canvas — canvas display (scala `s`)
 * @param {number} s — fattore di scala canvas/pagina (displayScale)
 * @returns {Array} righe preparate { d, di, pbox, quad, cropP, rowP }
 */
export function prepareDetRows(detRects, canvas, s) {
  const scale = s || 1;
  return detRects.map((d, di) => {
    const pbox = {
      x1: Math.round(d.x1 * scale), y1: Math.round(d.y1 * scale),
      x2: Math.round(d.x2 * scale), y2: Math.round(d.y2 * scale),
    };
    const wc = pbox.x2 - pbox.x1, hc = pbox.y2 - pbox.y1;
    const quad = (Array.isArray(d.poly) && d.poly.length >= 4)
      ? d.poly.map(pt => [pt[0] * scale, pt[1] * scale])
      : null;
    const cropP = quad ? { quad } : null;
    const rowP = (canvas && wc >= 4 && hc >= 4)
      ? deskewCropParams(pbox, d.slope, 2, cropP)
      : null;
    return { d, di, pbox, quad, cropP, rowP };
  });
}

/**
 * Assegna ogni box YOLO alla riga di detection dominante (v. sopra).
 *
 * @param {Array} yoloBoxes — box merged (arricchiti con _yIdx)
 * @param {Array} prepped — output di prepareDetRows
 * @param {number} pageSlope — pendenza di pagina (deskew)
 * @param {number} lhDet — altezza riga di riferimento
 * @returns {{ boxRow: Map, orphans: Array }} boxRow: box → prepped[ri]
 */
export function assignBoxesToRows(yoloBoxes, prepped, pageSlope, lhDet) {
  yoloBoxes.forEach((b, i) => { b._yIdx = i; });

  const s = Number.isFinite(pageSlope) ? pageSlope : 0;
  const rows = prepped.map((rp, ri) => {
    const d = rp.d;
    const cx = (d.x1 + d.x2) / 2;
    const sh = s * cx;
    return {
      ...rp, ri,
      cx, x1: d.x1, x2: d.x2, y1: d.y1, y2: d.y2,
      sl: Number.isFinite(d.slope) ? d.slope : s,
      y1d: d.y1 - sh, y2d: d.y2 - sh,
      fused: (d.y2 - d.y1) > 1.5 * lhDet,
    };
  });
  const frags = yoloBoxes
    .map((b, i) => {
      const cx = (b.x1 + b.x2) / 2;
      const sh = s * cx;
      return { ...b, index: i, cx, cy: (b.y1 + b.y2) / 2 - sh, y1d: b.y1 - sh, y2d: b.y2 - sh };
    })
    .filter(f => Number.isFinite(f.x1) && Number.isFinite(f.y1));
  const rowOf = assignFragsToRows(frags, rows, lhDet);
  const boxRow = new Map();
  const orphans = [];
  for (const f of frags) {
    const r = rowOf.get(f.index);
    if (r) boxRow.set(yoloBoxes[f.index], prepped[r.ri]);
    else orphans.push(yoloBoxes[f.index]);
  }
  return { boxRow, orphans };
}