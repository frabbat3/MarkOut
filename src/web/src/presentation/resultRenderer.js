/**
 * Result Renderer — visualizzazione dei risultati (bounding box, crops, YOLO).
 */
import { pdfViewer, cropContainer, yoloFragsView, rowsView, allRowsView, markdownOut, resultMeta, viewTabs, result } from './dom.js';
import { hideAll } from './dom.js';
import { buildMarkdown } from './markdownExporter.js';
import { deskewCropParams, extractDeskewedCropCanvas } from '../domain/geometry.js';
import { prepareDetRows, assignBoxesToRows, detLineHeight, keyOfDet } from '../domain/layout/rowAssignment.js';
import { SHOW_OVERLAY, DEBUG } from '../config/pipeline.js';
import { attachInspectable, showInspector } from './debugInspector.js';
import { renderDebugReport, resolveFragmentYoloId } from './debugReport.js';

let tabBtns = viewTabs?.querySelectorAll('.tab-btn') ?? [];

/**
 * Mostra il risultato finale.
 *
 * @param {File|null} currentFile
 * @param {Array} cropData
 * @param {Array} pageData
 */
export async function showResult(currentFile, cropData, pageData) {
  hideAll();
  if (!cropData.length) {
    const noHighlights = document.getElementById('noHighlights');
    if (noHighlights) noHighlights.classList.remove('hidden');
    return;
  }

  const pages = new Set(cropData.map(c => c.page));
  if (resultMeta) {
    resultMeta.textContent = `${cropData.length} fragments · ${pages.size} pages — ${currentFile?.name || ''}`;
  }
  if (markdownOut) {
    markdownOut.textContent = await buildMarkdown(cropData, currentFile?.name || '');
  }

  // Schede debug (bbox, crops, yolo, rows, report) — attive solo in modalità DEBUG
  if (DEBUG) {
    renderCrops(cropData, pageData);
    renderYoloFrags(pageData);
    renderRows(pageData);
    renderAllRows(pageData);
    renderBBoxPages(pageData, cropData);
    renderDebugReport(currentFile, cropData, pageData);
  }
  result.classList.remove('hidden');
}

/**
 * Renderizza le griglie di crop.
 * Ogni card ha un ID stabile (F#n globale, R# regione, Y# box YOLO)
 * e apre l'ispettore JSON al click.
 *
 * @param {Array} cropData
 * @param {Array} pageData
 */
function renderCrops(cropData, pageData) {
  if (!cropContainer) return;
  cropContainer.innerHTML = '';

  for (let i = 0; i < cropData.length; i++) {
    const c = cropData[i];
    const div = document.createElement('div');
    div.className = 'crop-item';

    if (c.canvas) {
      // Frammento con crop canvas (YOLO+OCR)
      const img = document.createElement('img');
      img.src = c.canvas.toDataURL();
      img.alt = `Highlight p.${c.page}`;
      div.appendChild(img);
    } else if (c.text) {
      // Frammento senza canvas (testo già disponibile) — mostra il testo direttamente
      const txt = document.createElement('div');
      txt.className = 'crop-text-only';
      txt.textContent = c.text;
      div.appendChild(txt);
    } else {
      // Nessun contenuto — salta
      continue;
    }

    // ID condivisi con il report: F#n (globale), Y# (box), R# (regione)
    const pd = (pageData || []).find(p => p.pageNum === c.page);
    const yid = pd ? resolveFragmentYoloId(c, pd) : null;
    const rid = Number.isFinite(c.regionOrder) ? c.regionOrder : null;
    const status = c.ocr?.status || '?';
    const warn = (status === 'error' || status === 'empty') ? ' ⚠️' : '';

    const label = document.createElement('span');
    label.className = 'crop-label';
    let t = `F#${i} · p.${c.page} · R#${rid ?? '?'}`;
    if (yid !== null && yid !== undefined) t += ` · Y#${yid}`;
    t += ` · ${(c.score * 100).toFixed(0)}%`;
    if (Number.isFinite(c.x1) && Number.isFinite(c.x2)) {
      t += ` [${Math.round(c.x1)},${Math.round(c.y1)}→${Math.round(c.x2)},${Math.round(c.y2)}]`;
    }
    t += ` · ${c.ocr?.engine || 'native'}(${status})${warn}`;
    if (c.text) t += `\n«${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}»`;
    label.textContent = t;
    div.appendChild(label);

    // Click → ispeziona il frammento completo (coordinate + OCR + errori)
    const { canvas, ...rest } = c;
    attachInspectable(div, `F#${i} — frammento p.${c.page} r.${c.regionOrder ?? '?'} i.${c.itemIndex ?? '?'} y.${c.yoloIndex ?? '?'}`, {
      id: `F#${i}`,
      yoloId: yid !== null && yid !== undefined ? `Y#${yid}` : null,
      regionId: rid !== null ? `R#${rid}` : null,
      ...rest,
    });
    cropContainer.appendChild(div);
  }
}

/**
 * Renderizza le pagine con bounding box.
 * Ogni componente viene etichettato con il suo ID stabile (D#/Y#/R#)
 * e il click sul canvas ispeziona il punto (box YOLO, riga detection,
 * regione gap tree).
 *
 * @param {Array} pageData
 * @param {Array} cropData
 */
function renderBBoxPages(pageData, cropData) {
  if (!pdfViewer) return;
  pdfViewer.innerHTML = '';

  for (const pd of pageData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'bbox-page';

    // Riepilogo degli stadi della pipeline per questa pagina
    const yRaw = (pd.yoloBoxes || []).length;
    const yMerged = (pd.yoloBoxesMerged || pd.yoloBoxes || []).length;
    const detN = (pd.detRects || []).length;
    const regs = pd.boxes || [];
    const fallN = regs.filter(b => b._fallback).length;
    const frags = (cropData || []).filter(f => f.page === pd.pageNum);
    const ocrBad = frags.filter(f => f.ocr && (f.ocr.status === 'error' || f.ocr.status === 'empty')).length;
    const slopeDeg = Number.isFinite(pd.pageSlope)
      ? (Math.atan(pd.pageSlope) * 180 / Math.PI).toFixed(2) : '?';

    const label = document.createElement('div');
    label.className = 'bbox-page-label';
    label.textContent =
      `Page ${pd.pageNum} — YOLO ${yRaw}→${yMerged} · det ${detN} · regioni ${regs.length}` +
      (fallN ? ` (⚠️${fallN} fallback)` : '') +
      ` · frammenti ${frags.length}` + (ocrBad ? ` (⚠️${ocrBad} OCR)` : '') +
      ` · slope ${slopeDeg}° — click canvas: inspect`;
    wrapper.appendChild(label);

    const cvs = pd.canvas;  // ← riusa il canvas originale (ora compresso), evita la copia
    if (!cvs) continue;
    cvs.style.cssText = 'max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.12);cursor:pointer;';
    const ctx = cvs.getContext('2d');
    const s = pd.displayScale || 1;  // fattore di scala per overlay (canvas compresso 50%)
    wrapper.appendChild(cvs);

    // Click → ispeziona il componente sotto il puntatore
    cvs.addEventListener('click', ev => {
      const rect = cvs.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = (cvs.width / rect.width) / s;
      const sy = (cvs.height / rect.height) / s;
      const x = (ev.clientX - rect.left) * sx;
      const y = (ev.clientY - rect.top) * sy;
      const inside = (b, px, py) => px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2;

      const hit = { x, y, yolo: null, det: null, region: null };
      const ym = pd.yoloBoxesMerged || [];
      for (let i = 0; i < ym.length; i++) {
        if (inside(ym[i], x, y)) { hit.yolo = { _id: `Y#${i}`, ...ym[i] }; break; }
      }
      const dr = pd.detRects || [];
      for (let i = 0; i < dr.length; i++) {
        if (inside(dr[i], x, y)) { hit.det = { _id: `D#${i}`, ...dr[i] }; break; }
      }
      const boxes = pd.boxes || [];
      for (let i = 0; i < boxes.length; i++) {
        if (inside(boxes[i], x, y)) { hit.region = { _id: `R#${i}`, ro: boxes[i].readingOrder, ...boxes[i] }; break; }
      }

      const hits = [hit.yolo, hit.det, hit.region].filter(Boolean);
      const pos = `(${Math.round(x)},${Math.round(y)})`;
      if (!hits.length) {
        showInspector(`Page ${pd.pageNum} @ ${pos} — no component`, { click: { x, y }, page: pd.pageNum });
        return;
      }
      // Ispeziona il più specifico (YOLO) + gli altri come contesto
      const pick = hit.yolo || hit.det || hit.region;
      showInspector(`Page ${pd.pageNum} @ ${pos} — ${hits.map(h => h._id).join(' · ')}`, {
        click: { x, y },
        ...hit,
      });
    });

    // Debug overlay
    if (SHOW_OVERLAY) {
      // Detection PP-OCRv6 in azzurro (coordinate scalate) + ID D#
      const dr = pd.detRects || [];
      for (let i = 0; i < dr.length; i++) {
        const d = dr[i];
        ctx.fillStyle = 'rgba(0, 200, 255, 0.12)';
        ctx.fillRect(d.x1 * s, d.y1 * s, (d.x2 - d.x1) * s, (d.y2 - d.y1) * s);
        ctx.strokeStyle = 'rgba(0, 200, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.strokeRect(d.x1 * s, d.y1 * s, (d.x2 - d.x1) * s, (d.y2 - d.y1) * s);
        ctx.setLineDash([]);
        ctx.font = '10px sans-serif';
        ctx.fillStyle = 'rgba(0, 140, 200, 0.9)';
        ctx.shadowColor = 'rgba(255,255,255,0.9)';
        ctx.shadowBlur = 3;
        ctx.fillText(`D#${i}`, d.x1 * s + 2, d.y1 * s + 10);
        ctx.shadowBlur = 0;
      }
      // YOLO merged in verde + ID Y#
      const ym = pd.yoloBoxesMerged || [];
      for (let i = 0; i < ym.length; i++) {
        const y = ym[i];
        ctx.fillStyle = 'rgba(0, 220, 80, 0.10)';
        ctx.fillRect(y.x1 * s, y.y1 * s, (y.x2 - y.x1) * s, (y.y2 - y.y1) * s);
        ctx.strokeStyle = 'rgba(0, 220, 80, 0.40)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(y.x1 * s, y.y1 * s, (y.x2 - y.x1) * s, (y.y2 - y.y1) * s);
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = 'rgba(0, 150, 60, 0.95)';
        ctx.shadowColor = 'rgba(255,255,255,0.9)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Y#${i}`, y.x1 * s + 2, y.y1 * s + 22);
        ctx.shadowBlur = 0;
      }
      // Legenda (non scalata — UI chrome a posizione fissa)
      const lx = 10, ly = 20;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(lx, ly, 250, 66);
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 1;
      ctx.strokeRect(lx, ly, 250, 66);
      ctx.fillStyle = 'rgba(0, 200, 255, 0.35)';
      ctx.fillRect(lx + 6, ly + 6, 16, 10);
      ctx.fillStyle = '#333';
      ctx.fillText(`PP-OCRv6 det (${dr.length}) — D#`, lx + 28, ly + 5);
      ctx.fillStyle = 'rgba(0, 220, 80, 0.40)';
      ctx.fillRect(lx + 6, ly + 24, 16, 10);
      ctx.fillStyle = '#333';
      ctx.fillText(`YOLO merged (${ym.length}) — Y#`, lx + 28, ly + 23);
      ctx.fillStyle = '#666';
      ctx.fillText('click: inspect component', lx + 6, ly + 50);
    }

    // Box evidenziati con ordine di lettura
    const maxFontSize = Math.max(28, Math.min(72, Math.round(Math.min(cvs.width, cvs.height) / 18)));

    for (let i = 0; i < (pd.boxes || []).length; i++) {
      const box = pd.boxes[i];
      if (!box) continue;
      const x = box.x1 * s, y = box.y1 * s, w = (box.x2 - box.x1) * s, h = (box.y2 - box.y1) * s;
      const isFallback = box._fallback;
      const order = (box.readingOrder ?? 0) + 1;

      if (!isFallback) {
        ctx.fillStyle = 'rgba(255, 230, 0, 0.25)';
        ctx.fillRect(x, y, w, h);
      }

      ctx.strokeStyle = isFallback ? 'rgba(255, 107, 53, 0.6)' : '#FF6B35';
      ctx.lineWidth = Math.max(2, Math.round(Math.min(cvs.width, cvs.height) / 400));
      if (isFallback) ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      if (isFallback) ctx.setLineDash([]);

      // Order number
      const orderStr = String(order);
      const numSize = Math.max(18, Math.min(maxFontSize, Math.min(w, h) * 0.55));
      ctx.font = `bold ${numSize}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const nx = x + w - 4, ny = y + 4;
      ctx.fillStyle = '#D32F2F';
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillText(orderStr, nx, ny);
      ctx.shadowBlur = 0;

      // Score label con ID regione (R#n = readingOrder)
      const infoText = `R#${i} ${(box.score * 100).toFixed(0)}%${isFallback ? ' ⚠️' : ''}`;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const tw = ctx.measureText(infoText).width;
      let bx = x + 2, by = y - 2;
      if (by < 12) by = y + h - 2;
      ctx.fillStyle = isFallback ? 'rgba(136,136,136,0.85)' : 'rgba(255,107,53,0.85)';
      ctx.beginPath();
      ctx.roundRect(bx - 3, by - 11, tw + 6, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(infoText, bx + 1, by - 1);
    }

    pdfViewer.appendChild(wrapper);
  }
}

/**
 * Renderizza i frammenti YOLO.
 *
 * @param {Array} pageData
 */
function renderYoloFrags(pageData) {
  if (!yoloFragsView) return;
  yoloFragsView.innerHTML = '';

  for (const pd of pageData) {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '20px';

    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;padding:8px 0;font-size:0.95rem;';
    const regs = (pd.boxes || []).length;
    const yN = (pd.yoloBoxesMerged || pd.yoloBoxes || []).length;
    label.textContent = `Page ${pd.pageNum} — frammenti YOLO (F#) per regioni (R#) · ${regs} regioni · ${yN} box merged`;
    wrapper.appendChild(label);

    const cvs = document.createElement('canvas');
    cvs.width = pd.canvas.width;
    cvs.height = pd.canvas.height;
    cvs.style.cssText = 'max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.12);';
    const ctx = cvs.getContext('2d');
    ctx.drawImage(pd.canvas, 0, 0);
    const s = pd.displayScale || 1;  // fattore di scala (canvas compresso 50%)

    let fragIndex = 0;
    for (const region of pd.boxes) {
      const items = region.items || [];
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        const yoloBoxes = item.yoloBoxes || [];
        for (let yi = 0; yi < yoloBoxes.length; yi++) {
          const yb = yoloBoxes[yi];
          const x = yb.x1 * s, y = yb.y1 * s, w = (yb.x2 - yb.x1) * s, h = (yb.y2 - yb.y1) * s;

          ctx.fillStyle = 'rgba(255, 230, 0, 0.25)';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = '#FF6B35';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);

          const orderStr = `F#${fragIndex} · Y#${yb.index ?? '?'}`;
          const numSize = Math.max(12, Math.min(24, Math.min(w, h) * 0.35));
          ctx.font = `bold ${numSize}px sans-serif`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'top';
          ctx.fillStyle = '#D32F2F';
          ctx.shadowColor = 'rgba(255,255,255,0.9)';
          ctx.shadowBlur = 4;
          ctx.fillText(orderStr, x + w - 3, y + 3);
          ctx.shadowBlur = 0;

          fragIndex++;
        }
      }
    }

    wrapper.appendChild(cvs);
    yoloFragsView.appendChild(wrapper);

    // Click sul canvas → dati pagina completi
    const { canvas: _cv, ...pdRest } = pd;
    attachInspectable(cvs, `Page ${pd.pageNum} — dati pagina (${regs} regioni)`, pdRest);
  }
}


/**
 * Renderizza le righe di detection RAW, divise in blocchi (le regioni
 * finali del gap tree, nell'ordine di lettura assegnato dalla pipeline
 * tramite readingOrder) e al loro interno in ordine top->bottom deskewed.
 *
 * Ogni riga è un rettangolo di detection così come prodotto dalla
 * detection (nessuna fusione/banding). Flusso di estrazione: tutte
 * le righe vengono normalizzate (deskew + crop), poi filtrate per
 * quelle che hanno almeno un box YOLO assegnato con il criterio
 * della pipeline (assignFragsToRows): massima sovrapposizione
 * verticale deskewed (ov/fh) con x-overlap, fallback riga più
 * vicina entro 1.5×lh. Le righe che superano il filtro ma non
 * appartengono a nessuna regione vengono mostrate in un blocco extra.
 *
 * @param {Array} pageData
 */
/**
 * Assegnazione box ↔ riga e altezza riga di riferimento: vedi
 * domain/layout/rowAssignment.js (condivise con il debug report).
 */

// Vista riga per le card: rp + box assegnati + flag "fusa" (>1.5×lh,
// la detection ha unito 2+ righe di testo) mostrato nella label.
function makeRowView(rp, inside, lhDet) {
  return { ...rp, inside, fused: (rp.d.y2 - rp.d.y1) > 1.5 * lhDet };
}

function makeRowCardAppender(pd, s) {
  const appendCard = (grid, row) => {
      const d = row.d;
      const card = document.createElement('div');
      card.className = 'crop-item';

      const w = row.pbox.x2 - row.pbox.x1, h = row.pbox.y2 - row.pbox.y1;
      const rowCanv = (pd.canvas && w >= 4 && h >= 4)
        ? extractDeskewedCropCanvas(pd.canvas, row.pbox, d.slope, 2, row.cropP)
        : null;
      const p = rowCanv ? deskewCropParams(row.pbox, d.slope, 2, row.cropP) : null;

      if (rowCanv && p) {
        const ctx = rowCanv.getContext('2d');
        ctx.setTransform(1, -p.s, 0, 1, p.dx, p.dy);

        ctx.strokeStyle = 'rgba(0, 150, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (row.quad) {
          for (let i = 0; i < row.quad.length; i++) {
            const X = row.quad[i][0] + p.dx;
            const Y = row.quad[i][1] - p.s * row.quad[i][0] + p.dy;
            if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
          }
          ctx.closePath();
        } else {
          ctx.rect(row.pbox.x1 - 0.5, row.pbox.y1 - 0.5, row.pbox.x2 - row.pbox.x1 + 1, row.pbox.y2 - row.pbox.y1 + 1);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        row.inside.forEach((b, bi) => {
          const bx = b.x1 * s, by = b.y1 * s, bw = (b.x2 - b.x1) * s, bh = (b.y2 - b.y1) * s;
          ctx.fillStyle = 'rgba(255, 107, 53, 0.20)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = '#FF6B35';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx, by, bw, bh);
        });
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.font = 'bold 11px sans-serif';
        row.inside.forEach((b, bi) => {
          const bx = (b.x1 * s) + p.dx;
          const by = (b.y1 * s) - p.s * (b.x1 * s) + p.dy;
          ctx.fillStyle = '#D32F2F';
          ctx.shadowColor = 'rgba(255,255,255,0.9)';
          ctx.shadowBlur = 3;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(`Y#${b._yIdx ?? bi}`, bx + 2, by + 2);
          ctx.shadowBlur = 0;
        });
      }

      if (rowCanv) {
        const img = document.createElement('img');
        img.src = rowCanv.toDataURL();
        img.alt = `Det p.${pd.pageNum} #${row.di}`;
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        const txt = document.createElement('div');
        txt.className = 'crop-text-only';
        txt.textContent = `[det #${row.di} — no page canvas]`;
        card.appendChild(txt);
      }

      const lbl = document.createElement('span');
      lbl.className = 'crop-label';
      const slopeDeg = Number.isFinite(d.slope) ? ` · ${(Math.atan(d.slope) * 180 / Math.PI).toFixed(1)}°` : '';
      const fusedTag = row.fused ? ' · ⚠️fusa' : '';
      const yIds = row.inside.map(b => `Y#${b._yIdx ?? '?'}`).join(', ');
      const detId = row.di >= 0 ? `D#${row.di}` : 'D#?';
      lbl.textContent =
        `${detId}${slopeDeg}${fusedTag} · ${row.inside.length} box ${yIds}` +
        ` [${Math.round(d.x1)},${Math.round(d.y1)}→${Math.round(d.x2)},${Math.round(d.y2)}]`;
      card.appendChild(lbl);

      // Click → ispeziona la riga con i box assegnati
      attachInspectable(card, `${detId} — detection row with assigned YOLO boxes`, {
        id: detId,
        page: pd.pageNum,
        fused: row.fused,
        ...row,
        yoloBoxIds: row.inside.map(b => b._yIdx ?? null),
      });
      grid.appendChild(card);
  };
  return appendCard;
}

function renderRows(pageData) {
  if (!rowsView) return;
  rowsView.innerHTML = '';

  for (const pd of pageData) {
    const s = pd.displayScale || 1;
    const detRects = pd.detRects || [];
    // Box YOLO usati nella pipeline (post-NMS/merge, come nel layout)
    const yoloBoxes = pd.yoloBoxesMerged || pd.yoloBoxes || [];

    // Preparazione di tutte le righe: parametri del crop deskewed
    // (pbox/quad/cropP, gli stessi usati poi per le card e dal report).
    const allPrep = prepareDetRows(detRects, pd.canvas, s);

    // Centro del box nello spazio del crop (X = cx + dx, Y = cy - s*cx + dy)
    // box → riga: area contenuta (xOv·yOv deskewed) massima, tie →
    // centro più vicino; fallback entro 1.5×lh. Fuse incluse.
    const lhDet = detLineHeight(detRects);
    const { boxRow, orphans } = assignBoxesToRows(yoloBoxes, allPrep, pd.pageSlope || 0, lhDet);
    const keyOf = keyOfDet;
    const idxByKey = new Map();
    detRects.forEach((d, i) => { const k = keyOf(d); if (!idxByKey.has(k)) idxByKey.set(k, i); });

    const blocks = [];
    for (const region of (pd.boxes || [])) {
      if (!Array.isArray(region.detItems) || region.detItems.length === 0) continue;
      const rows = [];
      for (const det of region.detItems) {
        const k = keyOf(det);
        const rp = allPrep[idxByKey.has(k) ? idxByKey.get(k) : -1];
        if (!rp) continue;
        const inside = yoloBoxes.filter(b => boxRow.get(b) === rp);
        if (!inside.length) continue;
        // Ordina i box da sinistra a destra lungo l'asse di lettura
        const sRow = Number.isFinite(det.slope) ? det.slope : 0;
        inside.sort((a, b) => {
          const ax = (a.x1 + a.x2) / 2 + sRow * (a.y1 + a.y2) / 2;
          const bx = (b.x1 + b.x2) / 2 + sRow * (b.y1 + b.y2) / 2;
          return ax - bx || a.x1 - b.x1 || a.y1 - b.y1;
        });
        if (inside.length) rows.push(makeRowView(rp, inside, lhDet));
      }
      if (!rows.length) continue;
      // Ordinamento della regione (stessa logica della pipeline):
      // i box YOLO orfani entrano nella lista come righe singole e
      // tutte le entità (righe + solitari) si ordinano top→bottom per
      // y deskewed di pagina, poi sinistra→destra per x1; dentro ogni
      // riga i box restano ordinati per asse di lettura (già sopra).
      const sP = pd.pageSlope || 0;
      const sortY = e => e.y1 - sP * (e.x1 + e.x2) / 2;
      const entities = rows.map(v => ({ kind: 'row', v, y: sortY(v.d), x: v.d.x1 }));
      for (const b of orphans) {
        const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
        if (cx >= region.x1 && cx <= region.x2 && cy >= region.y1 && cy <= region.y2) {
          entities.push({ kind: 'box', v: b, y: sortY(b), x: b.x1 });
        }
      }
      entities.sort((a, b) => a.y - b.y || a.x - b.x);
      blocks.push({ region, rows: entities });
    }

    // Righe RAW con box ma non appartenenti ad alcuna regione
    const leftovers = [];
    {
      const seen = new Set();
      for (const b of blocks) for (const r of b.rows) if (r.kind === 'row') seen.add(keyOf(r.v.d));
      for (const rp of allPrep) {
        if (seen.has(keyOf(rp.d))) continue;
        const inside = yoloBoxes.filter(b => boxRow.get(b) === rp);
        if (inside.length) leftovers.push(makeRowView(rp, inside, lhDet));
      }
    }

    const totalRows = blocks.reduce((n, b) => n + b.rows.filter(e => e.kind === 'row').length, 0) + leftovers.length;
    if (!totalRows && !orphans.length) continue;

    // Header pagina
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '20px';
    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;padding:8px 0;font-size:0.95rem;';
    label.textContent =
      `Page ${pd.pageNum} — ${totalRows}/${detRects.length} RAW rows with YOLO boxes (max contained deskewed area; detection = row)` +
      ` · ${blocks.length} blocchi gap tree` + (orphans.length ? ` · ${orphans.length} box orfani` : '');
    wrapper.appendChild(label);

    // Card di una riga (crop deskewed con i parametri già calcolati)
    const appendCard = makeRowCardAppender(pd, s);

    // Card del box YOLO "e basta": ritaglio esatto del rettangolo del
    // box (slope 0, pad 0), niente crop riga e niente overlay.
    const appendBoxCard = (grid, box) => {
      const card = document.createElement('div');
      card.className = 'crop-item';
      const bw = (box.x2 - box.x1) * s, bh = (box.y2 - box.y1) * s;
      const boxP = {
        x1: Math.round(box.x1 * s), y1: Math.round(box.y1 * s),
        x2: Math.round(box.x2 * s), y2: Math.round(box.y2 * s),
      };
      const cb = (pd.canvas && bw >= 4 && bh >= 4)
        ? extractDeskewedCropCanvas(pd.canvas, boxP, 0, 0)
        : null;
      if (cb) {
        const img = document.createElement('img');
        img.src = cb.toDataURL();
        img.alt = `Box YOLO p.${pd.pageNum}`;
        img.loading = 'lazy';
        card.appendChild(img);
      }
      const lbl = document.createElement('span');
      lbl.className = 'crop-label';
      const yId = box._yIdx !== undefined ? `Y#${box._yIdx}` : 'Y#?';
      lbl.textContent =
        `p.${pd.pageNum} ${yId} [${Math.round(box.x1)},${Math.round(box.y1)}→${Math.round(box.x2)},${Math.round(box.y2)}]`;
      card.appendChild(lbl);

      // Click → ispeziona il box YOLO
      attachInspectable(card, `${yId} — box YOLO (p.${pd.pageNum})`, {
        id: yId, page: pd.pageNum, ...box,
      });
      grid.appendChild(card);
    };

    // Blocchi in ordine di lettura delle regioni (gap tree)
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const region = block.region;
      const title = document.createElement('div');
      title.className = 'row-block-title';
      const col = Number.isFinite(region.columnId) ? ` · col ${region.columnId}` : '';
      title.textContent =
        `Blocco ${bi + 1} — R#${region.readingOrder ?? '?'}${col} ` +
        `[${Math.round(region.x1)},${Math.round(region.y1)}→${Math.round(region.x2)},${Math.round(region.y2)}] · ` +
        `${block.rows.filter(e => e.kind === 'row').length} righe` +
        (block.rows.some(e => e.kind === 'box') ? ` · ${block.rows.filter(e => e.kind === 'box').length} box solitari` : '');
      wrapper.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'row-grid';
      for (const ent of block.rows) {
        if (ent.kind === 'row') appendCard(grid, ent.v);
        else appendBoxCard(grid, ent.v);
      }
      wrapper.appendChild(grid);
    }

    if (leftovers.length) {
      let nBox = 0;
      for (const row of leftovers) nBox += row.inside.length;
      const title = document.createElement('div');
      title.className = 'row-block-title';
      title.textContent = `Extra block — rows not assigned to gap-tree regions · ${nBox} YOLO boxes (${leftovers.length} rows)`;
      wrapper.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'row-grid';
      for (const row of leftovers) for (const box of row.inside) appendBoxCard(grid, box);
      wrapper.appendChild(grid);
    }

    // Box YOLO rimasti senza alcuna riga e fuori da ogni regione
    const orphanOutside = orphans.filter(b => {
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      return !blocks.some(bb => cx >= bb.region.x1 && cx <= bb.region.x2 && cy >= bb.region.y1 && cy <= bb.region.y2);
    });
    if (orphanOutside.length) {
      const title = document.createElement('div');
      title.className = 'row-block-title';
      title.textContent = `YOLO boxes without a detection row (outside any region) · ${orphanOutside.length}`;
      wrapper.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'row-grid';
      for (const b of orphanOutside) appendBoxCard(grid, b);
      wrapper.appendChild(grid);
    }

    rowsView.appendChild(wrapper);
  }
}
/**
 * Renderizza TUTTE le righe estratte dal modello di detection (senza
 * filtro YOLO), divise nei blocchi gap tree in ordine di lettura delle
 * regioni (readingOrder); dentro ogni blocco ordinate top->bottom
 * deskewed. Ogni card mostra il crop deskewed della riga e, in
 * overlay, i box YOLO ad essa assegnati (stessa assegnazione della
 * tab "YOLO Rows": max area contenuta deskewed (xOv·yOv)).
 *
 * @param {Array} pageData
 */
function renderAllRows(pageData) {
  if (!allRowsView) return;
  allRowsView.innerHTML = '';

  for (const pd of pageData) {
    const s = pd.displayScale || 1;
    const detRects = pd.detRects || [];
    const yoloBoxes = pd.yoloBoxesMerged || pd.yoloBoxes || [];
    if (!detRects.length) continue;

    // Tutte le righe, normalizzate (deskew + crop params)
    const allPrep = prepareDetRows(detRects, pd.canvas, s);

    // box → riga (assegnazione condivisa con la tab "YOLO Rows")
    const lhDet = detLineHeight(detRects);
    const { boxRow } = assignBoxesToRows(yoloBoxes, allPrep, pd.pageSlope || 0, lhDet);

    const keyOf = keyOfDet;
    const idxByKey = new Map();
    detRects.forEach((d, i) => { const k = keyOf(d); if (!idxByKey.has(k)) idxByKey.set(k, i); });

    const blocks = [];
    for (const region of (pd.boxes || [])) {
      if (!Array.isArray(region.detItems) || region.detItems.length === 0) continue;
      const rows = [];
      for (const det of region.detItems) {
        const k = keyOf(det);
        const rp = allPrep[idxByKey.has(k) ? idxByKey.get(k) : -1];
        if (!rp) continue;
        const inside = yoloBoxes.filter(b => boxRow.get(b) === rp);
        // Ordina i box lungo l'asse di lettura (x deskewed)
        const sRow = Number.isFinite(det.slope) ? det.slope : 0;
        inside.sort((a, b) => {
          const ax = (a.x1 + a.x2) / 2 + sRow * (a.y1 + a.y2) / 2;
          const bx = (b.x1 + b.x2) / 2 + sRow * (b.y1 + b.y2) / 2;
          return ax - bx || a.x1 - b.x1 || a.y1 - b.y1;
        });
        rows.push(makeRowView(rp, inside, lhDet));
      }
      if (!rows.length) continue;
      // Ordine di lettura dentro il blocco: top->bottom deskewed, poi x
      rows.sort((a, b) => {
        const ya = a.d.y1 - (a.d.slope ?? 0) * (a.d.x1 + a.d.x2) / 2;
        const yb = b.d.y1 - (b.d.slope ?? 0) * (b.d.x1 + b.d.x2) / 2;
        return (ya - yb) || (a.d.x1 - b.d.x1);
      });
      blocks.push({ region, rows });
    }

    // Righe non appartenenti ad alcuna regione (tutte, senza filtro)
    const leftovers = [];
    {
      const seen = new Set();
      for (const b of blocks) for (const r of b.rows) seen.add(keyOf(r.d));
      for (const rp of allPrep) {
        if (seen.has(keyOf(rp.d))) continue;
        leftovers.push(makeRowView(rp, yoloBoxes.filter(b => boxRow.get(b) === rp), lhDet));
      }
    }

    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '20px';
    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;padding:8px 0;font-size:0.95rem;';
    label.textContent =
      `Page ${pd.pageNum} — ${detRects.length} righe di detection (tutte)` +
      ` · ${blocks.length} blocchi gap tree` +
      (leftovers.length ? ` · ${leftovers.length} fuori regione` : '');
    wrapper.appendChild(label);

    const appendCard = makeRowCardAppender(pd, s);

    // Blocchi in ordine di lettura delle regioni (gap tree)
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const region = block.region;
      const title = document.createElement('div');
      title.className = 'row-block-title';
      const col = Number.isFinite(region.columnId) ? ` · col ${region.columnId}` : '';
      title.textContent =
        `Blocco ${bi + 1} — R#${region.readingOrder ?? '?'}${col} ` +
        `[${Math.round(region.x1)},${Math.round(region.y1)}→${Math.round(region.x2)},${Math.round(region.y2)}] · ${block.rows.length} righe`;
      wrapper.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'row-grid';
      for (const row of block.rows) appendCard(grid, row);
      wrapper.appendChild(grid);
    }

    if (leftovers.length) {
      const title = document.createElement('div');
      title.className = 'row-block-title';
      title.textContent = `Righe fuori dalle regioni gap tree · ${leftovers.length}`;
      wrapper.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'row-grid';
      for (const row of leftovers) appendCard(grid, row);
      wrapper.appendChild(grid);
    }

    allRowsView.appendChild(wrapper);
  }
}

/**
 * Cambia la view attiva tra le tab.
 *
 * @param {string} viewName — 'bbox' | 'crops' | 'markdown' | 'yolo' | 'rows'
 */
export function switchView(viewName) {
  tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.view === viewName));
  const pdfViewer = document.getElementById('pdfViewer');
  const cropContainer = document.getElementById('cropContainer');
  const markdownOut = document.getElementById('markdownOutput');
  const yoloFragsView = document.getElementById('yoloFrags');
  const rowsView = document.getElementById('rowsContainer');
  const allRowsView = document.getElementById('allRowsContainer');
  const debugReportOut = document.getElementById('debugReport');

  if (pdfViewer) pdfViewer.classList.toggle('hidden', viewName !== 'bbox');
  if (cropContainer) cropContainer.classList.toggle('hidden', viewName !== 'crops');
  if (markdownOut) markdownOut.classList.toggle('hidden', viewName !== 'markdown');
  if (yoloFragsView) yoloFragsView.classList.toggle('hidden', viewName !== 'yolo');
  if (rowsView) rowsView.classList.toggle('hidden', viewName !== 'rows');
  if (allRowsView) allRowsView.classList.toggle('hidden', viewName !== 'allrows');
  if (debugReportOut) debugReportOut.classList.toggle('hidden', viewName !== 'report');

  // Tab "Edit highlights" (disponibile anche in produzione)
  const boxEditorEl = document.getElementById('boxEditor');
  if (boxEditorEl) boxEditorEl.classList.toggle('hidden', viewName !== 'edit');
  if (viewName === 'edit') {
    import('./boxEditor.js').then(m => m.activateBoxEditor());
  }

  // La tab attiva è riflessa nell'URL (?view=…) — deep-link, WIG Navigation & State
  try { history.replaceState(null, '', '?view=' + viewName); } catch { /* noop */ }
}

/**
 * Inizializza i tab.
 */
export function initTabs() {
  tabBtns = viewTabs?.querySelectorAll('.tab-btn') ?? [];
  viewTabs?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn?.dataset.view) switchView(btn.dataset.view);
  });

  // Deep-link: ripristina la tab dall'URL (?view=markdown) — WIG Navigation & State
  try {
    const view = new URLSearchParams(location.search).get('view');
    if (view) {
      const btn = viewTabs?.querySelector(`.tab-btn[data-view="${view}"]`);
      if (btn && !btn.classList.contains('hidden')) switchView(view);
    }
  } catch { /* noop */ }
}
