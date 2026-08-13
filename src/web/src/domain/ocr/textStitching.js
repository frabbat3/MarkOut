/**
 * Text Stitching — ricostruzione del testo da frammenti OCR.
 *
 * Gestisce:
 * - Unione di testi da split sovrapposti (dedup a livello di parola)
 * - Recupero parole tagliate al seam (overlap a livello di carattere)
 * - Merge di risultati OCR batch
 *
 * Configurazione "v4" validata su dataset (CER split>1024: 0.422 → 0.059):
 * prima si cerca l'overlap di parole (dedup), poi l'overlap di caratteri
 * (parole spezzate al taglio), altrimenti si concatenano con spazio.
 */

/**
 * Overlap a livello di parola tra fine di `left` e inizio di `right`.
 * @param {string} left
 * @param {string} right
 * @returns {string|null} — testo unito senza duplicazione, o null
 */
function stitchWords(left, right) {
  const leftWords = left.split(/\s+/);
  const rightWords = right.split(/\s+/);

  for (let k = Math.min(leftWords.length, rightWords.length); k >= 1; k--) {
    const tail = leftWords.slice(-k).join(' ').toLowerCase();
    const head = rightWords.slice(0, k).join(' ').toLowerCase();
    if (tail === head) {
      return leftWords.join(' ') + ' ' + rightWords.slice(k).join(' ');
    }
  }
  return null;
}

/** True se la stringa contiene solo lettere (equivalente a str.isalpha). */
function isAlpha(s) {
  return /^\p{L}+$/u.test(s);
}

/**
 * Overlap a livello di carattere: recupera le parole tagliate al seam
 * (es. "scien-" + "ce" → "science"), solo se il match è "dentro" una
 * parola di entrambi i lati. Stessa semantica della valutazione Python.
 *
 * @param {string} left
 * @param {string} right
 * @param {number} [minK=4] — lunghezza minima dell'overlap
 * @returns {string|null}
 */
function stitchChars(left, right, minK = 4) {
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  const L = l.length;
  const R = r.length;
  for (let k = Math.min(L, R); k >= minK; k--) {
    if (l.slice(-k) === r.slice(0, k)) {
      // left[-k-1:k-1] e right[k-1:k+1] (semantica Python replicata)
      const a = left.slice(L - k - 1, k - 1);
      const b = right.slice(k - 1, k + 1);
      if (a && b && isAlpha(a) && isAlpha(b)) {
        return left.slice(0, -k) + right;
      }
    }
  }
  return null;
}

/**
 * Unisce i testi dei sub-canvas (2 o 3) nell'ordine di lettura:
 * word-overlap → char-overlap → concatenazione con spazio.
 *
 * @param {string[]} texts
 * @returns {string}
 */
export function stitchSplitTexts(texts) {
  let out = texts[0];
  for (let i = 1; i < texts.length; i++) {
    const w = stitchWords(out, texts[i]);
    if (w !== null) {
      out = w;
      continue;
    }
    const c = stitchChars(out, texts[i]);
    out = c !== null ? c : out + ' ' + texts[i];
  }
  return out;
}

import { alignFragmentToRow } from './rowAssist.js';

/**
 * Rimappa i risultati OCR piatti (un risultato per sub-canvas)
 * ai frammenti originali, gestendo split e merge.
 *
 * v5: per ogni frammento con riga det (rowCanvases) riconosce anche la riga
 * intera e combina i due testi con alignFragmentToRow: se il frammento
 * allinea dentro la riga si usa il segmento di riga (contesto migliore),
 * altrimenti resta il testo del frammento (det inaffidabile).
 *
 * @param {Array} subMap — array di { fragIndex, subCanvases, rowCanvases, split }
 * @param {Array} flatResults — risultati OCR piatti (parallelo a flatCanvases:
 *   prima i sub-canvas del frammento, poi quelli della riga)
 * @param {Array} batch — i frammenti originali
 */
export function mapOcrResultsToFragments(subMap, flatResults, batch) {
  let flatIdx = 0;
  for (const entry of subMap) {
    const f = batch[entry.fragIndex];

    // Testi del frammento (eventuali split → stitch)
    const fragResults = [];
    for (let si = 0; si < entry.subCanvases.length; si++) {
      const r = flatResults[flatIdx++];
      if (r?.items?.length > 0) {
        fragResults.push(r.items.map(item => item.text).join(' '));
      }
    }
    const fragText = fragResults.length > 1
      ? stitchSplitTexts(fragResults)
      : (fragResults[0] || '');

    // Testi della riga det (v5: contesto della riga intera)
    const rowResults = [];
    for (let si = 0; si < entry.rowCanvases.length; si++) {
      const r = flatResults[flatIdx++];
      if (r?.items?.length > 0) {
        rowResults.push(r.items.map(item => item.text).join(' '));
      }
    }
    const rowText = rowResults.length > 1
      ? stitchSplitTexts(rowResults)
      : (rowResults[0] || '');

    const text = alignFragmentToRow(fragText, rowText);

    if (text.text) {
      f.text = text.text;
      // v5: offset del segmento nella riga originale — servono a
      // markdownExporter per ricostruire i frammenti adiacenti della
      // stessa riga senza perdere parole ("bet"+"ween…").
      if (text.rowText != null) {
        f.rowText = text.rowText;
        f.rowStart = text.rowStart;
        f.rowEnd = text.rowEnd;
      }
      f.ocr = {
        status: 'done', engine: 'PaddleOCR', text: f.text, confidence: null, error: null,
        // 'row' = riga disponibile/allineata · 'crop' = solo frammento
        source: text.used ? 'row' : 'crop',
      };
    } else {
      f.ocr = {
        status: 'empty', engine: 'PaddleOCR', text: null, confidence: null, error: null,
      };
    }
  }
}