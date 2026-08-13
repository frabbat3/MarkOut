# MarkOut — PaddleOCR.js Edition

Estrai il testo evidenziato da un PDF e convertilo in Markdown, **direttamente nel browser**.  
Nessun dato viene inviato a server esterni: l'elaborazione avviene interamente lato client.

---

## Indice

- [Come funziona](#come-funziona)
- [Ordinamento dei box](#ordinamento-dei-box)
- [Modalità produzione (memoria minimale)](#modalità-produzione-memoria-minimale)
- [Avvio del server](#avvio-del-server)
  - [Modalità normale](#modalità-normale)
  - [Modalità debug](#modalità-debug)
  - [Modalità produzione](#modalità-produzione)
  - [Riferimento rapido](#riferimento-rapido)
- [Requisiti](#requisiti)
- [Script `start.sh`](#script-startsh)
- [Pipeline di elaborazione](#pipeline-di-elaborazione)
- [Architettura del progetto](#architettura-del-progetto)
  - [config/](#config)
  - [app/](#app)
  - [presentation/](#presentation)
  - [services/](#services)
  - [domain/](#domain)
- [Modalità debug](#modalità-debug)
  - [Elementi UI in modalità debug](#elementi-ui-in-modalità-debug)
- [Personalizzazione](#personalizzazione)
- [Tecnologie utilizzate](#tecnologie-utilizzate)
- [Licenza](#licenza)

---

## Come funziona

1. **Carica un PDF** contenente evidenziature di qualsiasi colore (create con Adobe Acrobat, Preview, Microsoft Edge o qualsiasi lettore PDF — vengono rilevate **visivamente**, non serve che il PDF conservi le annotazioni)
2. **Il browser analizza il PDF** con un'unica **pipeline neurale** per tutti i documenti (digitali o scannerizzati):
   - Ogni pagina viene renderizzata su un canvas
   - Un modello **YOLO26 custom** (`HT_detector_v7.9.onnx`) rileva le aree evidenziate
   - La **detection PP-OCRv6** individua le righe di testo; gap-tree e ordine
     di lettura producono regioni (paragrafi/colonne) e l'assegnazione
     esclusiva di ogni box YOLO alla riga con la **massima area contenuta**
     (vedi [Ordinamento dei box](#ordinamento-dei-box))
   - **PaddleOCR.js** riconosce il testo dentro ogni frammento (crop deskewed
     per-riga)
3. **Ottieni il Markdown** — copia o scarica il risultato

---

## Ordinamento dei box

La pipeline sulle **detection** (PP-OCRv6 + gap-tree) esiste per produrre l'**ordine di
lettura dei box YOLO** e i crop per-riga. Regole di assegnazione esclusiva box↔riga
(`assignFragsToRows`, in `clusterHighlights.js` — la stessa identica funzione usata
dalle tab debug):

1. **Filtro per il gap-tree**: una detection resta nel layout solo se contiene il
   **centro** di un box YOLO, nel piano deskewed della riga (`y' = y − s·x`).
2. **Assegnazione**: ogni box va alla riga con la **maggiore area contenuta**, calcolata
   nel piano del crop della singola riga (slope della riga, fallback pageSlope).
3. **Parità**: se il distacco d'area è entro il **5% dell'area del box** (sfori di bordo,
   non copertura reale), vince il **centro più vicino**.
4. **Detection fuse**: partecipano normalmente alla contesa — la detection *è* la riga,
   nessuno split (il flag `fused` è solo informativo).
5. **Orfani** (box senza riga): entrano nell'ordinamento della regione come **righe
   singole** (top→bottom, sinistra→destra).

L'ordine finale è: regioni (per colonna) → righe → box (per asse di lettura deskewed).

---

## Modalità produzione (memoria minimale)

In produzione (`VITE_DEBUG` non impostato) la pipeline gira **identica** al debug —
stesso ordine, stessi crop deskewed per-riga — ma nulla di superfluo viene salvato:

- **Niente** `displayCanvas` compresso né `pageData` (le tab debug non esistono);
- `clusterAndOrderBoxes(..., lite=true)` ritorna **`detRects: []`** (servono solo ai tab);
- a fine pagina il canvas a piena risoluzione viene rilasciato (`releaseCanvas`);
- l'output verso il chiamante è la **lista piatta dei box** (coordinate + `readingOrder`,
  via `flattenOrderedBoxes`): regioni/items/poly muoiono col **GC**, non sopravvivono
  nel ciclo delle pagine;
- dopo l'OCR i canvas dei frammenti vengono rilasciati.

Il risultato: in produzione la struttura delle detection vive **solo per la durata della
singola pagina** (serve a ordine + crop), poi sparisce — memoria sempre libera.

---

## Profilo dispositivo (desktop vs mobile)

La differenziazione **desktop ↔ mobile** di visualizzazione, memoria e librerie è
centralizzata in `src/config/device.js` (unica fonte di verità, statica per sessione):

| Aspetto | Desktop | Mobile |
|---|---|---|
| **GPU** | WebGPU di default (se RAM > 4GB e non disattivato dall'utente); fallback WASM | **WASM sempre** (stabile, heap gestibile; WebGPU è riservato al desktop) |
| **Render pagina** | 300 DPI, max 2000px | **300 DPI, max 2000px — stessa resa** (i crop per OCR sono identici su tutte le piattaforme) |
| **YOLO letterbox** | 1024px | **1024px — stesso input** (il modello ONNX ha shape fissa `[1,3,1024,1024]`) |
| **Batch motore PaddleOCR** | 32 | **16** |
| **Batch frammenti OCR** | max 48 (scala per RAM) | max 24 (scala per RAM) |
| **Chunk OCR** | 4 canvases | **2 canvases** (picco più basso) |
| **Precarico YOLO all'avvio** | ✅ sì | ❌ no (caricato al primo upload) |
| **Pipeline per-pagina** | batch YOLO → batch OCR | **pagina per pagina**: render → YOLO → layout → crop → OCR → rilascio canvas (mai più di una pagina di crop in memoria; prima i crop di tutte le pagine venivano accumulati) |
| **Canvas frammenti** | risoluzione piena | **ridotti a ≤1024px** di larghezza (finché il testo resta ≥40px: il modello rec normalizza a 48px, qualità invariata, memoria −75%) |
| **Badge accelerazione** | `⚡ GPU Acceleration` / `♻️ CPU Mode (WASM)` | `📱 GPU · Low Memory` / `📱 CPU Mode (WASM)` |

In pratica: **desktop** tende all'accelerazione GPU piena; **mobile** usa **sempre WASM** (stabile, heap gestibile, nessun processo GPU aggiuntivo) e cerca di spendere il minimo di memoria possibile — batch/chunk OCR ridotti, niente precarico, pipeline pagina per pagina (ogni pagina è completata per intero prima della successiva: render → YOLO → layout → crop → OCR → rilascio) e crop ridimensionati a ≤1024px — **senza toccare la resa dei crop** (stessa risoluzione del testo finale dopo la normalizzazione del modello rec). **A fine elaborazione la memoria viene rilasciata** (modelli, canvas residui, documento pdf.js e blob del file — resta solo il nome per i pulsanti Copia/Scarica .md): nella UI compare "🧹 memoria rilasciata" e il markdown rimane visibile e ri-esportabile.

### Formato del Markdown esportato (input LLM)

Il Markdown di Copia/Scarica è progettato come **base per modelli LLM**:
- **front-matter YAML** stabile: `source`, `date`, `pages`, `highlights` per un parsing automatico affidabile
- **ID citabili `[H#]`** globali in ordine di lettura: ogni riga di testo ha un ID stabile (`[H12]`) che l'LLM può usare nelle risposte per riferirsi a specifiche evidenziature
- gerarchia deterministica **`## Page N` → `### Section N`** → bullet
- **flag di qualità inline** (`⚠️ [no text]` = riga non riconosciuta) e sezione finale **`Extraction notes`** con le anomalie per riga

### Modalità sicura (post-crash)

Dopo un crash della tab (su iOS il sintomo è "il sito si ricarica da solo"), al reload appare un banner informativo con la fase esatta in cui l'elaborazione si è interrotta — la pipeline resta **sempre invariata**: nessuna riduzione automatica di risoluzione o batch. Su desktop, se WebGPU crasha o rallenta, l'utente può disattivarlo dal selettore "⚡ Accelerazione GPU (WebGPU)" (localStorage `markout-webgpu` = `'off'` → WASM forzato).

La lingua OCR è fissa: il modello di riconoscimento è unico e self-hosted (`PP-OCRv6_small_rec`) e copre l'inglese e le lingue latine più comuni (it, fr, de, es, pt, nl…). Niente selettore lingua: il modello è precaricato di default per tutte le lingue che supporta.

`config/pipeline.js` deriva `DPI`, `MAX_DIM`, `MODEL_SIZE` e le costanti batch OCR da questo profilo. Nessuna modalità di "degrado automatico": dopo un crash la pipeline riparte identica.

---

## Sito: pagine e SEO

Il sito è un build **multi-page** Vite (vedi `vite.config.js` → `rollupOptions.input`). Oltre al tool (`index.html`) ci sono pagine statiche con header/footer/tema condivisi (`style.css` + `pages.css` + `src/pages.js`):

| Pagina | Contenuto |
|---|---|
| `index.html` | Il tool (upload → markdown) + hero CTA e pulsante ⭐ Star su GitHub |
| `about.html` | Perché MarkOut esiste, stack tecnico |
| `services.html` | Funzionalità e casi d'uso |
| `how-it-works.html` | Pipeline spiegata passo-passo |
| `privacy.html` | Privacy policy (nessun dato lascia il browser) |
| `terms.html` | Termini d'uso |
| `contact.html` | Form di contatto → issue GitHub precompilato (validazione + stati errore/loading) |
| `thank-you.html` | Conferma post-form |
| `404.html` | Pagina 404 custom (GitHub Pages la serve automaticamente) |

### SEO / asset statici (`public/`)

- `robots.txt`, `sitemap.xml` (URL base: `https://frabbat3.github.io/MarkOut/`)
- `og-image.png` (1200×630, generata dai tool, ~33 KB), `favicon-16/32.png`, `apple-touch-icon.png`
- Ogni pagina ha `<title>`, meta description, canonical, Open Graph e Twitter card propri.

### Internazionalizzazione (EN/IT)

Il sito è bilingue con URL per lingua (stile BentoPDF):

- `https://frabbat3.github.io/MarkOut/about.html` → inglese (root)
- `https://frabbat3.github.io/MarkOut/it/about.html` → italiano
- `.../de/...` → tedesco · `.../fr/...` → francese · `.../es/...` → spagnolo · `.../pt/...` → portoghese
- Le URL senza `.html` (es. `/it/about`) funzionano automaticamente su GitHub Pages

Come funziona:

- **Pagine per lingua**: `it/` contiene le 9 pagine tradotte (contenuto già in italiano nell'HTML: funziona anche senza JS, meglio per SEO).
- **Dizionari JSON**: `public/locales/en.json` e `it.json` contengono le stringhe condivise (nav, footer, hero, cookie banner…).
- **`data-i18n="key"`**: gli elementi contrassegnati vengono compilati a runtime da `src/i18n.js` (il testo hardcoded è il fallback). Supporta anche `data-i18n-attr="aria-label"`.
- **Selettore lingua**: nel footer (stile BentoPDF) — pill scura con nome lingua + chevron, menu con ricerca live, `role="menu"/"menuitem"`, stato "nessuna lingua trovata"; cliccando una lingua si naviga alla stessa pagina nell'altra lingua (chiusura con Esc/click esterno).
- **La lingua è decisa dall'URL**: root = EN, `/it/` = IT (niente fallback su browser/localStorage — comportamento prevedibile).
- **SEO**: canonical e `hreflang` alternates su ogni pagina; sitemap con gli URL italiani.

Per aggiungere una lingua: copia una cartella esistente, traduci i contenuti, crea `locales/xx.json` (stesse chiavi), aggiungi le entry in `vite.config.js` e gli URL in `sitemap.xml`.

### Banner cookie e preferenze locali

Il sito non usa cookie né tracker: solo `localStorage` (`markout-theme`, `markout-webgpu`, `markout-cookie-banner`). Il banner informativo (chiudibile, persiste) appare su tutte le pagine — logica in `src/banner.js`, condivisa da `main.js` e `pages.js`.

---

## Avvio del server

Il progetto usa [Vite](https://vitejs.dev/) come bundler e server di sviluppo.  
Lo script `start.sh` gestisce tutte le modalità di avvio.

### Modalità normale

Avvia il server di sviluppo **senza** elementi di debug:

```bash
./start.sh dev
```

Viene avviato Vite su `http://localhost:8080`.  
Nell'interfaccia saranno visibili solo la tab **Markdown** e i pulsanti **Copia** / **Scarica .md**.

### Modalità debug

Avvia il server di sviluppo **con** gli strumenti di debug:

```bash
./start.sh dev debug
```

o equivalentemente:

```bash
./start.sh dev --debug
```

In questa modalità vengono mostrate tutte le tab (**Bounding Box**, **Evidenziazioni**, **Frammenti YOLO**, **YOLO Rows**, **All Det Rows**, **Markdown**, **Report**) e i pulsanti **Scarica BBox .txt**, **Copia Report**, **Scarica Report .txt**.  
La console del browser riporterà:

```
🔵 MarkOut ready — Vite + PaddleOCR.js (🐞 DEBUG MODE)
```

#### ID stabili dei componenti

Ogni componente della pipeline ha un ID stabile, mostrato ovunque nella UI di debug e nel report:

| ID | Significato |
|---|---|
| `Y#n` | box YOLO finale (post filtro + merge) |
| `Yr#n` | box YOLO raw (prima di filtri/merge) |
| `D#n` | riga di detection PP-OCRv6 |
| `R#n` | regione gap tree (= readingOrder) |
| `F#n` | frammento di output (ordine markdown) |

#### Come fare debug

1. **Bounding Box**: overlay con D# (azzurro), Y# (verde) e R# (arancione) + riepilogo per pagina (conteggi YOLO/det/regioni/frammenti, slope, OCR falliti). **Click sul canvas** per ispezionare il componente sotto il puntatore (JSON completo con coordinate, score, slope, assegnazioni).
2. **Evidenziazioni / YOLO Rows / All Det Rows**: ogni card riporta gli ID e apre l'**ispettore JSON** al click (pulsante *Copia JSON* dentro la modal).
3. **Report**: dump testuale completo della pipeline (ambiente, config, YOLO raw/merged con riga e regione assegnata, tutte le righe di detection con box assegnati, regioni gap tree con items, frammenti con testo OCR e stato). Il pulsante **Copia Report** lo mette negli appunti per incollarlo in chat (es. a un assistente AI): nel report ogni componente è identificato dagli ID sopra, oppure puoi citare direttamente gli ID visti nella UI (es. *"Y#3 finito nella D#12 della R#1"*).


### Modalità produzione

Compila i file ottimizzati e avvia il server di preview:

```bash
./start.sh build        # build normale
./start.sh build debug  # build con debug abilitato
./start.sh preview      # solo preview (senza build)
```

### Riferimento rapido

| Comando | Modalità | Debug |
|---|---|---|
| `./start.sh dev` | Sviluppo | ❌ |
| `./start.sh dev debug` | Sviluppo | ✅ |
| `./start.sh build` | Produzione | ❌ |
| `./start.sh build debug` | Produzione | ✅ |
| `./start.sh preview` | Preview | ❌ |

---

## Requisiti

- **Node.js** ≥ 18
- **npm** ≥ 9
- Un browser moderno con supporto **WebAssembly** (Chrome, Firefox, Edge, Safari 16+)

Al primo avvio `start.sh` installa automaticamente le dipendenze con `npm install`.

---

## Script `start.sh`

Lo script `start.sh` si trova nella directory principale del progetto e gestisce:

1. **Installazione automatica** delle dipendenze (`node_modules`)
2. **Impostazione della variabile d'ambiente** `VITE_DEBUG` se richiesta
3. **Esecuzione del comando Vite** appropriato (`dev`, `build`, `preview`)

```bash
#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "📦 Installazione dipendenze..."
  npm install
fi

MODE="${1:-build}"
DEBUG_FLAG="${2:-}"

if [ "$DEBUG_FLAG" = "--debug" ] || [ "$DEBUG_FLAG" = "debug" ]; then
  export VITE_DEBUG=true
  echo "🐞 Modalità debug ATTIVATA"
fi

case "$MODE" in
  dev)      npm run dev -- --port 8080 --host ;;
  preview)  npm run preview -- --port 8080 --host ;;
  build)    npm run build && npm run preview -- --port 8080 --host ;;
  *)        echo "❌ Modalità sconosciuta: $MODE"
            echo "Usa: start.sh [dev|preview|build] [debug|--debug]"
            exit 1 ;;
esac
```

Se preferisci usare `npm` direttamente:

```bash
# Sviluppo
npm run dev -- --port 8080 --host

# Con debug
VITE_DEBUG=true npm run dev -- --port 8080 --host
```

---

## Pipeline di elaborazione

```
PDF caricato
    │
    ▼
PDF.js (npm, self-hosted) ───→ Rende ogni pagina su canvas (300 DPI, max 2000px)
    │
    ▼
Pipeline neurale unica (tutti i PDF, digitali o scannerizzati)
    │
    ▼
YOLO26 (HT_detector_v7.9.onnx) ──▶ rileva le aree evidenziate
    - soglia confidenza: 0.30
    - NMS per fusioni vicine
    ▼
Cluster & Layout ───▶ GapTree: regioni (paragrafi/colonne,
gutter) ──▶ refine: ogni box → riga con MAX area contenuta
(piano deskewed della riga); parità ≤5% → centro più vicino;
detection fuse = riga unica; orfani = righe singole
──▶ ordine finale: regioni → righe → box (asse di lettura)
    ▼
Crop dei frammenti YOLO (deskew per-riga col quad detection)
    ▼
PaddleOCR.js (recognition-only sui crop; detection usata
solo per il layout GapTree — caricata lazily alla prima
pagina con evidenziature, mai su PDF senza highlight)
    ▼
Markdown ──── Unisce i testi in ordine di lettura
    │
    ▼
Guarigione del testo (wordGlue, 3 livelli — vedi sotto)
    │
    ▼
Output: Markdown + opzionale BBox .txt (solo debug)
```

### Guarigione del testo (wordGlue)

L'OCR e i crop dei box evidenziatore spezzano le parole (`"me taphor"`),
incollano parole vicine (`"embracedand"`), spezzano i trattini di a-capo
(`"soci-" + "ety"`) e lasciano lettere spure ai bordi. La pulizia è LEGGERA
ed è organizzata in tre livelli di certezza crescente:

1. **Formato/geometria** (senza linguaggio): normalizzazione punteggiatura,
   lettere maiuscole spure ai bordi delle giunzioni, de-trattinazione
   strutturale.
2. **Dizionario per lingua** (operazioni certe): un merge avviene solo se
   la forma unita è nel dizionario della lingua (top-50000 + classe chiusa
   di FrequencyWords, 29 lingue) e un pezzo è un frammento; gli split di
   parole incollate seguono solo regole strutturali conservative.
3. **N-grammi per lingua** (ambiguità): dove il dizionario lascia due
   candidate plausibili (`"di segno"` vs `"disegno"`, `"we re"` vs
   `"were"`) decide un modello bigramma (Tatoeba, ~400k frasi; chunk lazy
   ~2 MB per le lingue it/en/fr/de/es/pt) che valuta il contesto locale.

La lingua del documento è rilevata automaticamente (classe chiusa +
top-2000); se non è coperta, restano attive solo le pulizie di livello 1.
Gli errori residui sono FISIOLOGICI e vengono lasciati intatti: parole
tagliate dai box (`"White nt,"`), parole rare fuori dizionario
(`"sup erstructure"`), lettere sbagliate dal recognizer (`"sed on race"`).

Dati generati offline (non modificare a mano):
- `node tools/genWordGlue.mjs` — dizionari per lingua (wordGlueData.js +
  wordGlueDict_<lang>.js)
- `node tools/genWordGlueNgrams.mjs it en fr de es pt` — modelli bigramma
  (wordGlueNgram_<lang>.js + wordGlueNgramLoaders.js)

---

## Architettura del progetto

```
src/
├── config/
│   ├── device.js       ← Profilo dispositivo (desktop/mobile: memoria, GPU, batch)
│   └── pipeline.js      ← Soglie, flag e costanti della pipeline
├── app/
│   ├── state.js          ← Stato globale (file, cropData, pageData)
│   └── createApp.js      ← Orchestrazione della pipeline ML
├── presentation/
│   ├── dom.js            ← Riferimenti DOM e utilità UI
│   ├── resultRenderer.js ← Visualizzazione risultati (tab, bounding box, crops)
│   ├── markdownExporter.js ← Generazione ed export Markdown
│   ├── bboxExporter.js   ← Export coordinate bounding box
│   └── uploadController.js ← Gestione upload file
├── services/
│   ├── pdfService.js     ← Renderizzazione PDF con PDF.js
│   ├── yoloService.js    ← Caricamento e inferenza modello YOLO
│   └── ocrService.js     ← Integrazione PaddleOCR.js
├── domain/
│   ├── yolo.js           ← Preprocessing e decodifica output YOLO
│   ├── geometry.js       ← Utilità geometriche (crop, intersect, area)
│   ├── layout/
│   │   ├── clusterHighlights.js ← Regioni gap-tree, assegnazione box→riga
│   │   │                          (max area contenuta deskewed, parità → centro
│   │   │                          più vicino) e ordine finale di lettura;
│   │   │                          qui vive la funzione unica assignFragsToRows
│   │   ├── columns.js           ← Rilevazione colonne
│   │   ├── gapTree.js           ← Divisione in paragrafi
│   │   ├── readingOrder.js      ← Ordine di lettura
│   │   └── ...
│   └── ocr/
│       ├── cropPreparation.js   ← Preparazione crop per OCR
│       └── textStitching.js     ← Ricostruzione testo
└── main.js               ← Entry point
```

### `config/pipeline.js`

Contiene tutte le costanti configurabili della pipeline:

| Costante | Default | Descrizione |
|---|---|---|
| `DPI` | `300` | Risoluzione renderizzazione PDF (identica su desktop e mobile) |
| `MAX_DIM` | `2000` | Dimensione massima lato canvas (identica su desktop e mobile) |
| `MODEL_SIZE` | `1024` | Lato di inferenza YOLO (letterbox) — shape fissa del modello ONNX (identico su desktop e mobile) |
| `CONF_THRES` | `0.30` | Soglia confidenza YOLO |
| `MODEL_FILE` | `'HT_detector_v7.9.onnx'` | Modello YOLO evidenziature |
| `DEBUG` | `false` | Abilita modalità debug (tramite `VITE_DEBUG`) |
| `SHOW_OVERLAY` | `false` | Sovrapposizioni debug sul canvas |
| `PADDLEOCR_LANG` | `'en'` | Lingua OCR |
| `COLUMN_LAYOUT` | `true` | Rilevazione layout a colonne |
| `FILTER_DET_BEFORE_GAPTREE` | `true` | Tiene le detection solo se contengono il centro di un box YOLO (piano deskewed) |
| `OCR_BATCH_SIZE` | `32` | Batch OCR (det+recognition) |
| `MAX_OCR_WIDTH` | `1024` | Larghezza max per il resize dei crop OCR |
| `MIN_OCR_HEIGHT` | `64` | Altezza minima per l'upscale dei crop OCR |
| `SPLIT_VERTICAL_GAP_RATIO` | `3` | × lineHeight: gap verticale che spezza una regione gap-tree |
| `ASSIGN_MIN_OVERLAP_RATIO` | `0.70` | Overlap minimo per aggregare box in una banda |
| `UNCOVERED_MIN_SCORE` | `0.45` | Score minimo per i box fuori da ogni regione |
| `...` | ... | Altre soglie e parametri |

### `app/createApp.js`

Orchestra l'intera pipeline:
1. Carica i modelli AI in parallelo (YOLO + PaddleOCR)
2. Processa ogni pagina: render → YOLO → detection → gap-tree/refine → crop
   (in produzione: `lite=true` — niente displayCanvas, pageData, detRects;
   output piatto dei box a fine pagina, struttura detection al GC)
3. Lancia OCR batch su tutti i frammenti
4. Mostra il risultato finale

### `presentation/`

Gestisce l'interfaccia utente:

- **`dom.js`** — riferimenti a tutti gli elementi DOM, funzioni di utilità (tema scuro, hamburger menu, progress bar)
- **`resultRenderer.js`** — rendering di bounding box, crops e frammenti YOLO, gestione tab
- **`markdownExporter.js`** — costruzione del Markdown con raggruppamento per pagina/blocco/riga
- **`bboxExporter.js`** — export delle coordinate in formato testo
- **`uploadController.js`** — drag & drop e selezione file PDF

### `domain/`

Contiene la logica di dominio pura (senza effetti collaterali):

- **`yolo.js`** — preprocessing letterbox e decodifica output ONNX
- **`geometry.js`** — funzioni geometriche (intersezione, area, crop)
- **`layout/`** — algoritmi di layout: clustering GapTree, rilevazione colonne, gutter,
  assegnazione esclusiva box→riga (`assignFragsToRows`: max area contenuta nel piano
  deskewed della riga; parità entro il 5% dell'area del box → centro più vicino;
  detection fuse = riga unica; orfani = righe singole) e ordine di lettura. La stessa
  identica funzione alimenta pipeline e tab debug (zero logica divergente).
- **`ocr/`** — preparazione crop e stitching dei testi OCR

### `services/`

Incapsulano le dipendenze esterne:

- **`pdfService.js`** — PDF.js con caching pagine
- **`yoloService.js`** — ONNX Runtime Web per inferenza YOLO
- **`ocrService.js`** — PaddleOCR.js SDK con supporto batch

---

## Modalità debug

La modalità debug è controllata dalla variabile d'ambiente `VITE_DEBUG` ed è accessibile tramite il secondo argomento di `start.sh`:

```bash
./start.sh dev debug
```

Internamente, il flag viene letto in `src/config/pipeline.js`:

```js
export const DEBUG = import.meta.env.VITE_DEBUG === 'true';
export const SHOW_OVERLAY = DEBUG;
```

### Elementi UI in modalità debug

| Elemento | Normale | Debug |
|---|---|---|
| **Tab Markdown** | ✅ Visibile (default) | ✅ Visibile |
| **Tab Bounding Box** | ❌ Nascosto | ✅ Visibile |
| **Tab Highlights** | ❌ Nascosto | ✅ Visibile |
| **Tab YOLO Fragments** | ❌ Nascosto | ✅ Visibile |
| **Tab YOLO Rows** | ❌ Nascosto | ✅ Visibile |
| **Tab All Det Rows** | ❌ Nascosto | ✅ Visibile |
| **Pulsante 📋 Copia** | ✅ Visibile | ✅ Visibile |
| **Pulsante ⬇ Scarica .md** | ✅ Visibile | ✅ Visibile |
| **Pulsante 📦 BBox .txt** | ❌ Nascosto | ✅ Visibile |
| **Overlay debug (canvas)** | ❌ Nascosto | ✅ Visibile |

Inoltre, la console del browser mostra un avviso distintivo quando la modalità debug è attiva.

---

## Personalizzazione

Puoi modificare il comportamento della pipeline agendo su `src/config/pipeline.js`:

```js
export const CONF_THRES = 0.30;        // Soglia di confidenza YOLO (0-1)
export const PADDLEOCR_LANG = 'it';    // Lingua per OCR
export const COLUMN_LAYOUT = true;      // Layout a colonne
export const MERGE_VERTICAL_TOUCHING = true;  // Unisce box verticali adiacenti
```

---

## Tecnologie utilizzate

| Tecnologia | Versione | Ruolo |
|---|---|---|
| [Vite](https://vitejs.dev/) | 6.x | Bundler e dev server |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 4.5 (npm, self-hosted) | Parsing e rendering PDF (su CVE-2024-4367; niente CDN) |
| [PaddleOCR.js](https://www.npmjs.com/package/@paddleocr/paddleocr-js) | 0.4 | OCR lato browser (PP-OCRv6) |
| [ONNX Runtime Web](https://onnxruntime.ai/) | 1.22 | Inferenza modello YOLO custom |
| Vanilla JS | ES2022 | Logica applicativa |

---

## Licenza

Proprietaria — tutti i diritti riservati.
