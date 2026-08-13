/**
 * Diagnostics — telemetria leggera per il debug su dispositivo reale.
 *
 * iOS Safari non espone `performance.memory` e in caso di crash (Jetsam
 * o crash del processo GPU) la tab viene ricaricata senza lasciare
 * traccia in console. Questo modulo serve a rendere il crash
 * "visibile" e a ridurre il danno:
 *
 *  1. Traccia la fase corrente della pipeline in sessionStorage: dopo
 *     un crash, al reload sappiamo esattamente dove si è interrotto
 *     (e possiamo mostrarlo all'utente).
 *  2. Mostra un banner informativo quando rileva un run interrotto:
 *     la pipeline NON viene modificata (nessuna riduzione automatica
 *     della memoria) — l'utente riprova semplicemente come prima.
 *  3. Stima i byte dei canvas vivi (registro interno, aggiornato da
 *     geometry.js e createApp.js) e li logga con console.log a ogni
 *     fase: visibili da Safari Web Inspector (Mac + cavo USB).
 *  4. Handler globali per eccezioni e promise non gestite: su iOS
 *     Safari un errore JS può far sembrare "morto" il sito; qui almeno
 *     viene loggato e mostrato nella UI.
 */
const RUN_KEY = 'markout-run';

/** Contatori canvas vivi (aggiornati da trackCanvasCreated/Released). */
let _liveCount = 0;
let _liveBytes = 0;

/**
 * Registra un canvas appena creato (per il monitoraggio memoria).
 * @param {HTMLCanvasElement} canvas
 */
export function trackCanvasCreated(canvas) {
  if (!canvas) return;
  _liveCount += 1;
  _liveBytes += (canvas.width || 0) * (canvas.height || 0) * 4;
}

/**
 * Registra il rilascio di un canvas (width=0 → bitmap liberata).
 * @param {HTMLCanvasElement|null} canvas
 */
export function trackCanvasReleased(canvas) {
  if (!canvas) return;
  _liveCount = Math.max(0, _liveCount - 1);
  _liveBytes = Math.max(0, _liveBytes - (canvas.width || 0) * (canvas.height || 0) * 4);
}

/**
 * Log di memoria a una fase della pipeline.
 * @param {string} label
 */
export function logMem(label) {
  const heap = (typeof performance !== 'undefined' && performance.memory)
    ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB`
    : 'n/a';
  const t = (typeof performance !== 'undefined') ? (performance.now() / 1000).toFixed(1) : '?';
  console.log(`[MEM] ${label} — canvas vivi: ${_liveCount} (${(_liveBytes / 1048576).toFixed(1)}MB), JS heap: ${heap}, t=${t}s`);
}

/* ─── Tracciamento run (sessionStorage) ─── */

/**
 * Avvia il tracciamento di un run di elaborazione.
 * @param {string} fileName
 */
export function beginRun(fileName) {
  try {
    sessionStorage.setItem(RUN_KEY, JSON.stringify({
      file: fileName,
      phase: 'start',
      t: Date.now(),
    }));
  } catch { /* sessionStorage potrebbe non essere disponibile */ }
}

/**
 * Aggiorna la fase corrente del run.
 * @param {string} phase — 'yolo' | 'ocr' | 'done'
 * @param {string} [detail] — es. 'page 2/9'
 */
export function updateRunPhase(phase, detail = '') {
  try {
    const raw = sessionStorage.getItem(RUN_KEY);
    if (!raw) return;
    const run = JSON.parse(raw);
    run.phase = phase;
    run.detail = detail;
    run.t = Date.now();
    sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch { /* noop */ }
}

/**
 * Chiude il run (successo o errore gestito): il marker sparisce.
 */
export function endRun() {
  try {
    sessionStorage.removeItem(RUN_KEY);
  } catch { /* noop */ }
}

/**
 * Ritorna il run interrotto (started ma mai concluso), o null.
 * Usato all'avvio per rilevare un crash precedente.
 * @returns {{ file: string, phase: string, detail: string, t: number }|null}
 */
export function getStaleRun() {
  try {
    const raw = sessionStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const run = JSON.parse(raw);
    if (!run || run.phase === 'done') return null;
    return run;
  } catch {
    return null;
  }
}

/* ─── Banner crash / modalità sicura ─── */

function showBanner(html, buttons) {
  const old = document.getElementById('markout-banner');
  if (old) old.remove();

  const banner = document.createElement('div');
  banner.id = 'markout-banner';
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
    'background:#fff8e1', 'color:#5d4037', 'border-bottom:2px solid #ffc107',
    'padding:10px 14px', 'font-size:14px', 'line-height:1.5',
    'box-shadow:0 2px 8px rgba(0,0,0,.15)', 'display:flex',
    'flex-wrap:wrap', 'gap:8px', 'align-items:center', 'justify-content:center',
  ].join(';');
  banner.innerHTML = `<span>${html}</span>`;
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.style.cssText = 'padding:6px 12px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
    btn.style.background = b.primary ? '#1976d2' : '#e0e0e0';
    btn.style.color = b.primary ? '#fff' : '#333';
    btn.addEventListener('click', b.action);
    banner.appendChild(btn);
  }
  document.body.prepend(banner);
}

/**
 * All'avvio: se un run precedente si è interrotto (crash), mostra un
 * banner informativo con la fase esatta. La pipeline resta SEMPRE
 * invariata: nessuna riduzione automatica di risoluzione o batch.
 */
function initCrashBanner() {
  const stale = getStaleRun();
  if (!stale) return;

  const phaseLabel = {
    start: 'startup',
    yolo: 'highlight detection (YOLO)',
    ocr: 'text recognition (OCR)',
  }[stale.phase] || stale.phase;
  const where = stale.detail ? ` (${stale.detail})` : '';

  showBanner(
    `⚠️ The previous processing was <strong>interrupted during ${phaseLabel}${where}</strong> (insufficient memory or browser crash). ` +
    `You can simply retry: the pipeline is unchanged.`,
    [
      { label: 'OK', primary: true, action: () => document.getElementById('markout-banner')?.remove() },
    ]
  );
}

/* ─── Handler globali errori ─── */

function tryShowError(msg) {
  try {
    const err = document.getElementById('error');
    const errMsg = document.getElementById('errorMsg');
    const loading = document.getElementById('loading');
    if (!err || !errMsg) return;
    errMsg.textContent = msg;
    if (loading) loading.classList.add('hidden');
    err.classList.remove('hidden');
  } catch { /* noop */ }
}

function initGlobalErrorHandlers() {
  window.addEventListener('error', e => {
    const msg = e.message || 'Unknown error';
    console.error('[FATAL]', msg, e.filename ? `${e.filename}:${e.lineno}` : '');
    tryShowError(`Unexpected error: ${msg}`);
  });
  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    const msg = (reason && (reason.message || reason.toString())) || 'Rejected promise';
    console.error('[FATAL] unhandled rejection:', reason);
    tryShowError(`Unexpected error: ${msg}`);
  });
}

/**
 * Inizializza i diagnostics all'avvio dell'app.
 */
export function initDiagnostics() {
  initGlobalErrorHandlers();
  initCrashBanner();
  logMem('[DIAG] App avviata');
}
