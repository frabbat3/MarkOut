/**
 * Box Editor — tab "Edit highlights" (produzione + debug).
 *
 * Permette di scorrere tutto il PDF, vedere i box YOLO che alimentano
 * la pipeline, ridimensionarli, spostarli, eliminarli e aggiungerne di
 * nuovi — con undo/redo (Ctrl+Z / Ctrl+Shift+Z) — e di rielaborare
 * l'intera pipeline (layout + crop + OCR + Markdown) usando i box
 * modificati al posto della detection YOLO.
 *
 * Interazioni sul canvas:
 *  - click su un box → seleziona (maniglie visibili)
 *  - trascina il corpo → sposta
 *  - trascina bordi/angoli → ridimensiona
 *  - trascina su un'area vuota → disegna un nuovo box
 *  - Del/Backspace → elimina il box selezionato · Esc → deseleziona
 *  - ←/→ pagina precedente/successiva (con selezione: nudge ±1px,
 *    Shift = 10px) · PgUp/PgDn cambiano pagina
 *  - Ctrl+Z annulla · Ctrl+Shift+Z / Ctrl+Y ripeti
 */
import { editorPages } from '../app/state.js';
import { processPDF, showFinalResult, getEditablePdf } from '../app/createApp.js';
import { renderPageToCanvas } from '../services/pdfService.js';
import { showLoading, hideAll } from './dom.js';
import { t } from '../i18n.js';

const EDIT_MAX_LONG = 1400;   // lato lungo max del canvas di visualizzazione (px)
const HANDLE_HIT = 8;         // raggio (px display) per agganciare le maniglie
const MIN_BOX = 4;            // dimensione minima box (px originali)

const $ = id => document.getElementById(id);

/* ─── Stato editor ─── */
let pages = [];      // editorPages della run corrente (baseline)
let edits = null;    // Map<pageNum, boxes[]> copie di lavoro
let hist = [];       // [{page, before, after}] snapshot completi per pagina
let histPos = -1;
let curIdx = 0;
let selected = -1;   // indice nel box array della pagina corrente
let busy = false;    // true durante la rielaborazione

let pageSrc = null;  // canvas full-res della pagina corrente
let dispCanvas = null;
let dispCtx = null;
let dispScale = 1;

/** @type {null|{mode:string,startX:number,startY:number,pageBefore:Array,idx:number,handle:string,cur?:Object}} */
let drag = null;

/* ─── Accessori ─── */
const curPage = () => pages[curIdx];
const curBoxes = () => (edits && curPage() ? edits.get(curPage().pageNum) : null);

/* ─── Ciclo di vita ─── */

export function initBoxEditor() {
  dispCanvas = $('editCanvas');
  if (!dispCanvas) return;
  dispCtx = dispCanvas.getContext('2d');

  dispCanvas.addEventListener('pointerdown', onPointerDown);
  dispCanvas.addEventListener('pointermove', onPointerMove);
  dispCanvas.addEventListener('pointerup', onPointerUp);
  dispCanvas.addEventListener('pointercancel', onPointerUp);

  $('editPrev')?.addEventListener('click', () => gotoPage(curIdx - 1));
  $('editNext')?.addEventListener('click', () => gotoPage(curIdx + 1));
  $('editUndo')?.addEventListener('click', undo);
  $('editRedo')?.addEventListener('click', redo);
  $('editDelete')?.addEventListener('click', deleteSelected);
  $('editConfirm')?.addEventListener('click', confirmReprocess);

  document.addEventListener('keydown', onKeyDown);
  updateToolbar();
}

/**
 * Resetta l'editor (nuovo upload o prima di una rielaborazione).
 */
export function resetBoxEditor() {
  pages = [];
  edits = null;
  hist = [];
  histPos = -1;
  curIdx = 0;
  selected = -1;
  drag = null;
  releasePageSrc();
  updateToolbar();
  drawScene();
}

/**
 * Sincronizza l'editor con editorPages (fine run o rielaborazione).
 */
export function syncBoxEditor() {
  pages = [...editorPages];
  edits = new Map(pages.map(p => [p.pageNum, p.boxes.map(b => ({ ...b }))]));
  hist = [];
  histPos = -1;
  curIdx = 0;
  selected = -1;
  drag = null;
  releasePageSrc();
  updateToolbar();
  drawScene();
}

/**
 * True mentre la rielaborazione è in corso (guardia anti-upload).
 * @returns {boolean}
 */
export function isReprocessing() {
  return busy;
}

/**
 * Attiva la tab: renderizza la pagina corrente (lazy, una sola volta).
 */
export async function activateBoxEditor() {
  if (!pages.length) return;
  if (!pageSrc) {
    await renderCurrentPage();
  } else {
    drawScene();
    updateToolbar();
  }
}

/* ─── Rendering ─── */

function releasePageSrc() {
  if (pageSrc) {
    pageSrc.width = 0;
    pageSrc.height = 0;
    pageSrc = null;
  }
}

/**
 * Renderizza la pagina corrente a risoluzione piena e la mostra
 * ridimensionata (fit). Le coordinate dei box restano quelle
 * originali della pipeline: dispScale fa la conversione.
 */
async function renderCurrentPage() {
  const pdf = getEditablePdf();
  const p = curPage();
  if (!pdf || !p) return;
  const full = await renderPageToCanvas(pdf, p.pageNum);
  releasePageSrc();
  pageSrc = full;
  dispScale = Math.min(1, EDIT_MAX_LONG / Math.max(full.width, full.height));
  dispCanvas.width = Math.max(1, Math.round(full.width * dispScale));
  dispCanvas.height = Math.max(1, Math.round(full.height * dispScale));
  drawScene();
  updateToolbar();
}

function drawScene() {
  if (!dispCtx || !dispCanvas) return;
  const w = dispCanvas.width, h = dispCanvas.height;
  dispCtx.clearRect(0, 0, w, h);
  if (pageSrc) dispCtx.drawImage(pageSrc, 0, 0, w, h);
  if (!pages.length || !edits) return;

  const boxes = curBoxes() || [];
  const s = dispScale;
  boxes.forEach((b, i) => {
    const x = b.x1 * s, y = b.y1 * s, bw = (b.x2 - b.x1) * s, bh = (b.y2 - b.y1) * s;
    const isSel = i === selected;
    dispCtx.fillStyle = isSel ? 'rgba(255, 140, 60, 0.28)' : 'rgba(0, 220, 80, 0.14)';
    dispCtx.fillRect(x, y, bw, bh);
    dispCtx.strokeStyle = isSel ? '#FF6B35' : 'rgba(0, 200, 70, 0.75)';
    dispCtx.lineWidth = isSel ? 2.5 : 1.5;
    dispCtx.strokeRect(x, y, bw, bh);
    // Numero del box (1-based, ordine array)
    dispCtx.font = 'bold 11px sans-serif';
    dispCtx.fillStyle = '#fff';
    dispCtx.shadowColor = 'rgba(0,0,0,0.8)';
    dispCtx.shadowBlur = 3;
    dispCtx.fillText(String(i + 1), x + 3, y + 12);
    dispCtx.shadowBlur = 0;
    if (isSel) drawHandles(b);
  });

  // Rettangolo in disegno (rubber band)
  if (drag && drag.mode === 'draw' && drag.cur) {
    const r = drag.cur;
    dispCtx.strokeStyle = '#FF6B35';
    dispCtx.lineWidth = 2;
    dispCtx.setLineDash([6, 4]);
    dispCtx.strokeRect(r.x * s, r.y * s, (r.x2 - r.x) * s, (r.y2 - r.y) * s);
    dispCtx.setLineDash([]);
  }
}

function drawHandles(b) {
  const s = dispScale;
  const x1 = b.x1 * s, y1 = b.y1 * s, x2 = b.x2 * s, y2 = b.y2 * s;
  const pts = [
    [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
    [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
    [x1, y2], [x1, (y1 + y2) / 2],
  ];
  dispCtx.fillStyle = '#fff';
  dispCtx.strokeStyle = '#FF6B35';
  dispCtx.lineWidth = 1.5;
  for (const [hx, hy] of pts) {
    dispCtx.beginPath();
    dispCtx.rect(hx - 4, hy - 4, 8, 8);
    dispCtx.fill();
    dispCtx.stroke();
  }
}

/* ─── Coordinate ─── */

/** Punto del puntatore in coordinate pagina originali (+ copia display). */
function eventPoint(e) {
  const r = dispCanvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (dispCanvas.width / r.width);
  const my = (e.clientY - r.top) * (dispCanvas.height / r.height);
  return { x: mx / dispScale, y: my / dispScale, dx: mx, dy: my };
}

/** Maniglia del box selezionato colpita in coordinate display. */
function hitHandle(box, dx, dy) {
  const s = dispScale;
  const x1 = box.x1 * s, y1 = box.y1 * s, x2 = box.x2 * s, y2 = box.y2 * s;
  const pts = [
    ['nw', x1, y1], ['n', (x1 + x2) / 2, y1], ['ne', x2, y1],
    ['e', x2, (y1 + y2) / 2], ['se', x2, y2], ['s', (x1 + x2) / 2, y2],
    ['sw', x1, y2], ['w', x1, (y1 + y2) / 2],
  ];
  for (const [h, hx, hy] of pts) {
    if (Math.abs(dx - hx) <= HANDLE_HIT && Math.abs(dy - hy) <= HANDLE_HIT) return h;
  }
  return null;
}

/* ─── Interazioni pointer ─── */

function onPointerDown(e) {
  if (busy || !pages.length || !pageSrc || e.button !== 0) return;
  const p = eventPoint(e);
  const boxes = curBoxes();

  // 1) Maniglie del box selezionato → resize
  if (selected >= 0 && boxes[selected]) {
    const h = hitHandle(boxes[selected], p.dx, p.dy);
    if (h) {
      drag = {
        mode: 'resize', handle: h, idx: selected,
        startX: p.x, startY: p.y,
        pageBefore: boxes.map(b => ({ ...b })),
      };
      dispCanvas.setPointerCapture(e.pointerId);
      return;
    }
  }

  // 2) Box sotto il puntatore (top-most = ultimo) → select + move
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2) {
      selected = i;
      drag = {
        mode: 'move', idx: i,
        startX: p.x, startY: p.y,
        pageBefore: boxes.map(x => ({ ...x })),
      };
      dispCanvas.setPointerCapture(e.pointerId);
      drawScene();
      return;
    }
  }

  // 3) Area vuota → disegna un nuovo box
  selected = -1;
  drag = {
    mode: 'draw', idx: null,
    startX: p.x, startY: p.y,
    pageBefore: boxes.map(b => ({ ...b })),
  };
  dispCanvas.setPointerCapture(e.pointerId);
  drawScene();
}

function onPointerMove(e) {
  if (!drag || !pageSrc) return;
  const p = eventPoint(e);
  const boxes = curBoxes();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  if (drag.mode === 'move') {
    const b = boxes[drag.idx];
    const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
    const nx = clamp(drag.pageBefore[drag.idx].x1 + (p.x - drag.startX), 0, pageSrc.width - bw);
    const ny = clamp(drag.pageBefore[drag.idx].y1 + (p.y - drag.startY), 0, pageSrc.height - bh);
    b.x1 = nx; b.y1 = ny; b.x2 = nx + bw; b.y2 = ny + bh;
  } else if (drag.mode === 'resize') {
    const b = boxes[drag.idx];
    const h = drag.handle;
    let { x1, y1, x2, y2 } = drag.pageBefore[drag.idx];
    if (h.includes('w')) x1 = clamp(p.x, 0, x2 - MIN_BOX);
    if (h.includes('e')) x2 = clamp(p.x, x1 + MIN_BOX, pageSrc.width);
    if (h.includes('n')) y1 = clamp(p.y, 0, y2 - MIN_BOX);
    if (h.includes('s')) y2 = clamp(p.y, y1 + MIN_BOX, pageSrc.height);
    b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
  } else if (drag.mode === 'draw') {
    const x = clamp(p.x, 0, pageSrc.width);
    const y = clamp(p.y, 0, pageSrc.height);
    drag.cur = {
      x: Math.min(drag.startX, x), y: Math.min(drag.startY, y),
      x2: Math.max(drag.startX, x), y2: Math.max(drag.startY, y),
    };
  }
  drawScene();
}

function onPointerUp(e) {
  if (!drag) return;
  const boxes = curBoxes();
  const page = curPage().pageNum;

  if (drag.mode === 'draw') {
    const c = drag.cur;
    if (c && (c.x2 - c.x) >= MIN_BOX && (c.y2 - c.y) >= MIN_BOX) {
      boxes.push({ x1: c.x, y1: c.y, x2: c.x2, y2: c.y2, score: 1.0 });
      selected = boxes.length - 1;
      pushHistory(page, drag.pageBefore, boxes.map(b => ({ ...b })));
    }
  } else {
    pushHistory(page, drag.pageBefore, boxes.map(b => ({ ...b })));
  }

  drag = null;
  try { dispCanvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  drawScene();
  updateToolbar();
}

/* ─── Undo / Redo ─── */

function pushHistory(page, before, after) {
  hist = hist.slice(0, histPos + 1);
  hist.push({ page, before, after });
  histPos = hist.length - 1;
}

function applyEntry(entry, side) {
  const idx = pages.findIndex(p => p.pageNum === entry.page);
  if (idx < 0) return;
  curIdx = idx;
  selected = -1;
  edits.set(entry.page, entry[side].map(b => ({ ...b })));
  renderCurrentPage(); // async: drawScene + updateToolbar interni
}

function undo() {
  if (busy || histPos < 0) return;
  const e = hist[histPos];
  histPos--;
  applyEntry(e, 'before');
}

function redo() {
  if (busy || histPos + 1 >= hist.length) return;
  histPos++;
  applyEntry(hist[histPos], 'after');
}

/* ─── Operazioni ─── */

function deleteSelected() {
  if (busy || !pages.length || selected < 0) return;
  const boxes = curBoxes();
  const page = curPage().pageNum;
  const before = boxes.map(b => ({ ...b }));
  boxes.splice(selected, 1);
  selected = -1;
  pushHistory(page, before, boxes.map(b => ({ ...b })));
  drawScene();
  updateToolbar();
}

/** Nudge del box selezionato (step in px pagina). */
function nudge(dx, dy, step) {
  if (busy || !pages.length || selected < 0 || !pageSrc) return;
  const boxes = curBoxes();
  const b = boxes[selected];
  const page = curPage().pageNum;
  const before = boxes.map(x => ({ ...x }));
  const nx = Math.min(Math.max(0, b.x1 + dx * step), pageSrc.width - (b.x2 - b.x1));
  const ny = Math.min(Math.max(0, b.y1 + dy * step), pageSrc.height - (b.y2 - b.y1));
  b.x1 = nx; b.y1 = ny; b.x2 = nx + (b.x2 - b.x1); b.y2 = ny + (b.y2 - b.y1);
  pushHistory(page, before, boxes.map(x => ({ ...x })));
  drawScene();
}

async function gotoPage(idx) {
  if (!pages.length) return;
  const n = Math.min(pages.length - 1, Math.max(0, idx));
  if (n === curIdx && pageSrc) {
    drawScene();
    updateToolbar();
    return;
  }
  curIdx = n;
  selected = -1;
  drag = null;
  await renderCurrentPage();
}

/* ─── Rielaborazione ─── */

/**
 * Conferma: rielabora l'intera pipeline con i box modificati.
 * Salta la detection YOLO e usa i box dell'editor per pagina.
 */
async function confirmReprocess() {
  if (busy || !pages.length) return;
  const pdf = getEditablePdf();
  if (!pdf) return;

  const all = {};
  let total = 0;
  for (const p of pages) {
    const bs = (edits.get(p.pageNum) || []).map(b => ({ ...b }));
    all[p.pageNum] = bs;
    total += bs.length;
  }

  busy = true;
  showLoading(t('edit.reprocessing', `Re-processing with your boxes (${total})…`));
  try {
    resetBoxEditor();
    await processPDF(pdf, { editedBoxes: all });
    await showFinalResult();
    syncBoxEditor();
    const { switchView } = await import('./resultRenderer.js');
    switchView('markdown');
  } catch (err) {
    console.error('[EDITOR] Re-process failed:', err);
    hideAll();
    const error = $('error');
    const errorMsg = $('errorMsg');
    if (error && errorMsg) {
      errorMsg.textContent = err.message || 'Error during re-processing.';
      error.classList.remove('hidden');
    }
  } finally {
    busy = false;
  }
}

/* ─── Toolbar & scorciatoie ─── */

function updateToolbar() {
  const lab = $('editPageLabel');
  if (lab) {
    lab.textContent = t('edit.page', 'Page {c}/{n}')
      .replace('{c}', pages.length ? String(curIdx + 1) : '0')
      .replace('{n}', String(pages.length));
  }
  const u = $('editUndo'), r = $('editRedo'), d = $('editDelete');
  if (u) u.disabled = histPos < 0;
  if (r) r.disabled = histPos + 1 >= hist.length;
  if (d) d.disabled = selected < 0;
  const prev = $('editPrev'), next = $('editNext'), conf = $('editConfirm');
  if (prev) prev.disabled = pages.length <= 1 || curIdx === 0;
  if (next) next.disabled = pages.length <= 1 || curIdx >= pages.length - 1;
  if (conf) conf.disabled = !pages.length || busy;
}

function onKeyDown(e) {
  const editor = $('boxEditor');
  if (!editor || editor.classList.contains('hidden')) return;
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;

  const mod = e.ctrlKey || e.metaKey;

  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === 'Escape') {
    selected = -1;
    drag = null;
    drawScene();
    updateToolbar();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (selected >= 0 && !mod) {
      nudge(e.key === 'ArrowLeft' ? -1 : 1, 0, e.shiftKey ? 10 : 1);
    } else {
      gotoPage(curIdx + (e.key === 'ArrowLeft' ? -1 : 1));
    }
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected >= 0 && !mod) {
    e.preventDefault();
    nudge(0, e.key === 'ArrowUp' ? -1 : 1, e.shiftKey ? 10 : 1);
    return;
  }
  if (e.key === 'PageUp') {
    e.preventDefault();
    gotoPage(curIdx - 1);
    return;
  }
  if (e.key === 'PageDown') {
    e.preventDefault();
    gotoPage(curIdx + 1);
  }
}
