/**
 * Markdown Exporter — generazione ed export del Markdown.
 *
 * I frammenti YOLO (cropData) sono organizzati per:
 *   Pagina → Regione (paragrafo) → Riga (item) → YOLO (frammento)
 *
 * Il formato è pensato come INPUT per modelli LLM:
 *  - front-matter YAML stabile (sorgente, conteggi per pagina, qualità
 *    estrattiva) per un parsing automatico affidabile
 *  - ogni unità di evidenziatura è numerata [H#] con ID globale stabile in
 *    ordine di lettura: l'LLM può citare le singole evidenziature
 *    (es. "secondo il [H12] di pagina 3 …")
 *  - le righe spezzate dalla pipeline (a capo / box adiacenti) vengono
 *    riunite da un linking geometrico leggero (highlightLinking.js): la
 *    frase continua in un unico bullet
 *  - gerarchia esplicita Page → Section, sempre presente (schema
 *    deterministico)
 *  - flag di qualità inline: ⚠️ [no text] = riga non riconosciuta
 *  - sezione "Extraction notes" finale con le anomalie per riga
 */
import { copyBtn, downloadBtn, fmtDate, markdownOut } from './dom.js';
import { linkHighlightLines } from '../domain/highlightLinking.js';
import { makeCtx, healText } from '../domain/wordGlue.js';
import { editDistance } from '../domain/ocr/rowAssist.js';

/** IoU tra due box (per il dedup dei frammenti duplicati). */
function boxIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1);
  const ub = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (ua + ub - inter);
}

/** Testo collassato (minuscole, senza spazi) per il confronto. */
function collapseText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

/** Somiglianza 0..1 tra due testi (edit distance normalizzata). */
function textSim(a, b) {
  const A = collapseText(a);
  const B = collapseText(b);
  if (!A || !B) return 0;
  return 1 - editDistance(A, B) / Math.max(A.length, B.length);
}

/**
 * Rimuove i frammenti duplicati dello stesso item (la stessa riga rilevata
 * due volte da box YOLO sovrapposti, es. Y#29/Y#20 con testi quasi
 * identici): box sovrapposti (IoU ≥ 0.35) + testo quasi identico
 * (somiglianza ≥ 0.85) → tiene il frammento col punteggio più alto
 * (a parità, il testo più lungo).
 */
function dedupeItemFrags(frags) {
  const keep = [];
  for (const f of frags) {
    if (!f.text) {
      keep.push(f);
      continue;
    }
    let dropped = false;
    for (let i = 0; i < keep.length; i++) {
      const k = keep[i];
      if (!k.text) continue;
      if (boxIoU(f, k) < 0.35) continue;
      if (textSim(f.text, k.text) < 0.85) continue;
      const fScore = f.score ?? 0;
      const kScore = k.score ?? 0;
      if (fScore > kScore || (fScore === kScore && f.text.length > k.text.length)) {
        keep[i] = f;
      }
      dropped = true;
      break;
    }
    if (!dropped) keep.push(f);
  }
  return keep;
}

/**
 * Costruisce il Markdown dai frammenti OCR.
 *
 * @param {Array} crops — frammenti con .page, .regionOrder, .itemIndex, .yoloIndex, .text, .ocr
 * @param {string} fileName
 * @returns {string}
 */
export async function buildMarkdown(crops, fileName) {
  if (!crops || !crops.length) return '';

  // YAML: escapa backslash, doppi apici e caratteri di controllo — un
  // filename con virgolette o newline non deve rompere il front-matter.
  const esc = s => String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\t]/g, ' ');
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

  const pages = [...new Set(crops.map(c => c.page))].sort((a, b) => a - b);

  // ── Passo 1: costruisci i bullet (una riga di testo ciascuno)
  // con ID globali H# in ordine di lettura, flag di qualità e box
  // geometrico (serve al linking) ──
  /** @type {Array<{page:number, section:number, h:number, text:string, flags:string[], box:Object|null, warns:Array<{h:number,msg:string}>}>} */
  const lines = [];
  let h = 0;

  const byPage = new Map();
  for (const c of crops) {
    if (!byPage.has(c.page)) byPage.set(c.page, []);
    byPage.get(c.page).push(c);
  }

  for (const pageNum of pages) {
    const pageFrags = byPage.get(pageNum);

    // Margine sinistro della pagina: 10° percentile degli x1 delle righe
    // (robusto agli outlier, es. footer/annotazioni). Le righe con x1
    // molto piccolo (< 50px) sono quasi sempre footer o annotazioni a
    // margine: escluse se il corpo del testo offre campioni sufficienti.
    const xs = pageFrags
      .map(f => f.lineBox?.x1 ?? f.x1 ?? Infinity)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const body = xs.filter(x => x >= 50);
    const marginXs = body.length >= 4 ? body : xs;
    const pageMargin = marginXs.length ? marginXs[Math.min(marginXs.length - 1, Math.floor(marginXs.length * 0.1))] : null;

    // Regioni (paragrafi) in ordine di lettura
    const byRegion = new Map();
    for (const f of pageFrags) {
      const ro = f.regionOrder ?? 0;
      if (!byRegion.has(ro)) byRegion.set(ro, []);
      byRegion.get(ro).push(f);
    }
    const sortedRegions = [...byRegion.keys()].sort((a, b) => a - b);

    for (let si = 0; si < sortedRegions.length; si++) {
      const regionFrags = byRegion.get(sortedRegions[si]);
      const section = si + 1;

      // Righe di testo dentro la regione
      const byItem = new Map();
      for (const f of regionFrags) {
        const ii = f.itemIndex ?? 0;
        if (!byItem.has(ii)) byItem.set(ii, []);
        byItem.get(ii).push(f);
      }
      const sortedItems = [...byItem.keys()].sort((a, b) => a - b);

      for (const itemIdx of sortedItems) {
        const itemFrags = byItem.get(itemIdx);
        itemFrags.sort((a, b) => a.yoloIndex - b.yoloIndex);

        h += 1;
        // Testo dell'item (una riga di evidenziatura): prima si eliminano
        // i frammenti duplicati (stessa riga rilevata due volte), poi unione
        // SEMPLICE con uno spazio — le parole spezzate dai box YOLO vengono
        // ricomposte a valle dal wordGlue (dizionari multilingua).
        const uniqFrags = dedupeItemFrags(itemFrags);
        const text = norm(uniqFrags.map(f => f.text).join(' '));
        const hasText = text.length > 0;

        // Box unione dei frammenti della riga (per il linking geometrico)
        const box = uniqFrags.reduce((acc, f) => ({
          x1: Math.min(acc.x1, f.x1 ?? Infinity),
          y1: Math.min(acc.y1, f.y1 ?? Infinity),
          x2: Math.max(acc.x2, f.x2 ?? -Infinity),
          y2: Math.max(acc.y2, f.y2 ?? -Infinity),
        }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
        const boxOk = isFinite(box.x1) && isFinite(box.y1) && isFinite(box.x2) && isFinite(box.y2) && box.x2 > box.x1 && box.y2 > box.y1;

        const flags = [];
        if (!hasText) {
          flags.push('no text');
        }

        lines.push({
          page: pageNum, section, h, text, flags,
          box: boxOk ? box : null,
          lineBox: itemFrags[0]?.lineBox ?? null,
          margin: pageMargin,
          warns: hasText ? [] : [{ h, page: pageNum, msg: 'line not recognized (empty/failed OCR)' }],
        });
      }
    }
  }

  // ── Passo 2: linking geometrico — riunisce le righe spezzate
  // (a capo / box adiacenti della stessa evidenziatura) con unione SEMPLICE
  // con spazio; le parole spezzate vengono ricomposte dal wordGlue sotto.
  // Ogni unione registra l'offset dello spazio (seams) per la pulizia
  // delle lettere spurie ai bordi di riga.
  const units = linkHighlightLines(lines);

  // ── Passo 2b: guarigione del testo (wordGlue) ──
  // Rileva la lingua del documento e carica il dizionario corrispondente
  // (chunk lazy per lingua); sotto COVERAGE_MIN (lingua non coperta) il
  // gluaggio si disattiva ma restano le pulizie senza dizionario.
  const ctx = await makeCtx(units.map(u => u.text));
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const next = units[i + 1];
    const nextFirst = next
      ? (String(next.text).split(/\s+/).filter(Boolean)[0] ?? null)
      : null;
    // Livello unità: solo operazioni CERTE (il contesto di un frammento è
    // troppo corto per lo scorer n-gramma); le ambiguità si risolvono a
    // livello di sezione, sul testo unito.
    u.text = await healText(u.text, ctx, u.seams ?? [], nextFirst, { scorer: false });
  }

  // Rinumera le sezioni in modo contiguo (dopo i merge possono mancare)
  let si = 0, lastRaw = null;
  for (const u of units) {
    if (u.section !== lastRaw) { si += 1; lastRaw = u.section; }
    u.section = si;
  }

  const mergedCount = units.reduce((n, u) => n + (u.merged > 1 ? 1 : 0), 0);
  // Avvisi delle unità (h rimappato sul numero dell'unità dal linker)
  const warns = units.flatMap(u => u.warns.map(w => ({ h: w.h, page: u.page, msg: w.msg })));

  // ── Passo 2: front-matter YAML (solo informazioni basilari) ──
  const out = [
    '---',
    `title: "Highlights — ${esc(fileName)}"`,
    `source: "${esc(fileName)}"`,
    `date: "${fmtDate()}"`,
    `pages: ${pages.length}`,
    `highlights: ${units.length}`,
    '---',
    '',
    '# Highlights',
    '',
    `Document: ${fileName} · ${pages.length} pages · ${units.length} highlights.`,
    '',
  ];

  // ── Passo 3: corpo — pagina → sezione → testo unito ──
  // Ogni sezione è UN unico blocco con tutto il testo delle sue
  // evidenziature concatenato in ordine di lettura (dopo linking
  // geometrico e gluaggio parole). I riferimenti [H#] compaiono solo
  // nelle Extraction notes (anomalie per riga).
  for (const pageNum of pages) {
    out.push('---', `## Page ${pageNum}`, '');

    const pageUnits = units.filter(u => u.page === pageNum);
    let curSection = -1;
    let secTexts = [];
    const emitSection = async () => {
      const t = secTexts.join(' ').trim();
      // Seconda passata di guarigione sul testo unito della sezione:
      // recupera le parole spezzate AI CONFINI tra unità ("provid-" +
      // "ing…", "classi-" + "fied…") quando il linking non le ha unite.
      if (t) out.push(`* ${await healText(t, ctx, [], null)}`, '');
      secTexts = [];
    };
    for (const u of pageUnits) {
      if (u.section !== curSection) {
        await emitSection();
        curSection = u.section;
        out.push(`### Section ${curSection}`, '');
      }
      if (u.text) secTexts.push(u.text);
    }
    await emitSection();
  }

  // ── Passo 4: note di estrazione (anomalie per unità) ──
  out.push('---', '## Extraction notes', '');
  if (mergedCount) {
    out.push(`- ${mergedCount} unit${mergedCount > 1 ? 's' : ''} merged by geometric linking (adjacent boxes / line-wrap continuation).`, '');
  }
  if (warns.length) {
    for (const w of warns) {
      out.push(`- [H${w.h}] page ${w.page} — ${w.msg}`, '');
    }
  } else {
    out.push('- No warnings: every line was extracted with OCR.', '');
  }
  if (!ctx) {
    out.push('- Text healing limited: document language not recognized (word-level reconstruction disabled).', '');
  }

  return out.join('\n');
}

/* ─── Copia negli appunti ─── */async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Inizializza i listener per copia e download Markdown.
 */
export function initMarkdownExport() {
  /** Etichetta del pulsante senza cancellare l'icona SVG (span i18n). */
  const setCopyLabel = (text) => {
    const span = copyBtn?.querySelector('[data-i18n]');
    if (span) span.textContent = text;
    else if (copyBtn) copyBtn.textContent = text;
  };

  /**
   * Testo Markdown corrente: quello (eventualmente editato a tastiera)
   * nella textarea; se vuoto, rigenera dai dati della pipeline.
   */
  const getEditedMarkdown = async () => {
    if (markdownOut && markdownOut.value.trim()) return markdownOut.value;
    const { currentFile, cropData } = await import('../app/state.js');
    return buildMarkdown(cropData, currentFile?.name || '');
  };

  copyBtn.addEventListener('click', async () => {
    const state = await import('../app/state.js');
    const { currentFile, cropData } = state;
    if (!currentFile || !cropData.length) return;
    const txt = await getEditedMarkdown();
    const ok = await copyText(txt);
    setCopyLabel(ok ? 'Copied!' : 'Copy failed');
    setTimeout(() => setCopyLabel('Copy'), 2000);
  });

  downloadBtn.addEventListener('click', async () => {
    const { currentFile, cropData } = await import('../app/state.js');
    if (!currentFile || !cropData.length) return;
    const txt = await getEditedMarkdown();
    const blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.name.replace(/\.pdf$/i, '') + '-highlights.md';
    a.click();
    URL.revokeObjectURL(url);
  });
}
