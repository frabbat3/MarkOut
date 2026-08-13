/**
 * YOLO Service — sessione ONNX/WebGPU e inferenza YOLO.
 *
 * Carica il modello HT_detector_v7.9.onnx con ONNX Runtime Web,
 * preferendo WebGPU, con fallback WASM.
 *
 * Usa import dinamico per caricare il bundle ORT appropriato:
 * - Browser con WebGPU → 'onnxruntime-web/webgpu'
 * - Browser senza WebGPU → 'onnxruntime-web/wasm'
 * Questo evita errori 'initWasm()' su dispositivi senza supporto WebGPU.
 *
 * La decisione WebGPU↔WASM è centralizzata in config/device.js:
 *   - Desktop: WebGPU se RAM > 4GB (come sempre).
 *   - Mobile: WebGPU tentato anche lì, ma col profilo a memoria
 *     minimale (batch OCR ridotti, stessa resa render e stesso
 *     input YOLO del desktop): se non regge → WASM.
 */
import { MODEL_FILE, INPUT_NAME, OUTPUT_NAME, CONF_THRES, MODEL_SIZE } from '../config/pipeline.js';
import { shouldTryWebgpu as deviceAllowsWebgpu } from '../config/device.js';
import { preprocessYOLO, decodeYOLO, boxesToOrig } from '../domain/yolo.js';
import { mergeOverlappingBoxes, filterSmallBoxes } from '../domain/geometry.js';

let _session = null;
let _modelPromise = null;
let _provider = null; // 'webgpu' | 'wasm'
let _forceWasm = false; // true se WebGPU è già fallito

// Riferimento al modulo ORT caricato dinamicamente
let _ort = null;

/**
 * Restituisce il provider di esecuzione YOLO.
 * @returns {string|null} 'webgpu', 'wasm', o null se non ancora caricato
 */
export function getProvider() {
  return _provider;
}

/**
 * Scarica il modello ONNX esplicitamente (cache:'reload' → bypassa la
 * cache del service worker) e VALIDA i byte: un modello corrotto o
 * troncato (es. copia parziale in Cache Storage) fa fallire WebGPU e WASM
 * con "protobuf parsing failed" senza un vero motivo.
 * ONNX è protobuf: il primo byte di un modello valido è 0x08 (tag del
 * campo) e l'header inizia con 08 07 12 07 (producer "pytorch").
 * @returns {Promise<Uint8Array>}
 */
async function fetchModelBytes() {
  const res = await fetch(MODEL_FILE, { cache: 'reload' });
  if (!res.ok) {
    throw new Error(`Model not reachable (HTTP ${res.status}): check that the server is running and serves ${MODEL_FILE}`);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length < 1000 || bytes[0] !== 0x08) {
    throw new Error('Model bytes are not a valid ONNX file. Cached copy may be corrupted — hard-reload the page (Ctrl+Shift+R) or clear site data.');
  }
  return bytes;
}

/**
 * Carica il modulo ONNX Runtime Web appropriato.
 * Prova prima WebGPU (più veloce), se non disponibile o fallisce
 * usa WASM. I due bundle vengono importati separatamente in
 * due moduli distinti per evitare conflitti.
 *
 * GitHub Pages non ha header crossOriginIsolated, quindi
 * WASM multi-threading non funziona. numThreads=1 forzato.
 *
 * La politica WebGPU↔WASM vive in config/device.js (profilo desktop
 * vs mobile a memoria minimale); qui restano solo `_forceWasm`
 * (fallback da un tentativo fallito) e il probe dell'adapter.
 *
 * @returns {Promise<Object>} modulo ort
 */
function shouldTryWebgpu() {
  return !_forceWasm && deviceAllowsWebgpu();
}

/**
 * Prova ad allocare un piccolo buffer WebGPU per verificare
 * che l'adapter funzioni prima di caricare il modello.
 * @param {GPUAdapter} adapter
 * @returns {Promise<boolean>}
 */
async function probeWebgpuDevice(adapter) {
  try {
    const device = await adapter.requestDevice();
    const buf = device.createBuffer({
      size: 1024, // 1KB — allocazione minima
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    buf.destroy();
    device.destroy();
    return true;
  } catch (e) {
    console.warn('[YOLO] WebGPU probe failed:', e.message);
    return false;
  }
}

/**
 * Probe pubblico (usato dallo slider GPU nella UI): verifica che
 * WebGPU sia davvero utilizzabile su questo browser/PC, senza
 * caricare il modello. Ritorna subito l'esito per aggiornare il badge.
 * @returns {Promise<boolean>}
 */
export async function probeWebgpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    return probeWebgpuDevice(adapter);
  } catch (e) {
    console.warn('[YOLO] WebGPU adapter request failed:', e.message);
    return false;
  }
}

async function loadOrtModule() {
  if (_ort) return _ort;

  const tryWebgpu = shouldTryWebgpu();
  let adapter = null;
  let webgpuValid = false;

  if (tryWebgpu) {
    console.log('[YOLO] WebGPU available, trying…');
    try {
      adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        // Probe per verificare che il device sia veramente funzionante
        webgpuValid = await probeWebgpuDevice(adapter);
        if (webgpuValid) {
          console.log('[YOLO] Adapter:', `${adapter.info?.vendor} ${adapter.info?.architecture}`);
        } else {
          console.log('[YOLO] Adapter not working, using WASM');
        }
      }
    } catch (e) {
      console.warn('[YOLO] WebGPU adapter request failed:', e.message);
    }
  }

  if (tryWebgpu && webgpuValid && adapter) {
    console.log('[YOLO] Loading WebGPU bundle…');
    try {
      const ort = await import('onnxruntime-web/webgpu');
      ort.env.logLevel = 'error';
      ort.env.wasm.numThreads = 1;
      ort.env.webgpu = ort.env.webgpu || {};
      ort.env.webgpu.adapter = adapter;

      const session = await ort.InferenceSession.create(await fetchModelBytes(), {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      _ort = ort;
      _session = session;
      _provider = 'webgpu';
      console.log('[YOLO] ✓ WebGPU');
      return ort;
    } catch (webgpuErr) {
      console.warn('[YOLO] WebGPU failed:', webgpuErr.message);
      _forceWasm = true;
      _ort = null;
      _session = null;
      _provider = null;
      console.log('[YOLO] Retrying with WASM…');
    }
  }

  // Fallback WASM (modulo separato, senza contaminazione WebGPU)
  console.log('[YOLO] Loading WASM bundle…');
  try {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = 1;

    const modelBytes = await fetchModelBytes();
    // Su macchine con poca memoria la creazione della sessione con
    // graphOptimizationLevel 'all' può fallire con OOM ("out of memory"
    // del runtime WASM): ritenta con 'basic', che alloca meno buffer
    // temporanei, prima di arrendersi.
    let session = null;
    let lastErr = null;
    for (const level of ['all', 'basic']) {
      try {
        session = await ort.InferenceSession.create(modelBytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: level,
        });
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[YOLO] WASM session (optimization=${level}) failed:`, e.message);
      }
    }
    if (!session) throw lastErr || new Error('WASM session creation failed');
    _ort = ort;
    _session = session;
    _provider = 'wasm';
    console.log('[YOLO] ✓ WASM');
    return ort;
  } catch (wasmErr) {
    console.error('[YOLO] WASM also failed:', wasmErr.message);
    // Se anche WASM fallisce, probabilmente WebGPU ha corrotto lo stato
    // Non possiamo più recuperare in questa sessione
    const oom = /out of memory/i.test(String(wasmErr?.message || wasmErr));
    const hint = oom
      ? ' — memoria insufficiente: ricarica la pagina (hard refresh), chiudi le altre schede o prova un PDF più piccolo.'
      : '';
    throw new Error(`No backend available: ${wasmErr.message}${hint}`);
  }
}

/**
 * Carica il modello YOLO ONNX.
 * La sessione viene cachata e riutilizzata.
 *
 * @returns {Promise<Object>} sessione ORT
 */
export async function loadModel() {
  if (_session) return _session;
  if (_modelPromise) return _modelPromise;

  _modelPromise = (async () => {
    await loadOrtModule();
    // _session è impostato da loadOrtModule
    if (!_session) throw new Error('No backend available');
    return _session;
  })();

  try {
    return await _modelPromise;
  } catch (err) {
    _modelPromise = null;
    _session = null;
    _provider = null;
    _ort = null;
    throw err;
  }
}

/**
 * Rilascia il modello YOLO e libera la memoria GPU.
 * Dopo questa chiamata, loadModel() ricaricherà il modello.
 */
export function unloadModel() {
  if (_session) {
    try {
      // WebGPU EP non ha sempre dispose(): la guardia evita falsi errori
      if (typeof _session.dispose === 'function') {
        _session.dispose();  // rilascia risorse WebGPU/WASM
      }
    } catch (e) {
      console.warn('[YOLO] Dispose error:', e.message);
    }
    _session = null;
  }
  _modelPromise = null;
  _ort = null;
  _provider = null;
  _forceWasm = false;  // resetta per il prossimo caricamento
  console.log('[YOLO] Model released');
}

/**
 * Esegue l'inferenza YOLO su un canvas pagina.
 *
 * @param {HTMLCanvasElement} pageCanvas
 * @returns {Promise<{ rawBoxes: Array, boxes: Array, mergedBoxes: Array }>}
 */
export async function runYOLOInference(pageCanvas) {
  const ort = await loadOrtModule();
  const session = await loadModel();
  const prep = preprocessYOLO(pageCanvas);
  const inputTensor = new ort.Tensor('float32', prep.tensorArr, [1, 3, MODEL_SIZE, MODEL_SIZE]);

  const results = await session.run({ [INPUT_NAME]: inputTensor });
  const rawData = results[OUTPUT_NAME].data;

  let boxes = boxesToOrig(
    decodeYOLO(rawData, CONF_THRES),
    prep.scale, prep.padX, prep.padY
  );

  const rawBoxes = boxes.slice();
  // Filtra prima i box piccoli, poi merge: così l'array finale
  // ha gli stessi indici di mergedBoxes e containedYOLOs
  boxes = filterSmallBoxes(boxes, pageCanvas.width, pageCanvas.height);
  boxes = mergeOverlappingBoxes(boxes, 0.5, 0.7);
  const mergedBoxes = boxes.slice();

  return { rawBoxes, boxes, mergedBoxes };
}
