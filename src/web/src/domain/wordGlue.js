/**
 * Word Glue — ricomposizione leggera delle parole spezzate dagli artefatti
 * della pipeline OCR (crop YOLO, riconoscimento, evidenziatore).
 *
 * Tre livelli, in ordine di certezza:
 *
 *  L1 (geometria/formato, senza linguaggio): punteggiatura, lettere spurie
 *     ai bordi delle giunzioni, de-trattinazione strutturale.
 *  L2 (dizionario PER LINGUA, operazioni CERTE): un merge avviene solo se
 *     la forma unita è nel dizionario della lingua (top-50000 + classe
 *     chiusa) e almeno un pezzo è un frammento; uno split avviene solo con
 *     regole strutturali conservative (pezzi di parola nota, niente clitici
 *     romanzi attaccati a radici vocali-finali).
 *  L3 (n-grammi PER LINGUA): dove il dizionario lascia un'ambiguità (entrambi
 *     i pezzi sono parole note E la forma unita è nota: "di segno" vs
 *     "disegno", "we re" vs "were", "al lora" vs "allora") decide un modello
 *     bigramma (~400k frasi Tatoeba, chunk lazy ~2 MB, vedi ngramScorer.js)
 *     valutando la finestra di contesto locale. Senza modello → si tiene la
 *     forma separata (conservativo).
 *
 * Gli errori residui sono FISIOLOGICI (parole tagliate dai box
 * dell'evidenziatore, parole rare fuori dizionario, lettere sbagliate dal
 * recognizer): questo modulo li lascia così come sono, non li inventa.
 */
export const COVERAGE_MIN = 0.35;

import { loadScorer, scoreSequence } from './ngramScorer.js';

let _data = null;
let _dataPromise = null;
const _closedCache = new Map();   // lang → Set (classe chiusa)
const _dicts = new Map();         // lang → Promise<string> (dizionario)

/** Carica (una volta) i set compatti di tutte le lingue. */
export async function ensureData() {
  if (_data) return _data;
  if (!_dataPromise) {
    _dataPromise = import('./wordGlueData.js').then(m => {
      _data = m;
      return m;
    });
  }
  return _dataPromise;
}

/** Preload dei set compatti durante il run (non blocca la pipeline). */
export function warmup() {
  return ensureData().catch(() => {});
}

function closedSet(lang) {
  let s = _closedCache.get(lang);
  if (!s) {
    s = new Set(_data.LANG_CLOSED[lang].split('\n').filter(Boolean));
    _closedCache.set(lang, s);
  }
  return s;
}

/** Solo lettere Unicode (minuscole): numeri e punteggiatura non contano. */
function core(w) {
  return String(w ?? '').toLowerCase().replace(/[^\p{L}]/gu, '');
}

/** True se word è nel testo ordinato lines (stringa di righe separate da \n). */
function inSortedText(lines, word) {
  if (!word) return false;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let p = mid;
    while (p > 0 && lines.charCodeAt(p - 1) !== 10) p -= 1;  // allinea a inizio riga
    let i = 0;
    let diff = 0;
    while (i < word.length && p + i < lines.length) {
      diff = word.charCodeAt(i) - lines.charCodeAt(p + i);
      if (diff !== 0) break;
      i += 1;
    }
    const d = i < word.length
      ? (diff !== 0 ? diff : 1)               // word più lunga della riga
      : (p + i < lines.length && lines.charCodeAt(p + i) === 10) ? 0 : -1;
    if (d === 0) return true;
    if (d < 0) {
      hi = p;
    } else {
      const nl = lines.indexOf('\n', p);
      lo = nl === -1 ? lines.length : nl + 1;
    }
  }
  return false;
}

const VOWELS = /^[aeiouàáâãäåæèéêëìíîïòóôõöøùúûüÿ]/i;

/** Token alpha (cores) di un insieme di testi. */
function alphaTokens(texts) {
  const out = [];
  for (const t of texts) {
    for (const tok of String(t ?? '').split(/\s+/)) {
      const c = core(tok);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Frequenza dei token (core) nei testi dati — per la regola di protezione
 * delle parole di dominio ripetute. Sincrona (non usa il dizionario). */
export function tokenCounts(texts) {
  const m = new Map();
  for (const t of texts) {
    for (const tok of String(t ?? '').split(/\s+/)) {
      const c = core(tok);
      if (!c) continue;
      m.set(c, (m.get(c) || 0) + 1);
    }
  }
  return m;
}

/**
 * Rileva la lingua dei testi con i set compatti (classe chiusa + top-2000
 * di ogni lingua). Richiede ≥ 10 token alpha e copertura ≥ COVERAGE_MIN.
 * @param {string[]} texts
 * @returns {{lang: string, coverage: number}|null}
 */
export function detectLanguage(texts) {
  if (!_data) return null;
  const tokens = alphaTokens(texts);
  if (tokens.length < 10) return null;
  let best = null;
  for (const lang of _data.LANGS) {
    const closed = closedSet(lang);
    const common = _data.LANG_COMMON[lang];
    let hit = 0;
    for (const c of tokens) {
      if (closed.has(c) || inSortedText(common, c)) hit += 1;
    }
    const coverage = hit / tokens.length;
    if (!best || coverage > best.coverage) best = { lang, coverage };
  }
  return best && best.coverage >= COVERAGE_MIN ? best : null;
}

/**
 * Contesto di guarigione per una lingua: set compatti + dizionario completo
 * + frequenze del documento. Null se la lingua non è riconosciuta/coperta.
 *
 * @param {string[]} texts — testi del documento (rilevazione lingua)
 * @param {string} [langOpt] — lingua esplicita (salta rilevazione e gate)
 * @returns {Promise<{lang:string, closed:Set<string>, common:string,
 *           dict:string, counts:Map<string,number>}|null>}
 */
export async function makeCtx(texts, langOpt) {
  const D = await ensureData();
  const lang = langOpt || (detectLanguage(texts)?.lang ?? null);
  if (!lang || !D.LANGS.includes(lang)) return null;

  // Il dizionario (chunk pesante) è caricato una volta per lingua; il
  // contesto è un oggetto FRESCO a ogni chiamata (le frequenze count
  // dipendono dal documento corrente e non devono essere condivise).
  if (!_dicts.has(lang)) {
    const loader = D.DICT_LOADERS?.[lang];
    _dicts.set(lang, loader
      ? loader().then(m => m.DICT_TEXT ?? '').catch(() => '')
      : Promise.resolve(''));
  }
  const dict = await _dicts.get(lang);
  if (!dict) return null;
  if (!langOpt) {
    // Gate di copertura col dizionario completo: solo per lingua
    // rilevata automaticamente (l'esplicita si fida del chiamante).
    const tokens = alphaTokens(texts);
    if (tokens.length < 10) return null;
    const closed = closedSet(lang);
    let hit = 0;
    for (const c of tokens) if (closed.has(c) || inSortedText(dict, c)) hit += 1;
    if (hit / tokens.length < COVERAGE_MIN) return null;
  }
  return {
    lang,
    closed: closedSet(lang),
    common: D.LANG_COMMON[lang],
    dict,
    counts: tokenCounts(texts),
  };
}

/** Copertura del dizionario (0..1) o 0 se lingua non riconosciuta. */
export async function dictCoverage(texts) {
  const tokens = alphaTokens(texts);
  if (!tokens.length) return 1;
  const ctx = await makeCtx(texts);
  if (!ctx) return 0;
  let found = 0;
  for (const c of tokens) {
    if (ctx.closed.has(c) || inSortedText(ctx.dict, c)) found += 1;
  }
  return found / tokens.length;
}

/**
 * Parola forte: classe chiusa, top-2000 o frequente nel documento
 * (solo parole di almeno 5 lettere: i frammenti ripetuti — "tess uto" ×2 —
 * non diventano parole).
 */
function strongWord(ctx, c) {
  if (ctx.counts && c.length >= 5 && ctx.counts.get(c) >= 2) return true;
  return ctx.closed.has(c) || inSortedText(ctx.common, c);
}

/** Parola qualsiasi. Le lettere singole valgono solo se sono parole
 * funzione della lingua: "t", "s", "y" (inglese) NON bloccano il gluaggio. */
function anyWord(ctx, c) {
  if (c.length === 1) return ctx.closed.has(c);
  return strongWord(ctx, c) || inSortedText(ctx.dict, c);
}

function knownWord(ctx, c) {
  return ctx.closed.has(c) || inSortedText(ctx.dict, c);
}

/** Modello n-gramma della lingua (lazy, null se assente). */
function scorerFor(ctx) {
  return loadScorer(ctx.lang);
}

/**
 * Costruisce il token unito preservando solo la punteggiatura del "bordo":
 *   "soci-" + "ety"  → "society"   (trattino di giunzione scartato)
 *   "God"   + "'s"   → "God's"    (clitico inglese conservato)
 *   "al"    + "'lora"→ "allora"   (apostrofo spurio scartato)
 *   "l'"    + "ora"  → "l'ora"    (elisione conservata, ma "d ella"→"della")
 *   "all-importan" + "t" → "all-important" (trattino interno conservato)
 */
function mergeSeam(x, y, ctx) {
  const cx = core(x);
  const cy = core(y);
  const tailP = x.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
  const leadP = y.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? '';
  let seam = '';
  const CLITICS = new Set(['s', 't', 'd', 'm', 're', 've', 'll']);
  if (leadP.includes("'")) {
    if (CLITICS.has(cy)) seam = "'";
  } else if (tailP.includes("'")) {
    if (cx.length <= 3 && VOWELS.test(cy) && !ctx.closed.has(cx + cy)) seam = "'";
  }
  return x.slice(0, x.length - tailP.length) + seam + y.slice(leadP.length);
}

/**
 * Classifica il merge della coppia X Y:
 *   'merge' — certo (forma unita nota + pezzo frammento, oppure segnali
 *             ortografici forti: nome proprio spezzato, frammento minuscolo)
 *   'maybe' — ambiguo (forma unita nota ed ENTRAMBI i pezzi parole note):
 *             decide lo scorer n-gramma sul contesto
 *   'no'    — non unire
 */
function classifyMerge(x, y, prev, z, ctx) {
  const cx = core(x);
  const cy = core(y);
  if (!cx || !cy) return 'no';
  const { closed, dict } = ctx;
  const yw = anyWord(ctx, cy);

  // PRIOR ortografico: se il token DOPO Y inizia con la maiuscola e Y è
  // minuscolo e corto, Y appartiene al frammento successivo (rumore di case
  // dell'OCR: "di ca Icio" = "di calcio", non "dica Icio")
  if (z && /^\p{Lu}/u.test(z) && /^\p{Ll}/u.test(y) && cy.length <= 3) return 'no';

  // Varianti del core sinistro: intero e, se c'è un'apostrofo interno,
  // il pezzo DOPO l'ultimo apostrofo ("un'organ" + "izzazione" →
  // "organizzazione")
  const xCores = [cx];
  const ap = x.lastIndexOf("'");
  if (ap > 0 && ap < x.length - 1) {
    const cx2 = core(x.slice(ap + 1));
    // solo stamparole (≥ 3 lettere): i clitici "'s", "'t", "'d" non sono
    // radici di parola ("nature's or" non deve leggersi "sor")
    if (cx2 && cx2 !== cx && cx2.length >= 3) xCores.push(cx2);
  }

  // A — forma unita nota e almeno un pezzo è un frammento → unisci
  for (const cx2 of xCores) {
    const xy2 = cx2 + cy;
    if (knownWord(ctx, xy2) && (!anyWord(ctx, cx2) || !yw)) return 'merge';
  }
  // PRIOR strutturale: due parole FUNZIONE non formano mai una parola sola
  // ("no a", "in to", "per che", "e gli" restano separati)
  if (closed.has(cx) && closed.has(cy)) return 'no';
  // B — forma unita nota con ENTRAMBI i pezzi parole → ambiguità (scorer)
  for (const cx2 of xCores) {
    if (knownWord(ctx, cx2 + cy)) return 'maybe';
  }
  // C — nome proprio spezzato: maiuscola a metà frase + coda lunga ignota
  const sentenceEnd = prev ? /[.!?…]["')\]]?$/.test(String(prev).trim()) : false;
  if (/^\p{Lu}/u.test(x) && /^\p{Ll}/u.test(y) && !yw && cy.length >= 7 &&
      cx.length <= 3 && prev && !sentenceEnd) return 'merge';
  // D — due frammenti con un pezzo minuscolo (≤ 2): quasi mai parole vere
  // (mai attraverso un salto di maiuscola: "ca Icio" resta)
  const xw = anyWord(ctx, cx);
  if (!xw && !yw && Math.min(cx.length, cy.length) <= 2 &&
      !(/^\p{Ll}/u.test(x) && /^\p{Lu}/u.test(y))) return 'merge';
  return 'no';
}

/**
 * Finestra di contesto per lo scoring: fino a 3 parole emesse + il segmento
 * corrente (fino a 5 token) con eventuale sostituzione 'mxy' (X+Y fusi) o
 * 'myz' (Y+Z fusi). Restituisce i cores.
 */
function windowCores(out, toks, i, repl, ctx) {
  const words = [];
  for (let k = Math.max(0, out.length - 3); k < out.length; k++) {
    const c = core(out[k]);
    if (c) words.push(c);
  }
  const seg = [];
  for (let k = i; k < Math.min(toks.length, i + 5); k++) seg.push(toks[k]);
  if (repl === 'mxy' && seg.length >= 2) {
    seg[0] = mergeSeam(seg[0], seg[1], ctx);
    seg.splice(1, 1);
  } else if (repl === 'myz' && seg.length >= 3) {
    seg[1] = mergeSeam(seg[1], seg[2], ctx);
    seg.splice(2, 1);
  }
  for (const t of seg) {
    const c = core(t);
    if (c) words.push(c);
  }
  return words;
}

/**
 * Ricompone le parole spezzate in un testo. Applicare DOPO la
 * normalizzazione degli spazi.
 *
 * Per ogni confine valuta fino a tre candidate locali — [X|Y] (tieni),
 * [XY] (unisci), [X|YZ] (unisci a destra) — e sceglie con lo scorer
 * n-gramma; senza modello restano solo i merge CERTI (classificati
 * 'merge' da classifyMerge), con preferenza della fusione verificata dal
 * dizionario quando due fusioni certe competono ("a n otion" → "a notion").
 *
 * @param {string} text
 * @param {object|null} [ctx] — contesto lingua (makeCtx); null = testo invariato
 * @param {boolean} [useScorer=true] — abilita le decisioni n-gramma
 *   (disattivare per i testi-frammento, es. unità singole: il contesto
 *   troppo corto produce falsi merge come "ing a" → "inga")
 * @returns {Promise<string>}
 */
export async function glueSplitWords(text, ctx, useScorer = true) {
  if (!ctx) return String(text ?? '');
  const toks = String(text ?? '').split(' ');
  const scorer = useScorer ? await scorerFor(ctx) : null;
  const out = [];

  const pick = (cands) => {
    // cands: [{action:'keep'|'mxy'|'myz'}...] → migliore per score
    if (!scorer || cands.length < 2) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      const words = windowCores(out, toks, c.i, c.repl, ctx);
      if (words.length < 2) continue;
      const s = scoreSequence(scorer, words);
      if (!best || s > bestScore + 1e-9) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  };

  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    const y = toks[i + 1];
    if (y === undefined || x === '' || y === '') {
      out.push(x);
      continue;
    }
    const z = toks[i + 2];
    const prev = out[out.length - 1];
    const c1 = classifyMerge(x, y, prev, z, ctx);
    const c2 = (z !== undefined && z !== '') ? classifyMerge(y, z, prev, toks[i + 3], ctx) : 'no';

    // Due fusioni candidate: valuta anche [X|YZ] (o tieni entrambe)
    if (c1 !== 'no' && c2 !== 'no') {
      const cands = [{ action: 'keep', i, repl: null }];
      if (c1 === 'merge' || (c1 === 'maybe' && scorer)) cands.push({ action: 'mxy', i, repl: 'mxy' });
      if (c2 === 'merge' || (c2 === 'maybe' && scorer)) cands.push({ action: 'myz', i, repl: 'myz' });
      const best = pick(cands);
      if (!best) {
        // senza scorer: preferisci la fusione col merged di DIZIONARIO più
        // lungo; se nessuna (solo 'maybe') tieni separato
        const m1 = c1 === 'merge' ? core(mergeSeam(x, y, ctx)) : null;
        const m2 = c2 === 'merge' ? core(mergeSeam(y, z, ctx)) : null;
        if (m1 && m2) {
          if (m2.length > m1.length && !ctx.closed.has(m2) && ctx.closed.has(m1)) {
            out.push(x);
            continue;  // (Y,Z) si fonde al giro dopo
          }
          out.push(mergeSeam(x, y, ctx));
          i += 1;
          continue;
        }
        if (m1) {
          out.push(mergeSeam(x, y, ctx));
          i += 1;
          continue;
        }
        if (m2) {
          out.push(x);
          continue;
        }
        out.push(x);
        continue;
      }
      if (best.action === 'mxy') {
        out.push(mergeSeam(x, y, ctx));
        i += 1;
      } else if (best.action === 'myz') {
        out.push(x);
        out.push(mergeSeam(y, z, ctx));
        i += 2;
      } else {
        out.push(x);
      }
      continue;
    }

    if (c1 === 'merge') {
      out.push(mergeSeam(x, y, ctx));
      i += 1;
      continue;
    }
    if (c1 === 'maybe') {
      const best = pick([{ action: 'keep', i, repl: null }, { action: 'mxy', i, repl: 'mxy' }]);
      if (best && best.action === 'mxy') {
        out.push(mergeSeam(x, y, ctx));
        i += 1;
      } else {
        out.push(x);
      }
      continue;
    }
    if (c2 === 'merge') {
      out.push(x);
      continue;  // (Y,Z) si fonde al giro dopo
    }
    // NB: niente branch preemptive per c2 === 'maybe': la scelta
    // "unisci Y+Z" deve avvenire alla posizione di (Y,Z), dove il
    // confronto a 3 vie vede anche il token DOPO Z ("the bes t" →
    // "the best", non "thebes t")
    out.push(x);
  }
  return out.join(' ');
}

/**
 * Trova la migliore scomposizione del token in parole note (greedy:
 * prefisso più lungo che è parola, poi ricorsione sul resto).
 * Conservativo per evitare i falsi positivi del dizionario:
 *   - split a 2 pezzi: ogni pezzo è parola (≥ 4 lettere) o parola funzione
 *     della classe chiusa (2-4 lettere, con l'altro pezzo lungo ≥ 6); i
 *     CLITICI romanzi ("te", "si", "ne"…) richiedono l'altro pezzo ≥ 7
 *     ("adatta te" NON divide "adattate", "Whites who" divide)
 *   - due parole lunghe non-funzione attaccate: ok solo se ENTRAMBE ≥ 5
 *     ("termedethnic" si divide, "teletrasporto" no)
 *   - split a 3+ pezzi: ogni pezzo è lungo (≥ 6, comune o chiuso) o parola
 *     funzione (≤ 4, classe chiusa)
 * @param {object} ctx — contesto lingua
 * @param {string} token — core (minuscole, solo lettere)
 * @returns {string[]|null} — sequenza di parole, o null
 */
function bestSplit(ctx, token) {
  if (!token || token.length < 6) return null;
  const { closed, dict, common } = ctx;
  const isWord = (w) => closed.has(w) || inSortedText(dict, w);
  if (isWord(token)) return null;  // è già una parola: niente split

  const strong = (w) => w.length >= 6 && isWord(w) && (closed.has(w) || inSortedText(common, w));
  const weak = (w) => w.length >= 2 && w.length <= 3 && closed.has(w);
  // clitici romanzi (fatto lessicale): attaccati a una radice che finisce
  // per vocale NON sono un confine di parola ("adattate" resta intero)
  const CLITIC_RISK = new Set(['te','se','ne','me','ti','si','ci','vi','la','lo','le','li','gli','ce','ve','mi']);
  const part2 = (w, other) => (w.length >= 4 && isWord(w))
    || (w.length >= 2 && w.length <= 4 && closed.has(w) &&
        other.length >= (CLITIC_RISK.has(w) ? 7 : 6));

  function find(rest, pieces) {
    if (!rest) {
      if (pieces.length < 2) return null;
      if (pieces.length === 2) {
        const [a, b] = pieces;
        if (!(part2(a, b) && part2(b, a))) return null;
        if (a.length >= 4 && b.length >= 4 && !closed.has(a) && !closed.has(b) &&
            (a.length < 5 || b.length < 5)) return null;
        return pieces;
      }
      const ok = pieces.every(p => strong(p) || weak(p));
      const nStrong = pieces.filter(strong).length;
      return (ok && nStrong >= 1) ? pieces : null;
    }
    if (pieces.length >= 1) {
      const okRest = rest.length >= 6 ? isWord(rest)
        : (rest.length <= 4 ? closed.has(rest) : isWord(rest));
      if (okRest) {
        const res = find('', [...pieces, rest]);
        if (res) return res;
      }
    }
    for (let k = Math.min(rest.length - 1, 14); k >= 2; k--) {
      const left = rest.slice(0, k);
      const okLeft = k >= 6 ? isWord(left) : (k <= 4 ? closed.has(left) : isWord(left));
      if (!okLeft) continue;
      const res = find(rest.slice(k), [...pieces, left]);
      if (res) return res;
    }
    return null;
  }
  return find(token, []);
}

/** Rimappa la scomposizione sulla stringa originale (maiuscole e
 * punteggiatura ai bordi del token restano al loro posto). */
function remapToken(tok, parts) {
  let rest = tok;
  const out = [];
  for (const p of parts) {
    const idx = rest.toLowerCase().indexOf(p);
    if (idx < 0) return null;
    out.push(rest.slice(0, idx) + rest.slice(idx, idx + p.length));
    rest = rest.slice(idx + p.length);
  }
  return out.join(' ') + rest;
}

/**
 * Ripara i token col trattino la cui coda si è INCOLLATA alla parola
 * successiva: "long-heldraci" + "st" → "long- held raci" (poi il glue
 * ricompone "raci st" → "racist" e il dehyphen "long- held" → "long-held").
 * Richiede: la parte prima del trattino è una parola e la coda + il token
 * successivo formano una parola nota.
 */
function hyphenRepair(ctx, tok, next) {
  if (!next) return null;
  const cn = core(next);
  if (!cn) return null;
  const hy = tok.indexOf('-');
  if (hy <= 0 || hy >= tok.length - 1) return null;
  const left = tok.slice(0, hy + 1);
  const cl = core(left);
  if (!cl || !anyWord(ctx, cl)) return null;
  const rest = tok.slice(hy + 1);
  if (anyWord(ctx, core(rest))) return null;
  // prima la coda INTERA + token successivo ("all-importan" + "t" →
  // "important"): niente spezzettamenti prematuri
  if (ctx.closed.has(core(rest) + cn) || inSortedText(ctx.dict, core(rest) + cn)) {
    return `${left} ${rest}`;
  }
  for (let q = 1; q < rest.length; q++) {
    const a = core(rest.slice(0, q));
    const b = core(rest.slice(q));
    if (!a || !b) continue;
    if (!anyWord(ctx, a)) continue;
    if (ctx.closed.has(b + cn) || inSortedText(ctx.dict, b + cn)) {
      return `${left} ${rest.slice(0, q)} ${rest.slice(q)}`;
    }
  }
  return null;
}

/**
 * SPLIT di parole incollate dall'OCR (spazi mancanti tra parole):
 * "afterthousand" → "after thousand", "embracedand" → "embraced and".
 * Solo regole strutturali conservative (vedi bestSplit); l'intero token
 * già nel dizionario non viene mai toccato.
 *
 * @param {string} text
 * @param {object|null} [ctx] — contesto lingua (makeCtx); null = testo invariato
 * @returns {Promise<string>}
 */
export async function splitGluedWords(text, ctx) {
  if (!ctx) return String(text ?? '');
  const toks = String(text ?? '').split(' ');
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const c = core(tok);
    if (!c) {
      out.push(tok);
      continue;
    }
    // I token col trattino NON passano dallo splitter (i composti
    // "all-important" restano interi): li gestisce hyphenRepair sotto.
    const parts = tok.includes('-') ? null : bestSplit(ctx, c);
    if (parts) {
      const remapped = remapToken(tok, parts);
      out.push(remapped ?? tok);
      continue;
    }
    if (tok.includes('-')) {
      const fixed = hyphenRepair(ctx, tok, toks[i + 1]);
      if (fixed) {
        out.push(fixed);
        continue;
      }
    }
    out.push(tok);
  }
  return out.join(' ');
}

/**
 * De-trattinazione: riattacca i trattini di fine riga.
 *   "soci-" + "ety"    → "society"     (forma unita nota)
 *   "Enslav-" + "ers"  → "Enslavers"   (il pezzo prima del trattino non
 *                                        è una parola: trattino di a capo)
 *   "well-" + "known"  → "well-known"  (entrambe parole: composto, si
 *                                        riattacca col trattino)
 *   "x-" + "ray"       → resta         (pezzo troppo corto, ambiguo)
 *
 * @param {string} text
 * @param {object|null} [ctx] — contesto lingua (makeCtx); null = testo invariato
 * @returns {Promise<string>}
 */
export async function dehyphenate(text, ctx) {
  if (!ctx) return String(text ?? '');
  const toks = String(text ?? '').split(' ');
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const n = toks[i + 1];
    if (n && t.endsWith('-') && core(t)) {
      const cx0 = core(t);   // core SENZA il trattino
      const cy = core(n);
      if (cy) {
        const xy = cx0 + cy;
        if (ctx.closed.has(xy) || inSortedText(ctx.dict, xy)) {
          out.push(t.slice(0, -1) + n);   // society, providing…
          i += 1;
        } else if (!anyWord(ctx, cx0) && cx0.length >= 3 && !/^\d/u.test(n)) {
          out.push(t.slice(0, -1) + n);   // Enslav- ers → Enslavers
          i += 1;
        } else if (anyWord(ctx, cx0) && anyWord(ctx, cy)) {
          out.push(t.slice(0, -1) + '-' + n);  // well- known → well-known
          i += 1;
        } else {
          out.push(t);
        }
      } else {
        out.push(t);
      }
    } else {
      out.push(t);
    }
  }
  return out.join(' ');
}

/**
 * Normalizzazione della punteggiatura (senza dizionario):
 *   - spazi prima di , . ; : ! ? ) eliminati
 *   - spazio dopo , ; : quando segue una lettera
 *   - spazio dopo . ! ? quando segue una MAIUSCOLA ("minded.They" →
 *     "minded. They"; "e.g." e "beings.4" restano)
 *   - clitici inglesi: "God 's" → "God's"
 *   - trattino em con spaziatura uniforme: "tool—intel…" → "tool — intel…"
 */
export function normalizePunct(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+'(s|t|d|m|re|ve|ll)\b/gi, "'$1");
  t = t.replace(/\s+([,.;:!?%)])/g, '$1');
  t = t.replace(/([,;:])(?=\p{L})/gu, '$1 ');
  t = t.replace(/([.!?])(?=\p{Lu})/gu, '$1 ');
  t = t.replace(/\s*—\s*/g, ' — ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Rimuove le lettere maiuscole SPURIE ai bordi delle giunzioni di riga:
 * la casella dell'evidenziatore taglia a metà una parola e l'OCR legge una
 * lettera sola ("…the African kingdom. E" + "Since…" → "…kingdom. Since").
 * Le giunzioni sono gli offset (posizione dello spazio) registrati dal
 * linking geometrico; vale anche a fine unità con nextFirst.
 * "I" e "A" sono conservate salvo che la riga successiva inizi con una
 * parola maiuscola lunga (≥ 4) non "I" ("…mind. I" + "Producers…" → rimosso).
 */
export function cleanSeamLetters(text, seams, nextFirst = null) {
  let t = String(text ?? '');
  const offs = [...(seams ?? [])].filter(o => Number.isFinite(o)).sort((a, b) => b - a);
  for (const o of offs) {
    if (o < 0 || o >= t.length) continue;
    const left = t.slice(0, o);
    const right = t.slice(o + 1);
    const m = left.match(/(^|\s)([A-Z])$/);
    if (!m) continue;
    const letter = m[2];
    if (letter === 'A') continue;
    const before = left.slice(0, -1).replace(/\s+$/, '');
    if (!/[.!?…]["')\]]?$/.test(before)) continue;
    if (!/^[A-Z]/.test(right)) continue;
    if (letter === 'I' && !/^[A-Z][a-z]{3,}/.test(right.replace(/^\s+/, ''))) continue;
    t = left.slice(0, -1) + ' ' + right;
  }
  if (nextFirst) {
    const nf = String(nextFirst).trim().split(/\s+/)[0];
    const m = t.match(/([.!?…])\s+([A-Z])$/);
    if (m) {
      const letter = m[2];
      const nextStrong = /^[A-Z][a-z]{3,}/.test(nf);
      if (letter !== 'A' && (letter !== 'I' || nextStrong)) {
        t = t.replace(/\s+[A-Z]$/, '');
      }
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Guarigione completa di un testo estratto: pulizia lettere spurie alle
 * giunzioni → split parole incollate → glue parole spezzate →
 * de-trattinazione → punteggiatura. Con ctx null (lingua non riconosciuta)
 * restano attive solo le pulizie senza dizionario.
 *
 * @param {string} text
 * @param {object|null} [ctx] — contesto lingua (makeCtx)
 * @param {number[]} [seams] — offset delle giunzioni di riga
 * @param {string|null} [nextFirst] — primo token dell'unità successiva
 * @param {object} [opts] — { scorer: boolean }: decisioni n-gramma
 *   (default true; false per i frammenti/unità singole con poco contesto)
 * @returns {Promise<string>}
 */
export async function healText(text, ctx, seams, nextFirst, opts) {
  const useScorer = opts?.scorer !== false;
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = cleanSeamLetters(t, seams, nextFirst);
  if (ctx) {
    t = await splitGluedWords(t, ctx);
    t = await glueSplitWords(t, ctx, useScorer);
    t = await dehyphenate(t, ctx);
  }
  return normalizePunct(t);
}

/**
 * True se token è una parola della lingua indicata (dizionario top-50000
 * o classe chiusa). Le lettere singole valgono solo se parole funzione.
 * @param {string} token
 * @param {string} lang — codice lingua (es. 'en', 'it')
 * @returns {Promise<boolean>}
 */
export async function isWord(token, lang) {
  const ctx = await makeCtx([String(token ?? '')], lang);
  if (!ctx) return false;
  const c = core(token);
  if (!c) return false;
  return anyWord(ctx, c);
}
