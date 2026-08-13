/**
 * Reading Order — ordinamento di regioni in senso di lettura naturale.
 *
 * Algoritmo: per bande orizzontali (y-overlap), poi per colonne x
 * all'interno di ogni banda, poi y + tiebreaker x per stessa riga.
 */
import { centerOf } from '../geometry.js';
import { BAND_OVERLAP_TOLERANCE, SAME_ROW_TOLERANCE_RATIO } from '../../config/pipeline.js';

/**
 * Ordina regioni in reading order: per bande orizzontali (y-overlap),
 * poi per colonne x all'interno di ogni banda, poi y + tiebreaker x
 * per stessa riga.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} regions
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {number} lineHeight — altezza mediana delle righe
 * @returns {Array} Regioni ordinate
 */
export function orderByReadingOrder(regions, pageWidth, pageHeight, lineHeight) {
  if (regions.length < 2) return regions.slice();

  const sameRowTolerance = Math.max(6, Math.round(lineHeight * SAME_ROW_TOLERANCE_RATIO));

  // 1. Ordina per centro-y
  const sorted = [...regions].sort((a, b) => centerOf(a).y - centerOf(b).y);

  // 2. Raggruppa in bande orizzontali
  const bands = [];
  let currentBand = [];
  let bandY2 = -Infinity;

  for (const r of sorted) {
    if (currentBand.length === 0) {
      currentBand.push(r);
      bandY2 = r.y2;
    } else if (r.y1 < bandY2 - BAND_OVERLAP_TOLERANCE) {
      currentBand.push(r);
      bandY2 = Math.max(bandY2, r.y2);
    } else {
      bands.push(currentBand);
      currentBand = [r];
      bandY2 = r.y2;
    }
  }
  if (currentBand.length > 0) bands.push(currentBand);

  // 3. Ogni banda: dividi in colonne x, ordina ogni colonna per y
  const result = [];
  for (const band of bands) {
    const cols = splitBandIntoColumns(band);
    for (const col of cols) {
      col.sort((a, b) => {
        const yDiff = centerOf(a).y - centerOf(b).y;
        if (Math.abs(yDiff) < sameRowTolerance) {
          return centerOf(a).x - centerOf(b).x;
        }
        return yDiff;
      });
      result.push(...col);
    }
  }

  return result;
}

/**
 * Divide una banda orizzontale in colonne verticali.
 * Due box sono nella stessa colonna se i loro x-range si sovrappongono.
 *
 * @param {{ x1: number, x2: number }[]} band
 * @returns {Array[]}
 */
export function splitBandIntoColumns(band) {
  if (band.length <= 1) return [band];

  const sorted = [...band].sort((a, b) => centerOf(a).x - centerOf(b).x);
  const columns = [];
  let currentCol = [sorted[0]];
  let colX2 = sorted[0].x2;

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.x1 < colX2) {
      currentCol.push(r);
      colX2 = Math.max(colX2, r.x2);
    } else {
      columns.push(currentCol);
      currentCol = [r];
      colX2 = r.x2;
    }
  }
  columns.push(currentCol);
  return columns;
}

/**
 * Alias per retrocompatibilità. Delega a orderByReadingOrder.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} regions
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {number} lineHeight
 * @returns {Array}
 */
export function runXYCutOnRegions(regions, pageWidth, pageHeight, lineHeight) {
  return orderByReadingOrder(regions, pageWidth, pageHeight, lineHeight);
}
