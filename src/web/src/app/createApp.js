/**
 * Create App — orchestrazione della pipeline ML.
 *
 * Coordina:
 * - Caricamento modelli AI (YOLO + PaddleOCR)
 * - Processamento pagina per pagina
 * - OCR batch su tutti i frammenti
 * - Esposizione dei risultati alla UI
 */
import { renderPageToCanvas } from '../services/pdfService.js';
import { loadModel, unloadModel, runYOLOInference, getProvider } from '../services/yoloService.js';
import { initPaddleOCR, releasePaddleOCR, getDetModel, runOcrOnFragments } from '../services/ocrService.js';
import { clusterAndOrderBoxes, flattenOrderedBoxes } from '../domain/layout/clusterHighlights.js';
import { extractCropCanvas, extractDeskewedCropCanvas, downscaleForOcr } from '../domain/geometry.js';
import {
  currentFile, cropData, pageData,
  setCropData, resetCropData, resetPageData, addPageData,
  addEditorPage, resetEditorPages,
} from './state.js';
import { showResult, switchView } from '../presentation/resultRenderer.js';
import { setProgress, showLoading, hideAll, getSelectedLang, updateAcceleratorBadge } from '../presentation/dom.js';
import { DEBUG, OCR_ROW_MAX_W } from '../config/pipeline.js';
import { IS_MOBILE } from '../config/device.js';
import { setSessionInfo } from './state.js';
import { warmup } from '../domain/wordGlue.js';
import { trackCanvasReleased, logMem, updateRunPhase } from './diagnostics.js';

/* ─── PDF editabile (tab "Edit highlights") ───
 * Dopo una run il documento pdf.js resta in memoria per permettere
 * all'editor di ri-renderizzare le pagine e di rielaborare la
 * pipeline con i box modificati. Il proxy viene distrutto solo
 * quando arriva un nuovo PDF (o in caso di errore).
 */
let _editablePdf = null;

/**
 * Imposta il PDF correntemente editabile (distrugge il precedente).
 * @param {PDFDocumentProxy|null} pdf
 */
export function setEditablePdf(pdf) {
  if (_editablePdf && _editablePdf !== pdf) {
    try { _editablePdf.destroy(); } catch (e) { /* noop */ }
  }
  _editablePdf = pdf;
}

/**
 * Il PDF editabile corrente (null se nessuna run completata).
 * @returns {PDFDocumentProxy|null}
 */
export function getEditablePdf() {
  return _editablePdf;
}

/**
 * Yield al browser per aggiornamenti UI.
 * @returns {Promise<void>}
 */
export function yieldToBrowser() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Rilascia la memoria GPU di un canvas azzerando le dimensioni.
 * Il solo `delete canvas` non libera la texture nella VRAM.
 * @param {HTMLCanvasElement|null} canvas
 */
function releaseCanvas(canvas) {
  if (!canvas) return;
  if (canvas.width === 0 && canvas.height === 0) return; // già rilasciato (canvas condivisi)
  canvas.width = 0;
  canvas.height = 0;
  // Se il canvas è nel DOM, rimuovilo per liberare il riferimento
  if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  trackCanvasReleased(canvas);
}

/**
 * Bounding box di un quadrilatero di detection. Il formato di
 * paddleocr-js è Point2D[] (array di coppie [x, y]), NON un array
 * piatto: leggere item.poly[0], item.poly[2], … come numeri produce
 * NaN — e un lineBox NaN disattivava silenziosamente il linking
 * "a capo" e il crop della riga intera (v5).
 * @param {Array<[number, number]>|null} poly
 * @param {{x1:number,y1:number,x2:number,y2:number}} fallback
 * @returns {{x1:number,y1:number,x2:number,y2:number}}
 */
function polyToBox(poly, fallback) {
  if (!Array.isArray(poly) || poly.length < 2) return fallback;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of poly) {
    if (!Array.isArray(p) || p.length < 2) return fallback;
    const px = p[0], py = p[1];
    if (!Number.isFinite(px) || !Number.isFinite(py)) return fallback;
    x1 = Math.min(x1, px); y1 = Math.min(y1, py);
    x2 = Math.max(x2, px); y2 = Math.max(y2, py);
  }
  return { x1, y1, x2, y2 };
}

/**
 * Pipeline principale di elaborazione PDF.
 *
 * Percorso unico: NEURALE per tutti i PDF — YOLO per gli highlight,
 * PP-OCRv6 per detection layout e OCR dei frammenti. Nessun percorso
 * nativo separato per i PDF con annotazioni.
 *
 * @param {PDFDocumentProxy} pdf
 * @param {{editedBoxes?: Object<number, Array>}} [options] — se presente,
 *   salta la detection YOLO e usa questi box ({x1,y1,x2,y2,score?}) per pagina.
 */
export async function processPDF(pdf, options = {}) {
  resetCropData();
  resetPageData();
  resetEditorPages();

  const editedBoxes = options.editedBoxes || null;

  // Preload del dizionario per il gluaggio parole (chunk lazy): lo
  // scarichiamo DURANTE l'OCR così il markdown è pronto senza attese.
  warmup();

  const totalPages = pdf.numPages;

  // Pipeline neurale unica per tutti i PDF (niente percorso nativo):
  // YOLO per gli highlight, PP-OCRv6 per detection layout e OCR.
  // PaddleOCR viene caricato lazily alla prima pagina con evidenziature
  // (processPage): evita ~30MB di modelli su PDF senza evidenziature.
  if (IS_MOBILE) {
    await neuralPipelineMobile(pdf, totalPages, editedBoxes);
  } else {
    await neuralPipeline(pdf, totalPages, editedBoxes);
  }

  // Rilascia i canvas (memoria GPU) dei frammenti
  // In DEBUG i crop servono ancora alla tab "Evidenziazioni" (renderCrops).
  if (!DEBUG) {
    for (const f of cropData) {
      releaseCanvas(f.canvas);
      delete f.canvas;
      releaseCanvas(f.rowCanvas);
      delete f.rowCanvas;
    }
  }
}

/**
 * Pipeline neurale — elaborazione batch (desktop).
 * YOLO su tutte le pagine, poi OCR batch su tutti i frammenti.
 * Carica/scarica i modelli solo quando servono per risparmiare memoria GPU.
 *
 * @param {PDFDocumentProxy} pdf
 * @param {number} totalPages
 * @param {Object<number, Array>|null} editedBoxes
 */
async function neuralPipeline(pdf, totalPages, editedBoxes) {
  /* ── Fase 2a: YOLO detection su tutte le pagine (saltata se i box
     sono stati editati dall'utente) ── */
  if (editedBoxes) {
    setSessionInfo({ yoloProvider: 'edited', boxesSource: 'user-edited' });
  } else {
    setProgress('⏳ Loading YOLO model…', 0, 1, [5, 5]);
    await yieldToBrowser();
    await loadModel();  // carica YOLO
    updateAcceleratorBadge(getProvider());
    setSessionInfo({ yoloProvider: getProvider() });
    setProgress('⏳ Loading YOLO model…', 1, 1, [5, 5]);
  }

  for (let p = 1; p <= totalPages; p++) {
    const pctLo = 5, pctHi = 60;
    const label = editedBoxes
      ? `📄 Page ${p}/${totalPages} — layout & crops…`
      : `📄 Page ${p}/${totalPages} — detecting highlights…`;
    setProgress(label, p, totalPages, [pctLo, pctHi]);
    const r = await processPage(pdf, p, editedBoxes ? editedBoxes[p] : undefined);
    addEditorPage(r.editorPage);
    setCropData([...cropData, ...r.fragments]);
  }

  // Rilascia YOLO — libera memoria GPU
  unloadModel();

  if (!cropData.length) {
    await releasePaddleOCR(); // no-op se mai caricato
    return;
  }

  /* ── Fase 2b: OCR batch su tutti i frammenti ── */
  setProgress('⏳ Loading OCR model…', 0, 1, [60, 60]);
  await yieldToBrowser();
  await initPaddleOCR(getSelectedLang());  // carica OCR
  setProgress('⏳ Loading OCR model…', 1, 1, [60, 60]);

  await runOcrOnFragments(cropData, (step, current, total) => {
    setProgress(step, current, total, [60, 100]);
  });

  // Rilascia OCR — libera memoria GPU
  await releasePaddleOCR();

  // Rilascia i canvas (memoria GPU) — non servono più dopo l'OCR.
  // In DEBUG restano per la tab "Evidenziazioni" (renderCrops).
  if (!DEBUG) {
    for (const f of cropData) {
      releaseCanvas(f.canvas);
      delete f.canvas;
      releaseCanvas(f.rowCanvas);
      delete f.rowCanvas;
    }
  }
}

/**
 * Pipeline neurale — elaborazione per mobile (pagina per pagina).
 *
 * Ogni pagina viene completata per intero prima di passare alla
 * successiva: render → YOLO → layout → crop → OCR → rilascio dei
 * canvas. In memoria c'è al massimo UNA pagina di crop canvas alla
 * volta (prima i crop di tutte le pagine venivano accumulati durante
 * la fase YOLO, con YOLO e PaddleOCR entrambi caricati: su iOS il
 * picco superava il budget di Safari e la tab crashava).
 *
 * I modelli (YOLO + PaddleOCR) restano caricati per tutto il run:
 * vengono rilasciati solo alla fine. Su mobile il backend è WASM
 * (mai WebGPU su iOS: vedi config/device.js).
 *
 * @param {PDFDocumentProxy} pdf
 * @param {number} totalPages
 * @param {Object<number, Array>|null} editedBoxes
 */
async function neuralPipelineMobile(pdf, totalPages, editedBoxes) {
  if (editedBoxes) {
    setSessionInfo({ yoloProvider: 'edited', boxesSource: 'user-edited' });
  } else {
    setProgress('⏳ Loading YOLO model…', 0, 1, [0, 2]);
    await loadModel();
    updateAcceleratorBadge(getProvider());
    setSessionInfo({ yoloProvider: getProvider() });
    await yieldToBrowser();
    logMem('[MOBILE] YOLO caricato');
  }

  const allFragments = [];

  for (let p = 1; p <= totalPages; p++) {
    const pctLo = 2 + ((p - 1) / totalPages) * 45;
    const pctHi = 2 + (p / totalPages) * 45;

    // ── YOLO + layout + crop (questa pagina) ──
    updateRunPhase('yolo', `page ${p}/${totalPages}`);
    const label = editedBoxes
      ? `📄 Page ${p}/${totalPages} — layout & crops…`
      : `📄 Page ${p}/${totalPages} — detecting highlights…`;
    setProgress(label, p, totalPages, [pctLo, pctHi]);
    await yieldToBrowser();
    const r = await processPage(pdf, p, editedBoxes ? editedBoxes[p] : undefined);
    const pageFragments = r.fragments;
    addEditorPage(r.editorPage);
    allFragments.push(...pageFragments);
    logMem(`[MOBILE] Page ${p}: YOLO ok, ${pageFragments.length} frammenti`);

    if (!pageFragments.length) continue;

    // ── OCR dei soli frammenti di questa pagina ──
    updateRunPhase('ocr', `page ${p}/${totalPages}`);
    if (!getDetModel().detModel) {
      setProgress('⏳ Loading OCR model…', 0, 1, [pctLo, pctHi]);
      await yieldToBrowser();
      await initPaddleOCR(getSelectedLang());
      setProgress('⏳ Loading OCR model…', 1, 1, [pctLo, pctHi]);
    }
    await runOcrOnFragments(pageFragments, (step, current, total) => {
      setProgress(step, current, total, [pctLo, pctHi]);
    });

    // ── Rilascia subito i canvas di questa pagina (memoria) ──
    if (!DEBUG) {
      for (const f of pageFragments) {
        releaseCanvas(f.canvas);
        delete f.canvas;
        releaseCanvas(f.rowCanvas);
        delete f.rowCanvas;
      }
    }
    logMem(`[MOBILE] Page ${p}: OCR completato, canvas rilasciati`);
  }

  // Rilascia i modelli — libera memoria WASM/GPU per l'upload successivo
  unloadModel();
  await releasePaddleOCR();
  logMem('[MOBILE] Modelli rilasciati');

  // Accumula tutti i frammenti nel dataset globale
  setCropData([...cropData, ...allFragments]);
  updateRunPhase('done', '');
}

/**
 * Carica PaddleOCR lazily: il detection model serve a GapTree solo quando
 * una pagina ha evidenziature YOLO. Su PDF senza evidenziature non vengono
 * mai caricati ~30MB di modelli (e lo spinner di riconoscimento non appare).
 */
async function ensureDetModel() {
  if (getDetModel().detModel) return;
  setProgress('⏳ Loading OCR model…', 0, 1, [3, 7]);
  await yieldToBrowser();
  const ok = await initPaddleOCR(getSelectedLang());
  if (!ok) {
    console.warn('[OCR] Init failed: layout will proceed without detection model (ordered YOLO fallback)');
  }
  setProgress('⏳ Loading OCR model…', 1, 1, [3, 7]);
}

/**
 * Processa una singola pagina PDF.
 *
 * @param {PDFDocumentProxy} pdf
 * @param {number} pageNum
 * @param {Array<{x1,y1,x2,y2,score?}>} [providedBoxes] — box forniti
 *   dall'editor (skip YOLO)
 * @returns {Promise<{ fragments: Array, boxes: Array, editorPage: Object }>}
 */
async function processPage(pdf, pageNum, providedBoxes) {
  const pageCanvas = await renderPageToCanvas(pdf, pageNum);

  let rawBoxes, boxes, mergedBoxes;
  if (providedBoxes) {
    // Box editati dall'utente: sono già il risultato finale.
    boxes = providedBoxes.map(b => ({
      x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
      score: Number.isFinite(b.score) ? b.score : 1.0,
    }));
    rawBoxes = boxes.slice();
    mergedBoxes = boxes.slice();
  } else {
    ({ rawBoxes, boxes, mergedBoxes } = await runYOLOInference(pageCanvas));
  }

  // Baseline per l'editor "Edit highlights" (sempre, anche in produzione):
  // i box che alimentano il layout, in coordinate pagina originali.
  const editorPage = {
    pageNum,
    w: pageCanvas.width,
    h: pageCanvas.height,
    boxes: mergedBoxes.map(b => ({
      x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
      score: Number.isFinite(b.score) ? b.score : 1.0,
    })),
  };

  // Se non ci sono evidenziature YOLO su questa pagina, skippa la detection
  // PP-OCRv6 e il layout ordinamento (risparmia ~0.3–0.8s per pagina vuota)
  let orderedBoxes = [];
  let detRects = [];
  let pageSlope = 0;

  if (boxes.length > 0) {
    // Caricamento lazy di PaddleOCR (detection per GapTree) — solo qui serve
    await ensureDetModel();
    const { detModel, cv } = getDetModel();
    // In produzione (lite=true) la pipeline sulle detection viene
    // eseguita SOLO per estrarre l'ordine dei box: il risultato è la
    // lista piatta con readingOrder, senza regioni/items/poly/detRects.
    const result = await clusterAndOrderBoxes(
      boxes, pageCanvas.width, pageCanvas.height,
      pageCanvas, pageNum, detModel, cv, null, !DEBUG
    );
    orderedBoxes = result.boxes;
    detRects = result.detRects;
    // Pendenza di pagina (deskew) stimata dal layout: usata per il crop
    // "deskewed" dei frammenti (evita zone di testo delle righe vicine).
    pageSlope = result.pageSlope || 0;
  } else {
    console.log(`[YOLO] Page ${pageNum}: no highlights, skipping layout`);
  }

  // Comprimi il canvas per la visualizzazione (solo in DEBUG — le schede
  // bbox/yolo sono nascoste in produzione e il canvas non serve)
  let displayCanvas = null;
  let displayScale = 1;
  if (DEBUG) {
    displayScale = 0.5;
    displayCanvas = document.createElement('canvas');
    displayCanvas.width = Math.round(pageCanvas.width * displayScale);
    displayCanvas.height = Math.round(pageCanvas.height * displayScale);
    displayCanvas.getContext('2d').drawImage(pageCanvas, 0, 0, displayCanvas.width, displayCanvas.height);
  }

  // Salva dati pagina per rendering UI (solo DEBUG)
  if (DEBUG) {
    addPageData({
      pageNum, canvas: displayCanvas, displayScale, boxes: orderedBoxes,
      yoloBoxes: rawBoxes, yoloBoxesMerged: mergedBoxes,
      detRects: detRects.slice(),
      pageSlope,
    });
  }

  // Crea frammenti a livello YOLO
  const fragments = [];

  // Crop dei frammenti: STESSA struttura del debug anche in produzione
  // (items con poly/slope per-riga) — ordine e qualità dei crop non
  // cambiano; cambia solo ciò che NON viene salvato: displayCanvas,
  // pageData, detRects e (a fine pagina) il canvas pieno.
  // Regioni con items (assegnamento YOLO → righe di testo)
  for (const region of orderedBoxes) {
    const items = region.items || [];
    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];
      const yoloBoxes = item.yoloBoxes || [];
      // Estensione della RIGA DI TESTO (quadrilatero della detection):
      // serve al linking "a capo" (una riga è piena solo se arriva qui)
      const lineBox = polyToBox(item.poly, { x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 });
      // Crop "tagliato sul testo": se la riga (item) ha il quadrilatero
      // della detection, la banda y viene dai vertici del quad e l'estensione
      // x dal box del frammento — non dal parallelogramma dell'intero bbox,
      // che includeva per intero le righe sopra/sotto.
      const itemQuad = (Array.isArray(item.poly) && item.poly.length >= 4)
        ? { quad: item.poly, bandQuad: true }
        : null;
      // v5 — OCR assistito dalla riga: crop della RIGA INTERA (quadrilatero
      // della detection, deskewed come il sito). Serve come secondo input
      // del recognition (contesto dell'intera riga); l'allineamento
      // frammento↔riga decide se usarlo (vedi domain/ocr/rowAssist.js).
      // Creato UNA volta per riga e CONDIVISO dai frammenti dello stesso
      // item: prima veniva clonato per ogni frammento (N canvas identici
      // per riga) e mai rilasciato.
      const rowQuad = (Array.isArray(item.poly) && item.poly.length >= 4)
        ? { quad: item.poly }
        : null;
      const rowCanv = rowQuad
        ? downscaleForOcr(extractDeskewedCropCanvas(pageCanvas, lineBox, item.slope ?? pageSlope, 2, rowQuad), OCR_ROW_MAX_W, true)
        : null;
      for (let yi = 0; yi < yoloBoxes.length; yi++) {
        const yb = yoloBoxes[yi];
        const cropCanv = extractDeskewedCropCanvas(pageCanvas, yb, item.slope ?? pageSlope, 2, itemQuad);
        if (cropCanv) {
          fragments.push({
            page: pageNum,
            regionOrder: region.readingOrder,
            itemIndex: ii,
            yoloIndex: yi,
            score: yb.score ?? region.score,
            x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2,
            lineBox,
            canvas: cropCanv,
            rowCanvas: rowCanv,
            text: '',
            ocr: { status: 'pending', engine: 'PaddleOCR', text: null, confidence: null, error: null },
          });
        }
      }
    }
  }

  // YOLO uncovered (centro fuori da ogni regione GapTree, senza items)
  for (const region of orderedBoxes) {
    if (region.items && region.items.length > 0) continue;
    const yoloIndices = region.containedYOLOs || [];
    for (const yi of yoloIndices) {
      const yb = boxes[yi];
      if (!yb) continue;
      const cropCanv = extractDeskewedCropCanvas(pageCanvas, yb, pageSlope, 4);
      if (cropCanv) {
        fragments.push({
          page: pageNum,
          regionOrder: region.readingOrder ?? 0,
          itemIndex: 0,
          yoloIndex: yi,
          score: region.score ?? yb.score,
          x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2,
          lineBox: { x1: yb.x1, y1: yb.y1, x2: yb.x2, y2: yb.y2 },
          canvas: cropCanv,
          text: '',
          ocr: { status: 'pending', engine: 'PaddleOCR', text: null, confidence: null, error: null },
        });
      }
    }
  }

  // Fallback: quando GapTree non è stato eseguito (detection fallita),
  // orderedBoxes è un array piatto senza items/containedYOLOs.
  // Crea un frammento per ogni YOLO box direttamente.
  if (fragments.length === 0 && orderedBoxes.length > 0) {
    const hasStructured = orderedBoxes.some(r => r.items || r.containedYOLOs);
    if (!hasStructured) {
      console.log(`[YOLO] Page ${pageNum}: ${orderedBoxes.length} bare boxes, creating fallback fragments`);
      for (let bi = 0; bi < orderedBoxes.length; bi++) {
        const b = orderedBoxes[bi];
        const cropCanv = extractDeskewedCropCanvas(pageCanvas, b, pageSlope);
        if (cropCanv) {
          fragments.push({
            page: pageNum,
            regionOrder: b.readingOrder ?? bi,
            itemIndex: 0,
            yoloIndex: bi,
            score: b.score ?? 1.0,
            x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
            lineBox: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
            canvas: cropCanv,
            text: '',
            ocr: { status: 'pending', engine: 'PaddleOCR', text: null, confidence: null, error: null },
          });
        }
      }
    }
  }

  // Rilascia la pagina canvas (memoria GPU) — non serve più
  releaseCanvas(pageCanvas);

  // La struttura detection (regioni/items/poly/detRects) serve solo
  // qui dentro, per l'ordine e i crop: in produzione al chiamante va
  // la lista piatta dei box (ordine + coordinate), e la struttura
  // muore col GC (memoria libera). In DEBUG resta intatta per i tab.
  if (!DEBUG) {
    orderedBoxes = flattenOrderedBoxes(orderedBoxes, boxes, pageSlope);
  }

  return { fragments, boxes: orderedBoxes, editorPage };
}

/**
 * Rilascio finale della memoria dopo l'elaborazione.
 *
 * Libera tutto ciò che non serve più alla visualizzazione del risultato:
 * - modelli AI (YOLO + PaddleOCR) — idempotente: le pipeline li hanno già
 *   rilasciati alla fine; qui copre anche i percorsi d'errore (crash a
 *   metà run, eccezioni) in cui resterebbero caricati
 * - canvas residui (cropData/pageData) — in produzione; in DEBUG restano
 *   per le tab di ispezione
 * - riferimento al File caricato: resta solo il nome (serve ai pulsanti
 *   Copia/Scarica .md), il blob del PDF viene rilasciato
 *
 * Il markdown già renderizzato e i dati testuali di cropData restano
 * intatti: Copia/Scarica continuano a funzionare.
 */
export async function releaseRunMemory() {
  try { unloadModel(); } catch (e) { console.warn('[MEM] unloadModel:', e.message); }
  try { await releasePaddleOCR(); } catch (e) { console.warn('[MEM] releasePaddleOCR:', e.message); }
  try {
    if (!DEBUG) {
      for (const f of cropData) {
        releaseCanvas(f.canvas);
        delete f.canvas;
        releaseCanvas(f.rowCanvas);
        delete f.rowCanvas;
      }
      for (const pd of pageData) {
        releaseCanvas(pd.canvas);
        delete pd.canvas;
      }
    }
  } catch (e) { console.warn('[MEM] release canvas:', e.message); }
  // Nota: il File e il pdf.js proxy restano in memoria apposta —
  // servono alla tab "Edit highlights" per ri-renderizzare le pagine
  // e rielaborare la pipeline con i box modificati.
  logMem('[MEM] Fine run — modelli e canvas rilasciati (PDF editabile mantenuto)');
}

/**
 * Mostra il risultato finale nella UI.
 */
export async function showFinalResult() {
  hideAll();
  if (!cropData.length) {
    const noHighlights = document.getElementById('noHighlights');
    if (noHighlights) noHighlights.classList.remove('hidden');
    return;
  }

  // Delega a resultRenderer
  await showResult(currentFile, cropData, pageData);
  switchView(DEBUG ? 'bbox' : 'markdown');
  const result = document.getElementById('result');
  if (result) result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Nota: cropData/pageData NON vengono rimossi qui — i pulsanti
  // Copia/Scarica .md rileggono cropData allo click (markdownExporter).
}
