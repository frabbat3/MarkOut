/* ═══════════════════════════════════════════════
   MarkOut — Estrazione testo evidenziato da PDF
   ═══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

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
      // Fallback
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
    // Reset UI
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

  /* ─── Nascondi sezioni ─── */
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

  /* ═══════════════════════════════════════════════
     ESTRATTO: mostra risultati
     ═══════════════════════════════════════════════ */
  function showResults(highlights, fileName) {
    hideAll();

    if (highlights.length === 0) {
      noHighlights.classList.remove('hidden');
      return;
    }

    // Costruisci Markdown
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

    // Meta
    const wordCount = highlights.reduce((sum, h) => sum + h.split(/\s+/).length, 0);
    resultMeta.textContent = `${highlights.length} evidenziature · ${wordCount} parole · elaborato localmente nel browser`;

    markdownOut.textContent = md;
    result.classList.remove('hidden');

    // Scroll to result
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ═══════════════════════════════════════════════
     PDF HIGHLIGHT EXTRACTION
     ═══════════════════════════════════════════════ */
  async function extractHighlights(pdfData) {
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const allHighlights = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations(),
        page.getTextContent()
      ]);

      // Filtra solo annotazioni di tipo "Highlight"
      const highlightAnnots = annotations.filter(a => a.subtype === 'Highlight');
      if (highlightAnnots.length === 0) continue;

      // Prepara bounding box del testo
      const textItems = textContent.items.map(item => {
        const [a, b, c, d, e, f] = item.transform;
        const fontSize = Math.sqrt(a * a + b * b) || 12;
        const height = fontSize;
        return {
          str: item.str,
          // Bbox in user space (y up)
          bbox: {
            x1: e,
            y1: f - height * 0.25,          // un po' sotto la baseline
            x2: e + (item.width || fontSize * item.str.length * 0.5),
            y2: f + height * 0.85            // un po' sopra il cap height
          },
          // Per ordinamento
          y: f,
          x: e
        };
      });

      // Per ogni evidenziatura, trova il testo corrispondente
      for (const annot of highlightAnnots) {
        // Usa quadPoints se disponibili (più precisi), altrimenti rect
        let regions = [];

        if (annot.quadPoints && annot.quadPoints.length > 0) {
          // Ogni quad ha 8 numeri: x1,y1, x2,y2, x3,y3, x4,y4
          for (let i = 0; i < annot.quadPoints.length; i += 8) {
            const q = annot.quadPoints.slice(i, i + 8);
            const xs = [q[0], q[2], q[4], q[6]];
            const ys = [q[1], q[3], q[5], q[7]];
            regions.push({
              x1: Math.min(...xs),
              y1: Math.min(...ys),
              x2: Math.max(...xs),
              y2: Math.max(...ys)
            });
          }
        } else if (annot.rect) {
          regions.push({
            x1: Math.min(annot.rect[0], annot.rect[2]),
            y1: Math.min(annot.rect[1], annot.rect[3]),
            x2: Math.max(annot.rect[0], annot.rect[2]),
            y2: Math.max(annot.rect[1], annot.rect[3])
          });
        }

        if (regions.length === 0) continue;

        // Raccogli i text item che cadono nelle regioni evidenziate
        const matchedTexts = new Set();

        for (const region of regions) {
          for (const item of textItems) {
            if (rectsOverlap(item.bbox, region)) {
              matchedTexts.add(item);
            }
          }
        }

        if (matchedTexts.size > 0) {
          // Ordina per posizione (dall'alto verso il basso, poi da sinistra a destra)
          const sorted = Array.from(matchedTexts).sort((a, b) => {
            // In user space, y maggiore = più in alto
            const dy = b.y - a.y;
            if (Math.abs(dy) > 5) return dy;
            return a.x - b.x;
          });

          const text = sorted.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim();
          if (text) {
            allHighlights.push(text);
          }
        }
      }
    }

    return allHighlights;
  }

  /* ─── Overlap test tra due rettangoli (user space, y up) ─── */
  function rectsOverlap(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  }
});
