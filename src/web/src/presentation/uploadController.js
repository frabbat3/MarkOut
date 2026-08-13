/**
 * Upload Controller — gestione upload e processamento file PDF.
 */
import { uploadArea, fileInput, showLoading, hideAll, errorMsg, error, resultMeta } from './dom.js';
import { setCurrentFile, resetCropData } from '../app/state.js';
import { processPDF, showFinalResult, releaseRunMemory } from '../app/createApp.js';
import { getPdfjs } from '../services/pdfService.js';
import { DEVICE_MEMORY_GB } from '../config/device.js';
import { beginRun, endRun, updateRunPhase } from '../app/diagnostics.js';

/**
 * Guardia anti-concorrenza: evita che due elaborazioni partano in
 * parallelo (niente AbortController nella pipeline, quindi non è
 * possibile annullare: si blocca solo l'avvio di una seconda run).
 */
let _processing = false;

/**
 * Calcola la dimensione massima del file in base alla memoria del dispositivo.
 * Usa navigator.deviceMemory se disponibile (Chrome/Edge), altrimenti default 4 GB.
 *
 * Mappatura:
 *   0.25-0.5 GB → 15 MB   (dispositivi molto limitati)
 *   1 GB        → 25 MB
 *   2 GB        → 50 MB
 *   4 GB        → 100 MB
 *   8 GB+       → 150 MB
 *
 * @returns {number} — limite in bytes
 */
function getMaxFileSize() {
  // Profilo centralizzato (config/device.js): fallback prudente per piattaforma
  const deviceMem = DEVICE_MEMORY_GB; // GB
  const maxMB = Math.max(15, Math.min(150, Math.round(deviceMem * 25)));
  return maxMB * 1024 * 1024;
}

/**
 * Inizializza i listener per upload file.
 */
export function initUploadController() {
  uploadArea.addEventListener('click', () => {
    if (_processing) return;
    fileInput.click();
  });

  uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', function () {
    if (this.files[0]) processFile(this.files[0]);
    this.value = '';
  });
}

/**
 * Legge un file come Uint8Array (wrapper Promise sul FileReader).
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Error reading the file.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Elabora un file PDF.
 *
 * @param {File} f
 */
async function processFile(f) {
  hideAll();

  // Guardia anti-concorrenza
  if (_processing) {
    errorMsg.textContent = 'Processing in progress: wait for it to finish before uploading another PDF.';
    error.classList.remove('hidden');
    return;
  }

  if (!f.name.toLowerCase().endsWith('.pdf')) {
    errorMsg.textContent = 'The file is not a valid PDF.';
    error.classList.remove('hidden');
    return;
  }

  // Limite dimensione basato sulla memoria del dispositivo
  const maxSize = getMaxFileSize();
  if (f.size > maxSize) {
    errorMsg.textContent = `File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). ` +
      `The limit for this device is ${(maxSize / 1024 / 1024).toFixed(0)} MB.`;
    error.classList.remove('hidden');
    return;
  }

  _processing = true;
  fileInput.disabled = true;

  beginRun(f.name);

  let completed = false;

  try {
    setCurrentFile(f);
    resetCropData();
    showLoading('Initializing…');
    console.log(`[UPLOAD] Opening ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);

    const buf = await readFileAsBuffer(f);
    const pdfjs = await getPdfjs(); // lazy: pdfjs-dist si carica solo al primo upload
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    // pdf.js ha copiato i dati internamente; rilascia il riferimento
    console.log(`[UPLOAD] PDF loaded: ${pdf.numPages} pages`);
    updateRunPhase('open', `${pdf.numPages} pages`);

    showLoading('Loading AI models…');
    try {
      await processPDF(pdf);
      try { await pdf.destroy(); } catch (e) { console.warn('[UPLOAD] destroy:', e.message); }
      await showFinalResult();
      completed = true;
    } catch (err) {
      console.error('[PIPELINE] Errore elaborazione:', err);
      try { await pdf.destroy(); } catch (e) { /* noop */ }
      hideAll();
      errorMsg.textContent = err.message || 'Error during processing.';
      error.classList.remove('hidden');
    }
  } catch (err) {
    console.error('[PDF] Errore apertura:', err);
    hideAll();
    errorMsg.textContent = err.message || 'Could not read the PDF.';
    error.classList.remove('hidden');
  } finally {
    // Rilascio finale: modelli AI, canvas residui e blob del file.
    // Copre anche i percorsi d'errore (eccezioni a metà run).
    await releaseRunMemory();
    endRun();
    _processing = false;
    fileInput.disabled = false;
  }
}
