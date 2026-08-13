/**
 * Row Assist — OCR assistito dalla riga di detection (v5).
 *
 * Ogni frammento YOLO viene riconosciuto due volte: sul crop dell'evidenzia-
 * zione (F, come v4) e sul crop della RIGA INTERA individuata dalla detection
 * PP-OCRv6 (R). La riga ha più contesto → il recognition model è mediamente
 * più accurato; il testo del frammento deve essere un segmento della riga.
 *
 * Strategia (robusta: la detection PUÒ sbagliare, es. pagine molto inclinate
 * dove frammenta le righe o sposta i quad):
 *   1. collassa gli spazi di F e R (il CTC frammenta le spaziature)
 *   2. cerca la finestra di R che meglio allinea F (edit distance)
 *   3. accetta solo se il distacco è ≤ tolleranza (10% di lenF, min 1)
 *      E la finestra copre ≥ 85% del frammento (niente troncamenti)
 *   4. se accettato → testo = segmento di R; in ogni caso vengono restituiti
 *      anche gli offset del segmento nella riga originale (rowText, rowStart,
 *      rowEnd): servono a markdownExporter per ricostruire il testo di più
 *      frammenti della stessa riga senza perdere parole ("bet"+"ween…").
 *   5. altrimenti → testo = F (la riga è inaffidabile: si usa il crop).
 */

/**
 * Distanza di Levenshtein tra due stringhe (iterativa, O(n·m)).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Rimuove ogni whitespace e abbassa il case. */
function collapse(text) {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * Collassa `text` tenendo traccia dell'indice originale di ogni carattere
 * conservato (per mappare un intervallo collassato → testo originale).
 * @returns {{ collapsed: string, indexMap: number[] }}
 */
function collapseWithMap(text) {
  let collapsed = '';
  const indexMap = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    collapsed += ch.toLowerCase();
    indexMap.push(i);
  }
  return { collapsed, indexMap };
}

/**
 * Allinea il testo del frammento dentro quello della riga.
 *
 * @param {string} fragText — OCR del crop evidenziatore (v4)
 * @param {string} rowText — OCR della riga intera (det PP-OCRv6)
 * @returns {{ text: string, rowText: string|null, rowStart: number|null,
 *            rowEnd: number|null, used: boolean }}
 *   text = testo finale (segmento di riga se allineato, altrimenti fragText);
 *   rowText/rowStart/rowEnd = segmento allineato nella riga originale (anche
 *   quando text === fragText, d=0) o null se la riga non è affidabile.
 */
export function alignFragmentToRow(fragText, rowText) {
  const none = { text: fragText || '', rowText: null, rowStart: null, rowEnd: null, used: false };
  if (!fragText || !rowText) return none;

  const F = collapse(fragText);
  const { collapsed: R, indexMap } = collapseWithMap(rowText);
  if (!F || !R) return none;

  // Tolleranza: max(1, 10% della lunghezza del frammento) — errori di rec
  // piccoli vengono corretti, ma una riga sbagliata non viene mai forzata
  const tol = Math.max(1, Math.round(F.length * 0.1));
  const minLen = Math.max(1, F.length - tol);
  const maxLen = F.length + tol;

  // Finestra scorrevole su R con lunghezza in [lenF−tol, lenF+tol]:
  // trova il segmento di riga più simile al frammento.
  let best = null;
  for (let start = 0; start < R.length; start++) {
    const maxEnd = Math.min(R.length, start + maxLen);
    for (let end = start + minLen; end <= maxEnd; end++) {
      const d = editDistance(R.slice(start, end), F);
      if (!best || d < best.d) {
        best = { start, end, d };
        if (d === 0) break;
      }
    }
    if (best && best.d === 0) break;
  }

  // Righe di guardia: nessun allineamento trovato, distacco troppo alto,
  // copertura insufficiente (≥85%) o distacco sproporzionato al segmento
  // (≤15%: niente match vaghi tipo "of"→"d f").
  if (!best) return none;
  const span = best.end - best.start;
  if (best.d > tol) return none;
  if (span < Math.ceil(F.length * 0.85)) return none;
  if (best.d > span * 0.15) return none;

  // Mappa l'intervallo collassato → testo originale della riga
  const i0 = indexMap[best.start];
  const i1 = indexMap[best.end - 1] + 1;
  const segment = rowText.slice(i0, i1) || fragText;

  // d = 0 → testo identico (a meno della spaziatura): si tiene il frammento
  // (la spaziatura della riga NON è più affidabile), ma gli offset sulla
  // riga restano disponibili per la ricostruzione dei frammenti adiacenti.
  if (best.d === 0) {
    return { text: fragText, rowText, rowStart: i0, rowEnd: i1, used: true };
  }

  // Guardia sui bordi per la SOSTITUZIONE del testo (d > 0): la rec della
  // riga sbaglia ai bordi (hyphen tagliati, simboli scambiati). Se i bordi
  // cambiano si tiene F, ma gli offset restano validi per la ricostruzione
  // (differenze di solo punteggiatura a fine riga, es. "3" vs "³", non
  // devono bloccare l'unione dei frammenti adiacenti).
  const segR = R.slice(best.start, best.end);
  if (!segR.length || segR[0] !== F[0] || segR[segR.length - 1] !== F[F.length - 1]) {
    return { text: fragText, rowText, rowStart: i0, rowEnd: i1, used: true };
  }
  return { text: segment, rowText, rowStart: i0, rowEnd: i1, used: true };
}
