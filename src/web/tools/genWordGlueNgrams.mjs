/**
 * Generatore dei modelli n-gramma (bigrammi) per lingua, usati dal
 * livello 3 di wordGlue (risoluzione delle ambiguità di merge/split).
 * NON fa parte del bundle: va eseguito offline.
 *
 *   node tools/genWordGlueNgrams.mjs [lang1 lang2 ...]
 *
 * Fonte: esportazioni per lingua di Tatoeba (frasi brevi, licenza CC-BY)
 *   https://downloads.tatoeba.org/exports/per_language/<iso3>/<iso3>_sentences.tsv.bz2
 *
 * Per ogni lingua:
 *   - scarica le frasi, le tokenizza (solo parole α, minuscole)
 *   - conta i bigrammi (w1, w2) con ENTRAMBE le parole nel dizionario
 *     top-50000 della lingua (generato da genWordGlue.mjs) e conteggio ≥ 3
 *   - emette wordGlueNgram_<lang>.js: BIGRAM_TEXT (righe ordinate
 *     "w1 w2 count") + UNI_TEXT (conteggi unigramma da FrequencyWords,
 *     "word count") per il backoff dello scorer
 *
 * Il modello serve SOLO a confrontare candidate plausibili (tutte parole
 * note): i bigrammi rari/propri non servono.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../src/domain');
const tmpDir = path.join(__dirname, '.cache_ngrams');
fs.mkdirSync(tmpDir, { recursive: true });

// ISO 639-1 (dizionari wordGlue) → ISO 639-3 (Tatoeba)
const ISO3 = {
  it: 'ita', en: 'eng', fr: 'fra', de: 'deu', es: 'spa', pt: 'por',
  nl: 'nld', pl: 'pol', ro: 'ron', sv: 'swe', no: 'nor', da: 'dan',
  fi: 'fin', cs: 'ces', sk: 'slk', sl: 'slv', hr: 'hrv', hu: 'hun',
  tr: 'tur', id: 'ind', vi: 'vie', ca: 'cat', et: 'est', lt: 'lit',
  lv: 'lav', sq: 'sqi', is: 'isl', eu: 'eus', bs: 'bos',
};
const MIN_COUNT = 3;   // soglia conteggio bigramma
const MAX_SENTENCES = 400000;

const langs = process.argv.slice(2).filter(l => ISO3[l]);
if (!langs.length) {
  console.error('uso: node tools/genWordGlueNgrams.mjs it en fr de es pt …');
  process.exit(1);
}

function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  console.log(`  download ${url}`);
  execFileSync('curl', ['-sL', '--max-time', '300', '-o', dest, url], { stdio: 'inherit' });
  return dest;
}

async function unigramCounts(lang) {
  const url = `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_50k.txt`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const txt = await r.text();
    const counts = new Map();
    for (const line of txt.split('\n')) {
      const [w, c] = line.split(' ');
      if (w && /^\p{L}+$/u.test(w)) counts.set(w.toLowerCase(), Number(c) || 0);
    }
    return counts;
  } catch {
    return null;
  }
}

function inSortedText(lines, word) {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let p = mid;
    while (p > 0 && lines.charCodeAt(p - 1) !== 10) p -= 1;
    let i = 0, diff = 0;
    while (i < word.length && p + i < lines.length) {
      diff = word.charCodeAt(i) - lines.charCodeAt(p + i);
      if (diff !== 0) break;
      i += 1;
    }
    const d = i < word.length
      ? (diff !== 0 ? diff : 1)
      : (p + i < lines.length && lines.charCodeAt(p + i) === 10) ? 0 : -1;
    if (d === 0) return true;
    if (d < 0) { hi = p; } else {
      const nl = lines.indexOf('\n', p);
      lo = nl === -1 ? lines.length : nl + 1;
    }
  }
  return false;
}

for (const lang of langs) {
  const iso3 = ISO3[lang];
  console.log(`\n== ${lang} (${iso3}) ==`);

  // Dizionario top-50000 della lingua (per filtrare i bigrammi)
  const dictMod = await import(path.join(outDir, `wordGlueDict_${lang}.js`)
    .replace(/\\/g, '/')).catch(() => null);
  if (!dictMod?.DICT_TEXT) {
    console.warn(`!! ${lang}: dizionario mancante (eseguire prima genWordGlue.mjs)`);
    continue;
  }

  // Corpus di frasi Tatoeba
  const bz2 = path.join(tmpDir, `${iso3}_sentences.tsv.bz2`);
  download(`https://downloads.tatoeba.org/exports/per_language/${iso3}/${iso3}_sentences.tsv.bz2`, bz2);
  const tsv = bz2.replace(/\.bz2$/, '');
  if (!fs.existsSync(tsv)) {
    console.log(`  bunzip2 ${bz2}`);
    execFileSync('bunzip2', ['-k', bz2], { stdio: 'inherit' });
  }

  // Conteggio bigrammi
  const bigrams = new Map();
  let nSent = 0;
  const stream = fs.readFileSync(tsv, 'utf8').split('\n');
  for (const line of stream) {
    if (nSent >= MAX_SENTENCES) break;
    const tabs = line.split('\t');
    if (tabs.length < 3) continue;
    const words = tabs[2].toLowerCase().split(/\s+/)
      .map(w => w.replace(/[^\p{L}]/gu, ''))
      .filter(w => w.length > 0);
    if (words.length < 3) continue;
    nSent += 1;
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i], b = words[i + 1];
      if (a.length > 24 || b.length > 24) continue;
      if (!inSortedText(dictMod.DICT_TEXT, a) || !inSortedText(dictMod.DICT_TEXT, b)) continue;
      const key = `${a} ${b}`;
      bigrams.set(key, (bigrams.get(key) || 0) + 1);
    }
  }
  const filtered = [...bigrams.entries()].filter(([, c]) => c >= MIN_COUNT).sort((x, y) => x[0] < y[0] ? -1 : 1);
  console.log(`  frasi: ${nSent} · bigrammi totali: ${bigrams.size} · ≥${MIN_COUNT}: ${filtered.length}`);

  // Unigrammi (backoff)
  const uni = await unigramCounts(lang);
  if (!uni) {
    console.warn(`!! ${lang}: unigrammi mancanti, salto`);
    continue;
  }
  const uniText = [...uni.entries()].filter(([, c]) => c > 0).sort((x, y) => x[0] < y[0] ? -1 : 1)
    .map(([w, c]) => `${w} ${c}`).join('\n');
  const biText = filtered.map(([k, c]) => `${k} ${c}`).join('\n');

  const out = `/**
 * Modello bigramma della lingua "${lang}" (fonte: Tatoeba, ${nSent} frasi).
 * GENERATO da tools/genWordGlueNgrams.mjs — NON modificare a mano.
 * BIGRAM_TEXT: righe ordinate "w1 w2 count" (entrambe nel top-50000).
 * UNI_TEXT: conteggi unigramma FrequencyWords "word count" (backoff).
 */
export const BIGRAM_TEXT = ${JSON.stringify(biText)};
export const UNI_TEXT = ${JSON.stringify(uniText)};
`;
  fs.writeFileSync(path.join(outDir, `wordGlueNgram_${lang}.js`), out);
  console.log(`  scritto wordGlueNgram_${lang}.js: ${out.length} byte`);
}

// Loader map per il caricamento lazy (vite + node): UNISCE le lingue già
// generate (i chunk possono essere creati in esecuzioni separate)
const existing = fs.readdirSync(outDir)
  .filter(f => /^wordGlueNgram_[a-z]{2}\.js$/.test(f))
  .map(f => f.replace(/^wordGlueNgram_/, '').replace(/\.js$/, ''));
const allLangs = [...new Set([...existing, ...langs])].sort()
  .filter(l => fs.existsSync(path.join(outDir, `wordGlueNgram_${l}.js`)));
const out = `/**
 * Loader dei modelli n-gramma per lingua (chunk lazy separati).
 * GENERATO da tools/genWordGlueNgrams.mjs — NON modificare a mano.
 */
export const NGRAM_LOADERS = {
${allLangs.map(l => `  ${l}: () => import('./wordGlueNgram_${l}.js'),`).join('\n')}
};
`;
fs.writeFileSync(path.join(outDir, 'wordGlueNgramLoaders.js'), out);
console.log(`\nwordGlueNgramLoaders.js scritto (${allLangs.length} lingue)`);
