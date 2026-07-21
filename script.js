/* ═══════════════════════════════════════════════
   MarkOut — Estrazione testo evidenziato da PDF
   ═══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  /* ─── Theme Toggle ─── */
  const themeToggle = document.getElementById('themeToggle');
  const iconLight = themeToggle.querySelector('.icon-light');
  const iconDark = themeToggle.querySelector('.icon-dark');

  // Leggi preferenza salvata
  const savedTheme = localStorage.getItem('markout-theme') || 'light';
  applyTheme(savedTheme);

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('markout-theme', next);
  });

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      iconLight.classList.add('hidden');
      iconDark.classList.remove('hidden');
      themeToggle.setAttribute('aria-label', 'Attiva tema chiaro');
    } else {
      document.documentElement.removeAttribute('data-theme');
      iconLight.classList.remove('hidden');
      iconDark.classList.add('hidden');
      themeToggle.setAttribute('aria-label', 'Attiva tema scuro');
    }
  }

  /* ─── Elementi DOM ─── */
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

  /* ─── Upload: click ─── */
  uploadArea.addEventListener('click', () => fileInput.click());

  /* ─── Upload: drag & drop ─── */
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  /* ─── Upload: file input ─── */
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  /* ─── Copia / Scarica ─── */
  let lastMarkdown = '';

  copyBtn.addEventListener('click', async () => {
    if (!lastMarkdown) return;
    try {
      await navigator.clipboard.writeText(lastMarkdown);
      copyBtn.textContent = '✅ Copiato!';
      setTimeout(() => { copyBtn.textContent = '📋 Copia'; }, 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = lastMarkdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      copyBtn.textContent = '✅ Copiato!';
      setTimeout(() => { copyBtn.textContent = '📋 Copia'; }, 2000);
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastMarkdown) return;
    const blob = new Blob([lastMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'estratto-evidenziato.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* ─── Gestione file ─── */
  function handleFile(file) {
    hideAll();
    loading.classList.remove('hidden');

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showError('Il file selezionato non è un PDF valido.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const pdfData = new Uint8Array(e.target.result);
        const highlights = await extractHighlights(pdfData);
        showResults(highlights, file.name);
      } catch (err) {
        console.error(err);
        showError('Errore durante l\'elaborazione del PDF: ' + err.message);
      }
    };
    reader.onerror = () => showError('Errore nella lettura del file.');
    reader.readAsArrayBuffer(file);
  }

  /* ─── Utility UI ─── */
  function hideAll() {
    loading.classList.add('hidden');
    result.classList.add('hidden');
    noHighlights.classList.add('hidden');
    error.classList.add('hidden');
  }

  function showError(msg) {
    hideAll();
    errorMsg.textContent = msg;
    error.classList.remove('hidden');
  }

  function showResults(highlights, fileName) {
    hideAll();

    if (highlights.length === 0) {
      noHighlights.classList.remove('hidden');
      return;
    }

    let md = `# Testo evidenziato\n\n`;
    md += `> Estratto da: **${fileName}**  \n`;
    md += `> Frammenti evidenziati: **${highlights.length}**\n\n`;
    md += `---\n\n`;

    highlights.forEach((h, i) => {
      md += `## ${i + 1}. Evidenziato\n\n`;
      md += `> ${h}\n\n`;
    });

    md += `---\n\n*Generato con MarkOut il ${new Date().toLocaleDateString('it-IT')}*`;

    lastMarkdown = md;

    const wordCount = highlights.reduce((sum, h) => sum + h.split(/\s+/).length, 0);
    resultMeta.textContent = `${highlights.length} evidenziature · ${wordCount} parole · elaborato localmente nel browser`;

    markdownOut.textContent = md;
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ═══════════════════════════════════════════════
     PDF HIGHLIGHT EXTRACTION — CORE
     ═══════════════════════════════════════════════ */
  async function extractHighlights(pdfData) {
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const totalPages = pdf.numPages;
    const allHighlights = [];
    let totalAnnotations = 0;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      // Ottieni annotazioni e contenuto testuale in parallelo
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations(),
        page.getTextContent()
      ]);

      totalAnnotations += annotations.length;

      // Filtra annotazioni di tipo "Highlight"
      // subtype === "Highlight" (stringa)  OPPURE  annotationType === 9 (numero)
      const highlightAnnots = annotations.filter(a =>
        a.subtype === 'Highlight' || a.annotationType === 9
      );

      if (highlightAnnots.length === 0) continue;

      // Prepara bounding box del testo in coordinate PDF (y ↑)
      const textItems = textContent.items.map(item => {
        const [a, , , d, e, f] = item.transform;
        const fontSize = Math.sqrt(a * a + d * d) || 12;
        const width = item.width || (fontSize * item.str.length * 0.55);
        return {
          str: item.str,
          // Bbox approssimativo in user space
          bbox: {
            x1: e,
            y1: f - fontSize * 0.3,
            x2: e + width,
            y2: f + fontSize * 0.9
          },
          y: f,
          x: e,
          fontSize
        };
      });

      // Per ogni evidenziatura, estrai il testo corrispondente
      for (const annot of highlightAnnots) {
        // Ottieni le regioni (quadPoints o rect)
        const regions = getAnnotationRegions(annot);
        if (regions.length === 0) continue;

        const matchedTexts = new Set();
        for (const region of regions) {
          for (const item of textItems) {
            if (rectsOverlap(item.bbox, region)) {
              matchedTexts.add(item);
            }
          }
        }

        if (matchedTexts.size > 0) {
          const sorted = Array.from(matchedTexts).sort((a, b) => {
            // In user space y maggiore = più in alto
            const dy = b.y - a.y;
            if (Math.abs(dy) > fontSizeThreshold(a, b)) return dy;
            return a.x - b.x;
          });

          const text = sorted.map(t => t.str).join('').replace(/\s+/g, ' ').trim();
          if (text) allHighlights.push(text);
        }
      }
    }

    // Debug info in console
    console.log(`📄 MarkOut: ${totalPages} pagine, ${totalAnnotations} annotazioni totali, ${allHighlights.length} evidenziature estratte`);

    return allHighlights;
  }

  /* ─── Estrae le regioni (rettangoli) da una annotazione ─── */
  function getAnnotationRegions(annot) {
    const regions = [];

    // 1) Prova con quadPoints (più precisi)
    if (annot.quadPoints && annot.quadPoints.length > 0) {
      // PDF.js può restituire quadPoints in due formati:
      // - Array di array: [[x1,y1,x2,y2,x3,y3,x4,y4], ...]
      // - Array piatto:  [x1,y1,x2,y2,x3,y3,x4,y4, ...]
      const first = annot.quadPoints[0];
      let quads;

      if (Array.isArray(first)) {
        // Formato nidificato: [[x1,y1,...], [x2,y2,...]]
        quads = annot.quadPoints;
      } else {
        // Formato piatto: [x1,y1,x2,y2,...]
        quads = [];
        for (let i = 0; i < annot.quadPoints.length; i += 8) {
          quads.push(annot.quadPoints.slice(i, i + 8));
        }
      }

      for (const q of quads) {
        // q ha 8 numeri: x1,y1, x2,y2, x3,y3, x4,y4
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        regions.push({
          x1: Math.min(...xs),
          y1: Math.min(...ys),
          x2: Math.max(...xs),
          y2: Math.max(...ys)
        });
      }
    }

    // 2) Fallback su rect (meno preciso ma sempre disponibile)
    if (regions.length === 0 && annot.rect) {
      regions.push({
        x1: Math.min(annot.rect[0], annot.rect[2]),
        y1: Math.min(annot.rect[1], annot.rect[3]),
        x2: Math.max(annot.rect[0], annot.rect[2]),
        y2: Math.max(annot.rect[1], annot.rect[3])
      });
    }

    return regions;
  }

  /* ─── Soglia di fontSize per ordinamento righe ─── */
  function fontSizeThreshold(a, b) {
    return Math.min(a.fontSize, b.fontSize) * 0.5;
  }

  /* ─── Overlap test tra due rettangoli (user space, y ↑) ─── */
  function rectsOverlap(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  }
});
