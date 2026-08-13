/**
 * Loader dei modelli n-gramma per lingua (chunk lazy separati).
 * GENERATO da tools/genWordGlueNgrams.mjs — NON modificare a mano.
 */
export const NGRAM_LOADERS = {
  de: () => import('./wordGlueNgram_de.js'),
  en: () => import('./wordGlueNgram_en.js'),
  es: () => import('./wordGlueNgram_es.js'),
  fr: () => import('./wordGlueNgram_fr.js'),
  it: () => import('./wordGlueNgram_it.js'),
  pt: () => import('./wordGlueNgram_pt.js'),
};
