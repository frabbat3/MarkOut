<p align="center"><img src="src/web/logo.svg" width="96"></p>
<h1 align="center">MarkOut</h1>
<p align="center"><strong>The privacy-first PDF highlight extractor.</strong><br>
Turn highlighted PDFs into clean Markdown — 100% in your browser.<br>
Live at <a href="https://frabbat3.github.io/MarkOut/"><strong>frabbat3.github.io/MarkOut</strong></a>.</p>

<p align="center">
  <a href="https://frabbat3.github.io/MarkOut/">
    <img src="https://img.shields.io/badge/🚀_Try_MarkOut_online-no_download_needed-2ea44f?style=for-the-badge&logo=github&logoColor=white" alt="Try MarkOut online — no download needed">
  </a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/frabbat3/MarkOut/actions/workflows/deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/frabbat3/MarkOut/deploy.yml?label=deploy&logo=github" alt="Deploy status"></a>
  <img alt="GitHub Stars" src="https://img.shields.io/github/stars/frabbat3/MarkOut?style=social">
</p>

---

**MarkOut** extracts the highlighted text from any PDF and exports it as
Markdown. Point it at a study document, a research paper or a scanned
textbook: it renders every page, detects the highlighted areas, reconstructs
the reading order and runs OCR — entirely **client-side**. No uploads, no
server, no accounts: your documents never leave your device.

The app is live at **[frabbat3.github.io/MarkOut](https://frabbat3.github.io/MarkOut/)** —
use it right now, no download or installation required.

> ⚠️ **Know your limits.** MarkOut is not a perfect digitizer. The detection
> model struggles with very complex layouts (dense multi-column pages,
> tables, unusual shapes), it may miss some highlighted areas, and the OCR
> is not always error-free. That said, the extracted Markdown is an
> excellent starting point: pasted into ChatGPT, Claude or any other LLM,
> it gives the model the exact text you care about, in the right order.

## Contents

- [How it works](#how-it-works)
- [What the output looks like](#what-the-output-looks-like)
- [Features](#features)
- [Codebase map](#codebase-map)
- [Technologies & credits](#technologies--credits)
- [Getting started](#getting-started)
- [License](#license)
- [Contributing](#contributing)

## How it works

```
PDF → render (300 DPI) → YOLO26 highlight detection → PP-OCRv6 layout
    → reading order (gap-tree + columns) → OCR per fragment → Markdown
```

1. **Render** — every page is rendered to a canvas by PDF.js at 300 DPI
   (max 2000 px).
2. **Detect highlights** — a custom YOLO26 model (`src/web/HT_detector_v7.9.onnx`,
   ONNX Runtime Web, letterbox 1024) finds the highlighted areas.
3. **Reconstruct layout** — the PP-OCRv6 detection model finds the text
   lines; a gap-tree layout algorithm groups them into regions
   (paragraphs/columns) and produces a reading order; every highlight box
   is assigned to the row that contains it.
4. **Recognize text** — PaddleOCR.js (PP-OCRv6 recognition, WebGPU on
   desktop, WASM fallback) reads each fragment from a deskewed crop.
5. **Export Markdown** — fragments are merged in reading order, split lines
   are re-joined (geometric linking + word-level healing) and the result is
   copied or downloaded as `.md`.

Every PDF — digital or scanned, with or without annotation metadata — goes
through the same neural pipeline, so behavior is consistent.

## What the output looks like

Each highlighted section is exported as a **single text block**: all the
highlighted fragments of the section are concatenated in reading order
(no per-line IDs — the text comes out ready to read, not as a table of
rows). Page and section headers keep the structure visible.

```markdown
---
title: "Highlights — example.pdf"
source: "example.pdf"
date: "2026-02-21"
pages: 12
highlights: 34
---

# Highlights

Document: example.pdf · 12 pages · 34 highlights.

---

## Page 3

### Section 2
All the highlighted text of this section, merged together in reading
order with split words and hyphens repaired.

---

## Extraction notes

- No warnings: every line was extracted with OCR.
```

Lines the OCR could not read are flagged and listed in the *Extraction
notes* section instead of being silently dropped.

## Features

| | |
| :--- | :--- |
| **Any PDF in** | Digital, scanned, screenshots, any highlight color — no annotation metadata needed |
| **Reading order** | Gap-tree layout + column detection: two-column papers come out in the right order |
| **OCR in the browser** | PP-OCRv6 recognition, WebGPU (desktop) / WASM (mobile), self-hosted models |
| **Ready-to-use text** | Sections exported as single merged blocks, YAML front-matter, page/section headers |
| **Text healing** | Split-word reconstruction, hyphen re-attach, glued-word split (dictionaries for ~30 languages + n-gram models) |
| **Quality flags** | Unreadable lines are flagged and listed in an *Extraction notes* section |
| **Multi-language UI** | English, Deutsch, Español, Français, Italiano, Português |
| **Debug report** | One-click text report of the whole pipeline (YOLO boxes, detections, regions, OCR status) |
| **Privacy** | Everything runs in the browser tab — nothing is uploaded anywhere |

## Codebase map

```
src/web/                          — the web app (Vite, vanilla JS)
├── index.html, about.html, …     — site pages + de/ es/ fr/ it/ pt/ copies
├── HT_detector_v7.9.onnx         — custom YOLO26 highlight detector
├── vendor/                       — PDF.js worker
├── public/models/                — self-hosted PP-OCRv6 ONNX models
├── public/locales/               — UI strings (6 languages)
└── src/
    ├── app/createApp.js          — pipeline: YOLO → layout → OCR → Markdown
    ├── config/                   — pipeline tunables + device profile
    ├── services/                 — yoloService, pdfService, ocrService
    ├── domain/                   — layout (gapTree, columns, clusterHighlights),
    │                               OCR crops, text healing (wordGlue,
    │                               highlightLinking), geometry
    └── presentation/             — markdownExporter, resultRenderer, debugReport

src/editor/                       — local tool to review/edit highlight boxes
src/train/                        — YOLO training notebooks
.github/workflows/deploy.yml      — GitHub Pages auto-deploy
```

## Technologies & credits

MarkOut builds on excellent open-source projects:

| Technology | Used for | Repository |
| :--- | :--- | :--- |
| **GapTree** layout algorithm | Regions & reading order | [hiroi-sora/GapTree_Sort_Algorithm](https://github.com/hiroi-sora/GapTree_Sort_Algorithm) |
| **Ultralytics YOLO** (YOLO26) | Highlight detection model | [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) |
| **PaddleOCR / PP-OCRv6** | Text-line detection + recognition | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) |
| **PaddleOCR.js** | OCR runtime in the browser | [PaddlePaddle/PaddleOCR-JS](https://github.com/PaddlePaddle/PaddleOCR-JS) |
| **PDF.js** | PDF rendering | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) |
| **ONNX Runtime Web** | Model inference (WebGPU / WASM) | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| **Vite** | Build & dev server | [vitejs/vite](https://github.com/vitejs/vite) |

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org/) ≥ 20 and npm.

```bash
# Clone the repository
git clone https://github.com/frabbat3/MarkOut.git
cd MarkOut/src/web

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open http://localhost:8080/ and drop a highlighted PDF.

**Debug build** — extra inspection tabs (YOLO boxes, detection rows,
regions) and a one-click *Debug report* of the whole pipeline:

```bash
VITE_DEBUG=true npm run dev -- --port 8080 --host
```

**Build & host** — the app is 100% static: `npm run build` produces
`src/web/dist/`, which any static host can serve. Pushes to `main` are
deployed automatically to GitHub Pages (models are self-hosted, no external
CDN). See [STATIC-HOSTING.md](STATIC-HOSTING.md) for details.

## License

- **MarkOut** is licensed under the [GNU Affero General Public License v3.0](LICENSE).
- **The highlight detector** (`HT_detector_v7.9.onnx`) is derived from
  Ultralytics YOLO26, which is **AGPL-3.0** for open-source use and
  **requires a commercial license from Ultralytics** for commercial
  deployment. If you plan to sell or embed MarkOut in a commercial product,
  check [Ultralytics licensing](https://www.ultralytics.com/license) first.
- Third-party components keep their own licenses: PaddleOCR/PP-OCRv6
  (Apache-2.0), PDF.js (Apache-2.0), ONNX Runtime Web (MIT), Vite (MIT).

## Contributing

Contributions are welcome — bug reports, feature requests, translations and
pull requests. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development
flow, and please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Found a
security issue? See [SECURITY.md](SECURITY.md).

---

<sub>**Keywords** — PDF highlighter extractor · export highlighted text from PDF · highlighted text to Markdown · PDF highlighter OCR · browser-based PDF OCR · reading order · study notes extractor · privacy-first PDF tool · local PDF processing · LLM input generator · estrarre testo evidenziato da PDF · evidenziatore PDF · estrazione evidenziature · extraire le texte surligné d'un PDF · surlignage PDF · extraer texto resaltado de PDF · subrayado PDF · extrair texto destacado de PDF · marca-texto PDF · Text aus PDF extrahieren · markierter Text PDF · PDF-Textmarker</sub>
