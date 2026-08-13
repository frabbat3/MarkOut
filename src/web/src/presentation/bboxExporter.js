/**
 * BBox Exporter — export delle coordinate dei bounding box in formato testo.
 */
import { downloadBBoxBtn } from './dom.js';

/**
 * Genera un file di testo con le coordinate dei bounding box divisi per pagina.
 *
 * @param {Array} pageData
 * @returns {string}
 */
export function buildBBoxText(pageData) {
  const lines = [];

  for (const pd of pageData) {
    const pw = pd.canvas.width;
    const ph = pd.canvas.height;
    const boxes = pd.boxes;
    const debug = boxes[0]?._debug;

    lines.push(`=== Page ${pd.pageNum} ===`);
    lines.push(`Page: ${pw}×${ph} px`);
    if (debug) {
      lines.push(`PP-OCRv6 detections: ${debug.detCount} → GapTree regions: ${debug.regionCount}`);
      lines.push(`YOLO input: ${debug.yoloCount} → keptRegions: ${debug.keptCount}, uncovered: ${debug.uncoveredCount}`);
      lines.push(`columnLayout: ${debug.columnLayout}, columns detected: ${debug.columns}`);
    }
    lines.push('minCutThreshold: 12 px');
    lines.push('');

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const x1 = b.x1.toFixed(1), y1 = b.y1.toFixed(1), x2 = b.x2.toFixed(1), y2 = b.y2.toFixed(1);
      const w = (b.x2 - b.x1).toFixed(1), h = (b.y2 - b.y1).toFixed(1);
      const cx = ((b.x1 + b.x2) / 2).toFixed(1), cy = ((b.y1 + b.y2) / 2).toFixed(1);
      const score = (b.score ?? '?').toFixed(2);
      const area = b._area?.toFixed(0) ?? (parseFloat(w) * parseFloat(h)).toFixed(0);
      const ar = b._aspectRatio?.toFixed(2) ?? (parseFloat(h) > 0 ? (parseFloat(w) / parseFloat(h)) : 0).toFixed(2);
      const ro = b.readingOrder ?? i;

      const fallback = b._fallback ? ' ⚠️' : '';
      const yoloInfo = b.containedYOLOs && b.containedYOLOs.length > 0
        ? ` YOLO#${b.containedYOLOs.join(',#')}` : '';
      const src = b.sourceCount ? ` src=${b.sourceCount}` : '';
      const col = b.columnId !== undefined ? ` col=${b.columnId}` : '';

      lines.push(`[${x1},${y1} → ${x2},${y2}]` +
        ` w=${w} h=${h} area=${area} ar=${ar}` +
        ` c=(${cx},${cy})` +
        ` ro=${ro} score=${score}${fallback}${yoloInfo}${src}${col}`);

      // Dettaglio items
      const items = b.items || [];
      if (items.length) {
        for (let di = 0; di < items.length; di++) {
          const d = items[di];
          lines.push(`  ├─ D${di} [${d.x1.toFixed(0)},${d.y1.toFixed(0)}→${d.x2.toFixed(0)},${d.y2.toFixed(0)}]` +
            ` w=${(d.x2 - d.x1).toFixed(0)} h=${(d.y2 - d.y1).toFixed(0)}` +
            ` score=${(d.score ?? '?').toFixed(2)}`);
        }
      }

      // Dettaglio YOLO
      const ybxs = b.containedYOLOs || [];
      if (ybxs.length) {
        const yboxes = pd.yoloBoxesMerged || [];
        for (const yi of ybxs) {
          const yb = yboxes[yi];
          if (!yb) { lines.push(`  ├─ Y#${yi} (non disponibile)`); continue; }
          lines.push(`  ├─ Y#${yi} [${yb.x1.toFixed(0)},${yb.y1.toFixed(0)}→${yb.x2.toFixed(0)},${yb.y2.toFixed(0)}]` +
            ` w=${(yb.x2 - yb.x1).toFixed(0)} h=${(yb.y2 - yb.y1).toFixed(0)}` +
            ` score=${(yb.score ?? '?').toFixed(2)}`);
        }
      }
    }

    // Riepilogo pagina
    const areas = boxes.map(b => b._area || ((b.x2 - b.x1) * (b.y2 - b.y1))).filter(a => a > 0);
    if (areas.length) {
      const sorted = areas.slice().sort((a, b) => a - b);
      const min = sorted[0], max = sorted[sorted.length - 1];
      const mid = Math.floor(sorted.length / 2);
      const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      lines.push(`area: min=${min.toFixed(0)} med=${med.toFixed(0)} max=${max.toFixed(0)}`);
    }
    const srcCounts = boxes.map(b => b.sourceCount || 0).filter(c => c > 0);
    if (srcCounts.length) {
      const avg = (srcCounts.reduce((a, c) => a + c, 0) / srcCounts.length).toFixed(1);
      lines.push(`sourceCount: avg=${avg} across ${srcCounts.length} regions`);
    }

    // Elenco YOLO raw e merged
    const yboxes = pd.yoloBoxes || [];
    const yboxesM = pd.yoloBoxesMerged || [];
    if (yboxes.length) {
      lines.push(`YOLO raw (${yboxes.length}) → merged (${yboxesM.length}):`);
      for (let yi = 0; yi < yboxes.length; yi++) {
        const yb = yboxes[yi];
        lines.push(`  Y#${yi} [${yb.x1.toFixed(0)},${yb.y1.toFixed(0)}→${yb.x2.toFixed(0)},${yb.y2.toFixed(0)}]` +
          ` w=${(yb.x2 - yb.x1).toFixed(0)} h=${(yb.y2 - yb.y1).toFixed(0)}` +
          ` score=${(yb.score ?? '?').toFixed(2)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Inizializza il listener per download BBox.
 */
export function initBBoxExport() {
  downloadBBoxBtn.addEventListener('click', async () => {
    const { currentFile, pageData } = await import('../app/state.js');
    if (!currentFile || !pageData.length) return;
    const txt = buildBBoxText(pageData);
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.name.replace(/\.pdf$/i, '') + '-bounds.txt';
    a.click();
    URL.revokeObjectURL(url);
  });
}