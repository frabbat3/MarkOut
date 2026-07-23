/**
 * MarkOut — Estrazione testo evidenziato via ML pipeline (YOLO25n)
 * Pipeline: PDF → render → deskew → HT_detector_v7.8.tflite → crop → OCR
 */
(function () {
  'use strict';

  /* ─── Costanti ─── */
  var DPI = 300;
  var MAX_DIM = 2000;
  var MODEL_SIZE = 1024;
  var CONF_THRES = 0.30;
  var MODEL_FILE = 'HT_detector_v7.8.tflite';
  var WASM_PATH = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@0.0.1-alpha.10/wasm/';

  /* ─── Theme Toggle ─── */
  var html = document.documentElement;
  document.getElementById('themeToggle').addEventListener('click', function () {
    if (html.hasAttribute('data-theme')) {
      html.removeAttribute('data-theme');
      localStorage.setItem('markout-theme', 'light');
    } else {
      html.setAttribute('data-theme', 'dark');
      localStorage.setItem('markout-theme', 'dark');
    }
  });
  if (localStorage.getItem('markout-theme') === 'dark') html.setAttribute('data-theme', 'dark');

  /* ─── Hamburger (mobile) ─── */
  var hamburger = document.getElementById('hamburger');
  var headerNav = document.getElementById('headerNav');
  hamburger.addEventListener('click', function () {
    headerNav.classList.toggle('nav-open');
  });
  document.addEventListener('click', function (e) {
    if (!hamburger.contains(e.target) && !headerNav.contains(e.target)) {
      headerNav.classList.remove('nav-open');
    }
  });

  /* ─── DOM refs ─── */
  var uploadArea   = document.getElementById('uploadArea');
  var fileInput    = document.getElementById('fileInput');
  var loading      = document.getElementById('loading');
  var loadingMsg   = loading.querySelector('p');
  var result       = document.getElementById('result');
  var noHighlights = document.getElementById('noHighlights');
  var error        = document.getElementById('error');
  var errorMsg     = document.getElementById('errorMsg');
  var markdownOut  = document.getElementById('markdownOutput');
  var resultMeta   = document.getElementById('resultMeta');
  var copyBtn      = document.getElementById('copyBtn');
  var downloadBtn  = document.getElementById('downloadBtn');
  var cropContainer = document.getElementById('cropContainer');

  var currentFile = null;
  var cropData  = []; // { page, score, cropCanvas }

  /* ─── Helpers ─── */
  function showLoading(msg) {
    loading.classList.remove('hidden');
    if (loadingMsg) loadingMsg.textContent = msg || 'Elaborazione…';
  }
  function hideAll() {
    loading.classList.add('hidden');
    result.classList.add('hidden');
    noHighlights.classList.add('hidden');
    error.classList.add('hidden');
  }
  function fmtDate() {
    return new Date().toLocaleDateString('it-IT', { year:'numeric', month:'long', day:'numeric' });
  }

  /* ═══════════════════════════════════════════════
     ML PIPELINE
     ═══════════════════════════════════════════════ */

  /* ─── Stage: rendering PDF con pdf.js ─────────── */
  function renderPageToCanvas(pdf, pageNum) {
    return pdf.getPage(pageNum).then(function (page) {
      var vp = page.getViewport({ scale: 1 }); // base scale
      var baseZoom = DPI / 72;
      var zoom = baseZoom;
      var longPx = Math.max(vp.width, vp.height) * baseZoom;
      if (longPx > MAX_DIM) zoom = baseZoom * (MAX_DIM / longPx);

      var canvas = document.createElement('canvas');
      var scaled = page.getViewport({ scale: zoom });
      canvas.width  = Math.round(scaled.width);
      canvas.height = Math.round(scaled.height);
      var ctx = canvas.getContext('2d');

      return page.render({ canvasContext: ctx, viewport: scaled }).promise.then(function () {
        page.cleanup();
        return canvas;
      });
    });
  }

  /* ─── Stage: deskew (allineamento) ────────────── */
  function getGrayData(canvas) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    var gray = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var p = i * 4;
      gray[i] = 0.299 * data[p] + 0.587 * data[p+1] + 0.114 * data[p+2];
    }
    return { gray: gray, w: w, h: h };
  }

  function rotateCanvas(src, angle, w, h) {
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    ctx.restore();
    return out;
  }

  function rowVariance(gray, w, h) {
    var sums = new Float64Array(h);
    for (var y = 0; y < h; y++) {
      var s = 0;
      for (var x = 0; x < w; x++) s += gray[y * w + x];
      sums[y] = s;
    }
    var mean = 0;
    for (var y = 0; y < h; y++) mean += sums[y];
    mean /= h;
    var varSum = 0;
    for (var y = 0; y < h; y++) varSum += (sums[y] - mean) * (sums[y] - mean);
    return varSum / h;
  }

  function deskewCanvas(canvas) {
    var w = canvas.width, h = canvas.height;
    var scale = Math.min(1, 1000 / Math.max(w, h));
    var sw = Math.round(w * scale), sh = Math.round(h * scale);

    // Downscale
    var small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    var sctx = small.getContext('2d');
    sctx.drawImage(canvas, 0, 0, sw, sh);

    // Cerca miglior angolo
    var bestAngle = 0, bestVar = -1;
    for (var a = -10; a <= 10; a += 0.5) {
      var rotated = rotateCanvas(small, a, sw, sh);
      var d = getGrayData(rotated);
      var v = rowVariance(d.gray, d.w, d.h);
      if (v > bestVar) { bestVar = v; bestAngle = a; }
    }

    // Ruota full-size
    var out = rotateCanvas(canvas, bestAngle, w, h);
    return { canvas: out, angle: bestAngle };
  }

  /* ─── Stage: preprocessing YOLO ───────────────── */
  function preprocessYOLO(canvas) {
    var w = canvas.width, h = canvas.height;
    var r = Math.min(MODEL_SIZE / w, MODEL_SIZE / h);
    var nw = Math.round(w * r), nh = Math.round(h * r);
    var padX = Math.round((MODEL_SIZE - nw) / 2);
    var padY = Math.round((MODEL_SIZE - nh) / 2);

    // Letterbox canvas con padding grigio (114)
    var lb = document.createElement('canvas');
    lb.width = MODEL_SIZE; lb.height = MODEL_SIZE;
    var ctx = lb.getContext('2d');
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    ctx.drawImage(canvas, padX, padY, nw, nh);

    // Leggi pixel → CHW float32 [0,1]
    var imgData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    var arr = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
    var stride = MODEL_SIZE * MODEL_SIZE;
    for (var y = 0; y < MODEL_SIZE; y++) {
      for (var x = 0; x < MODEL_SIZE; x++) {
        var idx = (y * MODEL_SIZE + x) * 4;
        arr[0 * stride + y * MODEL_SIZE + x] = imgData[idx] / 255.0;
        arr[1 * stride + y * MODEL_SIZE + x] = imgData[idx + 1] / 255.0;
        arr[2 * stride + y * MODEL_SIZE + x] = imgData[idx + 2] / 255.0;
      }
    }
    return { tensorArr: arr, scale: r, padX: padX, padY: padY };
  }

  /* ─── Decodifica output YOLO ──────────────────── */
  function decodeYOLO(data, confThres) {
    var dets = [];
    for (var i = 0; i < 300; i++) {
      var off = i * 6;
      var x1 = data[off], y1 = data[off+1];
      var x2 = data[off+2], y2 = data[off+3];
      var score = data[off+4], cls = data[off+5];
      if (score >= confThres) {
        dets.push({ x1: x1, y1: y1, x2: x2, y2: y2, score: score, cls: Math.round(cls) });
      }
    }
    return dets;
  }

  function boxesToOrig(dets, scale, padX, padY) {
    return dets.map(function (d) { return {
      x1: (d.x1 - padX) / scale,
      y1: (d.y1 - padY) / scale,
      x2: (d.x2 - padX) / scale,
      y2: (d.y2 - padY) / scale,
      score: d.score, cls: d.cls
    };});
  }

  /* ─── Crop extraction ─────────────────────────── */
  function extractCropCanvas(srcCanvas, box) {
    var w = srcCanvas.width, h = srcCanvas.height;
    var x1 = Math.max(0, Math.round(box.x1));
    var y1 = Math.max(0, Math.round(box.y1));
    var x2 = Math.min(w - 1, Math.round(box.x2));
    var y2 = Math.min(h - 1, Math.round(box.y2));
    if (x2 - x1 < 3 || y2 - y1 < 3) return null;
    var c = document.createElement('canvas');
    c.width = x2 - x1; c.height = y2 - y1;
    c.getContext('2d').drawImage(srcCanvas, x1, y1, x2-x1, y2-y1, 0, 0, x2-x1, y2-y1);
    return c;
  }

  /* ─── Stage: esecuzione modello TFLite ────────── */
  var _model = null;
  var _modelLoading = false;
  var _modelPromise = null;

  function loadModel() {
    if (_model) return Promise.resolve(_model);
    if (_modelPromise) return _modelPromise;

    _modelLoading = true;
    _modelPromise = new Promise(function (resolve, reject) {
      // Verifica che tflite e tf siano disponibili
      if (typeof tflite === 'undefined' || typeof tflite.loadTFLiteModel === 'undefined') {
        reject(new Error('tflite.js non caricato. Verifica la connessione a Internet.'));
        return;
      }
      if (typeof tf === 'undefined') {
        reject(new Error('TensorFlow.js non caricato.'));
        return;
      }

      console.log('🔵 ML: setWasmPath', WASM_PATH);
      tflite.setWasmPath(WASM_PATH).then(function () {
        console.log('🔵 ML: WASM path impostato. Carico modello...');
        return tflite.loadTFLiteModel(MODEL_FILE);
      }).then(function (model) {
        _model = model;
        _modelLoading = false;
        console.log('✅ ML: modello caricato');
        resolve(model);
      }).catch(function (err) {
        _modelLoading = false;
        _modelPromise = null;
        console.error('❌ ML: errore caricamento modello:', err);
        reject(err);
      });
    });
    return _modelPromise;
  }

  /* ─── Pipeline principale ─────────────────────── */
  function processPDF(pdf) {
    cropData = [];
    var totalPages = pdf.numPages;

    return loadModel().then(function () {
      // Processa pagina per pagina
      var promise = Promise.resolve();
      for (var p = 1; p <= totalPages; p++) {
        promise = promise.then(function (pageNum) {
          return processPage(pdf, pageNum).then(function (crops) {
            cropData = cropData.concat(crops);
          });
        }.bind(null, p));
      }
      return promise;
    });
  }

  function processPage(pdf, pageNum) {
    showLoading('📄 Elaboro pagina ' + pageNum + '/' + pdf.numPages + ' (rendering…)');

    return renderPageToCanvas(pdf, pageNum).then(function (pageCanvas) {

      showLoading('📄 Pagina ' + pageNum + ' — allineamento…');
      var deskewed = deskewCanvas(pageCanvas);
      var deskewedCanvas = deskewed.canvas;

      showLoading('📄 Pagina ' + pageNum + ' — rilevo evidenziature…');
      var prep = preprocessYOLO(deskewedCanvas);
      var inputTensor = tf.tensor(prep.tensorArr, [1, 3, MODEL_SIZE, MODEL_SIZE], 'float32');

      try {
        var outputTensor = _model.predict(inputTensor);
        return outputTensor.data().then(function (rawData) {
          inputTensor.dispose();
          outputTensor.dispose();

          var dets = decodeYOLO(rawData, CONF_THRES);
          var boxes = boxesToOrig(dets, prep.scale, prep.padX, prep.padY);
          console.log('📄 Pagina ' + pageNum + ': ' + boxes.length + ' highlight');

          var crops = [];
          for (var i = 0; i < boxes.length; i++) {
            var cropCanv = extractCropCanvas(deskewedCanvas, boxes[i]);
            if (cropCanv) {
              crops.push({ page: pageNum, score: boxes[i].score, canvas: cropCanv });
            }
          }
          return crops;
        });
      } catch (predErr) {
        inputTensor.dispose();
        console.warn('⚠️ Predict error page ' + pageNum + ':', predErr);
        return [];
      }

    });
  }

  /* ─── Build markdown ──────────────────────────── */
  function buildMarkdown(crops, fileName) {
    var pages = new Set();
    crops.forEach(function (c) { pages.add(c.page); });
    var out = [];
    out.push('---');
    out.push('title: "Evidenziazioni"');
    out.push('source: "' + fileName + '"');
    out.push('date: "' + fmtDate() + '"');
    out.push('count: ' + crops.length);
    out.push('pages: ' + pages.size);
    out.push('---');
    out.push('');
    out.push('# Evidenziazioni estratte');
    out.push('');
    out.push('**Fonte:** ' + fileName + '  ');
    out.push('**Data:** ' + fmtDate() + '  ');
    out.push('**Totale:** ' + crops.length + ' evidenziazioni · ' + pages.size + ' pagine');
    out.push('');
    // Raggruppa per pagina
    var sorted = crops.slice().sort(function (a,b) { return a.page - b.page; });
    var cur = 0;
    sorted.forEach(function (c) {
      if (c.page !== cur) { cur = c.page; out.push('---'); out.push('## Pagina ' + cur); out.push(''); }
      out.push('> ![crop](crop_p' + c.page + '_s' + c.score.toFixed(2) + ')');
      out.push('');
      out.push('');
    });
    return out.join('\n');
  }

  /* ═══════════════════════════════════════════════
     UI
     ═══════════════════════════════════════════════ */

  /* ─── Upload ─── */
  uploadArea.addEventListener('click', function () { fileInput.click(); });
  uploadArea.addEventListener('dragover', function (e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', function () { uploadArea.classList.remove('dragover'); });
  uploadArea.addEventListener('drop', function (e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (this.files[0]) processFile(this.files[0]);
    this.value = '';
  });

  /* ─── Copia / Scarica ─── */
  copyBtn.addEventListener('click', async function () {
    if (!currentFile || !cropData.length) return;
    var txt = buildMarkdown(cropData, currentFile.name);
    try { await navigator.clipboard.writeText(txt); } catch (ex) {
      var ta = document.createElement('textarea'); ta.value = txt;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    copyBtn.textContent = '✅ Copiato!';
    setTimeout(function () { copyBtn.textContent = '📋 Copia'; }, 2000);
  });

  downloadBtn.addEventListener('click', function () {
    if (!currentFile || !cropData.length) return;
    var txt = buildMarkdown(cropData, currentFile.name);
    var blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (currentFile.name || 'doc').replace(/\.pdf$/i, '') + '-evidenziazioni.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  /* ─── Processa file ───────────────────────────── */
  function processFile(f) {
    hideAll();
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      errorMsg.textContent = 'Il file non è un PDF valido.';
      error.classList.remove('hidden');
      return;
    }
    currentFile = f;
    cropData = [];
    showLoading('Inizializzazione modello ML…');
    console.log('📄 MarkOut: leggo file', f.name, '(' + (f.size / 1024).toFixed(1) + ' KB)');

    if (typeof pdfjsLib === 'undefined') {
      hideAll();
      errorMsg.textContent = 'PDF.js non caricato. Ricarica la pagina.';
      error.classList.remove('hidden');
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var buf = new Uint8Array(e.target.result);
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        pdfjsLib.getDocument({ data: buf }).promise.then(function (pdf) {
          console.log('📄 PDF caricato: ' + pdf.numPages + ' pagine');
          showLoading('Caricamento modello AI…');

          processPDF(pdf).then(function () {
            pdf.destroy();
            showResult();
          }).catch(function (err) {
            console.error('❌ Pipeline error:', err);
            hideAll();
            errorMsg.textContent = err.message || 'Errore durante l\'elaborazione.';
            error.classList.remove('hidden');
          });

        }).catch(function (err) {
          console.error('❌ Errore apertura PDF:', err);
          hideAll();
          errorMsg.textContent = err.message || 'Impossibile leggere il PDF.';
          error.classList.remove('hidden');
        });

      } catch (err) {
        console.error('❌ Errore:', err);
        hideAll();
        errorMsg.textContent = err.message;
        error.classList.remove('hidden');
      }
    };
    reader.onerror = function () {
      hideAll();
      errorMsg.textContent = 'Errore nella lettura del file.';
      error.classList.remove('hidden');
    };
    reader.readAsArrayBuffer(f);
  }

  /* ─── Mostra risultati ────────────────────────── */
  function showResult() {
    hideAll();

    if (!cropData.length) {
      noHighlights.classList.remove('hidden');
      return;
    }

    // Mostra crop
    cropContainer.innerHTML = '';
    var pages = new Set();
    cropData.forEach(function (c, idx) {
      pages.add(c.page);
      var div = document.createElement('div');
      div.className = 'crop-item';

      var img = document.createElement('img');
      img.src = c.canvas.toDataURL();
      img.alt = 'Evidenziazione p.' + c.page;
      div.appendChild(img);

      var label = document.createElement('span');
      label.className = 'crop-label';
      label.textContent = 'p.' + c.page + ' (' + (c.score * 100).toFixed(0) + '%)';
      div.appendChild(label);

      cropContainer.appendChild(div);
    });

    resultMeta.textContent = cropData.length + ' evidenziazioni · ' + pages.size + ' pagine — ' + currentFile.name;
    markdownOut.textContent = buildMarkdown(cropData, currentFile.name);
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  console.log('🔵 MarkOut ready — ML pipeline YOLO25n');
})();