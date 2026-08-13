/**
 * Debug Report — dump testuale completo dello stato della pipeline.
 *
 * Pensato per il debug collaborativo: ogni componente ha un ID stabile,
 * mostrato ovunque nella UI e usato anche nel report, così l'utente può
 * riferirsi a un elemento specifico in chat (o incollare l'intero report):
 *
 *   Y#n   box YOLO finale (post filtro + merge, indice in yoloBoxesMerged)
 *   Yr#n  box YOLO raw (indice in yoloBoxes, prima di filtri/merge)
 *   D#n   riga di detection PP-OCRv6 (indice in detRects)
 *   R#n   regione gap tree (indice in boxes ordinati = readingOrder)
 *   F#n   frammento di output (indice globale in cropData)
 *
 * Esempio di segnalazione: "Y#3 è finito nella D#12 della R#1 ma sta
 * nella R#0" oppure "F#5 ha OCR empty ma il crop è leggibile".
 */
import {
  DEBUG, CONF_THRES, MERGE_VERTICAL_TOUCHING, COLUMN_LAYOUT,
  FILTER_DET_BEFORE_GAPTREE, SPLIT_VERTICAL_GAP_RATIO,
  OVERLAP_MERGE_IOU, OVERLAP_MERGE_OVERLAP, VERTICAL_GAP_THRESHOLD,
  VERTICAL_X_OVERLAP_RATIO, COLUMN_OVERLAP_MIN, SMALL_BOX_MIN_W_RATIO,
  SMALL_BOX_MIN_H_RATIO, UNCOVERED_MIN_SCORE, PADDLEOCR_VERSION,
  MAX_OCR_WIDTH, MIN_OCR_HEIGHT, OCR_OVERLAP,
  MODEL_FILE,
} from '../config/pipeline.js';
import { IS_MOBILE, DEVICE_MEMORY_GB, YOLO_MODEL_SIZE, RENDER_DPI, RENDER_MAX_DIM } from '../config/device.js';
import { currentFile, pageData, cropData, session } from '../app/state.js';
import { prepareDetRows, assignBoxesToRows, detLineHeight, keyOfDet } from '../domain/layout/rowAssignment.js';
import { copyReportBtn, downloadReportBtn, debugReportOut } from './dom.js';

/* ─── Formattazione ─── */

const R = v => Number.isFinite(v) ? Math.round(v) : '?';
const W = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : '?';

/**
 * Riga compatto di un box: coordinate, dimensioni e score.
 * @param {{x1:number,y1:number,x2:number,y2:number,score?:number}} b
 * @returns {string}
 */
function boxStr(b) {
  return `[${R(b.x1)},${R(b.y1)}→${R(b.x2)},${R(b.y2)}] w=${R(b.x2 - b.x1)} h=${R(b.y2 - b.y1)}` +
    ` score=${Number.isFinite(b.score) ? b.score.toFixed(2) : '1.00'}`;
}

/**
 * Risolve l'ID Y# (indice nel merged array) del box YOLO di un frammento.
 * - Frammento da item (riga): item.yoloBoxes[frag.yoloIndex].index.
 * - Frammento uncovered: frag.yoloIndex È già l'indice del box.
 *
 * @param {{regionOrder:number,itemIndex:number,yoloIndex:number}} frag
 * @param {Object} pd — pageData della pagina del frammento
 * @returns {number|null}
 */
export function resolveFragmentYoloId(frag, pd) {
  try {
    if (!pd) return null;
    const region = (pd.boxes || []).find(x => x.readingOrder === frag.regionOrder);
    if (!region) return null;
    if (Array.isArray(region.items) && region.items.length) {
      const item = region.items[frag.itemIndex];
      const yb = item?.yoloBoxes?.[frag.yoloIndex];
      if (!yb) return null;
      return Number.isFinite(yb.index) ? yb.index : frag.yoloIndex;
    }
    return frag.yoloIndex; // uncovered: yoloIndex è l'indice del box
  } catch {
    return null;
  }
}

/**
 * Descrizione OCR compatta di un frammento.
 * @param {Object} f
 * @returns {string}
 */
function ocrCompact(f) {
  const status = f.ocr?.status || 'pending';
  const engine = f.ocr?.engine || 'PaddleOCR';
  const conf = f.ocr?.confidence != null ? ` conf=${Number(f.ocr.confidence).toFixed(2)}` : '';
  const src = f.ocr?.source ? ` src=${f.ocr.source}` : '';
  const err = f.ocr?.error ? ` err="${f.ocr.error}"` : '';
  const flag = status === 'empty' || status === 'error' ? ' ⚠️' : '';
  return `OCR[${engine}, ${status}${conf}${src}${err}]${flag}`;
}

/* ─── Costruzione report ─── */

/**
 * Costruisce il report completo della pipeline in formato testo.
 * @param {File|null} file
 * @param {Array} frags
 * @param {Array} pages
 * @returns {string}
 */
export function buildDebugReport(file, frags, pages) {
  const L = [];
  const push = (...a) => L.push(a.join(''));
  const LINE = '─'.repeat(80);
  const THICK = '═'.repeat(80);

  // ── Header / ambiente ──
  push(THICK);
  push('MARKOUT DEBUG REPORT');
  push(`Generated: ${new Date().toLocaleString('en-GB', { hour12: false })} · debug build: ${DEBUG}`);
  if (file) push(`File: ${file.name} · ${(file.size / 1024).toFixed(1)} KB · ${pages.length} pages processed`);
  push('');
  push('Environment:');
  push(`  URL: ${typeof location !== 'undefined' ? location.href : '?'}`);
  push(`  UA: ${navigator.userAgent}`);
  push(`  Mobile: ${IS_MOBILE} · deviceMemory: ${DEVICE_MEMORY_GB} GB · cores: ${navigator.hardwareConcurrency ?? '?'}`);
  push(`  YOLO backend: ${session.yoloProvider || '— (released/not detected)'}`);
  push(`  OCR backend: ${session.ocrProvider || '—'} · lingua: ${session.ocrLang || '?'} (${PADDLEOCR_VERSION})`);
  push('', 'Config (config/pipeline.js):');
  push(`  MODEL_FILE=${MODEL_FILE} · MODEL_SIZE=${YOLO_MODEL_SIZE} · RENDER ${RENDER_DPI}dpi/max${RENDER_MAX_DIM}px · CONF_THRES=${CONF_THRES}`);
  push(`  FILTER_DET_BEFORE_GAPTREE=${FILTER_DET_BEFORE_GAPTREE} · MERGE_VERTICAL_TOUCHING=${MERGE_VERTICAL_TOUCHING} · COLUMN_LAYOUT=${COLUMN_LAYOUT}`);
  push(`  SPLIT_VERTICAL_GAP_RATIO=${SPLIT_VERTICAL_GAP_RATIO} · OVERLAP_MERGE_IOU=${OVERLAP_MERGE_IOU} OVERLAP=${OVERLAP_MERGE_OVERLAP}`);
  push(`  VERTICAL_GAP_THRESHOLD=${VERTICAL_GAP_THRESHOLD} X_OVERLAP=${VERTICAL_X_OVERLAP_RATIO} · COLUMN_OVERLAP_MIN=${COLUMN_OVERLAP_MIN}`);
  push(`  SMALL_BOX_MIN_W=${SMALL_BOX_MIN_W_RATIO} H=${SMALL_BOX_MIN_H_RATIO} · UNCOVERED_MIN_SCORE=${UNCOVERED_MIN_SCORE}`);
  push(`  OCR: MAX_OCR_WIDTH=${MAX_OCR_WIDTH} MIN_OCR_HEIGHT=${MIN_OCR_HEIGHT} OVERLAP=${OCR_OVERLAP}`);

  // ── Sezione per pagina ──
  for (const pd of pages) {
    const yRaw = pd.yoloBoxes || [];
    const yMerged = pd.yoloBoxesMerged || pd.yoloBoxes || [];
    const detRects = pd.detRects || [];
    const regions = pd.boxes || [];
    const s = pd.displayScale || 1;
    const slopeDeg = Number.isFinite(pd.pageSlope) && Math.abs(pd.pageSlope) > 0.0001
      ? ` (${(Math.atan(pd.pageSlope) * 180 / Math.PI).toFixed(2)}°)` : '';
    const pageFrags = frags.filter(f => f.page === pd.pageNum);
    const ocrDone = pageFrags.filter(f => f.ocr?.status === 'done').length;
    const ocrEmpty = pageFrags.filter(f => f.ocr?.status === 'empty').length;
    const ocrErr = pageFrags.filter(f => f.ocr?.status === 'error').length;
    const ocrPending = pageFrags.filter(f => f.ocr?.status === 'pending').length;

    push('', THICK);
    push(`PAGE ${pd.pageNum}`);
    push(`  canvas=${pd.canvas ? `${pd.canvas.width}×${pd.canvas.height}` : '—'} displayScale=${W(pd.displayScale ?? 1)} slope=${W(pd.pageSlope ?? 0)}${slopeDeg}`);
    push(`  YOLO raw=${yRaw.length} → merged=${yMerged.length} · det=${detRects.length} · regions=${regions.length} (${regions.filter(r => r._fallback).length} fallback) · fragments=${pageFrags.length}`);
    if (pageFrags.length) {
      push(`  OCR: done=${ocrDone} empty=${ocrEmpty} error=${ocrErr} pending=${ocrPending}`);
    }

    // Assegnazione box → riga (stesso criterio della pipeline)
    const prepped = prepareDetRows(detRects, pd.canvas, s);
    const lh = detLineHeight(detRects);
    const { boxRow, orphans } = assignBoxesToRows(yMerged, prepped, pd.pageSlope || 0, lh);
    const rowOf = new Map();
    for (const [b, rp] of boxRow) rowOf.set(b._yIdx, rp);

    // riga → regione (tramite chiave coordinate dei detItems)
    const regionOfDet = new Map();
    regions.forEach((reg, ri) => {
      for (const d of (reg.detItems || [])) {
        const k = keyOfDet(d);
        if (!regionOfDet.has(k)) regionOfDet.set(k, ri);
      }
    });

    // YOLO merged con riga/regione assegnata
    push('', `YOLO merged (${yMerged.length}):`);
    for (let i = 0; i < yMerged.length; i++) {
      const b = yMerged[i];
      const rp = rowOf.get(b._yIdx);
      let tag = '→ no row';
      if (rp) {
        const k = keyOfDet(rp.d);
        const regTag = regionOfDet.has(k) ? ` · R#${regionOfDet.get(k)}` : ' · fuori regione';
        tag = `→ D#${rp.di}${regTag}`;
      }
      push(`  Y#${i} ${boxStr(b)} ${tag}`);
    }

    // YOLO raw (prima di filtri/merge)
    if (yRaw.length && yRaw !== yMerged) {
      push('', `YOLO raw (${yRaw.length}):`);
      yRaw.forEach((b, i) => push(`  Yr#${i} ${boxStr(b)}`));
    }

    // Righe di detection con box assegnati
    push('', `Detection (${detRects.length} rows):`);
    for (let i = 0; i < detRects.length; i++) {
      const d = detRects[i];
      const ids = [...rowOf.entries()].filter(([, r]) => r && r.di === i).map(([yi]) => `Y#${yi}`);
      const inside = ids.length ? ` ← ${ids.join(',')}` : '';
      const slope = Number.isFinite(d.slope) ? ` slope=${W(d.slope)}` : '';
      const fused = (d.y2 - d.y1) > 1.5 * lh ? ' ⚠️fusa' : '';
      push(`  D#${i} ${boxStr(d)}${slope}${fused}${inside}`);
    }

    // Regioni gap tree
    push('', `Gap-tree regions (${regions.length}):`);
    regions.forEach((reg, ri) => {
      const col = Number.isFinite(reg.columnId) ? ` col=${reg.columnId}` : '';
      const yIds = (reg.containedYOLOs || []).map(yi => `Y#${yi}`);
      const detIds = (reg.detItems || [])
        .map(d => {
          const k = keyOfDet(d);
          const found = detRects.findIndex(x => keyOfDet(x) === k);
          return found >= 0 ? `D#${found}` : null;
        })
        .filter(Boolean);
      const fall = reg._fallback ? ' ⚠️fallback' : '';
      const ro = reg.readingOrder ?? '?';
      push(`  R#${ri} ro=${ro}${col} ${boxStr(reg)}` +
        ` src=${reg.sourceCount ?? 0} items=${(reg.items || []).length}${fall}`);
      if (yIds.length) push(`      YOLO: ${yIds.join(' ')}`);
      if (detIds.length) push(`      det: ${detIds.join(' ')}`);
      (reg.items || []).forEach((item, ii) => {
        const slope = Number.isFinite(item.slope) ? ` slope=${W(item.slope)}` : '';
        const yb = (item.yoloBoxes || []).map(y => `Y#${Number.isFinite(y.index) ? y.index : '?'}`);
        push(`      item#${ii} ${boxStr(item)}${slope} Y=[${yb.join(',')}]`);
      });
    });

    // Orfani
    if (orphans.length) {
      push('', `YOLO boxes without detection row (orphans): ${orphans.map(b => `Y#${b._yIdx ?? '?'}`).join(' ')}`);
    }
  }

  // ── Frammenti finali (output) ──
  push('', THICK);
  push(`FRAMMENTI (${frags.length}) — ordine di output (markdown)`);
  frags.forEach((f, i) => {
    const pd = pages.find(p => p.pageNum === f.page);
    const yid = pd ? resolveFragmentYoloId(f, pd) : null;
    const rid = Number.isFinite(f.regionOrder) ? f.regionOrder : '?';
    push(`F#${i} p.${f.page} r.${rid} i.${f.itemIndex ?? '?'} y.${f.yoloIndex ?? '?'} → Y#${yid ?? '?'} ${boxStr(f)}`);
    push(`   ${ocrCompact(f)}`);
    if (f.text) push(`   text: «${f.text}»`);
  });

  // ── Guida ID ──
  push('', THICK);
  push('Component IDs: Y#n=final YOLO box · Yr#n=raw YOLO box · D#n=detection row · R#n=gap-tree region · F#n=output fragment');
  push('To report an issue, cite the components (e.g. "Y#3 missing", "D#12 fused", "R#1 wrong order", "F#5 wrong OCR").');
  push(THICK);

  return L.join('\n');
}

/**
 * Renderizza il report nella tab dedicata.
 */
export function renderDebugReport(file, frags, pages) {
  if (!debugReportOut) return;
  debugReportOut.textContent = buildDebugReport(file, frags, pages);
}

/* ─── Copia / download ─── */

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/**
 * Inizializza i pulsanti Copia Report / Scarica Report.
 */
export function initDebugReport() {
  copyReportBtn?.addEventListener('click', async () => {
    const text = buildDebugReport(currentFile, cropData, pageData);
    const ok = await copyText(text);
    flash(copyReportBtn, ok ? '✅ Report copiato!' : '❌ Seleziona il testo dalla tab Report');
  });

  downloadReportBtn?.addEventListener('click', () => {
    const text = buildDebugReport(currentFile, cropData, pageData);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentFile?.name || 'report').replace(/\.pdf$/i, '') + '-debug-report.txt';
    a.click();
    URL.revokeObjectURL(url);
  });
}