/**
 * MarkOut — Script condiviso delle pagine statiche (About, Privacy, …).
 *
 * Gestisce: tema chiaro/scuro, hamburger menu, banner "no cookies",
 * CTA sticky mobile e il form di contatto (con stati di errore/loading).
 *
 * NB: la pagina principale (index.html) usa src/main.js; questo modulo
 * è indipendente dal bundle dell'app (niente PDF/ML).
 */
import { initCookieBanner, initGitHubStars, registerServiceWorker, initLangSwitch } from './banner.js';
import { initI18n } from './i18n.js';

/* ─── Theme toggle (stessa logica di presentation/dom.js) ─── */
export function initThemeToggle() {
  const html = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;

  const syncThemeColor = (dark) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1117' : '#ffffff');
  };

  themeToggle.addEventListener('click', () => {
    const dark = html.getAttribute('data-theme') !== 'dark';
    if (dark) html.setAttribute('data-theme', 'dark');
    else html.removeAttribute('data-theme');
    try { localStorage.setItem('markout-theme', dark ? 'dark' : 'light'); } catch { /* noop */ }
    syncThemeColor(dark);
  });

  try {
    if (localStorage.getItem('markout-theme') === 'dark') {
      html.setAttribute('data-theme', 'dark');
      syncThemeColor(true);
    }
  } catch { /* noop */ }
}

/* ─── Hamburger menu (mobile) ─── */
export function initHamburger() {
  const hamburger = document.getElementById('hamburger');
  const headerNav = document.getElementById('headerNav');
  if (!hamburger || !headerNav) return;

  const close = () => headerNav.classList.remove('nav-open');
  hamburger.addEventListener('click', () => headerNav.classList.toggle('nav-open'));
  document.addEventListener('click', e => {
    if (!hamburger.contains(e.target) && !headerNav.contains(e.target)) close();
  });
  // Esc chiude il menu (WCAG 2.1.2)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* ─── Sticky CTA mobile ───
 * Su mobile la barra fissa in basso è sempre visibile; sul tool
 * (index.html) viene nascosta quando l'area di upload è a schermo,
 * per non coprire il risultato.
 */
export function initStickyCta() {
  const sticky = document.getElementById('stickyCta');
  if (!sticky) return;

  const uploadSection = document.getElementById('upload');
  if (uploadSection) {
    const onScroll = () => {
      const r = uploadSection.getBoundingClientRect();
      const visible = r.bottom > 0 && r.top < window.innerHeight * 0.6;
      sticky.style.display = visible ? 'none' : '';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}

/* ─── Form di contatto ───
 * Validazione client-side con stati di errore per campo, stato di
 * loading sul pulsante, poi apre un issue GitHub precompilato (unico
 * canale di contatto reale, senza backend) e rimanda alla thank-you.
 */
export function initContactForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  const fields = {
    name: form.querySelector('#cfName'),
    email: form.querySelector('#cfEmail'),
    message: form.querySelector('#cfMessage'),
  };
  const status = document.getElementById('formStatus');
  const submitBtn = document.getElementById('cfSubmit');
  if (!fields.name || !fields.email || !fields.message || !status || !submitBtn) return;

  const setError = (field, hasError) => {
    const wrap = field.closest('.form-field');
    if (wrap) wrap.classList.toggle('has-error', hasError);
    field.setAttribute('aria-invalid', hasError ? 'true' : 'false'); // WCAG 3.3.1
  };

  const validate = () => {
    let ok = true;
    if (!fields.name.value.trim()) { setError(fields.name, true); ok = false; }
    else setError(fields.name, false);

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(fields.email.value.trim())) { setError(fields.email, true); ok = false; }
    else setError(fields.email, false);

    if (fields.message.value.trim().length < 10) { setError(fields.message, true); ok = false; }
    else setError(fields.message, false);

    return ok;
  };

  // Reset errore digitando
  Object.values(fields).forEach(f => {
    f.addEventListener('input', () => {
      const wrap = f.closest('.form-field');
      if (wrap) wrap.classList.remove('has-error');
    });
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    status.classList.remove('visible', 'error', 'success');
    if (!validate()) {
      // Focus sul primo campo con errore (WIG Forms / WCAG 3.3.1)
      const firstInvalid = [fields.name, fields.email, fields.message]
        .find(f => f.closest('.form-field').classList.contains('has-error'));
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    // Stato di loading sul pulsante
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    // Piccolo delay simulato per mostrare il feedback di caricamento
    setTimeout(() => {
      const title = encodeURIComponent(`[Contact] ${fields.name.value.trim()}`);
      const body = encodeURIComponent(
        `**From:** ${fields.name.value.trim()} <${fields.email.value.trim()}>\n\n${fields.message.value.trim()}`
      );
      const url = `https://github.com/frabbat3/MarkOut/issues/new?title=${title}&body=${body}`;

      window.open(url, '_blank', 'noopener');
      window.location.href = 'thank-you.html';
    }, 700);
  });
}

/* ─── Init ─── */
initI18n();
initThemeToggle();
initHamburger();
initCookieBanner();
initGitHubStars();
initLangSwitch();
registerServiceWorker();
initStickyCta();
initContactForm();
