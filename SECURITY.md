# Security Policy

## Architecture

MarkOut is a **fully client-side application**: PDF rendering, highlight
detection (YOLO), OCR and text healing all run in the user's browser tab.
There is **no backend, no upload, no analytics and no third-party CDN** —
the AI models are self-hosted in this repository and served from the same
origin.

This means the classic server-side attack surface (uploads, storage,
accounts) does not exist.

## Reporting a Vulnerability

If you discover a security issue (for example: a crafted PDF that crashes
the browser tab, prototype pollution in the parsing code, a dependency with
a known vulnerability), please **do not open a public issue**.

Report it privately:

1. Open a confidential security advisory on GitHub:
   **Security → Report a vulnerability**
   (https://github.com/frabbat3/MarkOut/security/advisories/new)
2. Include:
   - a minimal PDF/input that reproduces the issue (if possible),
   - the affected version (commit hash),
   - browser + OS used,
   - the debug report output if available (`VITE_DEBUG=true`, then the
     "Debug report" button).

We will acknowledge the report within a few days and work with you on a fix
and coordinated disclosure.

## Supported versions

| Version | Supported |
| :--- | :--- |
| `main` (latest) | ✅ |

## Notes on dependencies

- `pdfjs-dist` — PDF parsing; keep it updated (its releases include parsing
  hardening fixes).
- `onnxruntime-web` — model inference; update for WebGPU/WASM fixes.
- `@paddleocr/paddleocr-js` — OCR runtime; the models are pinned and
  self-hosted in `src/web/public/models/`.
- The YOLO detector (`src/web/HT_detector_v7.9.onnx`) is a custom ONNX model;
  treat any model update as a supply-chain change.

If you rely on MarkOut for sensitive documents: everything stays local, but
the browser tab (and any installed extensions) can always observe the page —
that is inherent to any client-side web tool.
