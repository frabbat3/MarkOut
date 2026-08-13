/**
 * Columns — rilevamento colonne e ordinamento layout.
 *
 * Pipeline:
 *   detectVerticalGutters ha 2 fasi:
 *     Phase 1: buildColumnGroups — raggruppa regioni per
 *              sovrapposizione x (soglia OVERLAP_MIN=35px).
 *              I confini tra gruppi diventano gutter.
 *     Phase 2: edge-based — fallback per pagine a colonna
 *              singola, cerca gap puliti tra edges di regioni.
 *
 *   orderLayoutRegions utilizza gutter per ordinare le regioni
 *   in senso di lettura per colonna.
 */
import { centerOf, horizontalOverlap } from '../geometry.js';
import { runXYCutOnRegions } from './readingOrder.js';
import {
  COLUMN_OVERLAP_MIN,
  GUTTER_MIN_GAP_RATIO_LH,
  GUTTER_MIN_GAP_RATIO_W,
  GUTTER_MARGIN_L,
  GUTTER_MARGIN_R,
  GUTTER_MIN_PERSISTENCE,
  GUTTER_MIN_PERSISTENCE_NEAR,
  GUTTER_MIN_SUPPORT,
  GUTTER_MIN_SUPPORT_FEW,
  ASSIGN_CROSS_GUTTER_EPS_RATIO,
  ASSIGN_MIN_OVERLAP_RATIO,
} from '../../config/pipeline.js';

/**
 * Valuta la qualità di un gutter candidato divisore di colonne.
 * Divide la pagina in bande orizzontali (altezza = lineHeight)
 * e conta quante bande hanno regioni su entrambi i lati del
 * gutter e quante sono "pulite" (nessuna regione attraversa).
 *
 * @param {{ x1: number, x2: number }} gutter
 * @param {Array} regions
 * @param {number} lineHeight
 * @returns {{ persistence: number, leftSupport: number, rightSupport: number, informativeBands: number }}
 */
export function gutterPersistenceScore(gutter, regions, lineHeight) {
  const yMin = Math.min(...regions.map(r => r.y1));
  const yMax = Math.max(...regions.map(r => r.y2));
  const bandHeight = Math.max(Math.round(lineHeight), 12);
  const bandCount = Math.max(1, Math.ceil((yMax - yMin) / bandHeight));

  let informativeBands = 0, clearBands = 0;
  let leftSupportedBands = 0, rightSupportedBands = 0;

  for (let i = 0; i < bandCount; i++) {
    const by1 = yMin + i * bandHeight;
    const by2 = Math.min(yMax, by1 + bandHeight);
    const band = regions.filter(r => r.y1 < by2 && r.y2 > by1);
    if (band.length < 2) continue;

    informativeBands++;
    const crossesGap = band.some(r => r.x1 < gutter.x2 && r.x2 > gutter.x1);
    const hasLeft = band.some(r => r.x2 <= gutter.x1);
    const hasRight = band.some(r => r.x1 >= gutter.x2);

    if (!crossesGap) clearBands++;
    if (hasLeft) leftSupportedBands++;
    if (hasRight) rightSupportedBands++;
  }

  if (!informativeBands) {
    return { persistence: 0, leftSupport: 0, rightSupport: 0, informativeBands: 0 };
  }
  return {
    persistence: clearBands / informativeBands,
    leftSupport: leftSupportedBands / informativeBands,
    rightSupport: rightSupportedBands / informativeBands,
    informativeBands,
  };
}

/**
 * Raggruppa regioni in colonne per sovrapposizione x.
 * Due regioni sono nella stessa colonna se i loro x-range
 * si sovrappongono per almeno OVERLAP_MIN px.
 *
 * @param {{ x1: number, x2: number }[]} regions
 * @returns {Array[]}
 */
export function buildColumnGroups(regions) {
  if (!regions.length) return [];
  const sorted = [...regions].sort((a, b) => a.x1 - b.x1);
  const groups = [];
  let current = [sorted[0]];
  let groupX2 = sorted[0].x2;

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const overlap = groupX2 - r.x1;
    if (overlap > COLUMN_OVERLAP_MIN) {
      current.push(r);
      groupX2 = Math.max(groupX2, r.x2);
    } else {
      groups.push(current);
      current = [r];
      groupX2 = r.x2;
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Rileva i gutter verticali (confini tra colonne).
 *
 * Fase 1 (gruppi): buildColumnGroups separa le regioni per
 *   sovrapposizione x. Se 2+ gruppi, i loro confini sono gutter.
 *
 * Fase 2 (edge-based, fallback): cerca tutti i possibili gap
 *   tra x1/x2 delle regioni candidate, filtrando per larghezza,
 *   pulizia, persistenza su bande y e supporto.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} regions
 * @param {number} pageWidth
 * @param {number} lineHeight
 * @returns {Array}
 */
export function detectVerticalGutters(regions, pageWidth, lineHeight) {
  const candidates = regions.filter(r => (r.x2 - r.x1) < pageWidth * 0.82);
  if (candidates.length < 2) return [];

  // ─── Fase 1: gutter da colonne rilevate per sovrapposizione x ───
  const columnGroups = buildColumnGroups(candidates);
  if (columnGroups.length >= 2) {
    const gutters = [];
    for (let i = 0; i < columnGroups.length - 1; i++) {
      const g1_x2 = Math.max(...columnGroups[i].map(r => r.x2));
      const g2_x1 = Math.min(...columnGroups[i + 1].map(r => r.x1));
      const gap = g2_x1 - g1_x2;

      if (gap > 4) {
        gutters.push({ x1: g1_x2, x2: g2_x1, middle: (g1_x2 + g2_x1) / 2, width: gap });
      } else if (gap > -50) {
        const mid = Math.round((g1_x2 + g2_x1) / 2);
        const half = Math.max(2, Math.round(Math.max(-gap, 0) / 2) + 1);
        gutters.push({ x1: mid - half, x2: mid + half, middle: mid, width: half * 2 });
      }
    }

    if (gutters.length) {
      return gutters;
    }
  }

  // ─── Fase 2: edge-based detection (fallback) ───
  const minGap = Math.max(
    Math.round(lineHeight * GUTTER_MIN_GAP_RATIO_LH),
    Math.round(pageWidth * GUTTER_MIN_GAP_RATIO_W)
  );
  const edges = [...new Set(candidates.flatMap(r => [r.x1, r.x2]))].sort((a, b) => a - b);
  const gutters = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const x1 = edges[i], x2 = edges[i + 1];
    const width = x2 - x1;
    const middle = (x1 + x2) / 2;

    if (width < minGap) continue;
    if (middle < pageWidth * GUTTER_MARGIN_L || middle > pageWidth * (1 - GUTTER_MARGIN_R)) continue;
    if (candidates.some(r => r.x1 < x2 && r.x2 > x1)) continue;

    const leftCount = candidates.filter(r => r.x2 <= x1).length;
    const rightCount = candidates.filter(r => r.x1 >= x2).length;
    if (leftCount < 1 || rightCount < 1) continue;

    const score = gutterPersistenceScore({ x1, x2 }, candidates, lineHeight);
    if (score.informativeBands < 2) continue;

    const nearMargin = middle < pageWidth * 0.15 || middle > pageWidth * 0.85;
    const minPersistence = nearMargin ? GUTTER_MIN_PERSISTENCE_NEAR : GUTTER_MIN_PERSISTENCE;
    if (score.persistence < minPersistence) continue;

    const fewLeft = leftCount < 3;
    const fewRight = rightCount < 3;
    const minSupport = (fewLeft || fewRight) ? GUTTER_MIN_SUPPORT_FEW : GUTTER_MIN_SUPPORT;
    if (score.leftSupport < minSupport || score.rightSupport < minSupport) continue;

    gutters.push({ x1, x2, middle, width, ...score });
  }

  return gutters
    .sort((a, b) => b.width - a.width || b.persistence - a.persistence)
    .reduce((sel, g) => {
      if (!sel.some(other => g.x1 < other.x2 && g.x2 > other.x1)) sel.push(g);
      return sel;
    }, [])
    .sort((a, b) => a.x1 - b.x1);
}

/**
 * Costruisce le colonne a partire dai gutter.
 *
 * @param {{ x1: number, x2: number }[]} gutters
 * @param {number} pageWidth
 * @returns {Array}
 */
export function buildColumnsFromGutters(gutters, pageWidth) {
  const cols = [];
  let x1 = 0;
  for (const g of gutters) {
    if (g.x1 > x1) cols.push({ columnId: cols.length, x1, x2: g.x1 });
    x1 = g.x2;
  }
  if (x1 < pageWidth) cols.push({ columnId: cols.length, x1, x2: pageWidth });
  return cols;
}

/**
 * Verifica se una regione attraversa un gutter.
 * Usa una tolleranza (eps = lineHeight × 0.5).
 *
 * @param {{ x1: number, x2: number }} region
 * @param {{ x1: number, x2: number }} gutter
 * @param {number} lineHeight
 * @returns {boolean}
 */
export function crossesGutter(region, gutter, lineHeight) {
  const eps = Math.max(8, Math.round(lineHeight * ASSIGN_CROSS_GUTTER_EPS_RATIO));
  return region.x1 < gutter.x1 - eps && region.x2 > gutter.x2 + eps;
}

/**
 * Assegna una regione alla colonna con maggiore overlap.
 * Richiede overlap ≥ 70% della larghezza della regione.
 *
 * @param {{ x1: number, x2: number }} region
 * @param {Array} columns
 * @returns {number} columnId, -1 se nessuna
 */
export function assignRegionToColumn(region, columns) {
  const width = Math.max(1, region.x2 - region.x1);
  let best = null;
  let bestOverlap = 0;
  for (const col of columns) {
    const overlap = horizontalOverlap(region, col);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = col;
    }
  }
  if (!best || bestOverlap / width < ASSIGN_MIN_OVERLAP_RATIO) return -1;
  return best.columnId;
}

/**
 * Ordina le regioni per colonna: prima tutte le regioni della
 * colonna 0 (da sinistra), poi 1, ecc.
 * Ogni colonna è ordinata internamente da XY-Cut.
 * Le regioni "anchor" (che attraversano gutter) vengono
 * intervallate per posizione y.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} regions
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {number} lineHeight
 * @returns {Array}
 */
export function orderLayoutRegions(regions, pageWidth, pageHeight, lineHeight) {
  const gutters = detectVerticalGutters(regions, pageWidth, lineHeight);

  if (!gutters.length) {
    return runXYCutOnRegions(regions, pageWidth, pageHeight, lineHeight)
      .map(r => ({ ...r, columnId: 0 }));
  }

  const columns = buildColumnsFromGutters(gutters, pageWidth);
  const byColumn = columns.map(() => []);
  const anchors = [];

  for (const region of regions) {
    const attraversa = gutters.some(g => crossesGutter(region, g, lineHeight));
    if (attraversa) {
      anchors.push(region);
      continue;
    }
    const colId = assignRegionToColumn(region, columns);
    if (colId === -1) {
      anchors.push(region);
      continue;
    }
    byColumn[colId].push(region);
  }

  anchors.sort((a, b) => centerOf(a).y - centerOf(b).y);
  const output = [];
  let prevY = -Infinity;

  const appendBand = (fromY, toY) => {
    for (let cid = 0; cid < byColumn.length; cid++) {
      const seg = byColumn[cid].filter(r => {
        const y = centerOf(r).y;
        return y > fromY && y < toY;
      });
      if (seg.length) {
        output.push(...runXYCutOnRegions(seg, pageWidth, pageHeight, lineHeight)
          .map(r => ({ ...r, columnId: cid })));
      }
    }
  };

  for (const a of anchors) {
    const ay = centerOf(a).y;
    appendBand(prevY, ay);
    output.push({ ...a, columnId: -1 });
    prevY = ay;
  }
  appendBand(prevY, Infinity);

  return output;
}
