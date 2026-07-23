/**
 * MarkOut — Estrazione testo evidenziato via ML pipeline (YOLO25n)
 * Pipeline: PDF → render → deskew → HT_detector_v7.8.onnx → crop → OCR
 */
(function () {
  'use strict';

  /* ─── Costanti ─── */
  var DPI = 300;
  var MAX_DIM = 2000;
  var MODEL_SIZE = 1024;
  var CONF_THRES = 0.30;
  var MODEL_FILE = 'HT_detector_v7.8.onnx';
  var INPUT_NAME = 'images';
  var OUTPUT_NAME = 'output0';

  /* ─── OCR (PP-OCRv6) ─── */
  var OCR_MODEL_FILE = 'PP-OCRv6_rec.onnx';
  var OCR_INPUT_NAME = 'x';
  var OCR_OUTPUT_NAME = 'fetch_name_0';
  var OCR_CHARS_FILE = 'ppocr_chars.json';
  var OCR_HEIGHT = 48;
  var OCR_BLANK_ID = 0; // blank è alla classe 0

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

  var pdfViewer      = document.getElementById('pdfViewer');
  var viewTabs       = document.getElementById('viewTabs');
  var tabBtns        = viewTabs ? viewTabs.querySelectorAll('.tab-btn') : [];

  var currentFile = null;
  var cropData  = []; // { page, score, canvas } — crop images
  var pageData  = []; // { pageNum, canvas, boxes } — full pages with boxes

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

  /* ─── OCR preprocessing ──────────────────────── */
  function preprocessOCR(canvas) {
    var srcW = canvas.width, srcH = canvas.height;
    var scale = OCR_HEIGHT / srcH;
    var tgtW = Math.max(8, Math.round(srcW * scale / 8) * 8); // multiple of 8

    // Resize to target size
    var resized = document.createElement('canvas');
    resized.width = tgtW;
    resized.height = OCR_HEIGHT;
    var ctx = resized.getContext('2d');
    ctx.drawImage(canvas, 0, 0, tgtW, OCR_HEIGHT);

    // Get RGBA pixels
    var imgData = ctx.getImageData(0, 0, tgtW, OCR_HEIGHT);
    var data = imgData.data;

    // Convert to BGR CHW float32 [0,1]
    var arr = new Float32Array(3 * OCR_HEIGHT * tgtW);
    var stride = OCR_HEIGHT * tgtW;
    for (var y = 0; y < OCR_HEIGHT; y++) {
      for (var x = 0; x < tgtW; x++) {
        var idx = (y * tgtW + x) * 4;
        // RGBA → BGR (swap R↔B)
        arr[0 * stride + y * tgtW + x] = data[idx + 2] / 255.0; // B
        arr[1 * stride + y * tgtW + x] = data[idx + 1] / 255.0; // G
        arr[2 * stride + y * tgtW + x] = data[idx + 0] / 255.0; // R
      }
    }
    return { tensorArr: arr, width: tgtW, height: OCR_HEIGHT };
  }

  /* ─── CTC decode ─────────────────────────────── */
  function ctcDecode(outputData, seqLen, numClasses) {
    if (!_ocrChars) return '';
    numClasses = numClasses || (OCR_BLANK_ID + 1);
    var result = [];
    var prevIdx = -1;
    for (var t = 0; t < seqLen; t++) {
      var off = t * numClasses;
      // Argmax
      var maxIdx = 0;
      var maxVal = outputData[off];
      for (var c = 1; c < numClasses; c++) {
        var v = outputData[off + c];
        if (v > maxVal) { maxVal = v; maxIdx = c; }
      }
      if (maxIdx !== OCR_BLANK_ID && maxIdx !== prevIdx) {
        // Mappatura diretta: classe N -> _ocrChars[N]
        // _ocrChars[0] = 'blank' (non usato perché filtrato sopra)
        // _ocrChars[18709] = ' ' (spazio)
        if (maxIdx >= 0 && maxIdx < _ocrChars.length) {
          result.push(_ocrChars[maxIdx]);
        }
      }
      prevIdx = (maxIdx === OCR_BLANK_ID) ? -1 : maxIdx;
    }
    return result.join('');
  }

  /* ─── Stage: esecuzione modello ONNX (YOLO) ─── */
  var _session = null;
  var _modelLoading = false;
  var _modelPromise = null;

  /* ─── OCR Model (PP-OCRv6) ──────────────────── */
  var _ocrSession = null;
  var _ocrLoading = false;
  var _ocrPromise = null;
  var _ocrChars = null; // char array
  var _ocrCharsPromise = null;

  function loadModel() {
    if (_session) return Promise.resolve(_session);
    if (_modelPromise) return _modelPromise;

    _modelLoading = true;
    _modelPromise = new Promise(function (resolve, reject) {
      if (typeof ort === 'undefined') {
        reject(new Error('ONNX Runtime Web non caricato. Verifica la connessione a Internet.'));
        return;
      }

      console.log('🔵 ML: carico modello ONNX…');
      // Path esplicito per i WASM runtime
      if (ort.env && ort.env.wasm) {
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
      }
      ort.InferenceSession.create(MODEL_FILE, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      }).then(function (session) {
        _session = session;
        _modelLoading = false;
        console.log('✅ ML: sessione ONNX pronta');
        resolve(session);
      }).catch(function (err) {
        _modelLoading = false;
        _modelPromise = null;
        console.error('❌ ML: errore caricamento ONNX:', err);
        reject(err);
      });
    });
    return _modelPromise;
  }

  /* ─── Load OCR char dictionary ───────────────── */
  function loadChars() {
    if (_ocrChars) return Promise.resolve(_ocrChars);
    if (_ocrCharsPromise) return _ocrCharsPromise;

    _ocrCharsPromise = fetch(OCR_CHARS_FILE).then(function (r) {
      if (!r.ok) throw new Error('Impossibile caricare ' + OCR_CHARS_FILE);
      return r.json();
    }).then(function (chars) {
      _ocrChars = chars;
      console.log('✅ OCR: caricati ' + chars.length + ' caratteri');
      return chars;
    }).catch(function (err) {
      _ocrCharsPromise = null;
      console.error('❌ OCR: errore caricamento caratteri:', err);
      throw err;
    });
    return _ocrCharsPromise;
  }

  /* ─── Load OCR model (PP-OCRv6) ──────────────── */
  function loadOCRModel() {
    if (_ocrSession) return Promise.resolve(_ocrSession);
    if (_ocrPromise) return _ocrPromise;

    _ocrPromise = new Promise(function (resolve, reject) {
      if (typeof ort === 'undefined') {
        reject(new Error('ONNX Runtime Web non caricato'));
        return;
      }

      // Ensure WASM paths are set
      if (ort.env && ort.env.wasm) {
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
      }

      console.log('🔵 OCR: carico modello PP-OCRv6…');
      ort.InferenceSession.create(OCR_MODEL_FILE, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      }).then(function (session) {
        _ocrSession = session;
        _ocrLoading = false;
        console.log('✅ OCR: sessione PP-OCRv6 pronta');
        resolve(session);
      }).catch(function (err) {
        _ocrLoading = false;
        _ocrPromise = null;
        console.error('❌ OCR: errore caricamento PP-OCRv6:', err);
        reject(err);
      });
    });
    return _ocrPromise;
  }

  /* ─── Run OCR on a single crop ───────────────── */
  function runOCR(cropCanvas) {
    if (!_ocrSession || !_ocrChars) {
      return Promise.resolve('');
    }
    var prep = preprocessOCR(cropCanvas);
    var tensor = new ort.Tensor('float32', prep.tensorArr, [1, 3, prep.height, prep.width]);
    return _ocrSession.run({ [OCR_INPUT_NAME]: tensor }).then(function (results) {
      var output = results[OCR_OUTPUT_NAME];
      // output shape: [1, seqLen, numClasses]
      var dims = output.dims;
      var seqLen = dims[1];
      var numClasses = dims[2];
      var text = ctcDecode(output.data, seqLen, numClasses);
      return text;
    }).catch(function (err) {
      console.warn('⚠️ OCR: errore riconoscimento:', err);
      return '';
    });
  }

  /* ─── Pipeline principale ─────────────────────── */
  function processPDF(pdf) {
    cropData = [];
    pageData = [];
    var totalPages = pdf.numPages;

    // Carica modello YOLO + OCR + dizionario caratteri
    return Promise.all([loadModel(), loadOCRModel(), loadChars()]).then(function () {
      // Processa pagina per pagina (YOLO detection)
      var promise = Promise.resolve();
      for (var p = 1; p <= totalPages; p++) {
        promise = promise.then(function (pageNum) {
          return processPage(pdf, pageNum).then(function (result) {
            cropData = cropData.concat(result.crops);
          });
        }.bind(null, p));
      }
      return promise;
    }).then(function () {
      // OCR su ogni crop
      if (!cropData.length) return;
      showLoading('🔍 Riconoscimento testo OCR (' + cropData.length + ' evidenziazioni)…');
      var ocrPromise = Promise.resolve();
      cropData.forEach(function (crop) {
        ocrPromise = ocrPromise.then(function () {
          return runOCR(crop.canvas).then(function (text) {
            crop.text = text;
          });
        });
      });
      return ocrPromise;
    });
  }

  function processPage(pdf, pageNum) {
    showLoading('📄 Elaboro pagina ' + pageNum + '/' + pdf.numPages + ' (rendering…)');

    return renderPageToCanvas(pdf, pageNum).then(function (pageCanvas) {

      showLoading('📄 Pagina ' + pageNum + ' — rilevo evidenziature…');
      var deskewedCanvas = pageCanvas;
      var prep = preprocessYOLO(deskewedCanvas);
      var inputTensor = new ort.Tensor('float32', prep.tensorArr, [1, 3, MODEL_SIZE, MODEL_SIZE]);

      try {
        return _session.run({ [INPUT_NAME]: inputTensor }).then(function (results) {
          var output = results[OUTPUT_NAME];
          var rawData = output.data;

          var dets = decodeYOLO(rawData, CONF_THRES);
          var boxes = boxesToOrig(dets, prep.scale, prep.padX, prep.padY);
          console.log('📄 Pagina ' + pageNum + ': ' + boxes.length + ' highlight');

          // Store full page + boxes for bounding box viewer
          pageData.push({ pageNum: pageNum, canvas: deskewedCanvas, boxes: boxes });

          var crops = [];
          for (var i = 0; i < boxes.length; i++) {
            var cropCanv = extractCropCanvas(deskewedCanvas, boxes[i]);
            if (cropCanv) {
              crops.push({ page: pageNum, score: boxes[i].score, canvas: cropCanv, text: '' });
            }
          }
          return { crops: crops, boxes: boxes };
        });
      } catch (predErr) {
        console.warn('⚠️ Predict error page ' + pageNum + ':', predErr);
        return { crops: [], boxes: [] };
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
      var text = c.text || '';
      if (text) {
        out.push('> ' + text);
      } else {
        out.push('> ![crop](crop_p' + c.page + '_s' + c.score.toFixed(2) + ')');
      }
      out.push('');
      out.push('');
    });
    return out.join('\n');
  }

  /* ─── Render pages with bounding boxes ──────── */
  function renderBBoxPages() {
    if (!pdfViewer) return;
    pdfViewer.innerHTML = '';

    pageData.forEach(function (pd) {
      var wrapper = document.createElement('div');
      wrapper.className = 'bbox-page';

      var label = document.createElement('div');
      label.className = 'bbox-page-label';
      label.textContent = 'Pagina ' + pd.pageNum + ' — ' + pd.boxes.length + ' evidenziazion' + (pd.boxes.length === 1 ? 'e' : 'i');
      wrapper.appendChild(label);

      // Create output canvas
      var outCanvas = document.createElement('canvas');
      outCanvas.width = pd.canvas.width;
      outCanvas.height = pd.canvas.height;
      var ctx = outCanvas.getContext('2d');

      // Draw the page
      ctx.drawImage(pd.canvas, 0, 0);

      // Draw bounding boxes
      pd.boxes.forEach(function (box) {
        var x = box.x1, y = box.y1;
        var w = box.x2 - box.x1;
        var h = box.y2 - box.y1;

        // Semi-transparent highlight fill
        ctx.fillStyle = 'rgba(255, 230, 0, 0.25)';
        ctx.fillRect(x, y, w, h);

        // Border
        ctx.strokeStyle = '#FF6B35';
        ctx.lineWidth = Math.max(2, Math.round(Math.min(outCanvas.width, outCanvas.height) / 400));
        ctx.strokeRect(x, y, w, h);

        // Score badge
        var labelText = (box.score * 100).toFixed(0) + '%';
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
        var textW = ctx.measureText(labelText).width;
        var bx = x, by = y - 22;
        if (by < 0) { by = y + 2; }
        ctx.fillStyle = '#FF6B35';
        var badgeW = textW + 12, badgeH = 20, badgeR = 4;
        ctx.beginPath();
        ctx.moveTo(bx - 4 + badgeR, by - 1);
        ctx.lineTo(bx - 4 + badgeW - badgeR, by - 1);
        ctx.quadraticCurveTo(bx - 4 + badgeW, by - 1, bx - 4 + badgeW, by - 1 + badgeR);
        ctx.lineTo(bx - 4 + badgeW, by - 1 + badgeH - badgeR);
        ctx.quadraticCurveTo(bx - 4 + badgeW, by - 1 + badgeH, bx - 4 + badgeW - badgeR, by - 1 + badgeH);
        ctx.lineTo(bx - 4 + badgeR, by - 1 + badgeH);
        ctx.quadraticCurveTo(bx - 4, by - 1 + badgeH, bx - 4, by - 1 + badgeH - badgeR);
        ctx.lineTo(bx - 4, by - 1 + badgeR);
        ctx.quadraticCurveTo(bx - 4, by - 1, bx - 4 + badgeR, by - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(labelText, bx + 2, by + 14);
      });

      // Scale for display
      outCanvas.style.maxWidth = '100%';
      outCanvas.style.height = 'auto';
      outCanvas.style.borderRadius = '8px';
      outCanvas.style.boxShadow = '0 2px 12px rgba(0,0,0,0.12)';

      wrapper.appendChild(outCanvas);
      pdfViewer.appendChild(wrapper);
    });
  }

  /* ─── Tab switching ──────────────────────────── */
  function switchView(viewName) {
    // Update tab buttons
    tabBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
    });

    // Toggle panels
    pdfViewer.classList.toggle('hidden', viewName !== 'bbox');
    cropContainer.classList.toggle('hidden', viewName !== 'crops');
    markdownOut.classList.toggle('hidden', viewName !== 'markdown');
  }

  if (viewTabs) {
    viewTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn) return;
      var view = btn.getAttribute('data-view');
      if (view) switchView(view);
    });
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
      var labelText = 'p.' + c.page + ' (' + (c.score * 100).toFixed(0) + '%)';
      if (c.text) {
        labelText += ' ' + c.text.slice(0, 40) + (c.text.length > 40 ? '…' : '');
      }
      label.textContent = labelText;
      div.appendChild(label);

      cropContainer.appendChild(div);
    });

    resultMeta.textContent = cropData.length + ' evidenziazioni · ' + pages.size + ' pagine — ' + currentFile.name;
    markdownOut.textContent = buildMarkdown(cropData, currentFile.name);

    // Renderizza le pagine con bounding box
    renderBBoxPages();

    // Mostra il risultato con la vista Bounding Box attiva di default
    result.classList.remove('hidden');
    switchView('bbox');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  console.log('🔵 MarkOut ready — ML pipeline YOLO25n');
})();