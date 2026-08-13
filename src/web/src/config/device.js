/**
 * Device Profile — rilevamento dispositivo e profilo memoria/GPU.
 *
 * Unica fonte di verità per la differenziazione desktop ↔ mobile
 * di visualizzazione, memoria e librerie:
 *
 *   DESKTOP  → GPU (WebGPU) preferita, risoluzione render piena,
 *               batch OCR pieni, precarico dei modelli: la memoria
 *               non è un vincolo.
 *   MOBILE   → profilo a MEMORIA MINIMALE, niente precarico modelli
 *               e NIENTE WebGPU su iOS Safari (il backend WebGPU di
 *               ONNX Runtime è instabile su Safari/iOS: crash del
 *               processo GPU → la tab si ricarica. Su iPhone/iPad si
 *               usa sempre WASM, stabile e con heap gestibile).
 *               Su Android si tenta ancora WebGPU col probe, con
 *               fallback WASM automatico.
 *               La resa dei render resta IDENTICA al desktop (stesso
 *               DPI/MAX_DIM) e l'inferenza YOLO usa lo stesso input
 *               del desktop (shape fissa del modello ONNX).
 *
 * Tutti gli accessi a navigator sono difensivi (build Vite / SSR) e
 * il rilevamento è cachato: il profilo è statico per l'intera sessione.
 */

/* ─── Rilevamento dispositivo ─── */
let _isMobile = null;

/**
 * Rileva se il dispositivo è mobile (smartphone/tablet touch).
 * Stessa euristica usata in precedenza da yoloService/ocrService/createApp,
 * ora centralizzata: UA mobile oppure touch screen con viewport stretto.
 * @returns {boolean}
 */
export function detectMobile() {
  if (_isMobile !== null) return _isMobile;
  _isMobile = typeof navigator !== 'undefined' && (
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth <= 768)
  );
  return _isMobile;
}

/** @type {boolean} true su smartphone/tablet touch */
export const IS_MOBILE = detectMobile();

/* ─── Profilo GPU mobile ───
 * Su mobile si usa SEMPRE WASM (stabile, heap gestibile, niente processi
 * GPU aggiuntivi): WebGPU è riservato al desktop con RAM sufficiente.
 *
 * ─── WebGPU disattivabile (desktop) ───
 * L'utente può disattivare WebGPU dal selettore UI (localStorage
 * 'markout-webgpu' = 'off'): il sistema NON cambia mai la pipeline in
 * automatico, ma lascia all'utente la facoltà di forzare WASM se WebGPU
 * crasha o rallenta sul suo dispositivo.
 */
export function isWebgpuDisabled() {
  if (typeof localStorage === 'undefined') return false;
  try { return localStorage.getItem('markout-webgpu') === 'off'; } catch { return false; }
}

/**
 * Capacità GPU reale del dispositivo (browser + hardware):
 * true solo se l'API WebGPU esiste E il profilo la consente
 * (desktop con RAM > 4GB). NON considera la scelta dell'utente:
 * serve a decidere se mostrare lo slider nella UI.
 * @returns {boolean}
 */
export function canUseWebgpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  if (IS_MOBILE) return false; // mobile: WASM sempre
  if (IS_LOW_MEMORY) return false; // RAM ≤ 4GB: GPU condivisa, WASM
  return true;
}

/**
 * RAM del dispositivo (GB). `navigator.deviceMemory` è assente su
 * iOS Safari: fallback prudente per piattaforma (4 GB mobile, 8 GB desktop).
 * @type {number}
 */
export const DEVICE_MEMORY_GB = typeof navigator !== 'undefined'
  ? (navigator.deviceMemory || (IS_MOBILE ? 4 : 8))
  : 8;

/** RAM ≤ 4GB: GPU integrata/condivisa → profilo conservativo. */
export const IS_LOW_MEMORY = DEVICE_MEMORY_GB <= 4;

/* ─── Profilo render pagina (canvas) ─── */
/* DPI e MAX_DIM sono IDENTICI su desktop e mobile: la resa dei crop
   (e quindi la qualità OCR) non deve differire tra piattaforme.
   Il risparmio di memoria mobile viene dalle altre leve: batch/chunk
   OCR ridotti, niente precarico, rilascio anticipato dei canvas
   (pipeline pagina per pagina).
   Nota: la pipeline è SEMPRE la stessa — nessuna riduzione automatica
   di risoluzione dopo un crash. */
/** DPI di renderizzazione PDF (identico su tutte le piattaforme). */
export const RENDER_DPI = 300;
/** Dimensione massima del lato lungo del canvas pagina (identico ovunque). */
export const RENDER_MAX_DIM = 2000;

/* ─── Profilo YOLO ─── */
/* Il modello HT_detector_v7.9.onnx è esportato con SHAPE FISSA
   [1, 3, 1024, 1024]: l'input di inferenza è identico su desktop e
   mobile. (Un letterbox a 768px farebbe fallire OrtRun con
   "Got invalid dimensions for input" e degraderebbe la detection.) */
/** Lato del letterbox di inferenza YOLO — fisso, shape del modello ONNX. */
export const YOLO_MODEL_SIZE = 1024;

/* ─── Profilo OCR ─── */
/** Batch interno del motore PaddleOCR (det/rec): mobile ridotto (stabile, invariato). */
export const OCR_ENGINE_BATCH_MAX = IS_MOBILE ? 16 : 32;
/** Cap massimo per il batch di frammenti OCR (runOcrOnFragments). */
export const OCR_FRAGMENT_BATCH_MAX = IS_MOBILE ? 24 : 48;
/** Canvases processati per chunk (~200ms cad.): mobile 2 = picco più basso. */
export const OCR_CHUNK_MAX = IS_MOBILE ? 2 : 4;

/* ─── Cap canvas dei frammenti (mobile) ───
 * I crop dei frammenti vengono creati a risoluzione pagina (fino a
 * 2000px), ma il modello rec di PaddleOCR normalizza l'altezza a 48px:
 * i pixel oltre ~40px di testo sono sprecati per la memoria.
 * Su mobile i crop vengono quindi ridimensionati a ≤ CROP_MAX_W px
 * di larghezza quando il testo risultante resta ≥ CROP_MIN_H px
 * (qualità OCR invariata, memoria dei canvas fino a −75%).
 */
export const OCR_CROP_MAX_W = 1024;   // larghezza max crop (mobile)
export const OCR_CROP_MIN_H = 40;     // altezza testo minima dopo il downscale

/* ─── Politica GPU ─── */

/**
 * Decide se tentare WebGPU (GPU acceleration).
 *
 * - `forceWasm` (fallback da un tentativo precedente fallito) → mai WebGPU.
 * - Utente ha disattivato WebGPU (selettore UI, localStorage 'off') → WASM.
 * - Desktop con ≤4GB RAM → WASM (GPU condivisa, probabile OOM).
 * - Desktop con RAM sufficiente → WebGPU (default, disattivabile dall'utente).
 * - Mobile (iOS e Android) → MAI WebGPU: WASM sempre. Su iOS Safari il
 *   backend WebGPU di ONNX Runtime è sperimentale/instabile e i suoi
 *   buffer vivono in un processo GPU separato; su mobile la memoria è
 *   condivisa e il budget di Safari è teso. WASM è più lento ma
 *   stabile, prevedibile e rilasciabile.
 *
 * @param {boolean} [forceWasm=false]
 * @returns {boolean}
 */
export function shouldTryWebgpu(forceWasm = false) {
  if (forceWasm) return false;
  if (isWebgpuDisabled()) return false; // scelta esplicita dell'utente
  return canUseWebgpu();
}