/**
 * DOM — riferimenti agli elementi DOM e funzioni di utilità UI.
 */
import { IS_MOBILE, canUseWebgpu } from '../config/device.js';
import { probeWebgpu } from '../services/yoloService.js';

/* ─── Helpers ─── */
const $ = id => document.getElementById(id);

/* ─── DOM refs ─── */
export const uploadArea = $('uploadArea');
export const fileInput = $('fileInput');
export const loading = $('loading');
export const progressFill = $('progressFill');
export const progressStep = $('progressStep');
export const progressCount = $('progressCount');
export const result = $('result');
export const noHighlights = $('noHighlights');
export const error = $('error');
export const errorMsg = $('errorMsg');
export const markdownOut = $('markdownOutput');
export const resultMeta = $('resultMeta');
export const copyBtn = $('copyBtn');
export const downloadBtn = $('downloadBtn');
export const downloadBBoxBtn = $('downloadBBoxBtn');
export const copyReportBtn = $('copyReportBtn');
export const downloadReportBtn = $('downloadReportBtn');
export const debugReportOut = $('debugReport');
export const cropContainer = $('cropContainer');
export const pdfViewer = $('pdfViewer');
export const yoloFragsView = $('yoloFrags');
export const rowsView = $('rowsContainer');
export const allRowsView = $('allRowsContainer');
export const viewTabs = $('viewTabs');

/* ─── Lingua OCR fissa ───
 * Il modello di riconoscimento è unico e self-hosted
 * (PP-OCRv6_small_rec): copre l'inglese e le lingue latine più comuni
 * (it, fr, de, es, pt, nl…). La lingua è quindi FISSA a 'en' — niente
 * selettore: il modello è già precaricato per tutte le lingue che
 * supporta.
 */

/* ─── Progress ─── */

/**
 * Aggiorna la barra di progresso.
 *
 * @param {string} step — messaggio descrittivo
 * @param {number} current — passo corrente nella fase
 * @param {number} total — totale passi nella fase
 * @param {number[]} [weightRange] — intervallo percentuale [min, max] su scala globale
 */
export function setProgress(step, current, total, weightRange) {
  loading.classList.remove('hidden');
  if (progressStep) progressStep.textContent = step || 'Processing…';

  let pct;
  if (weightRange && total > 0) {
    const [lo, hi] = weightRange;
    pct = lo + (current / total) * (hi - lo);
  } else if (total > 0) {
    pct = Math.round((current / total) * 100);
  } else {
    pct = 0;
  }

  pct = Math.min(100, Math.max(0, pct));
  if (progressFill) progressFill.style.width = pct + '%';
  const prog = document.getElementById('loading');
  if (prog) prog.setAttribute('aria-valuenow', String(pct));
  if (progressCount && total > 0) {
    progressCount.textContent = `${current}/${total}`;
  } else if (progressCount) {
    progressCount.textContent = '';
  }
}

/**
 * Mostra il loading con un messaggio.
 * @param {string} msg
 */
export function showLoading(msg) {
  loading.classList.remove('hidden');
  if (progressStep) progressStep.textContent = msg || 'Processing…';
  if (progressCount) progressCount.textContent = '';
  if (progressFill) progressFill.style.width = '';
}

/**
 * Nasconde tutti i pannelli (loading, result, noHighlights, error).
 */
export function hideAll() {
  loading.classList.add('hidden');
  result.classList.add('hidden');
  noHighlights.classList.add('hidden');
  error.classList.add('hidden');
}

/* ─── Theme Toggle ─── */

/**
 * Inizializza il toggle tema scuro/chiaro.
 */
export function initThemeToggle() {
  const html = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;

  const syncThemeColor = (dark) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1117' : '#ffffff');
  };

  themeToggle.addEventListener('click', () => {
    // NB: non usare toggleAttribute('data-theme'): imposta un valore vuoto
    // (data-theme="") che non fa match con il selettore CSS [data-theme="dark"].
    const dark = html.getAttribute('data-theme') !== 'dark';
    if (dark) html.setAttribute('data-theme', 'dark');
    else html.removeAttribute('data-theme');
    localStorage.setItem('markout-theme', dark ? 'dark' : 'light');
    syncThemeColor(dark);
  });

  if (localStorage.getItem('markout-theme') === 'dark') {
    html.setAttribute('data-theme', 'dark');
    syncThemeColor(true);
  }
}

/* ─── OCR Language ─── */

/**
 * Restituisce la lingua OCR (fissa: il modello rec è unico e copre
 * inglese + lingue latine comuni — vedi PADDLEOCR_LANG).
 * @returns {string}
 */
export function getSelectedLang() {
  return 'en';
}

/* ─── WebGPU disattivabile (desktop) ───
 * WebGPU è il default su desktop; l'utente può spegnerlo se il suo
 * dispositivo crasha o rallenta (localStorage 'markout-webgpu' = 'off' →
 * WASM forzato). Su mobile il controllo resta nascosto (WASM sempre).
 * Il flag viene letto a ogni caricamento modelli: ha effetto al
 * prossimo upload senza bisogno di reload.
 */
export function initWebgpuToggle() {
  const wrap = document.getElementById('accelWrap');
  const toggle = document.getElementById('webgpuToggle');
  if (!wrap || !toggle) return;

  // Browser/PC senza WebGPU (browser senza API, mobile, RAM ≤ 4GB):
  // lo slider non viene mostrato affatto.
  if (!canUseWebgpu()) {
    wrap.classList.add('hidden');
    return;
  }

  const read = () => { try { return localStorage.getItem('markout-webgpu') !== 'off'; } catch { return true; } };
  toggle.checked = read();

  toggle.addEventListener('change', async () => {
    try {
      if (toggle.checked) localStorage.removeItem('markout-webgpu');
      else localStorage.setItem('markout-webgpu', 'off');
    } catch { /* noop */ }

    // La UI riflette subito la scelta dello slider
    if (!toggle.checked) {
      updateAcceleratorBadge('wasm'); // disattivato → CPU Mode (WASM)
      console.log('[WebGPU] disabled — WASM forced on next upload');
      return;
    }

    // Riattivato: probe reale sull'adapter prima di promettere la GPU
    updateAcceleratorBadge(null); // ⏳ Detecting…
    const ok = await probeWebgpu();
    updateAcceleratorBadge(ok ? 'webgpu' : 'wasm');
    console.log(`[WebGPU] enabled — probe ${ok ? 'OK (WebGPU)' : 'failed (WASM)'}`);
  });
}

/* ─── Badge accelerazione ─── */

/**
 * Crea o aggiorna il badge che mostra il backend di inferenza (GPU/CPU).
 * La visualizzazione è differenziata per dispositivo:
 *   - Desktop: '⚡ GPU Acceleration' (WebGPU) / '♻️ CPU Mode (WASM)'.
 *   - Mobile:  '📱 GPU · Low Memory' (WebGPU a memoria minimale) /
 *              '📱 CPU Mode (WASM)'.
 * @param {'webgpu'|'wasm'|null} provider
 */
export function updateAcceleratorBadge(provider) {
  let badge = document.getElementById('accelBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'accelBadge';
    badge.className = 'accel-badge';
    // Slot a spazio fisso dentro l'area upload: il drag-and-drop non si ridimensiona
    const slot = document.getElementById('accelBadgeSlot');
    if (slot) {
      slot.appendChild(badge);
    } else {
      const hint = document.querySelector('.upload-hint');
      if (hint && hint.parentNode) hint.parentNode.insertBefore(badge, hint.nextSibling);
    }
  }

  if (provider === 'webgpu') {
    badge.textContent = IS_MOBILE ? '📱 GPU · Low Memory' : '⚡ GPU Acceleration';
    badge.className = 'accel-badge accel-gpu';
    badge.title = IS_MOBILE
      ? 'WebGPU active with minimal-memory profile (reduced crops/batches)'
      : 'YOLO inference accelerated via WebGPU';
  } else if (provider === 'wasm') {
    badge.textContent = IS_MOBILE ? '📱 CPU Mode (WASM)' : '♻️ CPU Mode (WASM)';
    badge.className = 'accel-badge accel-cpu';
    badge.title = 'WebGPU not available — running on CPU via WASM';
  } else {
    badge.textContent = '⏳ Detecting…';
    badge.className = 'accel-badge accel-loading';
    badge.title = 'Loading model…';
  }
}

/* ─── Hamburger (mobile) ─── */

/**
 * Inizializza l'hamburger menu per mobile.
 */
/**
 * Formatta la data corrente in formato italiano.
 * @returns {string}
 */
export function fmtDate() {
  return new Date().toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * Inizializza l'hamburger menu per mobile.
 */
export function initHamburger() {
  const hamburger = document.getElementById('hamburger');
  const headerNav = document.getElementById('headerNav');
  if (!hamburger || !headerNav) return;

  const close = () => headerNav.classList.remove('nav-open');
  hamburger.addEventListener('click', () => headerNav.classList.toggle('nav-open'));
  document.addEventListener('click', e => {
    if (!hamburger.contains(e.target) && !headerNav.contains(e.target)) close();
  });
  // Esc chiude il menu (WCAG 2.1.2)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* ─── Debug mode ─── */

/**
 * Nasconde o mostra gli elementi UI riservati alla modalità debug
 * (tab Bounding Box, Evidenziazioni, Frammenti YOLO, pulsante scarica BBox).
 *
 * @param {boolean} isDebug
 */
export function initDebugMode(isDebug) {
  const debugTabs = ['bbox', 'crops', 'yolo', 'rows', 'allrows', 'report'];
  const tabBtns = viewTabs?.querySelectorAll('.tab-btn') ?? [];
  
  for (const btn of tabBtns) {
    const view = btn.dataset.view;
    if (debugTabs.includes(view)) {
      btn.classList.toggle('hidden', !isDebug);
    }
  }

  document.querySelectorAll('.debug-only').forEach(el => {
    el.classList.toggle('hidden', !isDebug);
  });

  if (!isDebug) {
    // Se debug disattivato, attiva la tab Markdown per default
    const markdownTab = viewTabs?.querySelector('.tab-btn[data-view="markdown"]');
    if (markdownTab) markdownTab.click();
  }
}
