/**
 * Debug Inspector — modal di ispezione dei componenti della pipeline.
 *
 * Ogni elemento della UI di debug (card crop, card riga, canvas pagina…)
 * può essere reso "ispezionabile" con attachInspectable(el, title, data):
 * un click apre un pannello con il JSON completo del componente
 * (coordinate, score, slope, OCR, assegnazioni…) e un pulsante copia,
 * così l'utente può incollare il singolo componente in chat.
 */
let _modal = null;
let _titleEl = null;
let _preEl = null;
let _copyBtn = null;
let _uid = 0;
let _current = null;
const _registry = new Map();

function ensureModal() {
  if (_modal) return;

  _modal = document.createElement('div');
  _modal.id = '__debugInspector';
  _modal.style.cssText = [
    'position:fixed;inset:0;z-index:100000;display:none;',
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.55);',
  ].join('');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:10px;',
    'max-width:min(920px,94vw);max-height:88vh;display:flex;flex-direction:column;',
    'overflow:hidden;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'box-shadow:0 12px 48px rgba(0,0,0,0.5);',
  ].join('');

  // Header
  const header = document.createElement('div');
  header.style.cssText = [
    'display:flex;justify-content:space-between;align-items:center;gap:10px;',
    'padding:10px 14px;border-bottom:1px solid #30363d;background:#161b22;flex-shrink:0;',
  ].join('');
  _titleEl = document.createElement('strong');
  _titleEl.style.cssText = 'color:#fff;font-size:13px;overflow-wrap:anywhere;';
  header.appendChild(_titleEl);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

  _copyBtn = document.createElement('button');
  _copyBtn.textContent = '📋 Copia JSON';
  _copyBtn.style.cssText = [
    'background:#238636;border:none;color:#fff;border-radius:6px;padding:5px 10px;',
    'font-size:12px;font-family:inherit;cursor:pointer;',
  ].join('');
  _copyBtn.addEventListener('click', copyCurrent);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = [
    'background:none;border:none;color:#f88;font-size:15px;cursor:pointer;padding:0 4px;',
  ].join('');
  closeBtn.addEventListener('click', hideInspector);

  actions.appendChild(_copyBtn);
  actions.appendChild(closeBtn);
  header.appendChild(actions);
  panel.appendChild(header);

  // Body (JSON scrollabile)
  const scroll = document.createElement('div');
  scroll.style.cssText = 'overflow:auto;padding:12px 14px;flex:1;';
  _preEl = document.createElement('pre');
  _preEl.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;font-size:11.5px;';
  scroll.appendChild(_preEl);
  panel.appendChild(scroll);

  _modal.appendChild(panel);
  document.body.appendChild(_modal);

  _modal.addEventListener('click', e => { if (e.target === _modal) hideInspector(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideInspector(); });
}

/** Replacer per JSON.stringify: canvas/funzioni/errori → descrizione. */
function replacer(key, val) {
  if (val instanceof Error) return `[Error: ${val.message}]`;
  if (typeof val === 'function') return '[function]';
  if (typeof HTMLCanvasElement !== 'undefined' && val instanceof HTMLCanvasElement) {
    return `[Canvas ${val.width}×${val.height}]`;
  }
  if (typeof HTMLImageElement !== 'undefined' && val instanceof HTMLImageElement) return '[Image]';
  return val;
}

/**
 * Mostra la modal con il JSON di un componente.
 * @param {string} title — titolo (es. "Y#3 — box YOLO p.1")
 * @param {*} data — oggetto da mostrare (JSON.stringify)
 */
export function showInspector(title, data) {
  ensureModal();
  let json;
  try {
    json = JSON.stringify(data, replacer, 2);
  } catch {
    json = String(data);
  }
  const MAX = 250000;
  if (json.length > MAX) json = json.slice(0, MAX) + '\n… [troncato]';
  _current = json;
  _titleEl.textContent = title || 'Ispezione';
  _preEl.textContent = json;
  _modal.style.display = 'flex';
}

/** Chiude la modal ispezione. */
export function hideInspector() {
  if (_modal) _modal.style.display = 'none';
}

/**
 * Registra un elemento DOM come ispezionabile (click → showInspector).
 * @param {HTMLElement} el
 * @param {string} title
 * @param {*} data
 */
export function attachInspectable(el, title, data) {
  if (!el) return;
  const key = 'inspect-' + (++_uid);
  _registry.set(key, { title, data });
  el.dataset.inspectKey = key;
  el.style.cursor = 'pointer';
}

/**
 * Inizializza la delega dei click sugli elementi [data-inspect-key].
 */
export function initDebugInspector() {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-inspect-key]');
    if (!t) return;
    const entry = _registry.get(t.dataset.inspectKey);
    if (entry) showInspector(entry.title, entry.data);
  });
}

function copyCurrent() {
  if (_current === null) return;
  copyText(_current);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    flash('✅ Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      flash('✅ Copied');
    } catch {
      flash('❌ Copy failed');
    }
    ta.remove();
  }
}

function flash(msg) {
  const old = _copyBtn.textContent;
  _copyBtn.textContent = msg;
  setTimeout(() => { _copyBtn.textContent = old; }, 1200);
}