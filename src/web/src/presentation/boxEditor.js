/**
 * Box Editor — tab "Edit highlights" (produzione + debug).
 *
 * Permette di scorrere tutto il PDF (pagine impilate, scroll con la
 * rotella come le tab di debug), vedere i box YOLO che alimentano la
 * pipeline, ridimensionarli, spostarli, eliminarli e aggiungerne di
 * nuovi — con undo/redo (Ctrl+Z / Ctrl+Shift+Z) — e di rielaborare
 * l'intera pipeline (layout + crop + OCR + Markdown) usando i box
 * modificati al posto della detection YOLO.
 *
 * Rendering: ogni pagina ha un canvas base (immagine) + un overlay
 * (box/maniglie). Le pagine vengono renderizzate lazily quando entrano
 * nel viewport (IntersectionObserver) e rilasciate quando si allontanano
 * troppo (> 8 pagine): layout stabile (aspect-ratio dal PDF) e memoria
 * contenuta anche su PDF lunghi.
 *
 * Interazioni:
 *  - click su un box → seleziona (maniglie visibili)
 *  - trascina il corpo → sposta · trascina bordi/angoli → ridimensiona
 *  - trascina su un'area vuota → disegna un nuovo box
 *  - il cursore cambia SOLO sui box (move/resize), altrove resta default
 *  - Del/Backspace → elimina il selezionato · Esc → deseleziona
 *  - ←/→ pagina precedente/successiva (con selezione: nudge ±1px,
 *    Shift = 10px) · PgUp/PgDn cambiano pagina · rotella = scroll libero
 *  - Ctrl+Z annulla · Ctrl+Shift+Z / Ctrl+Y ripeti
 */
import { editorPages } from '../app/state.js';
import { reprocessPages, showFinalResult, getEditablePdf } from '../app/createApp.js';
import { renderPageToCanvas } from '../services/pdfService.js';
import { loadModel, runYOLOInference } from '../services/yoloService.js';
import { showLoading, hideAll } from './dom.js';
import { t } from '../i18n.js';

const EDIT_MAX_LONG = 1400;   // lato lungo max del canvas di visualizzazione (px)
const HANDLE_HIT = 8;         // raggio (px display) per agganciare le maniglie
const MIN_BOX = 4;            // dimensione minima box (px originali)
const RELEASE_DISTANCE = 8;   // pagine oltre questa distanza vengono rilasciate

const $ = id => document.getElementById(id);

/* ─── Stato editor ─── */
let pages = [];      // editorPages della run corrente (baseline)
let edits = null;    // Map<pageNum, boxes[]> copie di lavoro
let hist = [];       // [{page, before, after}] snapshot completi per pagina
let histPos = -1;
let busy = false;    // true durante la rielaborazione
let viewIdx = 0;     // pagina più visibile (toolbar/tastiera)
let selected = { p: -1, i: -1 };  // pagina (indice) e box selezionati
let drag = null;     // {p, mode, startX, startY, pageBefore, idx, handle, cur}
let confirmArmed = false;
let confirmTimer = null;
let reDetecting = false;  // true durante il re-detect YOLO della pagina
let zoom = 1;             // fattore zoom display (1 = fit container)
let addMode = false;      // modalità "aggiungi box": il click avvia il drag di creazione
let listEl = null;
let io = null;
let scrollRaf = null;
let pageViews = [];  // {wrap, base, baseCtx, ov, ovCtx, s, rendered, idx}

/* ─── Accessori ─── */
const pageOf = idx => pages[idx];
const boxesOf = idx => edits.get(pageOf(idx).pageNum);

/* ─── Annunci per screen reader (aria-live) ─── */
function announce(text) {
  const live = $('editLive');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

/** Disarma il pulsante di conferma (ripristina l'etichetta). */
function setConfirmLabel(text) {
  const btn = $('editConfirm');
  if (!btn) return;
  const span = btn.querySelector('[data-i18n]');
  if (span) span.textContent = text;
  else btn.textContent = text;
}

function disarmConfirm() {
  confirmArmed = false;
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  const btn = $('editConfirm');
  if (btn) {
    btn.classList.remove('armed');
    setConfirmLabel(t('edit.confirm', 'Confirm & re-process'));
  }
}

/* ─── Ciclo di vita ─── */

export function initBoxEditor() {
  listEl = $('editPages');
  if (!listEl) return;

  $('editPrev')?.addEventListener('click', () => gotoPage(viewIdx - 1));
  $('editNext')?.addEventListener('click', () => gotoPage(viewIdx + 1));
  $('editUndo')?.addEventListener('click', undo);
  $('editRedo')?.addEventListener('click', redo);
  $('editDelete')?.addEventListener('click', deleteSelected);
  $('editRedetect')?.addEventListener('click', redetectPage);
  $('editZoomOut')?.addEventListener('click', () => setZoom(zoom / 1.25));
  $('editZoomIn')?.addEventListener('click', () => setZoom(zoom * 1.25));
  $('editZoomReset')?.addEventListener('click', () => setZoom(1));
  $('editAddBox')?.addEventListener('click', () => setAddMode(!addMode));
  $('editConfirm')?.addEventListener('click', confirmReprocess);

  document.addEventListener('keydown', onKeyDown);

  io = new IntersectionObserver(onIntersect, {
    root: listEl,
    rootMargin: '200% 0px',
  });

  // Scroll → aggiorna la pagina "corrente" (throttle via rAF)
  listEl.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateViewIdx();
    });
  }, { passive: true });

  // Ctrl+rotella = zoom (WIG Touch & Interaction)
  listEl.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

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
  viewIdx = 0;
  selected = { p: -1, i: -1 };
  drag = null;
  pageViews = [];
  if (listEl) listEl.innerHTML = '';
  disarmConfirm();
  updateToolbar();
}

/**
 * Sincronizza l'editor con editorPages (fine run o rielaborazione).
 */
export function syncBoxEditor() {
  pages = [...editorPages];
  edits = new Map(pages.map(p => [p.pageNum, p.boxes.map(b => ({ ...b }))]));
  hist = [];
  histPos = -1;
  viewIdx = 0;
  selected = { p: -1, i: -1 };
  drag = null;
  buildPageViews();
  updateToolbar();
}

/**
 * True mentre la rielaborazione è in corso (guardia anti-upload).
 * @returns {boolean}
 */
export function isReprocessing() {
  return busy;
}

/**
 * Attiva la tab: renderizza le pagine vicine al punto di scroll.
 */
export function activateBoxEditor() {
  if (!pages.length) return;
  // Renderizza la pagina corrente e un piccolo intorno subito
  const lo = Math.max(0, viewIdx - 2);
  const hi = Math.min(pages.length - 1, viewIdx + 4);
  for (let i = lo; i <= hi; i++) renderPage(i);
  updateToolbar();
}

/* ─── DOM pagine ─── */

function buildPageViews() {
  if (!listEl) return;
  if (io) io.disconnect();
  listEl.innerHTML = '';
  pageViews = pages.map((p, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'editor-page-wrap';
    wrap.style.aspectRatio = `${p.w} / ${p.h}`;

    const label = document.createElement('div');
    label.className = 'editor-page-label';
    label.textContent = t('edit.pageOf', 'Page {n}').replace('{n}', String(p.pageNum));
    wrap.appendChild(label);

    const base = document.createElement('canvas');
    base.className = 'editor-page-base';
    base.setAttribute('aria-hidden', 'true');
    const ov = document.createElement('canvas');
    ov.className = 'editor-page-ov';
    ov.tabIndex = 0;
    ov.setAttribute('role', 'img');
    ov.setAttribute('aria-label',
      `${t('edit.canvasLabel', 'Highlight boxes editor.')} — ${t('edit.pageOf', 'Page {n}').replace('{n}', String(p.pageNum))}`);
    ov.setAttribute('aria-describedby', 'editHint');

    wrap.appendChild(base);
    wrap.appendChild(ov);

    ov.addEventListener('pointerdown', e => onPointerDown(e, idx));
    ov.addEventListener('pointermove', e => onPointerMove(e, idx));
    ov.addEventListener('pointerup', e => onPointerUp(e, idx));
    ov.addEventListener('pointercancel', e => onPointerUp(e, idx));
    ov.addEventListener('pointerleave', () => { ov.style.cursor = 'default'; });

    listEl.appendChild(wrap);
    return {
      wrap, base, ov,
      baseCtx: base.getContext('2d'),
      ovCtx: ov.getContext('2d'),
      s: 0,
      rendered: false,
      idx,
    };
  });
  pageViews.forEach(v => io.observe(v.wrap));
}

function onIntersect(entries) {
  for (const e of entries) {
    const v = pageViews.find(pv => pv.wrap === e.target);
    if (!v) continue;
    if (e.isIntersecting) {
      renderPage(v.idx);
    } else if (Math.abs(v.idx - viewIdx) > RELEASE_DISTANCE) {
      releasePage(v.idx);
    }
  }
}

/* ─── Rendering pagine ─── */

async function renderPage(idx) {
  const v = pageViews[idx];
  if (!v || v.rendered) return;
  v.rendered = true; // guardia rientro
  const p = pageOf(idx);
  const pdf = getEditablePdf();
  if (!pdf) {
    v.rendered = false;
    return;
  }
  v.ov.setAttribute('aria-busy', 'true');
  try {
    const full = await renderPageToCanvas(pdf, p.pageNum);
    v.s = Math.min(1, EDIT_MAX_LONG / Math.max(full.width, full.height));
    v.base.width = Math.max(1, Math.round(full.width * v.s));
    v.base.height = Math.max(1, Math.round(full.height * v.s));
    v.baseCtx.drawImage(full, 0, 0, v.base.width, v.base.height);
    full.width = 0;
    full.height = 0;
    v.ov.width = v.base.width;
    v.ov.height = v.base.height;
    drawPage(idx);
    updateToolbar();
  } catch (err) {
    console.warn('[EDITOR] render page failed:', err);
    v.rendered = false;
  } finally {
    v.ov.setAttribute('aria-busy', 'false');
  }
}

function releasePage(idx) {
  const v = pageViews[idx];
  if (!v || !v.rendered) return;
  v.base.width = 0;
  v.base.height = 0;
  v.ov.width = 0;
  v.ov.height = 0;
  v.rendered = false;
}

/** Disegna box/maniglie/rubber-band sull'overlay della pagina. */
function drawPage(idx) {
  const v = pageViews[idx];
  if (!v || !v.rendered || !v.ov.width) return;
  const ctx = v.ovCtx;
  ctx.clearRect(0, 0, v.ov.width, v.ov.height);
  const boxes = boxesOf(idx) || [];
  const s = v.s;

  boxes.forEach((b, i) => {
    const x = b.x1 * s, y = b.y1 * s, bw = (b.x2 - b.x1) * s, bh = (b.y2 - b.y1) * s;
    const isSel = selected.p === idx && selected.i === i;
    ctx.fillStyle = isSel ? 'rgba(255, 140, 60, 0.28)' : 'rgba(0, 220, 80, 0.14)';
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = isSel ? '#FF6B35' : 'rgba(0, 200, 70, 0.75)';
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.strokeRect(x, y, bw, bh);
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.fillText(String(i + 1), x + 3, y + 12);
    ctx.shadowBlur = 0;
    if (isSel) drawHandles(ctx, b, s);
  });

  if (drag && drag.p === idx && drag.mode === 'draw2' && drag.cur) {
    const r = drag.cur;
    ctx.strokeStyle = '#FF6B35';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x * s, r.y * s, (r.x2 - r.x) * s, (r.y2 - r.y) * s);
    ctx.setLineDash([]);
  }

  if (drag && drag.p === idx && drag.mode === 'draw' && drag.cur) {
    const r = drag.cur;
    ctx.strokeStyle = '#FF6B35';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x * s, r.y * s, (r.x2 - r.x) * s, (r.y2 - r.y) * s);
    ctx.setLineDash([]);
  }
}

function drawHandles(ctx, b, s) {
  const x1 = b.x1 * s, y1 = b.y1 * s, x2 = b.x2 * s, y2 = b.y2 * s;
  const pts = [
    [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
    [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
    [x1, y2], [x1, (y1 + y2) / 2],
  ];
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#FF6B35';
  ctx.lineWidth = 1.5;
  for (const [hx, hy] of pts) {
    ctx.beginPath();
    ctx.rect(hx - 4, hy - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
}

/* ─── Coordinate ─── */

/** Punto del puntatore in coordinate pagina originali (+ copia display). */
function eventPoint(e, v) {
  const r = v.ov.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (v.ov.width / r.width);
  const my = (e.clientY - r.top) * (v.ov.height / r.height);
  return { x: mx / v.s, y: my / v.s, dx: mx, dy: my };
}

/** Maniglia del box colpita in coordinate display (null se nessuna). */
function hitHandle(box, v, dx, dy) {
  const s = v.s;
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

/** Box sotto il puntatore (top-most) o -1. */
function hitBox(p, boxes) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2) return i;
  }
  return -1;
}

const CURSOR_HANDLE = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

/* ─── Interazioni pointer ─── */

function onPointerDown(e, idx) {
  if (busy || e.button !== 0) return;
  const v = pageViews[idx];
  if (!v || !v.rendered) return;
  const p = eventPoint(e, v);
  const boxes = boxesOf(idx);

  // 0) Modalità aggiungi: click-to-click — il primo click fissa il punto
  //    iniziale, il secondo chiude il rettangolo (niente drag tenuto)
  if (addMode) {
    if (drag && drag.mode === 'draw2' && drag.p === idx) {
      // Secondo click: finalizza il box
      const c = drag.cur;
      if (c && (c.x2 - c.x) >= MIN_BOX && (c.y2 - c.y) >= MIN_BOX) {
        boxes.push({ x1: c.x, y1: c.y, x2: c.x2, y2: c.y2, score: 1.0 });
        selected = { p: idx, i: boxes.length - 1 };
        pushHistory(pageOf(idx).pageNum, drag.pageBefore, boxes.map(b => ({ ...b })));
        announce(t('edit.liveAdded', 'Box added').replace('{n}', String(boxes.length)));
      }
      drag = null;
      setAddMode(false); // one-shot
      drawPage(idx);
      updateToolbar();
      return;
    }
    // Primo click: avvia il disegno
    selected = { p: -1, i: -1 };
    drag = {
      p: idx, mode: 'draw2', idx: null,
      startX: p.x, startY: p.y,
      pageBefore: boxes.map(b => ({ ...b })),
      cur: { x: p.x, y: p.y, x2: p.x, y2: p.y },
    };
    drawPage(idx);
    updateToolbar();
    return;
  }

  // 1) Maniglie del box selezionato → resize
  if (selected.p === idx && selected.i >= 0 && boxes[selected.i]) {
    const h = hitHandle(boxes[selected.i], v, p.dx, p.dy);
    if (h) {
      drag = {
        p: idx, mode: 'resize', handle: h, idx: selected.i,
        startX: p.x, startY: p.y,
        pageBefore: boxes.map(b => ({ ...b })),
      };
      v.ov.style.cursor = CURSOR_HANDLE[h];
      v.ov.setPointerCapture(e.pointerId);
      return;
    }
  }

  // 2) Box sotto il puntatore → select + move
  const hit = hitBox(p, boxes);
  if (hit >= 0) {
    selected = { p: idx, i: hit };
    drag = {
      p: idx, mode: 'move', idx: hit,
      startX: p.x, startY: p.y,
      pageBefore: boxes.map(b => ({ ...b })),
    };
    v.ov.style.cursor = 'move';
    v.ov.setPointerCapture(e.pointerId);
    drawPage(idx);
    updateToolbar();
    return;
  }

  // 3) Area vuota → disegna un nuovo box (cursore invariato: default)
  selected = { p: -1, i: -1 };
  drag = {
    p: idx, mode: 'draw', idx: null,
    startX: p.x, startY: p.y,
    pageBefore: boxes.map(b => ({ ...b })),
  };
  v.ov.setPointerCapture(e.pointerId);
  drawPage(idx);
  updateToolbar();
}

function onPointerMove(e, idx) {
  const v = pageViews[idx];
  if (!v || !v.rendered) return;

  if (!drag) {
    // Nessun drag: il cursore cambia SOLO sui box (move/resize);
    // in modalità aggiungi è una croce su tutta la pagina.
    const p = eventPoint(e, v);
    if (addMode) {
      v.ov.style.cursor = 'crosshair';
      return;
    }
    const boxes = boxesOf(idx);
    let cursor = 'default';
    if (selected.p === idx && selected.i >= 0 && boxes[selected.i]) {
      const h = hitHandle(boxes[selected.i], v, p.dx, p.dy);
      if (h) cursor = CURSOR_HANDLE[h];
    }
    if (cursor === 'default' && hitBox(p, boxes) >= 0) cursor = 'move';
    v.ov.style.cursor = cursor;
    return;
  }
  if (drag.p !== idx) return;

  const p = eventPoint(e, v);
  const boxes = boxesOf(idx);
  const pge = pageOf(idx);
  const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, val));

  if (drag.mode === 'move') {
    const b = boxes[drag.idx];
    const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
    const nx = clamp(drag.pageBefore[drag.idx].x1 + (p.x - drag.startX), 0, pge.w - bw);
    const ny = clamp(drag.pageBefore[drag.idx].y1 + (p.y - drag.startY), 0, pge.h - bh);
    b.x1 = nx; b.y1 = ny; b.x2 = nx + bw; b.y2 = ny + bh;
  } else if (drag.mode === 'resize') {
    const b = boxes[drag.idx];
    const h = drag.handle;
    let { x1, y1, x2, y2 } = drag.pageBefore[drag.idx];
    if (h.includes('w')) x1 = clamp(p.x, 0, x2 - MIN_BOX);
    if (h.includes('e')) x2 = clamp(p.x, x1 + MIN_BOX, pge.w);
    if (h.includes('n')) y1 = clamp(p.y, 0, y2 - MIN_BOX);
    if (h.includes('s')) y2 = clamp(p.y, y1 + MIN_BOX, pge.h);
    b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
  } else if (drag.mode === 'draw2') {
    // click-to-click: il rettangolo segue il puntatore senza pulsante premuto
    v.ov.style.cursor = 'crosshair';
    const x = clamp(p.x, 0, pge.w);
    const y = clamp(p.y, 0, pge.h);
    drag.cur = {
      x: Math.min(drag.startX, x), y: Math.min(drag.startY, y),
      x2: Math.max(drag.startX, x), y2: Math.max(drag.startY, y),
    };
  } else if (drag.mode === 'draw') {
    const x = clamp(p.x, 0, pge.w);
    const y = clamp(p.y, 0, pge.h);
    drag.cur = {
      x: Math.min(drag.startX, x), y: Math.min(drag.startY, y),
      x2: Math.max(drag.startX, x), y2: Math.max(drag.startY, y),
    };
  }
  drawPage(idx);
}

function onPointerUp(e, idx) {
  if (!drag || drag.p !== idx) return;
  const v = pageViews[idx];
  const boxes = boxesOf(idx);
  const page = pageOf(idx).pageNum;

  // In modalità click-to-click il rilascio NON finalizza: si chiude col
  // secondo click (vedi onPointerDown).
  if (drag.mode === 'draw2') {
    if (v) {
      try { v.ov.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    return;
  }

  if (drag.mode === 'draw') {
    const c = drag.cur;
    if (c && (c.x2 - c.x) >= MIN_BOX && (c.y2 - c.y) >= MIN_BOX) {
      boxes.push({ x1: c.x, y1: c.y, x2: c.x2, y2: c.y2, score: 1.0 });
      selected = { p: idx, i: boxes.length - 1 };
      pushHistory(page, drag.pageBefore, boxes.map(b => ({ ...b })));
      announce(t('edit.liveAdded', 'Box added').replace('{n}', String(boxes.length)));
      if (addMode) setAddMode(false); // one-shot: si disattiva dopo la creazione
    }
  } else {
    pushHistory(page, drag.pageBefore, boxes.map(b => ({ ...b })));
  }

  drag = null;
  if (v) {
    v.ov.style.cursor = 'default';
    try { v.ov.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }
  drawPage(idx);
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
  selected = { p: -1, i: -1 };
  edits.set(entry.page, entry[side].map(b => ({ ...b })));
  if (pageViews[idx]?.rendered) drawPage(idx);
  scrollToPage(idx);
  updateToolbar();
}

function undo() {
  if (busy || histPos < 0) return;
  const e = hist[histPos];
  histPos--;
  applyEntry(e, 'before');
  announce(t('edit.liveUndo', 'Undone'));
}

function redo() {
  if (busy || histPos + 1 >= hist.length) return;
  histPos++;
  applyEntry(hist[histPos], 'after');
  announce(t('edit.liveRedo', 'Redone'));
}

/* ─── Operazioni ─── */

function deleteSelected() {
  if (busy || selected.p < 0 || selected.i < 0) return;
  const idx = selected.p;
  const boxes = boxesOf(idx);
  const page = pageOf(idx).pageNum;
  const before = boxes.map(b => ({ ...b }));
  boxes.splice(selected.i, 1);
  selected = { p: -1, i: -1 };
  pushHistory(page, before, boxes.map(b => ({ ...b })));
  announce(t('edit.liveDeleted', 'Box deleted').replace('{n}', String(boxes.length)));
  if (pageViews[idx]?.rendered) drawPage(idx);
  updateToolbar();
}

/** Nudge del box selezionato (step in px pagina). */
function nudge(dx, dy, step) {
  if (busy || selected.p < 0 || selected.i < 0) return;
  const idx = selected.p;
  const boxes = boxesOf(idx);
  const b = boxes[selected.i];
  const page = pageOf(idx).pageNum;
  const pge = pageOf(idx);
  const before = boxes.map(x => ({ ...x }));
  const nx = Math.min(Math.max(0, b.x1 + dx * step), pge.w - (b.x2 - b.x1));
  const ny = Math.min(Math.max(0, b.y1 + dy * step), pge.h - (b.y2 - b.y1));
  b.x1 = nx; b.y1 = ny; b.x2 = nx + (b.x2 - b.x1); b.y2 = ny + (b.y2 - b.y1);
  pushHistory(page, before, boxes.map(x => ({ ...x })));
  if (pageViews[idx]?.rendered) drawPage(idx);
  updateToolbar();
}

/* ─── Navigazione pagine ─── */

function scrollToPage(idx) {
  const v = pageViews[idx];
  if (!v) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  v.wrap.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

async function gotoPage(idx) {
  if (!pages.length) return;
  const n = Math.min(pages.length - 1, Math.max(0, idx));
  viewIdx = n;
  scrollToPage(n);
  renderPage(n);
  updateToolbar();
}

/** Aggiorna viewIdx in base alla pagina più visibile nello scroll. */
function updateViewIdx() {
  if (!listEl || !pageViews.length) return;
  const rect = listEl.getBoundingClientRect();
  let best = viewIdx;
  let bestArea = -1;
  for (const v of pageViews) {
    const r = v.wrap.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top));
    if (visible > bestArea) {
      bestArea = visible;
      best = v.idx;
    }
  }
  if (best !== viewIdx) {
    viewIdx = best;
    updateToolbar();
  }
}

/* ─── Zoom ─── */

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (listEl) {
    for (const w of listEl.querySelectorAll('.editor-page-wrap')) {
      w.style.width = (100 * zoom) + '%';
    }
  }
  const lab = $('editZoomLabel');
  if (lab) lab.textContent = Math.round(zoom * 100) + '%';
  // Aggiorna la pagina più visibile dopo il cambio di layout
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    updateViewIdx();
  });
}

/* ─── Modalità "aggiungi box" ───
 * Con il pulsante Add box attivo, UN click sulla pagina avvia il drag
 * per disegnare il nuovo box (cursore a croce); dopo la creazione la
 * modalità si disattiva da sola (one-shot). Esc annulla.
 */
function setAddMode(on) {
  addMode = on;
  const btn = $('editAddBox');
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  for (const v of pageViews) {
    if (v?.ov) v.ov.style.cursor = on ? 'crosshair' : 'default';
  }
  if (on) announce(t('edit.addOn', 'Click and drag on the page to draw a box'));
}

/* ─── Re-detect (YOLO sulla pagina corrente) ─── */

/**
 * Riesegue la detection YOLO sulla pagina corrente e sostituisce i box
 * della pagina con il risultato (con voce nella cronologia undo).
 */
async function redetectPage() {
  if (busy || reDetecting || !pages.length) return;
  const idx = viewIdx;
  const pdf = getEditablePdf();
  if (!pdf) return;

  reDetecting = true;
  updateToolbar();
  const pge = pageOf(idx);
  announce(t('edit.redetectRunning', 'Re-detecting highlights…'));
  try {
    await loadModel(); // il modello può essere stato rilasciato a fine run
    const canvas = await renderPageToCanvas(pdf, pge.pageNum);
    const { mergedBoxes } = await runYOLOInference(canvas);
    canvas.width = 0;
    canvas.height = 0;

    const boxes = boxesOf(idx);
    const before = boxes.map(b => ({ ...b }));
    const fresh = mergedBoxes.map(b => ({
      x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
      score: Number.isFinite(b.score) ? b.score : 1.0,
    }));
    boxes.splice(0, boxes.length, ...fresh);
    selected = { p: -1, i: -1 };
    pushHistory(pge.pageNum, before, boxes.map(b => ({ ...b })));
    if (pageViews[idx]?.rendered) drawPage(idx);
    announce(t('edit.liveRedetected', 'Detection refreshed').replace('{n}', String(boxes.length)));
  } catch (err) {
    console.error('[EDITOR] re-detect failed:', err);
    announce(err.message || 'Re-detect failed');
  } finally {
    reDetecting = false;
    updateToolbar();
  }
}

/* ─── Pagine modificate (per il re-process parziale) ─── */

/** Confronto box (stesso ordine, stesse coordinate). */
function boxesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.x1 !== y.x1 || x.y1 !== y.y1 || x.x2 !== y.x2 || x.y2 !== y.y2) return false;
  }
  return true;
}

/**
 * Pagine le cui modifiche differiscono dalla baseline dell'ultima run
 * (draw/move/resize/delete/nudge/re-detect — l'undo ripristina e la
 * pagina torna pulita).
 * @returns {Array<number>}
 */
function dirtyPages() {
  const out = [];
  for (const p of pages) {
    const cur = edits.get(p.pageNum);
    if (!boxesEqual(cur, p.boxes)) out.push(p.pageNum);
  }
  return out;
}

/* ─── Rielaborazione ─── */

/**
 * Conferma: rielabora l'intera pipeline con i box modificati.
 * Azione distruttiva (sovrascrive il risultato corrente) → conferma
 * a due passi: primo click arma il pulsante, secondo click esegue.
 */
async function confirmReprocess() {
  if (busy || !pages.length) return;
  const pdf = getEditablePdf();
  if (!pdf) return;

  // Solo le pagine effettivamente modificate vengono rielaborate
  const dirty = dirtyPages();
  if (!dirty.length) {
    announce(t('edit.nothing', 'No changes to re-process'));
    return;
  }

  if (!confirmArmed) {
    confirmArmed = true;
    const btn = $('editConfirm');
    if (btn) {
      btn.classList.add('armed');
      setConfirmLabel(t('edit.confirmAgain', 'Click again to confirm'));
    }
    announce(t('edit.confirmAgain', 'Click again to confirm'));
    confirmTimer = setTimeout(disarmConfirm, 4000);
    return;
  }
  disarmConfirm();

  const all = {};
  let total = 0;
  for (const pn of dirty) {
    const bs = (edits.get(pn) || []).map(b => ({ ...b }));
    all[pn] = bs;
    total += bs.length;
  }

  busy = true;
  showLoading(t('edit.reprocessing', `Re-processing your boxes (${total})…`));
  try {
    resetBoxEditor();
    await reprocessPages(pdf, all, new Set(dirty));
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
    const cur = pages.length ? pageOf(viewIdx).pageNum : 0;
    lab.textContent = t('edit.page', 'Page {c}/{n}')
      .replace('{c}', String(cur))
      .replace('{n}', String(pages.length));
  }
  const u = $('editUndo'), r = $('editRedo'), d = $('editDelete');
  if (u) u.disabled = histPos < 0;
  if (r) r.disabled = histPos + 1 >= hist.length;
  if (d) d.disabled = selected.p < 0;
  const prev = $('editPrev'), next = $('editNext'), conf = $('editConfirm'), rd = $('editRedetect'), ab = $('editAddBox');
  if (prev) prev.disabled = pages.length <= 1 || viewIdx === 0;
  if (next) next.disabled = pages.length <= 1 || viewIdx >= pages.length - 1;
  if (rd) rd.disabled = !pages.length || busy || reDetecting;
  if (ab) ab.disabled = !pages.length || busy;
  if (conf) {
    const dirty = pages.length ? dirtyPages().length : 0;
    conf.disabled = !pages.length || busy || dirty === 0;
    conf.title = dirty === 0 ? t('edit.nothing', 'No changes to re-process') : '';
  }
  disarmConfirm();
}

function onKeyDown(e) {
  const editor = $('boxEditor');
  if (!editor || editor.classList.contains('hidden')) return;
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'BUTTON' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;

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
  if (mod && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    setZoom(zoom * 1.25);
    return;
  }
  if (mod && e.key === '-') {
    e.preventDefault();
    setZoom(zoom / 1.25);
    return;
  }
  if (mod && e.key === '0') {
    e.preventDefault();
    setZoom(1);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === 'Escape') {
    selected = { p: -1, i: -1 };
    drag = null;
    if (addMode) setAddMode(false);
    if (pageViews[viewIdx]?.rendered) drawPage(viewIdx);
    updateToolbar();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (selected.p >= 0 && !mod) {
      nudge(e.key === 'ArrowLeft' ? -1 : 1, 0, e.shiftKey ? 10 : 1);
    } else {
      gotoPage(viewIdx + (e.key === 'ArrowLeft' ? -1 : 1));
    }
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected.p >= 0 && !mod) {
    e.preventDefault();
    nudge(0, e.key === 'ArrowUp' ? -1 : 1, e.shiftKey ? 10 : 1);
    return;
  }
  if (e.key === 'PageUp') {
    e.preventDefault();
    gotoPage(viewIdx - 1);
    return;
  }
  if (e.key === 'PageDown') {
    e.preventDefault();
    gotoPage(viewIdx + 1);
  }
}
