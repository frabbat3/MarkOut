/**
 * OCR Service — inizializzazione e riconoscimento PaddleOCR.js.
 *
 * Gestisce la sessione PaddleOCR e l'inferenza batch.
 * I crop arrivano già ritagliati dal modello YOLO custom,
 * quindi il detection model interno di PaddleOCR.js trova
 * solo 1 box per crop (la riga di testo).
 *
 * I modelli OCR sono self-hostati su GitHub Pages per evitare
 * la latenza del CDN cinese (paddle-model-ecology.bj.bcebos.com).
 */
import {
  PADDLEOCR_LANG,
  PADDLEOCR_VERSION,
  OCR_BATCH_SIZE,
  OCR_DET_BATCH_SIZE,
  OCR_REC_BATCH_SIZE,
  OCR_MAX_BATCH_SIZE,
} from '../config/pipeline.js';
import { IS_MOBILE, DEVICE_MEMORY_GB, shouldTryWebgpu } from '../config/device.js';
import { setSessionInfo } from '../app/state.js';
import { trackCanvasReleased } from '../app/diagnostics.js';

let _paddleOCR = null;
let _paddleOCRPromise = null;
let _currentLang = null;

/**
 * URL dei modelli PP-OCRv6 self-hostati (serviti da GitHub Pages).
 * I file .tar vengono scaricati una volta e inclusi nel build.
 *
 * Il path viene calcolato dinamicamente a partire dalla URL corrente
 * per funzionare sia in sviluppo (localhost:8080) che su GitHub Pages
 * (https://frabbat3.github.io/MarkOut/).
 * GitHub Pages aggiunge sempre il trailing slash, quindi il calcolo è
 * affidabile: la directory corrente è tutto prima dell'ultimo '/'.
 */
function getModelUrl(filename) {
  // Query string e hash esclusi: un '/' dentro i parametri (es.
  // ?redirect=/x) avrebbe fatto calcolare male la directory di base
  // (lastIndexOf prendeva quello sbagliato → modelli non trovati).
  const path = window.location.href.split('#')[0].split('?')[0];
  const dir = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
  return dir + 'models/' + filename;
}
const MODEL_DET = getModelUrl('PP-OCRv6_small_det_onnx_infer.tar');
const MODEL_REC = getModelUrl('PP-OCRv6_small_rec_onnx_infer.tar');

/**
 * Inizializza PaddleOCR.js con la lingua specificata (singleton).
 * Se la lingua cambia rispetto all'inizializzazione precedente,
 * la sessione viene ricreata.
 *
 * @param {string} [lang] — codice lingua (default: PADDLEOCR_LANG)
 * @returns {Promise<Object>}
 */
export async function initPaddleOCR(lang) {
  const targetLang = lang || PADDLEOCR_LANG;

  // Se già inizializzato con la stessa lingua, ritorna il cached
  if (_paddleOCR && _currentLang === targetLang) return _paddleOCR;

  // Se già inizializzato con lingua diversa, resetta
  if (_paddleOCR && _currentLang !== targetLang) {
    console.log(`[OCR] Language changed: ${_currentLang} → ${targetLang}, recreating session`);
    // Rilascia la vecchia sessione prima di crearne una nuova
    try { await _paddleOCR.dispose(); } catch (e) { console.warn('[OCR] Dispose old session:', e.message); }
    _paddleOCR = null;
    _paddleOCRPromise = null;
  }

  if (_paddleOCRPromise) return _paddleOCRPromise;

  _paddleOCRPromise = (async () => {
    console.log(`[OCR] Initializing (${targetLang})…`);
    try {
      // @paddleocr/paddleocr-js (pesante) caricato SOLO al primo upload,
      // non all'avvio: bundle iniziale leggero (Performance / Lighthouse).
      const { PaddleOCR } = await import('@paddleocr/paddleocr-js');

      // Politica GPU centralizzata in config/device.js:
      //  - Desktop: WebGPU se RAM > 4GB e non disattivato dall'utente
      //    (selettore UI).
      //  - Mobile: SEMPRE WASM (stabile, heap gestibile).
      // Su GitHub Pages non c'è Cross-Origin-Isolated → niente multi-thread.
      const useWebgpu = shouldTryWebgpu();
      const numThreads = 1;

      // I modelli sono serviti dallo stesso origin (GitHub Pages),
      // così il download è veloce e senza latenza CDN cinese.
      // PaddleOCR.js scarica i .tar, li estrae e carica i .onnx.
      const createOcr = (backend, threads) => PaddleOCR.create({
        lang: targetLang,
        ocrVersion: PADDLEOCR_VERSION,
        batch_size: OCR_BATCH_SIZE,
        text_detection_batch_size: OCR_DET_BATCH_SIZE,
        text_recognition_batch_size: OCR_REC_BATCH_SIZE,
        // Modelli self-hostati invece del CDN cinese
        textDetectionModelName: 'PP-OCRv6_small_det',
        textDetectionModelDir: { url: MODEL_DET },
        textRecognitionModelName: 'PP-OCRv6_small_rec',
        textRecognitionModelDir: { url: MODEL_REC },
        ortOptions: { backend, numThreads: threads },
      });

      let ocr;
      try {
        ocr = await createOcr(useWebgpu ? 'webgpu' : 'wasm', numThreads);
      } catch (err) {
        if (useWebgpu) {
          // navigator.gpu può esistere anche senza adapter reale
          // (VM, GPU process disabilitato, headless): ripiega su WASM.
          console.warn('[OCR] WebGPU non disponibile, retry con WASM');
          ocr = await createOcr('wasm', numThreads);
        } else {
          throw err;
        }
      }
      _paddleOCR = ocr;
      _currentLang = targetLang;

      // NOTA: il detection model NON viene rilasciato perché serve
      // a GapTree per la divisione in blocchi e l'ordinamento layout.
      // Vedi createApp.js → processPDF: la detection viene eseguita
      // durante l'inferenza YOLO per alimentare GapTree.
      // La recognition invece usa solo recModel (no detection re-run).

      const info = ocr.getInitializationSummary();
      const backendTag = info.backend === 'webgpu' ? '🚀 WebGPU' : '♻️ WASM';
      setSessionInfo({ ocrProvider: info.backend, ocrLang: targetLang });
      console.log(`[OCR] Pronto (${backendTag}, rec: ${info.recProvider || 'wasm'})`);
      return ocr;
    } catch (err) {
      _paddleOCRPromise = null;
      console.error('[OCR] Errore inizializzazione:', err, err && err.stack ? '\n' + err.stack : '');
      return null;
    }
  })();
  return _paddleOCRPromise;
}

/**
 * Determina la dimensione del batch OCR in base al profilo dispositivo
 * (config/device.js): i dispositivi mobili usano batch più piccoli per
 * tenere il picco di memoria GPU/WASM il più basso possibile.
 * @returns {number}
 */
function getDynamicBatchSize() {
  const mem = DEVICE_MEMORY_GB; // GB, fallback per piattaforma
  // Mobile: cap più severo (picco minimale per la GPU condivisa)
  if (IS_MOBILE) {
    if (mem <= 2) return 8;
    if (mem <= 4) return 16;
    return OCR_MAX_BATCH_SIZE; // 24
  }
  if (mem <= 1) return 8;
  if (mem <= 2) return 16;
  if (mem <= 4) return 32;
  return OCR_MAX_BATCH_SIZE; // 48
}

/**
 * Riconosce un batch di canvas usando SOLO il recognition model.
 * La detection di PaddleOCR viene saltata perchè i crop YOLO sono
 * già porzioni di testo. Ritorna risultati nel formato atteso
 * da mapOcrResultsToFragments: [{ items: [{ text }] }].
 *
 * @param {HTMLCanvasElement[]} canvases
 * @returns {Promise<Array<{items: Array<{text: string}>}>>}
 */
async function recognizeWithoutDetect(canvases) {
  if (!_paddleOCR?.recModel || !_paddleOCR.cv || !canvases.length) {
    return canvases.map(() => ({ items: [] }));
  }

  const { OCR_BATCH_CHUNK_SIZE } = await import('../config/pipeline.js');
  const chunkSize = Math.min(OCR_BATCH_CHUNK_SIZE, canvases.length);
  const results = [];

  const cv = _paddleOCR.cv;
  const recModel = _paddleOCR.recModel;
  const sourceToMat = _paddleOCR.sourceToMat;

  for (let i = 0; i < canvases.length; i += chunkSize) {
    const chunk = canvases.slice(i, i + chunkSize);

    // Converti canvas → OpenCV mats
    const sourceImages = await Promise.all(
      chunk.map(canvas => sourceToMat(cv, canvas))
    );

    try {
      const mats = sourceImages.map(s => s.mat);
      const recResults = await recModel.predict(cv, mats);

      // Formatta come [{ items: [{ text, score }] }]
      for (const r of recResults) {
        if (r?.text) {
          results.push({ items: [{ text: r.text }] });
        } else {
          results.push({ items: [] });
        }
      }
    } finally {
      for (const si of sourceImages) si.dispose();
    }

    // Cede il thread al browser dopo ogni chunk
    if (i + chunkSize < canvases.length) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }
  }

  return results;
}

/**
 * Processa un sotto-batch di canvases con possibilità di cedere il thread.
 * Divide il batch in chunk di OCR_BATCH_CHUNK_SIZE, yield dopo ogni chunk.
 *
 * @param {HTMLCanvasElement[]} canvases
 * @returns {Promise<Array>}
 */
async function predictNonBlocking(canvases) {
  // Usa il recognition direct (salta detection PaddleOCR)
  return recognizeWithoutDetect(canvases);
}

/**
 * Esegue OCR batch su un array di frammenti YOLO.
 * I frammenti vengono preparati (padding/split), processati in batch,
 * e i risultati rimappati.
 *
 * @param {Array} cropData — array di frammenti con .canvas
 * @param {Function} setProgress — callback per progress
 * @returns {Promise<void>}
 */
export async function runOcrOnFragments(cropData, setProgress) {
  if (!cropData.length) return;
  if (!_paddleOCR) {
    console.warn('[OCR] runOcrOnFragments skipped: PaddleOCR non inizializzato — i frammenti restano senza testo');
    return;
  }

  const totalFragments = cropData.length;
  const backend = _paddleOCR?.recModel?.provider || 'wasm';
  console.log(`[OCR] Recognizing ${totalFragments} fragments (backend: ${backend})`);

  const [{ prepareBatchForOCR }, { mapOcrResultsToFragments }] =
    await Promise.all([
      import('../domain/ocr/cropPreparation.js'),
      import('../domain/ocr/textStitching.js'),
    ]);

  const BATCH = getDynamicBatchSize();
  let processedCount = 0;

  for (let i = 0; i < cropData.length; i += BATCH) {
    const batch = cropData.slice(i, i + BATCH);
    processedCount += batch.length;
    setProgress('🔤 Recognizing text…', processedCount, totalFragments);

    // Cede il thread all'inizio di ogni batch principale
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

    try {
      const subMap = prepareBatchForOCR(batch);
      // v5: i sub-canvas della riga det seguono quelli del frammento.
      // Il crop della riga è CONDIVISO tra i frammenti dello stesso item:
      // il recognition viene eseguito UNA volta per riga (dedupe per
      // riferimento) e i risultati riespansi per frammento.
      const subCanvases = subMap.flatMap(e => e.subCanvases);
      const rowIdxByCanvas = new Map();
      const uniqueRowCanvases = [];
      for (const e of subMap) {
        for (const rc of e.rowCanvases) {
          if (!rowIdxByCanvas.has(rc)) {
            rowIdxByCanvas.set(rc, uniqueRowCanvases.length);
            uniqueRowCanvases.push(rc);
          }
        }
      }
      const flatCanvases = [...subCanvases, ...uniqueRowCanvases];

      let flatResults;
      if (flatCanvases.length > 0) {
        // Predict non-bloccante: chunk interni con yield
        flatResults = await predictNonBlocking(flatCanvases);
      } else {
        flatResults = [];
      }

      // Riespandi i risultati delle righe deduplicate nel formato atteso
      // da mapOcrResultsToFragments (per ogni entry: prima i sub-canvas,
      // poi le righe).
      const rowResultByCanvas = new Map();
      for (let ri = 0; ri < uniqueRowCanvases.length; ri++) {
        rowResultByCanvas.set(uniqueRowCanvases[ri], flatResults[subCanvases.length + ri]);
      }
      let subIdx = 0;
      const expanded = [];
      for (const e of subMap) {
        for (let s = 0; s < e.subCanvases.length; s++) expanded.push(flatResults[subIdx++]);
        for (const rc of e.rowCanvases) expanded.push(rowResultByCanvas.get(rc));
      }

      mapOcrResultsToFragments(subMap, expanded, batch);

      const ok = batch.filter(f => f.ocr?.status === 'done').length;
      console.log(`[OCR] Batch ${Math.floor(i / BATCH) + 1}: ${ok}/${batch.length} OK`);
    } catch (err) {
      console.warn('[OCR] Batch failed, individual retry:', err);
      // Re-try: processa ogni frammento individualmente
      await retryBatchIndividual(batch, prepareBatchForOCR, mapOcrResultsToFragments);
    }

    // I canvas di riga servono solo al mapping appena eseguito:
    // rilasciarli qui limita il picco di memoria a UN batch (prima
    // restavano vivi in cropData per tutto il run e per la sessione).
    for (const f of batch) {
      if (f.rowCanvas && (f.rowCanvas.width !== 0 || f.rowCanvas.height !== 0)) {
        trackCanvasReleased(f.rowCanvas);
        f.rowCanvas.width = 0;
        f.rowCanvas.height = 0;
      }
      delete f.rowCanvas;
    }
  }

  const ok = cropData.filter(f => f.ocr?.status === 'done').length;
  console.log(`[OCR] Completed: ${ok}/${totalFragments} fragments recognized`);
}

/**
 * Riprova un batch fallito processando un frammento alla volta.
 * Ogni frammento viene preparato, riconosciuto e rimappato singolarmente.
 *
 * @param {Array} batch — frammenti falliti
 * @param {Function} prepareBatchForOCR
 * @param {Function} mapOcrResultsToFragments
 */
async function retryBatchIndividual(batch, prepareBatchForOCR, mapOcrResultsToFragments) {
  for (const f of batch) {
    try {
      const subMap = prepareBatchForOCR([f]);
      const flatCanvases = subMap.flatMap(e => [...e.subCanvases, ...e.rowCanvases]);
      let flatResults = [];
      if (flatCanvases.length > 0) {
        flatResults = await recognizeWithoutDetect(flatCanvases);
      }
      mapOcrResultsToFragments(subMap, flatResults, [f]);
      // Cede il thread dopo ogni frammento
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    } catch (singleErr) {
      console.warn('[OCR] Fragment failed permanently:', singleErr);
      f.ocr = { status: 'error', engine: 'PaddleOCR', text: null, confidence: null, error: singleErr.message };
    }
  }
}

/**
 * Ottiene il riferimento al modello di detection PaddleOCR.
 *
 * @returns {{ detModel: Object|null, cv: Object|null }}
 */
export function getDetModel() {
  if (!_paddleOCR) return { detModel: null, cv: null };
  return {
    detModel: _paddleOCR.detModel || null,
    cv: _paddleOCR.cv || null,
  };
}

/**
 * Rilascia PaddleOCR e libera la memoria GPU.
 * Dopo questa chiamata, initPaddleOCR() ricaricherà i modelli.
 */
export async function releasePaddleOCR() {
  if (_paddleOCR) {
    try {
      await _paddleOCR.dispose();
      console.log('[OCR] Models released');
    } catch (e) {
      console.warn('[OCR] Dispose error:', e.message);
    }
    _paddleOCR = null;
  }
  _paddleOCRPromise = null;
  _currentLang = null;
}
