/**
 * Cluster & Order — pipeline principale di raggruppamento e ordinamento.
 *
 * Flusso:
 *   1. Detection PP-OCRv6 → bounding box
 *   2. Filtra detection per overlap YOLO (se FILTER_DET_BEFORE_GAPTREE)
 *   3. GapTree → regioni
 *   4. Assegna YOLO a regioni per centro (regione più piccola)
 *   5. Raccogli YOLO non coperti → uncovered
 *   6. Merge uncovered (se MERGE_VERTICAL_TOUCHING)
 *   7. Split gap verticali larghi (splitRegionsByVerticalGap)
 *   8. Ordina per colonna (orderLayoutRegions) o XY-Cut++
 *   9. Raffina ogni regione (refineItemsInRegions)
 */
import { median, centerOf, mergeAllElements, unionBoxes } from '../geometry.js';
import { gapTreeMergeAndOrder } from './gapTree.js';
import { orderByReadingOrder } from './readingOrder.js';
import { orderLayoutRegions, buildColumnGroups } from './columns.js';
import {
  FILTER_DET_BEFORE_GAPTREE,
  MERGE_VERTICAL_TOUCHING,
  SPLIT_VERTICAL_GAP_RATIO,
  COLUMN_LAYOUT,
  UNCOVERED_MIN_SCORE,
} from '../../config/pipeline.js';

/**
 * Assegna ogni box YOLO alla regione più specifica (area minima)
 * che contiene il suo centro. Restituisce keptRegions (con
 * containedYOLOs) e uncoveredYOLOs.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} yoloBoxes
 * @param {{ x1: number, y1: number, x2: number, y2: number }[]} regions
 * @returns {{ keptRegions: Array, uncoveredYOLOs: Array }}
 */
export function assignYolosToRegions(yoloBoxes, regions) {
  const yoloHit = new Array(yoloBoxes.length).fill(false);
  const yoloAssignment = new Array(yoloBoxes.length).fill(-1);

  for (let yi = 0; yi < yoloBoxes.length; yi++) {
    const yb = yoloBoxes[yi];
    const cx = (yb.x1 + yb.x2) / 2;
    const cy = (yb.y1 + yb.y2) / 2;
    let bestIdx = -1;
    let bestArea = Infinity;

    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri];
      if (cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2) {
        const area = (r.x2 - r.x1) * (r.y2 - r.y1);
        if (area < bestArea) { bestArea = area; bestIdx = ri; }
      }
    }

    if (bestIdx >= 0) {
      yoloAssignment[yi] = bestIdx;
      yoloHit[yi] = true;
    }
  }

  const keptRegions = regions.map((r, ri) => {
    const covered = [];
    for (let yi = 0; yi < yoloBoxes.length; yi++) {
      if (yoloAssignment[yi] === ri) covered.push(yi);
    }
    return { ...r, containedYOLOs: covered };
  });

  const uncoveredYOLOs = [];
  for (let yi = 0; yi < yoloBoxes.length; yi++) {
    if (!yoloHit[yi]) {
      const yb = yoloBoxes[yi];
      const score = yb.score || 0.5;
      // Filtra uncovered con score troppo basso (falsi positivi)
      if (score < UNCOVERED_MIN_SCORE) continue;
      uncoveredYOLOs.push({
        x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2,
        score, _fallback: true,
        _nativeText: yb._nativeText,
        containedYOLOs: [yi],
      });
    }
  }

  return { keptRegions, uncoveredYOLOs };
}

/**
 * Log dettagliato di regioni e YOLO assegnati.
 *
 * @param {Array} keptRegions
 * @param {Array} gaptreeResult
 * @param {Array} yoloBoxes
 */
export function logRegions(keptRegions, gaptreeResult, yoloBoxes) {
  for (const region of keptRegions) {
    const items = region.items || [];
    const yoloIndices = region.containedYOLOs || [];
    const yoloDetail = yoloIndices.map(yi => {
      const yb = yoloBoxes[yi];
      return `Y[${yi}](${yb.x1.toFixed(0)},${yb.y1.toFixed(0)}→${yb.x2.toFixed(0)},${yb.y2.toFixed(0)})`;
    }).join(', ');
    const itemDetail = items.map((b, idx) =>
      `D${idx}(${b.x1.toFixed(0)},${b.y1.toFixed(0)}→${b.x2.toFixed(0)},${b.y2.toFixed(0)})`
    ).join(', ');
    console.log(`[LAYOUT] Regione: x=${region.x1.toFixed(0)}-${region.x2.toFixed(0)} y=${region.y1.toFixed(0)}-${region.y2.toFixed(0)} items=${items.length} yolo=${yoloIndices.length}`);
    if (itemDetail) console.log(`  items: ${itemDetail}`);
    if (yoloDetail) console.log(`  yolo:  ${yoloDetail}`);
  }
  const scartate = gaptreeResult.length - keptRegions.length;
  console.log(`[LAYOUT] Regioni tenute: ${keptRegions.length}${scartate > 0 ? `, scartate: ${scartate}` : ''}`);
}

/**
 * Pendenza (dy/dx) della riga di lettura di un quadrilatero di detection.
 * Usa il lato più lungo quasi-orizzontale: per le righe di testo inclinate
 * (foto di pagina ruotata) è l'asse del baseline, non la diagonale.
 *
 * @param {Array<[number, number]>} poly — 4 vertici [tl, tr, br, bl] o qualsiasi ordine
 * @returns {number|null}
 */
function polySlope(poly) {
  if (!Array.isArray(poly) || poly.length < 4) return null;
  const pts = poly.map(p => ({ x: p[0], y: p[1] }));
  let best = null;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) continue;
    if (!best || len > best.len) best = { len, dx, dy };
  }
  if (!best) return null;
  // solo righe quasi-orizzontali (lettura sinistra→destra);
  // un quadrato centrale (dx<dy) viene scartato
  if (Math.abs(best.dx) < Math.abs(best.dy) * 0.35) return null;
  return best.dy / best.dx;
}

/**
 * Costruisce un item finale (riga visiva) da una banda di frammenti YOLO
 * già ordinata col metodo di lettura (lex) su x.
 *
 * @param {Array} band — frammenti YOLO ({ x1,y1,x2,y2,score,index,_nativeText,... })
 * @returns {Object}
 */
function makeRowItem(band, row = null) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, score = 0;
  let rowYd = Infinity;
  for (const b of band) {
    x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    score = Math.max(score, b.score ?? 0);
    rowYd = Math.min(rowYd, b.y1d ?? b.y1);
  }
  return {
    x1, y1, x2, y2,
    score,
    _finalRow: true,
    _rowYd: rowYd,
    yoloBoxes: band.map(b => ({
      index: b.index, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
      score: b.score, _nativeText: b._nativeText,
    })),
    // Quadrilatero e pendenza della riga di detection d'origine:
    // servono ai crop "tagliati sul testo" (banda = vertici del quad).
    poly: (row && Array.isArray(row.poly) && row.poly.length >= 4) ? row.poly : undefined,
    slope: row ? row.slope : undefined,
  };
}

/**
 * Coordinate x "deskewed" per l'ordine di lettura lungo la riga.
 * Proietta il centro del frammento sull'asse di lettura (rotazione
 * inversa approssimata per piccoli angoli): su una riga con pendenza
 * s, x' = x + s·y cresce monotonamente con la posizione di lettura.
 *
 * @param {{ cx: number, cy: number }} f — frammento con centro deskewed
 * @param {number} s — pendenza di pagina
 * @returns {number}
 */
function readingX(f, s) {
  return f.cx + s * f.cy;
}

/**
 * Assegna ogni frammento YOLO alla riga di detection dominante.
 *
 * Criterio: ogni box YOLO è associato ESCLUSIVAMENTE alla riga che
 * ne contiene la MAGGIORE AREA — nel piano del CROP della singola
 * riga: per ogni riga r il box e la riga vengono trasformati col suo
 * deskew (y' = y − s·x con s = slope della riga), quindi l'area
 * contenuta (xOv·yOv) è quella visibile nel crop che verrà prodotto.
 * A PARITÀ di area (distacco < 5% dell'area del box: differenze che
 * derivano solo da sfori di bordo di pochi pixel, non da quanto la
 * riga copre davvero l'evidenziazione) vince la riga col CENTRO più
 * vicino a quello del box (nel suo piano): caso reale pg2, det#63 vs
 * det#64 (slope −2.1°/−2.2°): box [835,1735→1377,1767] contenuto da
 * entrambe, aree 16448 vs 16352 (0.6%: 3px di sforo a destra) → il
 * centro del box sta a 3.2px dal centro det#63 e 29.6px da det#64 →
 * det#63. Il distacco è NETTO (> 5%) quando la copertura cambia
 * davvero (es. box#k: 16170 vs 13860 = 14% → area, det#14).
 * Le righe "fuse" partecipano come le altre (la detection È la riga).
 * Se nessuna riga si sovrappone al box, si usa la più vicina per
 * centro entro 1.5×lineHeight, altrimenti niente (banda fallback).
 *
 * @param {Array} frags — box YOLO { index, x1, x2, y1, y2, cx, ... }
 * @param {Array} rows — righe di detection { x1, x2, y1, y2, cx, sl, ... }
 * @param {number} lhDet — altezza riga di riferimento
 * @returns {Map} index → riga
 */
export function assignFragsToRows(frags, rows, lhDet) {
  const PARITY_AREA_RATIO = 0.05; // parità: distacco < 5% dell'area del box
  const rowOf = new Map();
  for (const f of frags) {
    const fc = Number.isFinite(f.cx) ? f.cx : (f.x1 + f.x2) / 2;
    const areaBox = Math.max(1, (f.x2 - f.x1) * (f.y2 - f.y1));
    // 1. Riga con la maggiore AREA del box contenuta, nel piano del
    //    crop di quella riga (y' = y − sl·x); a parità (entro ±5%
    //    dell'area del box) vince il centro più vicino
    let best = null;
    let bestArea = -Infinity;
    let bestDist = Infinity;
    for (const r of rows) {
      if (!Number.isFinite(r.x1) || !Number.isFinite(r.y1)) continue;
      const sr = Number.isFinite(r.sl) ? r.sl : 0;
      const rc = Number.isFinite(r.cx) ? r.cx : (r.x1 + r.x2) / 2;
      const rY1 = r.y1 - sr * rc, rY2 = r.y2 - sr * rc;
      const fY1 = f.y1 - sr * fc, fY2 = f.y2 - sr * fc;
      const xOv = Math.min(f.x2, r.x2) - Math.max(f.x1, r.x1);
      if (xOv <= 0) continue;
      const yOv = Math.min(fY2, rY2) - Math.max(fY1, rY1);
      if (yOv <= 0) continue;
      const area = xOv * yOv;
      const dist = Math.abs((fY1 + fY2) / 2 - (rY1 + rY2) / 2);
      const isNetWin = !best || area > bestArea + PARITY_AREA_RATIO * areaBox;
      const isParityWin = best && area >= bestArea - PARITY_AREA_RATIO * areaBox && dist < bestDist;
      if (isNetWin || isParityWin) {
        if (isNetWin) { bestArea = area; }
        bestDist = dist;
        best = r;
      }
    }
    // 2. Fallback: riga più vicina per centro (nel suo piano), entro 1.5×lh
    if (!best) {
      let bestDist = Infinity;
      for (const r of rows) {
        if (!Number.isFinite(r.x1) || !Number.isFinite(r.y1)) continue;
        const sr = Number.isFinite(r.sl) ? r.sl : 0;
        const rc = Number.isFinite(r.cx) ? r.cx : (r.x1 + r.x2) / 2;
        const rY1 = r.y1 - sr * rc, rY2 = r.y2 - sr * rc;
        const fY = (f.y1 - sr * fc + f.y2 - sr * fc) / 2;
        const dist = Math.abs(fY - (rY1 + rY2) / 2);
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      if (bestDist > lhDet * 1.5) best = null;
    }

    if (best) rowOf.set(f.index, best);
  }
  return rowOf;
}

/**
 * Raggruppa righe in probabili colonne interne alla regione, con
 * la stessa logica di buildColumnGroups (overlap x). Conservativo:
 * richiede ≥ 4 righe totali, ≥ 2 righe per colonna e un gap reale
 * tra gruppi. Una regione a colonna singola (anche con indentazioni
 * forti) resta un solo gruppo.
 *
 * @param {Array} rows — righe con x1/x2
 * @param {number} lhDet
 * @returns {Array|null} — gruppi (colonne) o null
 */
function detectRegionColumns(rows, lhDet) {
  if (rows.length < 4) return null;
  const groups = buildColumnGroups(rows);
  if (groups.length < 2) return null;

  const span = Math.max(...rows.map(r => r.x2)) - Math.min(...rows.map(r => r.x1));
  const minGap = Math.max(10, Math.round(lhDet * 1.2), Math.round(span * 0.01));

  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length < 2) return null;
    if (i > 0) {
      const prevX2 = Math.max(...groups[i - 1].map(r => r.x2));
      const curX1 = Math.min(...groups[i].map(r => r.x1));
      if (curX1 - prevX2 < minGap) return null;
    }
  }
  return groups;
}

/**
 * Ordina le righe di una regione in ordine di lettura robusto.
 *
 * - Se la regione contiene colonne evidenti → column-major (tutta la
 *   colonna di sinistra, poi la successiva), coerente con l'ordine
 *   delle regioni (orderLayoutRegions).
 * - Altrimenti ordine naturale per bordo superiore deskewed (y1d),
 *   tie per x1: un box alto "ponte" non deve spostare il proprio top
 *   a metà ordine (l'ancora è il top, non il centro). Righe della
 *   stessa linea visiva hanno y1d quasi identici → restano adiacenti
 *   e in ordine sinistra→destra.
 *
 * @param {Array} rows — righe con x1/x2/y1d/y2d (più _frags)
 * @param {number} lhDet
 * @returns {Array}
 */
function orderRegionRows(rows, lhDet) {
  if (rows.length < 2) return rows.slice();

  const cols = detectRegionColumns(rows, lhDet);
  if (cols) {
    const out = [];
    for (const col of cols) {
      col.sort((a, b) => a.y1d - b.y1d || a.x2 - b.x2 || a.x1 - b.x1);
      out.push(...col);
    }
    return out;
  }

  // Ordine naturale: top→bottom per y1d deskewed, tie per x1. L'ancora
  // è il bordo superiore, non il centro: un box alto "ponte" non deve
  // spostare il proprio top a metà ordine. Le righe di una stessa riga
  // visiva (spezzate dalla detection) hanno y1d quasi identici → restano
  // adiacenti e in ordine sinistra→destra.
  return [...rows].sort((a, b) => a.y1d - b.y1d || a.x1 - b.x1);
}

/**
 * Raffina le regioni: ordina righe e assegna YOLO a livello di riga.
 *
 * @param {Array} ordered — regioni ordinate
 * @param {Array} yoloBoxes
 * @param {number} lineHeight
 * @param {number} [pageSlope=0] — pendenza di pagina (deskew) per righe inclinate
 * @returns {Array}
 */
/**
 * Appiattisce l'ordinamento delle regioni (gap-tree) in una lista piatta
 * di box YOLO con readingOrder progressivo: per ogni regione in ordine,
 * gli items (righe/bande) in ordine — e dentro ogni item i box già
 * ordinati per asse di lettura; gli elementi senza items (uncovered)
 * contribuiscono coi loro containedYOLOs ordinati per (readingX, x1).
 * È l'output della modalità produzione (lite): il chiamante la usa a
 * fine elaborazione per NON trattenere la struttura detection in
 * memoria (restano solo ordine + coordinate).
 *
 * @param {Array} ordered — regioni/elementi ordinati (con .items / .containedYOLOs)
 * @param {Array} yoloBoxes — box YOLO originali (per gli uncovered)
 * @param {number} pageSlope — slope di pagina (ordine readingX degli uncovered)
 * @returns {Array} — [{ x1, y1, x2, y2, score, readingOrder }]
 */
export function flattenOrderedBoxes(ordered, yoloBoxes, pageSlope = 0) {
  const flat = [];
  let ro = 0;
  for (const el of ordered) {
    const items = el.items || [];
    if (items.length) {
      for (const item of items) {
        for (const yb of (item.yoloBoxes || [])) {
          flat.push({
            x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2,
            score: yb.score ?? el.score ?? 0.5,
            readingOrder: ro++,
          });
        }
      }
    } else {
      const els = (el.containedYOLOs || []).map(ci => yoloBoxes[ci]).filter(Boolean);
      els.sort((a, b) => readingX(a, pageSlope) - readingX(b, pageSlope) || a.x1 - b.x1 || a.y1 - b.y1);
      for (const yb of els) {
        flat.push({
          x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2,
          score: yb.score ?? el.score ?? 0.5,
          readingOrder: ro++,
        });
      }
    }
  }
  return flat;
}

export function refineItemsInRegions(ordered, yoloBoxes, lineHeight, pageSlope = 0) {
  for (const region of ordered) {
    const items = region.items;
    if (!items || items.length === 0) continue;

    const yoloIndices = region.containedYOLOs || [];

    // Conserva le detection originali per debug/bbox
    region.detItems = [...items].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);

    if (!yoloIndices.length) {
      region.items = region.detItems;
      continue;
    }

    // 1. Deskew: scansioni leggermente ruotate (+/−1–2°). La pendenza
    //    di pagina rimuove l'effetto moltiplicando la x per la pendenza:
    //    i frammenti della stessa riga tornano allineati su y; le righe
    //    adiacenti restano a un passo pieno (anti-fusione delle bande).
    const s = Number.isFinite(pageSlope) ? pageSlope : 0;
    const frags = yoloIndices
      .map(i => {
        const b = yoloBoxes[i];
        if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.y1)) return null;
        const cx = (b.x1 + b.x2) / 2;
        const sh = s * cx;
        return {
          ...b, index: i, cx,
          cy: (b.y1 + b.y2) / 2 - sh,
          y1d: b.y1 - sh,
          y2d: b.y2 - sh,
        };
      })
      .filter(Boolean);

    if (!frags.length) {
      region.items = region.detItems;
      continue;
    }

    // 2. Righe di lettura = righe di output del modello di detection
    //    (region.detItems), deskewate col pageSlope. Il flag "fused"
    //    (h > ~1.5×lineHeight: il modello ha unito 2+ righe) resta
    //    solo informativo: la detection È la riga, anche se fusa.
    const lhDet = (lineHeight && lineHeight > 0)
      ? lineHeight
      : (median(region.detItems.map(d => d.y2 - d.y1)) || 12);
    const FUSED_RATIO = 1.5;
    const rows = region.detItems.map(d => {
      const cx = (d.x1 + d.x2) / 2;
      const sh = s * cx;
      return {
        ...d, cx,
        sl: Number.isFinite(d.slope) ? d.slope : s,
        y1d: d.y1 - sh,
        y2d: d.y2 - sh,
        fused: (d.y2 - d.y1) > FUSED_RATIO * lhDet,
      };
    });

    // 3. Assegna ogni frammento YOLO ESCLUSIVAMENTE alla riga con la
    //    maggiore area contenuta (tie → centro più vicino). Tieni solo
    //    le righe che ricevono ≥ 1 frammento (le altre righe di
    //    detection non evidenziate spariscono).
    const rowOf = assignFragsToRows(frags, rows, lhDet);

    const byRow = new Map();
    const assigned = new Set();
    for (const f of frags) {
      const r = rowOf.get(f.index);
      if (!r) continue;
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r).push(f);
      assigned.add(f.index);
    }

    // 4. Righe con ≥1 YOLO + eventuali bande fallback in un'unica
    //    lista, ordinata con il criterio comune (righe → colonne → x).
    const rowList = [...byRow.keys()].map(r => ({
      ...r, _frags: byRow.get(r).slice(), _fallback: false,
    }));

    // 4. I box YOLO non assegnati (orfani) vengono aggiunti alla
    //    lista delle detection e trattati come righe singole: entrano
    //    nell'ordinamento della regione con lo stesso criterio
    //    (top→bottom per y deskewed, poi sinistra→destra per x).
    const unassigned = frags.filter(f => !assigned.has(f.index));
    for (const f of unassigned) {
      rowList.push({
        x1: f.x1, x2: f.x2,
        y1d: f.y1d, y2d: f.y2d,
        _frags: [f],
        _fallback: true,
      });
    }

    // 5. Ordine finale righe (colonne interne a column-major) e box
    //    in riga da sinistra a destra lungo l'asse di lettura.
    const orderedRows = orderRegionRows(rowList, lhDet);
    const regionItems = [];
    for (const row of orderedRows) {
      const band = row._frags.slice().sort(
        (a, b) => readingX(a, s) - readingX(b, s) || a.x1 - b.x1 || a.y1 - b.y1
      );
      regionItems.push(makeRowItem(band, row));
    }

    region.items = regionItems;
  }

  return ordered;
}

/**
 * Divide regioni con gap verticali interni larghi (>3×lineHeight)
 * in sotto-regioni.
 *
 * @param {Array} elements — regioni con .items e .containedYOLOs
 * @param {number} lineHeight
 * @param {Array} yoloBoxes
 * @returns {Array}
 */
export function splitRegionsByVerticalGap(elements, lineHeight, yoloBoxes) {
  if (!lineHeight || lineHeight <= 0) return elements;
  const MIN_GAP = Math.round(lineHeight * SPLIT_VERTICAL_GAP_RATIO);
  const result = [];
  let changed = false;

  for (const el of elements) {
    const items = el.items;
    if (!items || items.length < 2) {
      result.push(el);
      continue;
    }

    const sorted = [...items].sort((a, b) => a.y1 - b.y1);
    const groups = [];
    let cur = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y1 - sorted[i - 1].y2 > MIN_GAP) {
        groups.push(cur);
        cur = [];
      }
      cur.push(sorted[i]);
    }
    groups.push(cur);

    if (groups.length <= 1) {
      result.push(el);
      continue;
    }

    changed = true;
    const yoloIndices = el.containedYOLOs || [];
    const subRegions = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const sub = unionBoxes(group);
      // Estendi y1 della prima sotto-regione al bordo superiore
      // della regione originale, e y2 dell'ultima al bordo inferiore,
      // così i box YOLO nei margini non vengono persi
      if (gi === 0) sub.y1 = Math.min(sub.y1, el.y1);
      if (gi === groups.length - 1) sub.y2 = Math.max(sub.y2, el.y2);
      sub.items = group;
      sub.sourceCount = group.length;
      sub.readingOrder = el.readingOrder;
      sub.score = el.score;
      sub.containedYOLOs = yoloIndices.filter(yi => {
        const yb = yoloBoxes[yi];
        const cx = (yb.x1 + yb.x2) / 2;
        const cy = (yb.y1 + yb.y2) / 2;
        return cx >= sub.x1 && cx <= sub.x2 && cy >= sub.y1 && cy <= sub.y2;
      });
      subRegions.push(sub);
    }

    // Assegna i box YOLO che cadono nel gap tra gruppi alla
    // sotto-regione più vicina (per centro y)
    const allAssigned = new Set();
    for (const sub of subRegions) {
      for (const yi of (sub.containedYOLOs || [])) allAssigned.add(yi);
    }
    for (const yi of yoloIndices) {
      if (allAssigned.has(yi)) continue;
      const yb = yoloBoxes[yi];
      const cy = (yb.y1 + yb.y2) / 2;
      let bestSub = subRegions[0];
      let bestDist = Infinity;
      for (const sub of subRegions) {
        const subCy = (sub.y1 + sub.y2) / 2;
        const dist = Math.abs(cy - subCy);
        if (dist < bestDist) { bestDist = dist; bestSub = sub; }
      }
      if (bestSub) {
        if (!bestSub.containedYOLOs) bestSub.containedYOLOs = [];
        bestSub.containedYOLOs.push(yi);
      }
    }

    for (const sub of subRegions) result.push(sub);

    console.log(`[LAYOUT] Regione [${el.x1.toFixed(0)},${el.y1.toFixed(0)}-${el.x2.toFixed(0)},${el.y2.toFixed(0)}] spezzata in ${groups.length} sotto-regioni (gap >${MIN_GAP}px)`);
  }

  if (changed) {
    console.log(`[LAYOUT] Divisione verticale: ${elements.length} → ${result.length} elementi`);
  }
  return changed ? result : elements;
}

/**
 * Pipeline principale di clustering e ordinamento per una pagina.
 *
 * @param {Array} yoloBoxes — box YOLO già filtrati e merged (o highlight nativi)
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {HTMLCanvasElement|null} [pageCanvas=null]
 * @param {number} [pageNum=0]
 * @param {Function|null} [detModel=null] — PaddleOCR detection model
 * @param {Object|null} [cv=null] — PaddleOCR cv module
 * @param {Array|null} [nativeDetRects=null] — righe di testo native (da PDF textContent)
 *        Se fornito, sostituisce la detection PP-OCRv6.
 * @param {boolean} [lite=false] — modalità produzione: la pipeline gira
 *        identica (stesso ordine, stessa struttura per i crop), ma nel
 *        risultato non esce nulla di pesante: detRects è vuoto (serve
 *        solo ai tab debug) e il chiamante appiattisce i box con
 *        flattenOrderedBoxes, lasciando la struttura al GC.
 * @returns {Promise<{ boxes: Array, detRects: Array, pageSlope: number }>}
 */
export async function clusterAndOrderBoxes(
  yoloBoxes, pageWidth, pageHeight,
  pageCanvas = null, pageNum = 0,
  detModel = null, cv = null,
  nativeDetRects = null,
  lite = false
) {
  // 1. Detection: usa righe native se disponibili, altrimenti PP-OCRv6
  let allDetRects = [];
  let detAvailable = false;

  if (nativeDetRects && nativeDetRects.length > 0) {
    allDetRects = nativeDetRects;
    detAvailable = true;
    console.log(`[NATIVE] Page ${pageNum}: ${allDetRects.length} text lines from PDF content`);
  } else if (pageCanvas && detModel && cv) {
    try {
      const results = await detModel.predict(cv, [cv.imread(pageCanvas)], {
        boxThresh: 0.3,
        unclipRatio: 1.5,
      });
      const detBoxes = results[0]?.boxes || [];
      allDetRects = detBoxes.map(d => ({
        x1: Math.min(...d.poly.map(p => p[0])),
        y1: Math.min(...d.poly.map(p => p[1])),
        x2: Math.max(...d.poly.map(p => p[0])),
        y2: Math.max(...d.poly.map(p => p[1])),
        score: d.score || 0.95,
        // pendenza della riga rilevata (bordo di lettura del quadrilatero):
        // usata per il deskew di pagina (scansioni inclinate)
        slope: polySlope(d.poly),
        // quadrilatero originale della detection: usato per i crop
        // "tagliati sul testo" (esclude le righe adiacenti)
        poly: d.poly,
      }));
      detAvailable = allDetRects.length > 0;
      console.log(`[OCR-DET] Page ${pageNum}: ${allDetRects.length} text lines detected`);
      const _hh = allDetRects.map(d => `${d.y1.toFixed(0)}-${d.y2.toFixed(0)}(${Math.round(d.y2-d.y1)})`).join(' ');
      console.log(`[DET-ALL] Page ${pageNum}: ${_hh}`);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      console.warn(`[OCR-DET] Page ${pageNum}: detection failed (${msg}) — falling back to sorted YOLO boxes`);
    }
  }

  if (!detAvailable || !allDetRects.length) {
    return {
      boxes: yoloBoxes.slice().sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        .map((b, i) => ({ ...b, readingOrder: i })),
      detRects: lite ? [] : allDetRects,
      pageSlope: 0,
    };
  }

  // 2. Normalizza detection
  let valid = allDetRects.map(b => ({
    ...b,
    x1: Math.max(0, Math.min(b.x1, pageWidth)),
    y1: Math.max(0, Math.min(b.y1, pageHeight)),
    x2: Math.max(0, Math.min(b.x2, pageWidth)),
    y2: Math.max(0, Math.min(b.y2, pageHeight)),
  })).filter(b => (b.x2 - b.x1) > 0 && (b.y2 - b.y1) > 0);

  if (!valid.length) {
    return {
      boxes: yoloBoxes.slice().sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        .map((b, i) => ({ ...b, readingOrder: i })),
      detRects: lite ? [] : allDetRects,
      pageSlope: 0,
    };
  }

  // Pendenza di pagina: mediana delle pendenze delle righe di detection
  // (0 per righe native, che sono sempre allineate agli assi). Viene
  // usata sia per l'ordinamento sia per i crop deskewed dei frammenti.
  const slopes = valid.map(b => b.slope).filter(v => Number.isFinite(v) && Math.abs(v) < 0.35);
  const pageSlope = slopes.length ? median(slopes) : 0;
  if (Math.abs(pageSlope) > 0.001) {
    console.log(`[LAYOUT] Page ${pageNum}: skew stimato ${(Math.atan(pageSlope) * 180 / Math.PI).toFixed(2)}°`);
  }

  // 3. GapTree: raggruppa detection in regioni di layout.
  //    Mantenimento di una detection: contiene il CENTRO di almeno un
  //    box YOLO (valutato nel piano deskewed y' = y − s·x). Il centro
  //    è il punto di riferimento dell'evidenziazione: con un modello
  //    di detection accurato ogni box ha la sua riga.
  function yoloCenterInside(det, yb, s) {
    const cx = (yb.x1 + yb.x2) / 2;
    const cy = (yb.y1 + yb.y2) / 2 - s * cx;
    if (cx < det.x1 || cx > det.x2) return false;
    const sh = s * (det.x1 + det.x2) / 2;
    return cy >= det.y1 - sh && cy <= det.y2 - sh;
  }

  let detectionsForGapTree;
  if (FILTER_DET_BEFORE_GAPTREE && !nativeDetRects) {
    // Con YOLO: mantieni solo le righe col centro di un box highlight dentro
    detectionsForGapTree = valid.filter(d => yoloBoxes.some(yb => yoloCenterInside(d, yb, Number.isFinite(d.slope) ? d.slope : pageSlope)));
    console.log(`[LAYOUT] Page ${pageNum}: ${valid.length} boxes, ${detectionsForGapTree.length} with YOLO center inside`);
  } else if (nativeDetRects) {
    // Con dati nativi: passa TUTTE le righe testo a GapTree.
    // assignYolosToRegions filtrerà poi le regioni senza highlight.
    detectionsForGapTree = valid;
    console.log(`[NATIVE] Page ${pageNum}: ${valid.length} text lines, ${yoloBoxes.length} highlights`);
  } else {
    detectionsForGapTree = valid;
  }

  let gaptreeResult;
  if (detectionsForGapTree.length) {
    gaptreeResult = gapTreeMergeAndOrder(detectionsForGapTree, pageWidth, pageHeight);
    console.log(`[LAYOUT] GapTree pagina ${pageNum}: ${detectionsForGapTree.length} detection → ${gaptreeResult.length} regioni`);
  } else {
    gaptreeResult = [];
  }

  if (!gaptreeResult.length) {
    return {
      boxes: yoloBoxes.slice().sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        .map((b, i) => ({ ...b, readingOrder: i })),
      detRects: allDetRects,
      pageSlope,
    };
  }

  const regionCount = gaptreeResult.length;

  // 4. Assegna YOLO alle regioni + uncovered
  const { keptRegions, uncoveredYOLOs } = assignYolosToRegions(yoloBoxes, gaptreeResult);
  logRegions(keptRegions, gaptreeResult, yoloBoxes);

  if (uncoveredYOLOs.length) {
    for (const uy of uncoveredYOLOs) {
      console.log(`[LAYOUT] YOLO scoperto: [${uy.x1.toFixed(0)},${uy.y1.toFixed(0)}-${uy.x2.toFixed(0)},${uy.y2.toFixed(0)}] w=${(uy.x2 - uy.x1).toFixed(0)} h=${(uy.y2 - uy.y1).toFixed(0)}`);
    }
  }

  // 5. Merge + Split + Ordina
  let allElements = [...keptRegions, ...uncoveredYOLOs];

  if (MERGE_VERTICAL_TOUCHING && allElements.length >= 2) {
    const merged = mergeAllElements(allElements);
    if (merged.length !== allElements.length) {
      console.log(`[LAYOUT] Merge YOLO scoperti: ${allElements.length} → ${merged.length} elementi`);
      allElements = merged;
    }
  }

  // Split vertical gaps
  const lh = median(valid.map(b => b.y2 - b.y1)) || 12;
  allElements = splitRegionsByVerticalGap(allElements, lh, yoloBoxes);

  // Ordina per colonne o XY-Cut puro
  let ordered = null;

  if (COLUMN_LAYOUT && allElements.length >= 2) {
    ordered = orderLayoutRegions(allElements, pageWidth, pageHeight, lh);
  } else {
    ordered = orderByReadingOrder(allElements, pageWidth, pageHeight, lh);
  }

  if (!ordered || !ordered.length) {
    console.warn(`[LAYOUT] Page ${pageNum}: ordering failed (${allElements.length} elements), fallback y/x`);
    return {
      boxes: allElements
        .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        .map((el, i) => ({ ...el, readingOrder: i })),
      detRects: lite ? [] : allDetRects,
      pageSlope,
    };
  }

  // Raffina ogni regione
  ordered = refineItemsInRegions(ordered, yoloBoxes, lh, pageSlope);

  // Applica reading order finale
  const medSrc = keptRegions.length ? median(keptRegions.map(r => r.sourceCount || 1)) : 0;
  const nCols = ordered.filter(r => r.columnId !== undefined && r.columnId !== null).length > 0
    ? new Set(ordered.filter(r => r.columnId >= 0).map(r => r.columnId)).size
    : 0;

  const result = ordered.map((el, idx) => {
    const w = el.x2 - el.x1, h = el.y2 - el.y1;
    return {
      ...el,
      readingOrder: idx,
      _area: w * h,
      _aspectRatio: h > 0 ? w / h : 0,
      _debug: {
        pageWidth,
        pageHeight,
        minCutThreshold: 12,
        columns: nCols,
        columnLayout: COLUMN_LAYOUT,
        detCount: allDetRects.length,
        regionCount: regionCount,
        yoloCount: yoloBoxes.length,
        keptCount: keptRegions.length,
        uncoveredCount: uncoveredYOLOs.length,
        sourceCount: el.sourceCount || (el._fallback ? 0 : 1),
      },
    };
  });

  const modeStr = COLUMN_LAYOUT ? `colonne=${nCols}` : 'XY-Cut++ puro';
  console.log(`[LAYOUT] Page ${pageNum}: ${result.length} elements (${keptRegions.length} regions, ${uncoveredYOLOs.length} uncovered) — ${modeStr}, ${pageWidth}x${pageHeight}`);
  // Modalità produzione (lite): la pipeline gira identica al debug e la
  // struttura (regioni/items/poly per il crop per-riga) resta disponibile
  // al chiamante per generare i frammenti. L'unica differenza: NON esce
  // nulla di pesante — detRects [] (servono solo ai tab debug) — e il
  // chiamante appiattisce i box a fine uso (flattenOrderedBoxes), così
  // la struttura di detection muore col GC e la memoria resta libera.
  if (lite) {
    return { boxes: result, detRects: [], pageSlope };
  }

  return { boxes: result, detRects: allDetRects, pageSlope };
}