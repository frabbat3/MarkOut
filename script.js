/**
 * MarkOut — Estrazione evidenziazioni da PDF (logica Holo v2.0 + debug)
 */
(function () {
  'use strict';

  /* ─── Theme Toggle ─── */
  var html = document.documentElement;
  document.getElementById('themeToggle').addEventListener('click', function () {
    if (html.hasAttribute('data-theme')) {
      html.removeAttribute('data-theme');
      localStorage.setItem('markout-theme', 'light');
    } else {
      html.setAttribute('data-theme', 'dark');
      localStorage.setItem('markout-theme', 'dark');
    }
  });
  if (localStorage.getItem('markout-theme') === 'dark') html.setAttribute('data-theme', 'dark');

  /* ─── Hamburger (mobile) ─── */
  var hamburger = document.getElementById('hamburger');
  var headerNav = document.getElementById('headerNav');
  hamburger.addEventListener('click', function () {
    headerNav.classList.toggle('nav-open');
  });
  // Chiudi menu cliccando fuori
  document.addEventListener('click', function (e) {
    if (!hamburger.contains(e.target) && !headerNav.contains(e.target)) {
      headerNav.classList.remove('nav-open');
    }
  });

  /* ─── DOM refs ─── */
  var uploadArea   = document.getElementById('uploadArea');
  var fileInput    = document.getElementById('fileInput');
  var loading      = document.getElementById('loading');
  var result       = document.getElementById('result');
  var noHighlights = document.getElementById('noHighlights');
  var error        = document.getElementById('error');
  var errorMsg     = document.getElementById('errorMsg');
  var markdownOut  = document.getElementById('markdownOutput');
  var resultMeta   = document.getElementById('resultMeta');
  var copyBtn      = document.getElementById('copyBtn');
  var downloadBtn  = document.getElementById('downloadBtn');

  var currentFile = null;
  var currentHighlights = [];

  function fmtDate() {
    return new Date().toLocaleDateString('it-IT', { year:'numeric', month:'long', day:'numeric' });
  }

  function hideAll() {
    loading.classList.add('hidden');
    result.classList.add('hidden');
    noHighlights.classList.add('hidden');
    error.classList.add('hidden');
  }

  /* ─── Upload UI ─── */
  uploadArea.addEventListener('click', function () { fileInput.click(); });
  uploadArea.addEventListener('dragover', function (e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', function () { uploadArea.classList.remove('dragover'); });
  uploadArea.addEventListener('drop', function (e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (this.files[0]) processFile(this.files[0]);
    this.value = '';
  });

  /* ─── Copia / Scarica ─── */
  copyBtn.addEventListener('click', async function () {
    if (!currentFile || !currentHighlights.length) return;
    var txt = buildMarkdown(currentHighlights, currentFile.name);
    try { await navigator.clipboard.writeText(txt); } catch (ex) {
      var ta = document.createElement('textarea'); ta.value = txt;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
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
      errorMsg.textContent = 'Il file non è un PDF valido.';
      error.classList.remove('hidden');
      return;
    }
    currentFile = f;
    currentHighlights = [];
    loading.classList.remove('hidden');

    console.log('📄 MarkOut: leggo file', f.name, '(' + (f.size / 1024).toFixed(1) + ' KB)');

    // Verifica che pdfjsLib sia disponibile
    if (typeof pdfjsLib === 'undefined') {
      loading.classList.add('hidden');
      errorMsg.textContent = 'PDF.js non caricato. Prova a ricaricare la pagina.';
      error.classList.remove('hidden');
      console.error('❌ pdfjsLib non definito!');
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var buf = new Uint8Array(e.target.result);
        console.log('📄 buffer pronto, ' + buf.length + ' bytes, avvio getDocument...');

        // Imposta worker PRIMA di getDocument
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        pdfjsLib.getDocument({ data: buf }).promise.then(function (pdf) {
          console.log('📄 PDF caricato: ' + pdf.numPages + ' pagine');
          return extractHighlights(pdf);
        }).then(function (highlights) {
          currentHighlights = highlights;
          console.log('📄 Estrazione completata: ' + highlights.length + ' evidenziature');
          pdfjsLib.getDocument({ data: buf }).promise.then(function (p) { p.destroy(); });
          showResult();
        }).catch(function (err) {
          console.error('❌ Errore PDF:', err);
          loading.classList.add('hidden');
          errorMsg.textContent = err.message || 'Impossibile leggere il PDF.';
          error.classList.remove('hidden');
        });

      } catch (err) {
        console.error('❌ Errore:', err);
        loading.classList.add('hidden');
        errorMsg.textContent = err.message;
        error.classList.remove('hidden');
      }
    };
    reader.onerror = function () {
      loading.classList.add('hidden');
      errorMsg.textContent = 'Errore nella lettura del file.';
      error.classList.remove('hidden');
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

  /* ═══════════════════════════════════════════════
     PDF HIGHLIGHT EXTRACTION — logica Holo v2.0
     ═══════════════════════════════════════════════ */

  function isHighlight(a) {
    return a.subtype === 'Highlight';
  }

  function overlap(a, b) {
    var ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    var oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return ox > 0 && oy > 0;
  }

  function extractText(items, ann) {
    // 1. Usa "contents" se popolato
    if (ann.contents && ann.contents.trim()) {
      console.log('  ✅ usato ann.contents: "' + ann.contents.trim().substring(0, 50) + '..."');
      return ann.contents.trim();
    }

    // 2. Estrai quadPoints o rect
    var quads = [];
    if (ann.quadPoints && ann.quadPoints.length >= 8) {
      console.log('  📐 quadPoints lunghezza=' + ann.quadPoints.length + ', primo valore=' + ann.quadPoints[0] + ' (tipo=' + typeof ann.quadPoints[0] + ')');
      var isNested = Array.isArray(ann.quadPoints[0]);
      if (isNested) {
        // Formato nidificato: [[x1,y1,...], [x1,y1,...]]
        for (var i = 0; i < ann.quadPoints.length; i++) {
          var q = ann.quadPoints[i];
          if (q.length >= 8) {
            quads.push({
              x0: Math.min(q[0], q[2], q[4], q[6]),
              y0: Math.min(q[1], q[3], q[5], q[7]),
              x1: Math.max(q[0], q[2], q[4], q[6]),
              y1: Math.max(q[1], q[3], q[5], q[7])
            });
          }
        }
      } else {
        // Formato piatto: [x1,y1,x2,y2,x3,y3,x4,y4, ...]
        for (var i = 0; i < ann.quadPoints.length; i += 8) {
          var q = ann.quadPoints.slice(i, i + 8);
          quads.push({
            x0: Math.min(q[0], q[2], q[4], q[6]),
            y0: Math.min(q[1], q[3], q[5], q[7]),
            x1: Math.max(q[0], q[2], q[4], q[6]),
            y1: Math.max(q[1], q[3], q[5], q[7])
          });
        }
      }
      console.log('  → ' + quads.length + ' quads da quadPoints');
    } else if (ann.rect && ann.rect.length >= 4) {
      quads.push({ x0: ann.rect[0], y0: ann.rect[1], x1: ann.rect[2], y1: ann.rect[3] });
      console.log('  📐 usato rect: [' + quads[0].x0 + ', ' + quads[0].y0 + ', ' + quads[0].x1 + ', ' + quads[0].y1 + ']');
    }

    if (!quads.length) {
      console.log('  ❌ nessun quadPoints e nessun rect!');
      return '[testo]';
    }
    if (!items.length) {
      console.log('  ❌ nessun text item sulla pagina!');
      return '[testo]';
    }

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

    console.log('  → ' + matched.length + ' text item che overlap con ' + quads.length + ' quads (su ' + items.length + ' totali)');

    if (!matched.length) return '[testo]';

    // 4. Raggruppa per riga
    var lines = {};
    for (var m = 0; m < matched.length; m++) {
      var row = Math.round(matched[m].y / 6) * 6;
      if (!lines[row]) lines[row] = [];
      lines[row].push(matched[m]);
    }

    var result = [];
    var sortedRows = Object.keys(lines).map(Number).sort(function (a, b) { return b - a; });
    for (var r = 0; r < sortedRows.length; r++) {
      lines[sortedRows[r]].sort(function (a, b) { return a.x - b.x; });
      var lineText = lines[sortedRows[r]].map(function (m) { return m.text; }).join(' ');
      result.push(lineText);
    }

    var final = result.join(' ') || '[testo]';
    console.log('  → testo estratto: "' + final.substring(0, 80) + (final.length > 80 ? '..."' : '"'));
    return final;
  }

  async function extractHighlights(pdf) {
    var all = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      console.log('📄 Pagina ' + p + '/' + pdf.numPages + '...');
      var page = await pdf.getPage(p);

      var anns = [];
      try {
        anns = await page.getAnnotations();
        console.log('  Annotazioni totali: ' + anns.length);
        // Logga i tipi di annotazioni trovate
        var types = {};
        for (var ai = 0; ai < anns.length; ai++) {
          var subtype = anns[ai].subtype || '(nessuno)';
          types[subtype] = (types[subtype] || 0) + 1;
        }
        console.log('  Tipi annotazioni:', JSON.stringify(types));
        // Mostra qualche dettaglio sulle prime annotazioni
        for (var ai = 0; ai < Math.min(3, anns.length); ai++) {
          var a = anns[ai];
          console.log('  [' + ai + '] subtype=' + a.subtype + ' hasContents=' + !!(a.contents) + ' hasQuadPoints=' + !!(a.quadPoints) + ' hasRect=' + !!(a.rect));
        }
      } catch (e) {
        console.warn('  ⚠️ errore getAnnotations p' + p, e);
      }

      var hl = anns.filter(isHighlight);
      console.log('  Highlight trovate: ' + hl.length);

      if (!hl.length) continue;

      var items = [];
      try {
        var tc = await page.getTextContent();
        items = tc.items;
        console.log('  Text items: ' + items.length);
      } catch (e) {
        console.warn('  ⚠️ errore getTextContent p' + p, e);
      }

      for (var i = 0; i < hl.length; i++) {
        var text = extractText(items, hl[i]).trim();
        var note = (hl[i].contents || '').trim();
        all.push({ page: p, text: text, note: note });
      }
    }
    console.log('📄 TOTALE evidenziature: ' + all.length);
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
      if (h.page !== cur) { cur = h.page; out.push('---'); out.push('## Pagina ' + cur); out.push(''); }
      out.push('> ' + h.text);
      if (h.note) out.push('  *Nota: ' + h.note + '*');
      out.push('');
      out.push('');
    }
    return out.join('\n');
  }

  console.log('🔵 MarkOut ready — apri la console (F12) per vedere i log di debug');
})();
