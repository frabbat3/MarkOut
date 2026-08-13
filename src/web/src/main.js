/**
 * MarkOut — Entry point.
 *
 * Inizializza tema, UI, upload, export, e avvia l'app.
 *
 * Pipeline: PDF → render → HT_detector_v7.9.onnx → crop → PaddleOCR.js
 *
 * Build: Vite (npm run dev / npm run build)
 */
import { DEBUG } from './config/pipeline.js';
import { IS_MOBILE } from './config/device.js';
import { initCookieBanner, initGitHubStars, registerServiceWorker, initLangSwitch } from './banner.js';
import { initI18n } from './i18n.js';
import { initThemeToggle, initHamburger, initDebugMode, updateAcceleratorBadge, initWebgpuToggle } from './presentation/dom.js';
import { initTabs } from './presentation/resultRenderer.js';
import { initUploadController } from './presentation/uploadController.js';
import { initMarkdownExport } from './presentation/markdownExporter.js';
import { initBBoxExport } from './presentation/bboxExporter.js';
import { loadModel, getProvider } from './services/yoloService.js';
import { initPaddleOCR } from './services/ocrService.js';
import { initDebugConsole } from './presentation/debugConsole.js';
import { initDebugInspector } from './presentation/debugInspector.js';
import { initDebugReport } from './presentation/debugReport.js';
import { initDiagnostics } from './app/diagnostics.js';
import { setSessionInfo } from './app/state.js';

/* ─── Inizializzazione ─── */
initI18n();
initDiagnostics();
initThemeToggle();
initHamburger();
initCookieBanner();
initGitHubStars();
initLangSwitch();
registerServiceWorker();
initTabs();
initUploadController();
initMarkdownExport();
initBBoxExport();
initDebugMode(DEBUG);
initDebugConsole();
initDebugInspector();
initDebugReport();

/* ─── Accelerazione GPU (desktop) ─── */
initWebgpuToggle();

/* ─── Pre-caricamento modelli AI ───
 * YOLO viene pre-caricato subito (indipendente dalla lingua).
 * PaddleOCR invece aspetta la scelta lingua dell'utente e viene
 * caricato al primo upload (o al cambio lingua).
 *
 * MOBILE: il precarico viene saltato per risparmiare memoria
 * (RAM/VRAM condivisa): il modello viene caricato al primo upload,
 * quando la pipeline mostra comunque il progresso. La barra GPU
 * si aggiorna in quel momento.
 */
setTimeout(async () => {
  if (IS_MOBILE) {
    console.log('[YOLO] Mobile: precarico modelli saltato per risparmiare memoria (load al primo upload)');
    return;
  }
  try {
    await loadModel();
    if (DEBUG) console.log('[YOLO] Modello pre-caricato con successo');
    updateAcceleratorBadge(getProvider());
    setSessionInfo({ yoloProvider: getProvider() });
  } catch (err) {
    console.warn('[YOLO] Pre-load failed (will load on upload):', err);
  }
}, 300);

if (DEBUG) {
  console.log('[MarkOut] Pronto — modalita DEBUG');
} else {
  console.log('[MarkOut] Pronto');
}
