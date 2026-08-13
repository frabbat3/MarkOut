/**
 * MarkOut — i18n (sistema di traduzione stile BentoPDF, self-hosted).
 *
 * - URL per locale: /it/about.html (su GitHub Pages funziona anche /it/about)
 * - Dizionari JSON self-hostati: /locales/en.json, /locales/it.json
 * - Gli elementi con data-i18n="key" vengono compilati a runtime;
 *   il testo hardcoded nell'HTML è il fallback (il sito funziona senza JS)
 * - Rilevamento lingua: path (/it/) → localStorage → lingua del browser → en
 */
const LOCALES = ['en', 'it', 'de', 'fr', 'es', 'pt'];

/** Dizionario corrente (per la funzione t() dell'UI dinamica). */
let _dict = null;

/**
 * Traduce una chiave per l'UI dinamica (elementi creati a runtime).
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function t(key, fallback = '') {
  const v = _dict && typeof _dict[key] === 'string' ? _dict[key] : null;
  return v ?? (fallback || key);
}

/**
 * Lingua corrente, decisa DALL'URL (unica fonte di verità):
 * root = inglese, /xx/ = altre lingue. Niente fallback su browser o
 * localStorage: lo switcher e i link sono coerentemente statici.
 * @returns {'en'|'it'|'de'|'fr'|'es'|'pt'}
 */
export function getLocale() {
  const m = location.pathname.match(/\/(en|it|de|fr|es|pt)(\/|$)/);
  return (m && LOCALES.includes(m[1])) ? m[1] : 'en';
}

/**
 * URL del dizionario, robusto rispetto a root/sottocartella (GitHub Pages).
 * @param {'en'|'it'} locale
 */
function dictUrl(locale) {
  // /MarkOut/it/about.html → /MarkOut/  ·  /index.html → /  ·  dev /about.html → /
  const root = location.pathname
    .replace(/\/it\/[^/]*$/, '/')
    .replace(/\/[^/]*\.html$/, '/');
  return root + 'locales/' + locale + '.json';
}

/**
 * Applica il dizionario agli elementi [data-i18n] e imposta <html lang>.
 * In caso di errore resta il testo hardcoded dell'HTML (fallback).
 */
export async function initI18n() {
  const locale = getLocale();
  document.documentElement.lang = locale;

  if (!document.querySelector('[data-i18n], [data-i18n-attr]')) return;
  try {
    const res = await fetch(dictUrl(locale), { cache: 'no-cache' });
    if (!res.ok) return;
    const dict = await res.json();
    _dict = dict;
    document.querySelectorAll('[data-i18n], [data-i18n-attr]').forEach(el => {
      const key = el.dataset.i18n || el.dataset.i18nAttr;
      const val = dict[key];
      if (typeof val !== 'string') return;
      // innerHTML solo se l'elemento è esso stesso la traduzione;
      // se il testo tradotto vive in un <span> figlio (icone SVG inline
      // nel contenitore), qui si aggiorna solo l'attributo.
      if (el.dataset.i18n) el.innerHTML = val;
      const attr = el.dataset.i18nAttr;
      if (attr) el.setAttribute(attr, val);
    });
  } catch { /* fallback: testo hardcoded */ }
}
