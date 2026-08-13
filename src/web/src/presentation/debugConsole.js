/**
 * Debug Console — overlay che cattura e mostra i log della console
 * direttamente sullo schermo. Utile per debug su dispositivi mobili
 * senza dover collegare un computer.
 *
 * Attivabile con parametro URL: ?debug=1
 * o toccando 5 volte il titolo dell'app.
 */

let _enabled = false;
let _container = null;
const MAX_LOGS = 100;

/**
 * Cattura i metodi originali di console.
 */
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function createContainer() {
  if (_container) return;
  _container = document.createElement('div');
  _container.id = '__debugConsole';
  _container.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 99999;
    background: rgba(0,0,0,0.88);
    color: #0f0;
    font: 11px/1.4 monospace;
    max-height: 40vh;
    overflow-y: auto;
    padding: 8px 10px;
    display: none;
    white-space: pre-wrap;
    word-break: break-all;
  `;

  // Header con pulsante chiudi
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex; justify-content: space-between;
    align-items: center; margin-bottom: 6px;
    padding-bottom: 4px; border-bottom: 1px solid #333;
    position: sticky; top: 0; background: rgba(0,0,0,0.95);
  `;
  header.innerHTML = '<strong style="color:#fff;font-size:12px">🐞 Console Log</strong>';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    background: none; border: none; color: #f88;
    font-size: 16px; cursor: pointer; padding: 0 4px;
  `;
  closeBtn.onclick = () => toggle(false);
  header.appendChild(closeBtn);
  _container.appendChild(header);

  document.body.appendChild(_container);
}

function appendLog(level, args) {
  if (!_container) return;
  const msg = args.map(a =>
    typeof a === 'object' ? safeStringify(a) : String(a)
  ).join(' ');

  const el = document.createElement('div');
  el.style.cssText = 'padding: 1px 0;';

  const colors = { log: '#aaa', warn: '#ffa', error: '#f88' };
  const prefixes = { log: '▸', warn: '⚠', error: '✗' };
  el.style.color = colors[level] || '#aaa';

  // Formatta timestamp
  const t = new Date().toLocaleTimeString('it-IT', { hour12: false });
  el.textContent = `${t} ${prefixes[level] || '▸'} ${msg}`;

  _container.appendChild(el);

  // Limita numero di log
  while (_container.children.length > MAX_LOGS + 1) { // +1 per l'header
    _container.removeChild(_container.children[1]);
  }

  // Auto-scroll
  _container.scrollTop = _container.scrollHeight;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (key, val) => {
      if (typeof val === 'function') return '[function]';
      if (val instanceof Error) return `[Error: ${val.message}]`;
      return val;
    }, 2);
  } catch {
    return String(obj);
  }
}

/**
 * Attiva/disattiva la console di debug.
 * @param {boolean} [on] — true per attivare, false per disattivare
 */
export function toggle(on) {
  _enabled = on !== undefined ? on : !_enabled;
  if (_container) {
    _container.style.display = _enabled ? 'block' : 'none';
  }

  if (_enabled) {
    // Sovrascrive i metodi console
    console.log = function (...args) {
      appendLog('log', args);
      _origLog(...args);
    };
    console.warn = function (...args) {
      appendLog('warn', args);
      _origWarn(...args);
    };
    console.error = function (...args) {
      appendLog('error', args);
      _origError(...args);
    };
    appendLog('log', ['🐞 Debug console enabled']);
  } else {
    // Ripristina i metodi originali
    console.log = _origLog;
    console.warn = _origWarn;
    console.error = _origError;
  }
}

/**
 * Inizializza la console di debug.
 * Si attiva con ?debug=1 nell'URL o toccando 5 volte il logo.
 */
export function initDebugConsole() {
  createContainer();

  // Attiva se URL ha ?debug=1
  if (window.location.search.includes('debug=1')) {
    toggle(true);
  }

  // Attiva toccando 5 volte il logo
  let tapCount = 0;
  let tapTimer = null;
  const logo = document.querySelector('.logo-icon') || document.querySelector('.brand-name');
  if (logo) {
    logo.addEventListener('click', () => {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapCount = 0; }, 800);
      if (tapCount >= 5) {
        tapCount = 0;
        toggle();
      }
    });
  }

  // Mostra info iniziali
  _origLog('[🐞 DebugConsole] Pronta — ?debug=1 o 5 tap sul logo');
}
