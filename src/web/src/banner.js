/**
 * MarkOut — Utility condivise tra app e pagine statiche.
 */

/* ─── Contatore stelle GitHub ───
 * Mostra le stelle del repo nel pulsante del header (stile BentoPDF).
 * Fetch all'API pubblica di GitHub (no auth, 60 req/h per IP: più che
 * sufficienti). In caso di errore il contatore resta vuoto e il
 * pulsante rimane comunque un link funzionante.
 */
export function initGitHubStars() {
  const el = document.getElementById('ghStarCount');
  if (!el) return;

  fetch('https://api.github.com/repos/frabbat3/MarkOut')
    .then(r => { if (!r.ok) throw new Error('github api'); return r.json(); })
    .then(d => {
      const n = Number(d.stargazers_count) || 0;
      el.textContent = n >= 1000
        ? (n / 1000).toFixed(1).replace('.0', '') + 'k'
        : String(n);
      // Nome accessibile allineato al testo visibile (Lighthouse label-content-name)
      const btn = el.closest('.gh-star-btn');
      if (btn) {
        const it = document.documentElement.lang === 'it';
        btn.setAttribute('aria-label', it
          ? `Metti una stella a MarkOut su GitHub — ${n} ${n === 1 ? 'stella' : 'stelle'}`
          : `Star MarkOut on GitHub — ${n} star${n === 1 ? '' : 's'}`);
      }
    })
    .catch(() => { el.textContent = ''; });
}

/* ─── Service Worker (cache modelli/WASM) ───
 * Registrata solo in produzione: il modello ONNX e i WASM si scaricano
 * una volta e poi vengono serviti dalla Cache Storage. Su GitHub Pages
 * lo scope è la root del sito (il file sta in dist/sw.js).
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('[SW] registrazione fallita:', err));
  });
}

/* ─── Selettore lingua nel footer (stile BentoPDF) ───
 * Pulsante pill con nome lingua + chevron; menu con ricerca live,
 * lista role="menu"/"menuitem", stato "nessuna lingua trovata",
 * chiusura con Esc/click esterno e navigazione alla stessa pagina
 * nella lingua scelta (l'URL decide la lingua).
 */
export function initLangSwitch() {
  const wrap = document.getElementById('language-switcher');
  const btn = document.getElementById('langBtn');
  const menu = document.getElementById('langMenu');
  if (!wrap || !btn || !menu) return;

  const search = menu.querySelector('.lang-search');
  const empty = menu.querySelector('.lang-empty');
  const items = [...menu.querySelectorAll('.lang-item')];

  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };

  const filter = () => {
    const q = (search.value || '').trim().toLowerCase();
    let count = 0;
    items.forEach(it => {
      const key = it.dataset.searchKey || '';
      const show = !q || key.includes(q);
      it.classList.toggle('hidden', !show);
      if (show) count++;
    });
    if (empty) empty.classList.toggle('hidden', count > 0);
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = menu.classList.contains('hidden');
    btn.setAttribute('aria-expanded', String(willOpen));
    menu.classList.toggle('hidden', !willOpen);
    if (willOpen && search) {
      search.value = '';
      filter();
      requestAnimationFrame(() => search.focus());
    }
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  });
  if (search) search.addEventListener('input', filter);

  // Navigazione alla stessa pagina nell'altra lingua (root = inglese)
  items.forEach(it => {
    it.addEventListener('click', () => {
      const target = it.dataset.lang;
      if (!target) return;
      const path = location.pathname;
      const m = path.match(/\/(en|it|de|fr|es|pt)(\/|$)/);
      const root = m ? path.slice(0, m.index) : path.slice(0, path.lastIndexOf('/'));
      let page = path.slice(path.lastIndexOf('/') + 1);
      if (!page.endsWith('.html')) page = 'index.html';
      const url = target === 'en'
        ? root + '/' + page
        : root + '/' + target + '/' + page;
      location.href = url;
    });
  });
}
