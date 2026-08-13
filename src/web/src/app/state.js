/**
 * State — stato globale dell'applicazione.
 *
 * Mantiene i riferimenti ai dati elaborati e ai file correnti.
 */

/** @type {File|null} */
export let currentFile = null;

/** @type {Array} frammenti YOLO con canvas, OCR, coordinate */
export let cropData = [];

/** @type {Array} dati per pagina: canvas, boxes, detRects, ecc. */
export let pageData = [];

/** @type {Object} info di sessione raccolta durante la pipeline (per il report debug) */
export const session = {};

/**
 * Registra info di sessione (backend YOLO/OCR, lingua, …) per il report debug.
 * @param {Object} partial
 */
export function setSessionInfo(partial) {
  Object.assign(session, partial);
}

/**
 * Imposta il file corrente.
 * @param {File|null} f
 */
export function setCurrentFile(f) {
  currentFile = f;
}

/**
 * Aggiorna cropData.
 * @param {Array} data
 */
export function setCropData(data) {
  cropData = data;
}

/**
 * Aggiunge dati a pageData.
 * @param {Object} pd
 */
export function addPageData(pd) {
  pageData.push(pd);
}

/**
 * Resetta pageData.
 */
export function resetPageData() {
  pageData = [];
}

/**
 * Resetta cropData.
 */
export function resetCropData() {
  cropData = [];
}

/**
 * Resetta tutto lo stato.
 */
export function resetAll() {
  currentFile = null;
  cropData = [];
  pageData = [];
}
