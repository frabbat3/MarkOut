/**
 * Highlight Linking — unione geometrica leggera di righe di testo.
 *
 * I box YOLO di una stessa evidenziatura possono finire in righe o regioni
 * diverse (il GapTree li separa quando vede "buchi"): una frase evidenziata
 * che va a capo produce bullet separati come
 *   "la vita è"  +  "molto bella da vivere"
 * oppure una parola spezzata tra due box:
 *   "alcu"  +  "ne situazioni da indagare"
 *
 * Questo modulo unisce le righe consecutive (in ordine di lettura) con
 * pura geometria, senza OCR né calcoli pesanti:
 *   - stessa riga (overlap verticale) + gap orizzontale piccolo → unisci
 *     (gap quasi nullo → senza spazio: parola spezzata)
 *   - riga successiva "a capo" SOLO se la riga A arriva in fondo alla sua
 *     riga di testo (lineBox = quadrilatero della detection) e la riga B
 *     non è rientrata (nuovo paragrafo): il margine sinistro della pagina
 *     è stimato dalle righe stesse. Un capoverso rientrato o una riga
 *     corta non sono continuazioni: sono evidenziature separate.
 *   - riga molto corta (poche lettere) → parola spezzata a fine riga
 *
 * Le soglie sono in LINK_CONSTANTS (× altezza riga h) per essere tarate
 * con i test: test/linkTests.mjs.
 *
 * L'unione avviene SEMPRE con uno spazio tra i testi ("frase 1" + " " +
 * "frase 2"): le parole spezzate dai box YOLO ("alcu"+"ne") vengono
 * ricomposte a valle dal wordGlue (dizionario multilingua, vedi
 * wordGlue.js) — niente euristiche geometriche sullo spazio, per ridurre
 * al minimo gli errori di unione. Ogni unione registra l'offset dello
 * spazio nel campo `seams`: serve alla pulizia delle lettere spurie ai
 * bordi di riga (cleanSeamLetters in wordGlue.js).
 */

export const LINK_CONSTANTS = {
  sameLineOv: 0.4,   // overlap verticale minimo (×h) per considerare "stessa riga"
  sameLineGap: 3.0,  // gap orizzontale massimo (×h) sulla stessa riga
  lineGap: 0.8,      // gap verticale massimo (×h) tra righe per considerare "a capo"
  lineOverlap: 0.3,  // tolleranza: i box di righe adiacenti possono sovrapporsi di poco
  fullLineTol: 0.5,  // A deve arrivare a fine riga (lineBox.x2) entro questo margine (×h)
  indentTol: 0.75,   // B rientrato oltre questo (×h) dal margine → paragrafo nuovo, niente merge
  wrapOverlap: 0.2,  // la continuazione deve iniziare a sinistra di fine riga − margine (×h)
};

function unionBox(a, b) {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/**
 * Unisce righe consecutive in unità di evidenziatura continua.
 *
 * Le righe devono arrivare in ordine di lettura (pagina → regione → riga).
 * Le unità risultanti hanno:
 *   - h       : numero progressivo (riassegnato sulle unità)
 *   - merged  : quante righe componenti sono state unite (1 = non unita)
 *   - seams   : offset degli spazi di giunzione nel testo unito
 *   - warns   : avvisi delle componenti, rimappati sull'h dell'unità
 *   - flags   : 'no text' presente solo se l'unità finale è senza testo
 *
 * @param {Array<{page:number, section:number, text:string, box:{x1:number,y1:number,x2:number,y2:number}|null, lineBox?:{x1:number,y1:number,x2:number,y2:number}|null, margin?:number|null, isNative?:boolean, flags?:string[], warns?:Array<{h:number,msg:string}>}>} lines
 * @param {Object} [C] — costanti di soglia (override per test)
 * @returns {Array} unità unite
 */
export function linkHighlightLines(lines, C = LINK_CONSTANTS) {
  const units = [];

  for (const l of lines) {
    const prev = units[units.length - 1];
    let joined = false;

    if (prev && prev.page === l.page && prev.box && l.box) {
      const A = prev.box;
      const B = l.box;
      const h = Math.min(A.y2 - A.y1, B.y2 - B.y1);
      const vOv = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1);
      const vGap = B.y1 - A.y2;
      const hGap = B.x1 - A.x2;

      let ok = false;

      if (vOv > C.sameLineOv * h) {
        // Stessa riga: unisci se il buco orizzontale è piccolo
        ok = hGap < C.sameLineGap * h;
      } else if (vGap >= -C.lineOverlap * h && vGap <= C.lineGap * h) {
        // "A capo": solo se A riempie la riga fino in fondo (lineBox =
        // quadrilatero della riga di detection) e B non è un nuovo
        // paragrafo rientrato rispetto al margine sinistro della pagina.
        const lineA = prev.lineBox || A;
        const fullLine = A.x2 >= lineA.x2 - C.fullLineTol * h;
        // margine sinistro stimato della pagina: se assente, non filtrare
        const margin = l.margin ?? null;
        const atMargin = margin === null || B.x1 - margin <= C.indentTol * h;
        ok = fullLine && atMargin && B.x1 <= A.x2 - C.wrapOverlap * h;
      }

      if (ok) {
        const seamAt = prev.text ? prev.text.length : 0;
        prev.text = (prev.text ? prev.text + ' ' : '') + l.text;
        prev.text = prev.text.replace(/\s+/g, ' ').trim();
        (prev.seams ??= []).push(seamAt);
        prev.box = unionBox(prev.box, l.box);
        if (l.lineBox) prev.lineBox = { ...l.lineBox };
        prev.merged += 1;
        prev.isNative = prev.isNative || !!l.isNative;
        prev.warns.push(...(l.warns || []).map(w => ({ ...w })));
        if (prev.text) prev.flags = prev.flags.filter(f => f !== 'no text');
        joined = true;
      }
    }

    if (!joined) {
      units.push({
        page: l.page,
        section: l.section,
        text: l.text,
        box: l.box ? { ...l.box } : null,
        lineBox: l.lineBox ? { ...l.lineBox } : null,
        isNative: !!l.isNative,
        flags: [...(l.flags || [])],
        warns: [...(l.warns || []).map(w => ({ ...w }))],
        merged: 1,
        seams: [],
      });
    }
  }

  // Numera le unità in ordine di lettura e rimappa i warn sull'unità
  units.forEach((u, i) => {
    u.h = i + 1;
    for (const w of u.warns) w.h = u.h;
  });

  return units;
}
