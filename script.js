/**
 * MarkOut — Estrazione evidenziazioni da PDF (basato su logica Holo v2.0 funzionante)
 */
(function () {
  'use strict';

  /* ─── Theme Toggle ─── */
  const themeToggle = document.getElementById('themeToggle');
  const html = document.documentElement;

  // Ripristina preferenza da localStorage
  if (localStorage.getItem('markout-theme') === 'dark') {
    html.setAttribute('data-theme', 'dark');
  }

  themeToggle.addEventListener('click', function () {
    if (html.hasAttribute('data-theme')) {
      html.removeAttribute('data-theme');
      localStorage.setItem('markout-theme', 'light');
    } else {
      html.setAttribute('data-theme', 'dark');
      localStorage.setItem('markout-theme', 'dark');
    }
  });

  /* ─── DOM refs ─── */
  const uploadArea   = document.getElementById('uploadArea');
  const fileInput    = document.getElementById('fileInput');
  const loading      = document.getElementById('loading');
  const result       = document.getElementById('result');
  const noHighlights = document.getElementById('noHighlights');
  const error        = document.getElementById('error');
  const errorMsg     = document.getElementById('errorMsg');
  const markdownOut  = document.getElementById('markdownOutput');
  const resultMeta   = document.getElementById('resultMeta');
  const copyBtn      = document.getElementById('copyBtn');
  const downloadBtn  = document.getElementById('downloadBtn');

  let currentFile = null;
  let currentHighlights = [];

  /* ─── Helpers ─── */
  const fmtDate = () => new Date().toLocaleDateString('it-IT', { year:'numeric', month:'long', day:'numeric' });

  const esc = function (s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  };

  const hideAll = function () {
    loading.classList.add('hidden');
    result.classList.add('hidden');
    noHighlights.classList.add('hidden');
    error.classList.add('hidden');
  };

  /* ─── Upload UI ─── */
  uploadArea.addEventListener('click', function () { fileInput.click(); });

  uploadArea.addEventListener('dragover', function (e) {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', function () {
    uploadArea.classList.remove('dragover');
  });
  uploadArea.addEventListener('drop', function (e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    var f = e.dataTransfer.files[0];
    if (f) processFile(f);
  });

  fileInput.addEventListener('change', function () {
    var f = this.files[0];
    if (f) processFile(f);
    this.value = '';
  });

  /* ─── Copia / Scarica ─── */
  copyBtn.addEventListener('click', async function () {
    if (!currentFile || !currentHighlights.length) return;
    var txt = buildMarkdown(currentHighlights, currentFile.name);
    try {
      await navigator.clipboard.writeText(txt);
    } catch (ex) {
      var ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copyBtn.textContent = '✅ Copiato!';
    setTimeout(function () { copyBtn.textContent = '📋 Copia'; }, 2000);
  });

  downloadBtn.addEventListener('click', function () {
    if (!currentFile || !currentHighlights.length) return;
    var txt = buildMarkdown(currentHighlights, currentFile.name);
    var blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (currentFile.name || 'doc').replace(/\.pdf$/i, '') + '-evidenziazioni.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  /* ─── Elabora file ─── */
  function processFile(f) {
    hideAll();
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      showError('Il file selezionato non è un PDF valido.');
      return;
    }
    currentFile = f;
    currentHighlights = [];
    loading.classList.remove('hidden');

    var reader = new FileReader();
    reader.onload = async function (e) {
      try {
        var buf = new Uint8Array(e.target.result);
        var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        currentHighlights = await extractHighlights(pdf);
        pdf.destroy();
        showResult();
      } catch (err) {
        console.error('MarkOut error:', err);
        loading.classList.add('hidden');
        showError(err.message || 'Impossibile leggere il PDF.');
      }
    };
    reader.onerror = function () {
      loading.classList.add('hidden');
      showError('Errore nella lettura del file.');
    };
    reader.readAsArrayBuffer(f);
  }

  function showResult() {
    loading.classList.add('hidden');
    if (!currentHighlights.length) {
      noHighlights.classList.remove('hidden');
      return;
    }
    var mdText = buildMarkdown(currentHighlights, currentFile.name);
    var pages = new Set(currentHighlights.map(function (h) { return h.page; }));
    resultMeta.textContent = currentHighlights.length + ' evidenziazioni · ' + pages.size + ' pagine — ' + currentFile.name;
    markdownOut.textContent = mdText;
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    error.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════
     PDF HIGHLIGHT EXTRACTION — logica da Holo v2.0
     ═══════════════════════════════════════════════ */

  function isHighlight(a) {
    return a.subtype === 'Highlight';
  }

  /* Overlap tra due bbox (formato x0,y0 → x1,y1) */
  function overlap(a, b) {
    var ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    var oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return ox > 0 && oy > 0;
  }

  /* Estrae testo da un'annotazione highlight */
  function extractText(items, ann) {
    // 1. Se l'annotazione ha "contents", usalo subito (molti PDF lo popolano)
    if (ann.contents && ann.contents.trim()) {
      return ann.contents.trim();
    }

    // 2. Estrai quadPoints o rect
    var quads = [];
    if (ann.quadPoints && ann.quadPoints.length >= 8) {
      // quadPoints è un array piatto: [x1,y1,x2,y2,x3,y3,x4,y4, ...]
      for (var i = 0; i < ann.quadPoints.length; i += 8) {
        var q = ann.quadPoints.slice(i, i + 8);
        quads.push({
          x0: Math.min(q[0], q[2], q[4], q[6]),
          y0: Math.min(q[1], q[3], q[5], q[7]),
          x1: Math.max(q[0], q[2], q[4], q[6]),
          y1: Math.max(q[1], q[3], q[5], q[7])
        });
      }
    } else if (ann.rect && ann.rect.length >= 4) {
      quads.push({
        x0: ann.rect[0],
        y0: ann.rect[1],
        x1: ann.rect[2],
        y1: ann.rect[3]
      });
    }

    if (!quads.length || !items.length) return '[testo]';

    // 3. Trova text items che overlap con i quad
    var matched = [];
    for (var it = 0; it < items.length; it++) {
      var item = items[it];
      if (!item.str || !item.str.trim()) continue;
      var tx = item.transform[4];
      var ty = item.transform[5];
      var tw = item.width || 1;
      var th = item.height || item.fontSize || 12;
      var itemBox = { x0: tx, y0: ty - th, x1: tx + tw, y1: ty };

      for (var qi = 0; qi < quads.length; qi++) {
        if (overlap(itemBox, quads[qi])) {
          matched.push({ text: item.str, x: tx, y: ty, w: tw });
          break;
        }
      }
    }

    if (!matched.length) return '[testo]';

    // 4. Raggruppa per riga (Y approssimato a ±6 unità)
    var lines = {};
    for (var m = 0; m < matched.length; m++) {
      var row = Math.round(matched[m].y / 6) * 6;
      if (!lines[row]) lines[row] = [];
      lines[row].push(matched[m]);
    }

    var result = [];
    var sortedRows = Object.keys(lines).map(Number).sort(function (a, b) { return b - a; }); // Y alto → inizio pagina
    for (var r = 0; r < sortedRows.length; r++) {
      lines[sortedRows[r]].sort(function (a, b) { return a.x - b.x; }); // X crescente → sin→dx
      var lineText = lines[sortedRows[r]].map(function (m) { return m.text; }).join(' ');
      result.push(lineText);
    }

    return result.join(' ') || '[testo]';
  }

  async function extractHighlights(pdf) {
    var all = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);

      var anns = [];
      try { anns = await page.getAnnotations(); } catch (e) { console.warn('annotation error p' + p, e); }

      var hl = anns.filter(isHighlight);
      if (!hl.length) continue;

      var items = [];
      try { var tc = await page.getTextContent(); items = tc.items; } catch (e) { console.warn('textcontent error p' + p, e); }

      for (var i = 0; i < hl.length; i++) {
        var text = extractText(items, hl[i]).trim();
        var note = (hl[i].contents || '').trim();
        all.push({ page: p, text: text, note: note });
      }
    }
    return all;
  }

  /* ─── Markdown ─── */
  function buildMarkdown(highlights, fileName) {
    var pages = new Set(highlights.map(function (h) { return h.page; }));
    var out = [];
    out.push('---');
    out.push('title: "Evidenziazioni"');
    out.push('source: "' + fileName + '"');
    out.push('date: "' + fmtDate() + '"');
    out.push('count: ' + highlights.length);
    out.push('pages: ' + pages.size);
    out.push('---');
    out.push('');
    out.push('# Evidenziazioni estratte');
    out.push('');
    out.push('**Fonte:** ' + fileName + '  ');
    out.push('**Data:** ' + fmtDate() + '  ');
    out.push('**Totale:** ' + highlights.length + ' evidenziazioni · ' + pages.size + ' pagine');
    out.push('');

    var cur = 0;
    for (var i = 0; i < highlights.length; i++) {
      var h = highlights[i];
      if (h.page !== cur) {
        cur = h.page;
        out.push('---');
        out.push('## Pagina ' + cur);
        out.push('');
      }
      out.push('> ' + h.text);
      if (h.note) out.push('  *Nota: ' + h.note + '*');
      out.push('');
      out.push('');
    }
    return out.join('\n');
  }

})();
