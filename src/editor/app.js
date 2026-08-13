import * as pdfjsLib from '/vendor/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

// ONNX Runtime Web — caricato via <script> in index.html
// La variabile globale `ort` è disponibile dopo il caricamento del CDN

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_SIZE = 0.004;
const OVERLAP_THRESHOLD = 0.40;
const MAX_UNDO = 60;

const MODEL_PATH = '/HT_detector_v7.8.onnx';
const MODEL_SIZE = 1024; // 1024x1024 input
const MODEL_STRIDE = 32;

// Parametri inferenza (dal results.json originale)
const CONF_THRESHOLD = 0.15;
const MODE = 'full_page';  // full_page | strips

// Rendering parametri
const TARGET_DPI = 300;
const MAX_CANVAS_PX = 4096;
const BASE_DPI = 72;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  folders: [],
  folderIdx: 0,
  pageIdx: 0,
  data: null,
  pdf: null,
  zoom: 1.0,
  pageBase: null,
  selectedId: null,
  undoStack: [],
  dirty: false,
  createCorner: null,
  drag: null,
  renderTask: null,
  loading: false,

  // Nuovo: sorgenti PDF non elaborati
  sourcePdfs: [],
  rtSession: null,   // ONNX Runtime InferenceSession
  rtLoading: false,
  isProcessing: false,
  abortProcessing: false,
};
let _idCounter = 1;
const nextId = () => 'b' + (_idCounter++);

const $ = (id) => document.getElementById(id);
const pageView = $('page-view');
const pageWrap = $('page-wrap');
const canvas = $('pdf-canvas');
const boxLayer = $('box-layer');
const cornerMarker = $('corner-marker');
const rubber = $('rubber');
const overlay = $('overlay');
const processBar = $('process-bar');
const processStatus = $('process-status');
const processProgress = $('process-progress');
const processAbortBtn = $('process-abort-btn');

// ---------------------------------------------------------------------------
// ONNX Runtime Web — caricamento modello
// ---------------------------------------------------------------------------
async function loadModel() {
  if (state.rtSession) return state.rtSession;
  if (state.rtLoading) {
    while (state.rtLoading) await new Promise(r => setTimeout(r, 200));
    return state.rtSession;
  }
  state.rtLoading = true;
  try {
    // Configura i path WASM per ONNX Runtime Web (CDN)
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';

    // Il modello ha operazioni Resize con float16 che WebGPU/JSEP
    // non supporta correttamente ("Invalid data type"). Usiamo WASM
    // che con SIMD è comunque performante.
    const providers = ['wasm'];
    try {
      // Verifica se WebGPU è disponibile nel browser
      if (navigator.gpu) {
        // Tentiamo WebGPU ma con fallback esplicito a WASM per
        // ogni singolo nodo, non come preferenza mista.
        // NOTA: alcuni nodi Resize falliscono su JSEP, quindi
        // per ora usiamo solo WASM.
        console.log('WebGPU disponibile ma il modello richiede WASM per compatibilità');
      }
    } catch (e) {
      // WebGPU non disponibile
    }

    state.rtSession = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });

    console.log('Modello ONNX caricato con successo (provider: WASM)');
    return state.rtSession;
  } catch (e) {
    console.error('Impossibile caricare il modello ONNX:', e);
    throw e;
  } finally {
    state.rtLoading = false;
  }
}

// ---------------------------------------------------------------------------
// Preprocessing: canvas → tensor 1x3x1024x1024 con letterbox
// ---------------------------------------------------------------------------
function canvasToTensor(cvs) {
  const sw = cvs.width;
  const sh = cvs.height;

  // Calcola letterbox per adattare a MODEL_SIZE mantenendo aspect ratio
  const scale = Math.min(MODEL_SIZE / sw, MODEL_SIZE / sh);
  const newW = Math.round(sw * scale);
  const newH = Math.round(sh * scale);
  const padX = Math.round((MODEL_SIZE - newW) / 2);
  const padY = Math.round((MODEL_SIZE - newH) / 2);

  // Crea un canvas temporaneo per il resize con letterbox
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = MODEL_SIZE;
  tmpCanvas.height = MODEL_SIZE;
  const ctx = tmpCanvas.getContext('2d');

  // Sfondo grigio (valore medio 114 usato da YOLO)
  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);

  // Disegna l'immagine ridimensionata con posizione centrata
  ctx.drawImage(cvs, 0, 0, sw, sh, padX, padY, newW, newH);

  // Leggi i pixel
  const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const pixels = imageData.data; // RGBA, length = 1024*1024*4

  // Converti a float32 tensor in formato NCHW (1, 3, 1024, 1024)
  // Normalizza a [0, 1]
  const float32Data = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    const offset = i * 4;
    float32Data[i] = pixels[offset] / 255.0;           // R
    float32Data[MODEL_SIZE * MODEL_SIZE + i] = pixels[offset + 1] / 255.0; // G
    float32Data[2 * MODEL_SIZE * MODEL_SIZE + i] = pixels[offset + 2] / 255.0; // B
  }

  return {
    tensor: new ort.Tensor('float32', float32Data, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    scale,
    padX,
    padY,
    newW,
    newH,
  };
}

// ---------------------------------------------------------------------------
// Postprocessing: output YOLO (1x300x6) → bounding box normalizzati
// L'output del modello è [x1, y1, x2, y2, confidence, class_id]
// dove x1,y1,x2,y2 sono pixel nell'immagine 1024x1024 (con letterbox)
// ---------------------------------------------------------------------------
function parseDetections(outputData, meta) {
  const dets = [];
  const stride = 6;

  for (let i = 0; i < 300; i++) {
    const offset = i * stride;
    const x1px = outputData[offset];
    const y1px = outputData[offset + 1];
    const x2px = outputData[offset + 2];
    const y2px = outputData[offset + 3];
    const conf = outputData[offset + 4];
    const cls = outputData[offset + 5];

    if (conf < CONF_THRESHOLD) continue;
    if (cls !== 0) continue;

    // x1px,y1px,x2px,y2px sono pixel nel canvas 1024x1024 (con letterbox)
    // Rimuovi padding letterbox per ottenere coordinate nel canvas renderizzato
    const x1r = (x1px - meta.padX) / meta.scale;
    const y1r = (y1px - meta.padY) / meta.scale;
    const x2r = (x2px - meta.padX) / meta.scale;
    const y2r = (y2px - meta.padY) / meta.scale;

    // Normalizza a 0-1 rispetto alle dimensioni del canvas renderizzato
    const pageW = meta.pageW;
    const pageH = meta.pageH;
    let x1 = x1r / pageW;
    let y1 = y1r / pageH;
    let x2 = x2r / pageW;
    let y2 = y2r / pageH;

    // Clamp e ordina
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    x1 = Math.max(0, x1);
    y1 = Math.max(0, y1);
    x2 = Math.min(1, x2);
    y2 = Math.min(1, y2);

    if (x2 - x1 < 0.001 || y2 - y1 < 0.001) continue;

    dets.push({
      bbox: { x1, y1, x2, y2 },
      bbox_yolo: {
        cx: (x1 + x2) / 2,
        cy: (y1 + y2) / 2,
        w: x2 - x1,
        h: y2 - y1,
      },
    });
  }

  return dets;
}

// ---------------------------------------------------------------------------
// Elaborazione di una singola pagina PDF con il modello ONNX
// Rende la pagina a 300 DPI per massima qualità di rilevamento
// ---------------------------------------------------------------------------
async function processPage(pdfPage, pageIdx, totalPages) {
  // Dimensioni naturali della pagina a 72 DPI (scale=1)
  const baseVp = pdfPage.getViewport({ scale: 1 });
  const baseW = baseVp.width;
  const baseH = baseVp.height;

  // Scala di rendering: 300 DPI, ma con tetto massimo di 4096 px per lato
  const dpiScale = TARGET_DPI / BASE_DPI;
  const capScale = MAX_CANVAS_PX / Math.max(baseW, baseH);
  const renderScale = Math.min(dpiScale, capScale);

  // Crea viewport e canvas alle dimensioni calcolate
  const viewport = pdfPage.getViewport({ scale: renderScale });
  const cw = Math.floor(viewport.width);
  const ch = Math.floor(viewport.height);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = cw;
  offCanvas.height = ch;
  const ctx = offCanvas.getContext('2d');

  // Renderizza la pagina
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

  // Preprocess: canvas → tensor con letterbox 1024×1024
  const prep = canvasToTensor(offCanvas);

  // Inference
  const session = await loadModel();
  const feeds = { 'images': prep.tensor };
  const results = await session.run(feeds);
  const output0 = results['output0'];

  // Postprocess: output YOLO → bounding box normalizzati 0-1
  const detections = parseDetections(output0.data, {
    scale: prep.scale,
    padX: prep.padX,
    padY: prep.padY,
    pageW: cw,
    pageH: ch,
  });

  return detections;
}

// ---------------------------------------------------------------------------
// Elaborazione completa di un PDF: tutte le pagine → results.json
// ---------------------------------------------------------------------------
async function processPdf(pdfName, onProgress) {
  const session = await loadModel();

  // Carica il PDF
  const pdf = await pdfjsLib.getDocument({
    url: '/api/source-pdf?pdf=' + encodeURIComponent(pdfName),
    standardFontDataUrl: '/vendor/standard_fonts/',
    cMapUrl: '/vendor/cmaps/',
    cMapPacked: true,
    wasmUrl: '/vendor/wasm/',
  }).promise;

  const totalPages = pdf.numPages;
  const pagesData = {};
  let totalDets = 0;

  for (let i = 0; i < totalPages; i++) {
    if (state.abortProcessing) {
      setStatus('elaborazione annullata');
      throw new Error('annullato');
    }

    const page = await pdf.getPage(i + 1);
    onProgress(i, totalPages, `Rendering pagina ${i + 1}/${totalPages}…`);
    const dets = await processPage(page, i, totalPages);

    pagesData[String(i)] = dets;
    totalDets += dets.length;

    onProgress(i + 1, totalPages, `Pagina ${i + 1}/${totalPages} — ${dets.length} highlight`);
  }

  // Costruisci results.json
  const result = {
    total_pages: totalPages,
    total_detections: totalDets,
    pages: pagesData,
  };

  // Salva su server
  onProgress(totalPages, totalPages, 'Salvataggio risultati…');
  const r = await fetch('/api/create-batch-output', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdf_name: pdfName,
      results: result,
    }),
  });
  if (!r.ok) throw new Error('Errore salvataggio: HTTP ' + r.status);
  const j = await r.json();

  return j;
}

// ---------------------------------------------------------------------------
// UI Process Bar
// ---------------------------------------------------------------------------
function showProcessBar(pdfName) {
  processBar.style.display = 'flex';
  processBar.style.alignItems = 'center';
  processStatus.textContent = `Elaborazione: ${pdfName}`;
  processProgress.textContent = '0/0';
  state.abortProcessing = false;
}

function hideProcessBar() {
  processBar.style.display = 'none';
  processStatus.textContent = '';
  processProgress.textContent = '';
}

function updateProcessProgress(current, total, msg) {
  processProgress.textContent = `${current}/${total}`;
  if (msg) processStatus.textContent = msg;
}

// ---------------------------------------------------------------------------
// Avvia elaborazione automatica per i PDF non ancora processati
// ---------------------------------------------------------------------------
// Elabora tutti i PDF sorgente non ancora processati, uno dopo l'altro
// ---------------------------------------------------------------------------
async function autoProcessAllPdfs() {
  if (state.isProcessing) return;
  state.isProcessing = true;
  state.abortProcessing = false;
  state.loading = true;

  // Ricarica la lista sorgenti (potrebbero essere cambiate)
  state.sourcePdfs = await apiListSourcePdfs();

  let processed = 0;
  let errors = 0;

  try {
    for (let i = 0; i < state.sourcePdfs.length; i++) {
      if (state.abortProcessing) break;

      const pdfName = state.sourcePdfs[i];

      // Controlla se già processato
      const check = await apiCheckBatchExists(pdfName);
      if (check.exists) {
        processed++;
        continue; // già processato, salta
      }

      showProcessBar(pdfName);
      updateProcessProgress(processed + 1, state.sourcePdfs.length,
        `[${i + 1}/${state.sourcePdfs.length}] ${pdfName}`);
      setStatus(`elaborazione ${i + 1}/${state.sourcePdfs.length}…`, 'saving');

      try {
        const result = await processPdf(pdfName, (cur, total, msg) => {
          updateProcessProgress(processed + errors + 1, state.sourcePdfs.length,
            `[${i + 1}/${state.sourcePdfs.length}] ${pdfName} — ${msg}`);
        });
        processed++;
        console.log(`Elaborato: ${result.folder} (${result.total_detections} box)`);
      } catch (e) {
        if (e.message === 'annullato') {
          setStatus('elaborazione annullata');
          break;
        }
        errors++;
        console.error(`Errore su ${pdfName}:`, e);
        setStatus(`errore su ${pdfName}`, 'error');
        // Continua col prossimo
      }
    }

    if (!state.abortProcessing) {
      setStatus(`elaborazione completata: ${processed} PDF, ${errors} errori`,
        errors > 0 ? 'error' : 'saved');
    }

    // Ricarica la lista e naviga all'ultimo processato
    state.folders = await apiFolders();
    if (state.folders.length > 0) {
      await gotoFolder(0);
      updateCount();
    }
  } finally {
    hideProcessBar();
    state.isProcessing = false;
    state.loading = false;
    state.abortProcessing = false;
  }
}

processAbortBtn.addEventListener('click', () => {
  state.abortProcessing = true;
  setStatus('annullamento…');
});

// Mantenuto per retrocompatibilità (elabora un singolo PDF)
async function autoProcessPdf(pdfName, folderIdx) {
  return autoProcessAllPdfs();
}

processAbortBtn.addEventListener('click', () => {
  state.abortProcessing = true;
  setStatus('annullamento…');
});

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiFolders() {
  const r = await fetch('/api/folders');
  const j = await r.json();
  return j.folders || [];
}

async function apiListSourcePdfs() {
  try {
    const r = await fetch('/api/list-source-pdfs');
    const j = await r.json();
    return j.pdfs || [];
  } catch (e) {
    return [];
  }
}

async function apiCheckBatchExists(pdfName) {
  const r = await fetch('/api/check-batch-exists?pdf=' + encodeURIComponent(pdfName));
  const j = await r.json();
  return j;
}

async function saveCurrent() {
  if (!state.dirty || !state.data) return;
  setStatus('salvataggio…', 'saving');
  try {
    const enc = encodeURIComponent(state.folders[state.folderIdx]);
    const r = await fetch('/api/data?folder=' + enc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.data),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    state.data.total_detections = j.total_detections;
    state.dirty = false;
    setStatus('salvato', 'saved');
    updateCount();
  } catch (e) {
    setStatus('errore salvataggio!', 'error');
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
async function gotoFolder(idx) {
  if (idx < 0 || idx >= state.folders.length || state.loading || state.isProcessing) return;
  state.loading = true;
  showOverlay('Caricamento PDF…');
  await saveCurrent();
  state.folderIdx = idx;
  state.pageIdx = 0;
  state.zoom = 1.0;
  state.selectedId = null;
  state.undoStack = [];
  clearCreation();
  await loadFolder();
  hideOverlay();
  state.loading = false;
}

async function gotoPage(idx) {
  if (!state.data || state.loading) return;
  const total = state.data.total_pages;
  if (idx < 0 || idx >= total) return;
  state.loading = true;
  await saveCurrent();
  state.pageIdx = idx;
  state.selectedId = null;
  state.undoStack = [];
  clearCreation();
  await renderPage();
  state.loading = false;
}

async function loadFolder() {
  const name = state.folders[state.folderIdx];
  const enc = encodeURIComponent(name);
  // data
  const r = await fetch('/api/data?folder=' + enc);
  if (!r.ok) { showOverlay('Errore caricamento JSON', r.status); return; }
  state.data = await r.json();
  // assign ids
  for (const k in state.data.pages)
    for (const b of state.data.pages[k])
      if (!b._id) b._id = nextId();
  // pdf
  if (state.pdf) { try { await state.pdf.destroy(); } catch (e) {} state.pdf = null; }
  try {
    state.pdf = await pdfjsLib.getDocument({
      url: '/api/pdf?folder=' + enc,
      standardFontDataUrl: '/vendor/standard_fonts/',
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      wasmUrl: '/vendor/wasm/',
    }).promise;
  } catch (e) {
    showOverlay('Errore apertura PDF', String(e));
    return;
  }
  // sync total_pages with the real pdf
  if (state.pdf.numPages !== state.data.total_pages) {
    state.data.total_pages = state.pdf.numPages;
    for (let i = 0; i < state.data.total_pages; i++)
      if (!state.data.pages[String(i)]) state.data.pages[String(i)] = [];
    state.dirty = true;
  }
  state.pageIdx = clamp(state.pageIdx, 0, state.data.total_pages - 1);
  updateFolderUI();
  await renderPage();
}

// ---------------------------------------------------------------------------
// Rendering (invariato)
// ---------------------------------------------------------------------------
async function renderPage() {
  if (!state.pdf) return;
  const page = await state.pdf.getPage(state.pageIdx + 1);
  const base = page.getViewport({ scale: 1 });
  state.pageBase = { w: base.width, h: base.height };
  updatePageSize();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderScale = Math.min(state.zoom * dpr, 8);
  const viewport = page.getViewport({ scale: renderScale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  if (state.renderTask) { try { state.renderTask.cancel(); } catch (e) {} }
  const ctx = canvas.getContext('2d');
  state.renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await state.renderTask.promise;
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.error(e);
    return;
  }
  renderBoxes();
  updatePageUI();
}

function updatePageSize() {
  if (!state.pageBase) return;
  const w = state.pageBase.w * state.zoom;
  const h = state.pageBase.h * state.zoom;
  pageWrap.style.width = w + 'px';
  pageWrap.style.height = h + 'px';
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}

function styleBox(div, b) {
  const { x1, y1, x2, y2 } = b.bbox;
  div.style.left = (x1 * 100) + '%';
  div.style.top = (y1 * 100) + '%';
  div.style.width = ((x2 - x1) * 100) + '%';
  div.style.height = ((y2 - y1) * 100) + '%';
}

function renderBoxes() {
  boxLayer.innerHTML = '';
  if (!state.data) return;
  const boxes = currentBoxes();
  for (const b of boxes) {
    const div = document.createElement('div');
    div.className = 'box' + (b._id === state.selectedId ? ' selected' : '');
    div.dataset.id = b._id;
    styleBox(div, b);
    if (b._id === state.selectedId) {
      for (const h of HANDLES) {
        const hd = document.createElement('div');
        hd.className = 'handle ' + h;
        hd.dataset.h = h;
        div.appendChild(hd);
      }
    }
    boxLayer.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Utils (invariati)
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function recomputeYolo(b) {
  const { x1, y1, x2, y2 } = b.bbox;
  b.bbox_yolo = { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 };
}

function makeBox(x1, y1, x2, y2) {
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  const b = { bbox: { x1, y1, x2, y2 }, bbox_yolo: { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 }, _id: nextId() };
  return b;
}

function currentBoxes() {
  const key = String(state.pageIdx);
  if (!state.data.pages[key]) state.data.pages[key] = [];
  return state.data.pages[key];
}

function getBoxById(id) {
  return currentBoxes().find(b => b._id === id) || null;
}

function normFromEvent(e) {
  const rect = pageWrap.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  return { x, y };
}

function setStatus(text, cls) {
  const s = $('status');
  s.textContent = text;
  s.className = cls || '';
}

function markDirty() {
  state.dirty = true;
  setStatus('modifiche non salvate', 'unsaved');
  updateCount();
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
function pushUndo() {
  state.undoStack.push(JSON.parse(JSON.stringify(currentBoxes())));
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
}

function undo() {
  if (!state.undoStack.length) { setStatus('nulla da annullare'); return; }
  const snap = state.undoStack.pop();
  state.data.pages[String(state.pageIdx)] = snap;
  state.selectedId = null;
  renderBoxes();
  markDirty();
  setStatus('operazione annullata');
}

// ---------------------------------------------------------------------------
// Selection / delete
// ---------------------------------------------------------------------------
function selectBox(id) {
  state.selectedId = id;
  renderBoxes();
}

function deleteSelected() {
  if (!state.selectedId) return;
  const arr = currentBoxes();
  const i = arr.findIndex(b => b._id === state.selectedId);
  if (i < 0) return;
  pushUndo();
  arr.splice(i, 1);
  state.selectedId = null;
  renderBoxes();
  markDirty();
  setStatus('box eliminato');
}

// ---------------------------------------------------------------------------
// Box creation
// ---------------------------------------------------------------------------
function startCreation(n) {
  if (!state.createCorner) {
    state.createCorner = { x: n.x, y: n.y };
    showCornerMarker(n);
    setStatus('click sull\'angolo opposto per creare il box (Esc per annullare)');
  } else {
    const a = state.createCorner;
    const x1 = Math.min(a.x, n.x), y1 = Math.min(a.y, n.y);
    const x2 = Math.max(a.x, n.x), y2 = Math.max(a.y, n.y);
    clearCreation();
    if ((x2 - x1) < MIN_SIZE || (y2 - y1) < MIN_SIZE) {
      setStatus('box troppo piccolo, ignorato');
      return;
    }
    pushUndo();
    const box = makeBox(x1, y1, x2, y2);
    currentBoxes().push(box);
    state.selectedId = box._id;
    renderBoxes();
    markDirty();
    setStatus('box creato');
  }
}

function clearCreation() {
  state.createCorner = null;
  cornerMarker.style.display = 'none';
  rubber.style.display = 'none';
}

function showCornerMarker(n) {
  cornerMarker.style.left = (n.x * 100) + '%';
  cornerMarker.style.top = (n.y * 100) + '%';
  cornerMarker.style.display = 'block';
}

function updateRubber(e) {
  if (!state.createCorner) return;
  const n = normFromEvent(e);
  const a = state.createCorner;
  const x1 = Math.min(a.x, n.x), y1 = Math.min(a.y, n.y);
  const x2 = Math.max(a.x, n.x), y2 = Math.max(a.y, n.y);
  rubber.style.left = (x1 * 100) + '%';
  rubber.style.top = (y1 * 100) + '%';
  rubber.style.width = ((x2 - x1) * 100) + '%';
  rubber.style.height = ((y2 - y1) * 100) + '%';
  rubber.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Move / resize
// ---------------------------------------------------------------------------
function startMove(e, id) {
  const b = getBoxById(id); if (!b) return;
  state.drag = { type: 'move', id, startBox: { ...b.bbox }, startCX: e.clientX, startCY: e.clientY, undone: false };
  try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
}

function startResize(e, id, handle) {
  const b = getBoxById(id); if (!b) return;
  state.drag = { type: 'resize', id, handle, startBox: { ...b.bbox }, startCX: e.clientX, startCY: e.clientY, undone: false };
  try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
}

function handleDrag(e) {
  const d = state.drag;
  const b = getBoxById(d.id);
  if (!b) return;
  if (!d.undone) { pushUndo(); d.undone = true; }
  const rect = pageWrap.getBoundingClientRect();
  const dx = (e.clientX - d.startCX) / rect.width;
  const dy = (e.clientY - d.startCY) / rect.height;
  const s = d.startBox;
  if (d.type === 'move') {
    const w = s.x2 - s.x1, h = s.y2 - s.y1;
    const x1 = clamp(s.x1 + dx, 0, 1 - w);
    const y1 = clamp(s.y1 + dy, 0, 1 - h);
    b.bbox = { x1, y1, x2: x1 + w, y2: y1 + h };
  } else {
    let { x1, y1, x2, y2 } = s;
    if (d.handle.includes('w')) x1 = clamp(s.x1 + dx, 0, s.x2 - MIN_SIZE);
    if (d.handle.includes('e')) x2 = clamp(s.x2 + dx, s.x1 + MIN_SIZE, 1);
    if (d.handle.includes('n')) y1 = clamp(s.y1 + dy, 0, s.y2 - MIN_SIZE);
    if (d.handle.includes('s')) y2 = clamp(s.y2 + dy, s.y1 + MIN_SIZE, 1);
    b.bbox = { x1, y1, x2, y2 };
  }
  recomputeYolo(b);
  const div = boxLayer.querySelector('.box[data-id="' + b._id + '"]');
  if (div) styleBox(div, b);
  markDirty();
}

function endDrag() { state.drag = null; }

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------
function overlapCoef(a, b) {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const minArea = Math.min(areaA, areaB);
  if (minArea <= 0) return 0;
  return inter / minArea;
}

function mergeBoxes() {
  const boxes = currentBoxes();
  if (boxes.length < 2) { setStatus('meno di 2 box, niente da unire'); return; }
  const n = boxes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  let merges = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (overlapCoef(boxes[i].bbox, boxes[j].bbox) >= OVERLAP_THRESHOLD) { union(i, j); merges++; }
  if (merges === 0) { setStatus('nessuna sovrapposizione >= 40%'); return; }
  const groups = {};
  for (let i = 0; i < n; i++) { const r = find(i); (groups[r] = groups[r] || []).push(i); }
  pushUndo();
  const result = [];
  for (const k in groups) {
    const idxs = groups[k];
    if (idxs.length === 1) { result.push(boxes[idxs[0]]); continue; }
    let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
    for (const i of idxs) { const b = boxes[i].bbox; x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
    result.push(makeBox(x1, y1, x2, y2));
  }
  result.sort((a, b) => a.bbox.y1 - b.bbox.y1 || a.bbox.x1 - b.bbox.x1);
  state.data.pages[String(state.pageIdx)] = result;
  state.selectedId = null;
  renderBoxes();
  markDirty();
  setStatus('merge completato: ' + (n - result.length) + ' box uniti');
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function setZoom(z) {
  z = clamp(z, 0.2, 6);
  if (Math.abs(z - state.zoom) < 1e-4) return;
  state.zoom = z;
  updatePageSize();
  scheduleRender();
  updateZoomUI();
}

function fitWidth() {
  if (!state.pageBase) return;
  const avail = pageView.clientWidth - 48;
  setZoom(avail / state.pageBase.w);
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderPage(); }, 110);
}

// ---------------------------------------------------------------------------
// UI updates
// ---------------------------------------------------------------------------
function updateFolderUI() {
  $('folder-name').textContent = state.folders[state.folderIdx] || '-';
  $('folder-name').title = state.folders[state.folderIdx] || '';
}

function updatePageUI() {
  $('page-info').textContent = `pag. ${state.pageIdx + 1}/${state.data.total_pages}`;
}

function updateZoomUI() {
  $('zoom-info').textContent = Math.round(state.zoom * 100) + '%';
}

function updateCount() {
  if (!state.data) return;
  const total = Object.values(state.data.pages).reduce((s, v) => s + v.length, 0);
  $('count-info').textContent = `${currentBoxes().length} in pagina · ${total} totali`;
}

function showOverlay(msg, sub) {
  $('overlay-msg').textContent = msg;
  $('overlay-sub').textContent = sub || '';
  overlay.classList.add('show');
}

function hideOverlay() { overlay.classList.remove('show'); }

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
boxLayer.addEventListener('pointerdown', (e) => {
  if (state.loading) return;
  const boxEl = e.target.closest('.box');
  if (boxEl) {
    const id = boxEl.dataset.id;
    selectBox(id);
    clearCreation();
    const handleEl = e.target.closest('.handle');
    if (handleEl) startResize(e, id, handleEl.dataset.h);
    else startMove(e, id);
    return;
  }
  startCreation(normFromEvent(e));
});

window.addEventListener('pointermove', (e) => {
  if (state.drag) { handleDrag(e); return; }
  if (state.createCorner) updateRubber(e);
});

window.addEventListener('pointerup', () => { if (state.drag) endDrag(); });
window.addEventListener('pointercancel', () => { if (state.drag) endDrag(); });

$('prev-pdf').addEventListener('click', () => gotoFolder(state.folderIdx - 1));
$('next-pdf').addEventListener('click', () => gotoFolder(state.folderIdx + 1));
$('prev-page').addEventListener('click', () => gotoPage(state.pageIdx - 1));
$('next-page').addEventListener('click', () => gotoPage(state.pageIdx + 1));
$('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('zoom-reset').addEventListener('click', () => setZoom(1));
$('zoom-fit').addEventListener('click', fitWidth);
$('merge-btn').addEventListener('click', mergeBoxes);
$('delete-btn').addEventListener('click', deleteSelected);
$('undo-btn').addEventListener('click', undo);
$('save-btn').addEventListener('click', () => saveCurrent());

pageView.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault(); undo(); return;
  }

  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); gotoFolder(state.folderIdx - 1); break;
    case 'ArrowDown': e.preventDefault(); gotoFolder(state.folderIdx + 1); break;
    case 'ArrowLeft': e.preventDefault(); gotoPage(state.pageIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); gotoPage(state.pageIdx + 1); break;
    case 'Delete':
    case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case 'Escape':
      clearCreation();
      state.selectedId = null;
      renderBoxes();
      setStatus('pronto');
      break;
    case '+': case '=': setZoom(state.zoom * 1.2); break;
    case '-': case '_': setZoom(state.zoom / 1.2); break;
    case '0': setZoom(1); break;
  }
});

function saveSync() {
  if (!state.dirty || !state.data) return;
  try {
    const enc = encodeURIComponent(state.folders[state.folderIdx]);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/data?folder=' + enc, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(state.data));
    if (xhr.status === 200) state.dirty = false;
  } catch (e) { /* best effort */ }
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    saveSync();
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { updatePageSize(); }, 120);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function initEditor() {
  setStatus('caricamento…');
  state.folders = await apiFolders();
  state.sourcePdfs = await apiListSourcePdfs();

  // Carica il modello ONNX in background (dopo che l'UI è pronta)
  loadModel().then(() => {
    console.log('Modello ONNX caricato, pronto per elaborazione');
  }).catch(err => {
    console.warn('Impossibile caricare il modello ONNX:', err);
  });

  if (state.folders.length > 0) {
    // Ci sono cartelle già processate → apri la prima
    await gotoFolder(0);
    updateCount();
    setStatus('pronto');
    return;
  }

  // Nessuna cartella processata → controlla se ci sono PDF sorgente
  if (state.sourcePdfs.length > 0) {
    console.log(`Trovati ${state.sourcePdfs.length} PDF da elaborare automaticamente`);
    // Pre-carica il modello e poi avvia elaborazione automatica
    setStatus('caricamento modello IA…', 'saving');
    try {
      await loadModel();
    } catch (e) {
      showOverlay('Errore caricamento modello', String(e));
      return;
    }

    showOverlay(
      'Avvio elaborazione automatica…',
      `Rilevamento highlight con IA su ${state.sourcePdfs.length} PDF…`
    );
    await autoProcessAllPdfs();
  } else {
    // Non c'è nulla
    showOverlay(
      'Nessun PDF trovato',
      'Inserisci i PDF nella cartella pdf/ o in batch_output(3)/ (con results.json e PDF)'
    );
    return;
  }
}

// Avvio
initEditor();
