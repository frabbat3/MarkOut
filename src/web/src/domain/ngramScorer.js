/**
 * Ngram Scorer — livello 3 del wordGlue.
 *
 * Confronta candidate di segmentazione plausibili (tutte parole note) con
 * un modello BIGRAMMA per lingua (wordGlueNgram_<lang>.js, generato offline
 * da tools/genWordGlueNgrams.mjs su ~400k frasi Tatoeba). Caricamento lazy
 * per lingua: il chunk (~2 MB) arriva solo quando serve a decidere.
 *
 * Modello: P(w2|w1) = c(w1,w2)/c(w1) se il bigramma è visto, altrimenti
 * backoff α·P(w2) con P(w2) dai conteggi unigramma (FrequencyWords).
 * Le parole mai viste ricevono una probabilità quasi nulla (e le transizioni
 * mai viste un backoff basso): a parità di parole ignote il punteggio
 * preferisce il path con MENO transizioni ignote.
 */
let _loadersPromise = null;
const _models = new Map();   // lang → Promise<model|null>

async function loaders() {
  if (!_loadersPromise) {
    _loadersPromise = import('./wordGlueNgramLoaders.js')
      .catch(() => ({ NGRAM_LOADERS: {} }));
  }
  return _loadersPromise;
}

/**
 * Carica (una volta per lingua) il modello bigramma. Null se la lingua non
 * ha un modello generato.
 * @param {string} lang
 * @returns {Promise<{bigrams:string, uni:Map<string,number>, total:number}|null>}
 */
export async function loadScorer(lang) {
  if (!_models.has(lang)) {
    _models.set(lang, loaders().then(async ({ NGRAM_LOADERS }) => {
      const loader = NGRAM_LOADERS?.[lang];
      if (!loader) return null;
      try {
        const m = await loader();
        const uni = new Map();
        let total = 0;
        for (const line of m.UNI_TEXT.split('\n')) {
          const sp = line.lastIndexOf(' ');
          if (sp <= 0) continue;
          const c = Number(line.slice(sp + 1));
          if (!Number.isFinite(c)) continue;
          uni.set(line.slice(0, sp), c);
          total += c;
        }
        return { bigrams: m.BIGRAM_TEXT, uni, total };
      } catch {
        return null;
      }
    }));
  }
  return _models.get(lang);
}

/** Conteggio del bigramma "a b" (0 se assente) — ricerca binaria esatta. */
function bigramCount(model, a, b) {
  const key = `${a} ${b}`;
  const text = model.bigrams;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let p = mid;
    while (p > 0 && text.charCodeAt(p - 1) !== 10) p -= 1;
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(p, lineEnd);
    if (line.startsWith(key + ' ')) {
      return Number(line.slice(key.length + 1)) || 0;
    }
    if (line.slice(0, key.length) < key) {
      lo = lineEnd + 1;
    } else {
      hi = p;
    }
  }
  return 0;
}

const BACKOFF = 0.4;
const UNSEEN_DENOM = 100;   // parola mai vista: 1/(total·UNSEEN_DENOM)
const MIX = 0.5;            // interpolazione P_ML/P_uni (bias da prima parola frequente)

function uniProb(model, w) {
  const c = model.uni.get(w);
  if (c) return c / model.total;
  return 1 / (model.total * UNSEEN_DENOM);
}

/**
 * Log-probabilità di una sequenza di parole (bigramma + backoff).
 * Parole: cores minuscoli (punteggiatura/numero esclusi dal chiamante).
 * @param {object} model
 * @param {string[]} words
 * @returns {number} — log-prob (maggiore = più plausibile)
 */
export function scoreSequence(model, words) {
  let logp = 0;
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1];
    const b = words[i];
    const bc = bigramCount(model, a, b);
    if (bc > 0) {
      // Jelinek-Mercer: mix P_ML(w2|w1) con l'unigramma — il condizionale
      // puro punisce le prime parole molto frequenti ("in human" →
      // P(human|in) piccolissimo anche se "in human" è un contesto normale)
      const ml = bc / Math.max(1, model.uni.get(a) || 1);
      logp += Math.log(MIX * ml + (1 - MIX) * uniProb(model, b));
    } else {
      logp += Math.log(BACKOFF * uniProb(model, b));
    }
  }
  return logp;
}
