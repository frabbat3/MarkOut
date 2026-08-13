/**
 * Generatore del dizionario multi-lingua per il gluaggio delle parole
 * spezzate (wordGlue.js). NON fa parte del bundle: va eseguito offline.
 *
 *   node tools/genWordGlue.mjs
 *
 * Scarica le wordlist FrequencyWords (top 50000 per lingua, ~29 lingue a
 * scrittura latina) e costruisce:
 *   - wordGlueData.js: PER LINGUA CLOSED (classe chiusa, top 150) e
 *     COMMON (top 2000) — insieme compatto (~500 KB, caricato lazy) per
 *     la rilevazione della lingua e le regole "parola forte"
 *   - wordGlueDict_<lang>.js: dizionario top-50000 della singola lingua,
 *     ORDINATO e unito in un'unica stringa (ricerca binaria esatta a
 *     runtime: zero falsi positivi). Viene caricato SOLO il chunk della
 *     lingua rilevata nel documento (~200-400 KB).
 *
 * Rispetto alla versione precedente (top-8000 unito di 29 lingue):
 *   - dizionari PER LINGUA: niente più parole "false" di altre lingue
 *     ("frica", "re", "wil" non sono più parole inglesi)
 *   - top-50000: copertura molto maggiore dei testi reali ("metaphor",
 *     "rediscovered", "superstructure"…)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lingue a scrittura latina con wordlist su hermitdave/FrequencyWords
// ('no' = norvegese; 'nb' non esiste nel repo)
const LANGS = ['it','en','fr','de','es','pt','nl','pl','ro','sv','no','da',
  'fi','cs','sk','sl','hr','hu','tr','id','vi','ca','et','lt','lv','sq','is','eu','bs'];
const TOP = 50000;        // dizionario per lingua (esistenza parola)
const COMMON_TOP = 2000;  // parole ad alta frequenza per lingua ("decisamente reali")
const CLOSED_TOP = 150;   // parole funzione per lingua (classe chiusa)

async function fetchWords(lang) {
  const urls = [
    `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_50k.txt`,
    `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_25k.txt`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      const txt = await r.text();
      return txt.split('\n')
        .map(l => l.split(' ')[0].trim().toLowerCase())
        .filter(w => w && /^\p{L}+$/u.test(w));
    } catch { /* lista successiva */ }
  }
  console.warn(`!! ${lang}: nessuna lista disponibile`);
  return [];
}

const outDir = path.join(__dirname, '../src/domain');
const langs = [];
const langClosed = {};
const langCommon = {};
const loaders = {};

for (const lang of LANGS) {
  const words = await fetchWords(lang);
  if (words.length < 1000) continue;
  langs.push(lang);
  langClosed[lang] = [...new Set(words.slice(0, CLOSED_TOP))].sort().join('\n');
  langCommon[lang] = [...new Set(words.slice(0, COMMON_TOP))].sort().join('\n');

  const dict = [...new Set(words.slice(0, TOP))].sort().join('\n');
  fs.writeFileSync(path.join(outDir, `wordGlueDict_${lang}.js`), `/**
 * Dizionario top-50000 della lingua "${lang}" per wordGlue.js.
 * GENERATO da tools/genWordGlue.mjs — NON modificare a mano.
 * Ordinato: a runtime si usa ricerca binaria esatta (zero falsi positivi).
 */
export const DICT_TEXT = ${JSON.stringify(dict)};
`);
  loaders[lang] = true;
  console.log(`${lang}: ${Math.min(words.length, TOP)} parole, dict ${dict.length} byte`);
}

const header = `/**
 * Dizionari multi-lingua per il gluaggio delle parole spezzate.
 * GENERATO da tools/genWordGlue.mjs — NON modificare a mano.
 * Rigenerare con: node tools/genWordGlue.mjs
 *
 * PER LINGUA: LANG_CLOSED (classe chiusa, top ${CLOSED_TOP}) e LANG_COMMON
 * (top ${COMMON_TOP}) servono alla rilevazione della lingua e alle regole
 * "parola forte". I dizionari completi (top ${TOP}) stanno nei chunk
 * wordGlueDict_<lang>.js caricati lazy: DICT_LOADERS li importa on demand.
 * Copertura: ${langs.length} lingue a scrittura latina.
 */
export const LANGS = ${JSON.stringify(langs)};
export const LANG_CLOSED = ${JSON.stringify(langClosed)};
export const LANG_COMMON = ${JSON.stringify(langCommon)};
export const DICT_LOADERS = {
${langs.map(l => `  ${l}: () => import('./wordGlueDict_${l}.js'),`).join('\n')}
};
`;
fs.writeFileSync(path.join(outDir, 'wordGlueData.js'), header);
console.log(`\nwordGlueData.js: ${header.length} byte · ${langs.length} lingue`);
