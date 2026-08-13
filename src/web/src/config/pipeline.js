/**
 * Config — soglie, feature flag e costanti della pipeline ML.
 *
 * Le costanti di memoria/risoluzione (DPI, MAX_DIM, MODEL_SIZE, batch OCR)
 * sono DERIVATE dal profilo dispositivo (config/device.js):
 *   - Desktop: GPU acceleration, risoluzione piena, batch pieni.
 *   - Mobile:  GPU quando possibile ma a memoria minimale.
 */
import {
  RENDER_DPI,
  RENDER_MAX_DIM,
  YOLO_MODEL_SIZE,
  OCR_ENGINE_BATCH_MAX,
  OCR_FRAGMENT_BATCH_MAX,
  OCR_CHUNK_MAX,
  OCR_CROP_MAX_W,
  OCR_CROP_MIN_H,
} from './device.js';

export const DPI = RENDER_DPI;              // 300 — identico su desktop e mobile (stessa resa)
export const MAX_DIM = RENDER_MAX_DIM;      // 2000 — identico su desktop e mobile (stessa resa)
export const MODEL_SIZE = YOLO_MODEL_SIZE;  // 1024 — shape fissa del modello ONNX (identico ovunque)
export const CONF_THRES = 0.15;
export const MODEL_FILE = 'HT_detector_v7.9.onnx';

export const INPUT_NAME = 'images';
export const OUTPUT_NAME = 'output0';

/* ─── Merge post-GapTree ─── */
export const MERGE_VERTICAL_TOUCHING = true;

/* ─── Column layout ─── */
export const COLUMN_LAYOUT = true;

/* ─── Filtri detezione ─── */
/* Mantiene solo le detection che contengono il CENTRO di almeno un
   box YOLO (piano deskewed): con un modello accurato ogni box ha la
   sua riga. Sotto, il gap-tree (regioni) è una cosa a parte. */
export const FILTER_DET_BEFORE_GAPTREE = true;

/* ─── OCR ─── */
/* Lingua FISSA: il modello rec è unico e self-hosted
   (PP-OCRv6_small_rec) e copre l'inglese e le lingue latine più
   comuni (it, fr, de, es, pt, nl…). Niente selettore lingua: il
   modello è precaricato di default per tutte le lingue che
   supporta. */
export const PADDLEOCR_LANG = 'en';
export const PADDLEOCR_VERSION = 'PP-OCRv6';
// Batch interni del motore PaddleOCR: desktop 32 · mobile 16 (meno heap/VRAM)
export const OCR_BATCH_SIZE = OCR_ENGINE_BATCH_MAX;
export const OCR_DET_BATCH_SIZE = OCR_ENGINE_BATCH_MAX;
export const OCR_REC_BATCH_SIZE = OCR_ENGINE_BATCH_MAX;
export const MAX_OCR_WIDTH = 1024;
export const MIN_OCR_HEIGHT = 64;
export const OCR_OVERLAP = 60;
/* Larghezza massima del crop di riga (v5 row-assist): il modello rec
 * normalizza l'altezza a 48px, i pixel extra oltre ~1280px di larghezza
 * sono solo memoria (i row canvas si accumulano per tutte le pagine
 * durante la fase YOLO: senza cap un PDF denso può aggiungere ~400MB). */
export const OCR_ROW_MAX_W = 1280;

/* ─── Crop cap (mobile) ───
 * I crop dei frammenti vengono ridimensionati su mobile per contenere
 * la memoria dei canvas: larghezza ≤ CROP_MAX_W finché il testo
 * risultante resta ≥ CROP_MIN_H (vedi geometry.downscaleForOcr).
 */
export const CROP_MAX_W = OCR_CROP_MAX_W;
export const CROP_MIN_H = OCR_CROP_MIN_H;


/* ─── OCR batch ─── */
// Canvases processati per chunk (~200ms cad.): desktop 4 · mobile 2
export const OCR_BATCH_CHUNK_SIZE = OCR_CHUNK_MAX;
// Cap massimo del batch di frammenti in runOcrOnFragments: desktop 48 · mobile 24
export const OCR_MAX_BATCH_SIZE = OCR_FRAGMENT_BATCH_MAX;

/* ─── Post-GapTree split ─── */
export const SPLIT_VERTICAL_GAP_RATIO = 3; // × lineHeight

/* ─── Overlap merge ─── */
export const OVERLAP_MERGE_IOU = 0.5;
export const OVERLAP_MERGE_OVERLAP = 0.7;

/* ─── Vertical merge ─── */
export const VERTICAL_GAP_THRESHOLD = 3;     // px
export const VERTICAL_X_OVERLAP_RATIO = 0.30;

/* ─── Column detection ─── */
export const COLUMN_OVERLAP_MIN = 35;

/* ─── Filter small boxes ─── */
export const SMALL_BOX_MIN_W_RATIO = 0.008;
export const SMALL_BOX_MIN_H_RATIO = 0.006;

/* ─── YOLO uncovered ─── */
export const UNCOVERED_MIN_SCORE = 0.45;

/* ─── Reading order ─── */
export const BAND_OVERLAP_TOLERANCE = 3;
export const SAME_ROW_TOLERANCE_RATIO = 0.3; // × lineHeight

/* ─── Gutter detection ─── */
export const GUTTER_MIN_GAP_RATIO_LH = 1.5;  // × lineHeight
export const GUTTER_MIN_GAP_RATIO_W = 0.015;  // × pageWidth
export const GUTTER_MARGIN_L = 0.08;
export const GUTTER_MARGIN_R = 0.08;
export const GUTTER_MIN_PERSISTENCE = 0.70;
export const GUTTER_MIN_PERSISTENCE_NEAR = 0.85;
export const GUTTER_MIN_SUPPORT = 0.45;
export const GUTTER_MIN_SUPPORT_FEW = 0.15;

/* ─── Assignment ─── */
export const ASSIGN_CROSS_GUTTER_EPS_RATIO = 0.5; // × lineHeight
export const ASSIGN_MIN_OVERLAP_RATIO = 0.70;

/* ─── Debug mode ─── */
/* Attiva/disattiva le tab di debug (Bounding Box, Evidenziazioni, Frammenti YOLO) e il pulsante download BBox.
   Imposta VITE_DEBUG=true per attivarlo:  start.sh dev debug  */
export const DEBUG = import.meta.env?.VITE_DEBUG === 'true';

/* ─── Overlay debug ─── */
export const SHOW_OVERLAY = DEBUG;
