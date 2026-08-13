import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Multi-page build: ogni pagina statica (About, Privacy, …) è un entry HTML
// separato. I file in public/ (robots.txt, sitemap.xml, og-image, favicon)
// vengono copiati così come sono in dist/.
const PAGES = {
  index: resolve(__dirname, 'index.html'),
  about: resolve(__dirname, 'about.html'),
  services: resolve(__dirname, 'services.html'),
  'how-it-works': resolve(__dirname, 'how-it-works.html'),
  privacy: resolve(__dirname, 'privacy.html'),
  terms: resolve(__dirname, 'terms.html'),
  contact: resolve(__dirname, 'contact.html'),
  'thank-you': resolve(__dirname, 'thank-you.html'),
  '404': resolve(__dirname, '404.html'),
  // Versioni italiane (URL /it/…)
  'it/index': resolve(__dirname, 'it/index.html'),
  'it/about': resolve(__dirname, 'it/about.html'),
  'it/services': resolve(__dirname, 'it/services.html'),
  'it/how-it-works': resolve(__dirname, 'it/how-it-works.html'),
  'it/privacy': resolve(__dirname, 'it/privacy.html'),
  'it/terms': resolve(__dirname, 'it/terms.html'),
  'it/contact': resolve(__dirname, 'it/contact.html'),
  'it/thank-you': resolve(__dirname, 'it/thank-you.html'),
  'it/404': resolve(__dirname, 'it/404.html'),
  // Deutsch
  'de/index': resolve(__dirname, 'de/index.html'),
  'de/about': resolve(__dirname, 'de/about.html'),
  'de/services': resolve(__dirname, 'de/services.html'),
  'de/how-it-works': resolve(__dirname, 'de/how-it-works.html'),
  'de/privacy': resolve(__dirname, 'de/privacy.html'),
  'de/terms': resolve(__dirname, 'de/terms.html'),
  'de/contact': resolve(__dirname, 'de/contact.html'),
  'de/thank-you': resolve(__dirname, 'de/thank-you.html'),
  'de/404': resolve(__dirname, 'de/404.html'),
  // Français
  'fr/index': resolve(__dirname, 'fr/index.html'),
  'fr/about': resolve(__dirname, 'fr/about.html'),
  'fr/services': resolve(__dirname, 'fr/services.html'),
  'fr/how-it-works': resolve(__dirname, 'fr/how-it-works.html'),
  'fr/privacy': resolve(__dirname, 'fr/privacy.html'),
  'fr/terms': resolve(__dirname, 'fr/terms.html'),
  'fr/contact': resolve(__dirname, 'fr/contact.html'),
  'fr/thank-you': resolve(__dirname, 'fr/thank-you.html'),
  'fr/404': resolve(__dirname, 'fr/404.html'),
  // Español
  'es/index': resolve(__dirname, 'es/index.html'),
  'es/about': resolve(__dirname, 'es/about.html'),
  'es/services': resolve(__dirname, 'es/services.html'),
  'es/how-it-works': resolve(__dirname, 'es/how-it-works.html'),
  'es/privacy': resolve(__dirname, 'es/privacy.html'),
  'es/terms': resolve(__dirname, 'es/terms.html'),
  'es/contact': resolve(__dirname, 'es/contact.html'),
  'es/thank-you': resolve(__dirname, 'es/thank-you.html'),
  'es/404': resolve(__dirname, 'es/404.html'),
  // Português
  'pt/index': resolve(__dirname, 'pt/index.html'),
  'pt/about': resolve(__dirname, 'pt/about.html'),
  'pt/services': resolve(__dirname, 'pt/services.html'),
  'pt/how-it-works': resolve(__dirname, 'pt/how-it-works.html'),
  'pt/privacy': resolve(__dirname, 'pt/privacy.html'),
  'pt/terms': resolve(__dirname, 'pt/terms.html'),
  'pt/contact': resolve(__dirname, 'pt/contact.html'),
  'pt/thank-you': resolve(__dirname, 'pt/thank-you.html'),
  'pt/404': resolve(__dirname, 'pt/404.html'),
};

// Solo i file WASM effettivamente usati da ONNX Runtime Web:
// - wasm: runtime base (sempre necessario)
// - jsep: backend WebGPU
// - asyncify: fallback per operazioni asincrone (usato da ORT di default)
// jspi.wasm escluso: richiede configurazione esplicita, non usato
const ORT_WASM_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 8080,
    cors: true,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: PAGES,
    },
  },
  optimizeDeps: {
    include: ['@paddleocr/paddleocr-js'],
    exclude: ['onnxruntime-web'],
  },
  plugins: [{
    name: 'onnx-wasm',

    configureServer(server) {
      const wasmDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      const wasmRe = /\/(ort-wasm-.+\.wasm)(\?.*)?$/;

      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        const m = wasmRe.exec(url);
        if (m) {
          const filePath = resolve(wasmDir, m[1]);
          console.log('[vite] WASM request:', url, '->', filePath);
          if (existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/wasm');
            createReadStream(filePath).pipe(res);
            return;
          }
          console.warn('[vite] WASM missing:', filePath);
        }
        next();
      });
    },

    closeBundle() {
      const dstDir = resolve(__dirname, 'dist');
      mkdirSync(dstDir, { recursive: true });

      const modelSrc = resolve(__dirname, 'HT_detector_v7.9.onnx');
      if (existsSync(modelSrc)) {
        copyFileSync(modelSrc, resolve(dstDir, 'HT_detector_v7.9.onnx'));
        console.log('Copiato HT_detector_v7.9.onnx -> dist/');
      }

      const wasmSrcDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      for (const file of ORT_WASM_FILES) {
        const src = resolve(wasmSrcDir, file);
        if (existsSync(src)) {
          copyFileSync(src, resolve(dstDir, file));
          console.log('Copiato ' + file + ' -> dist/');
        } else {
          console.warn('WASM file non trovato: ' + file);
        }
      }
    }
  }]
});