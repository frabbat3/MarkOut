# Static Hosting

MarkOut is 100% static: `npm run build` produces a plain folder of HTML/JS
assets with **no server-side component**. Any static host works — GitHub
Pages, Netlify, Vercel, Cloudflare Pages, nginx, `http-server`, …

The AI models (YOLO detector + PP-OCRv6) are **self-hosted**: they live in
the repository (`src/web/HT_detector_v7.9.onnx`, `src/web/public/models/`)
and are served from the same origin as the app. No external CDNs, no runtime
downloads — the app also works offline once cached.

## GitHub Pages (automatic)

Pushes to `main` are deployed automatically by
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

```yaml
on:
  push:
    branches: [main]
    paths: ['src/web/**']
```

The workflow runs `npm ci && npm run build` in `src/web/` and publishes
`src/web/dist/` to GitHub Pages.

**Setup once:** in the repository settings → *Pages*, set the source to
**GitHub Actions** (not "branch"). A custom domain is configured in the same
page (add the domain, then the workflow's `cname` field or a `public/CNAME`
file).

## Manual build

```bash
cd src/web
npm install
npm run build          # output in dist/
```

Serve the result with any static server, e.g.:

```bash
npx http-server dist -p 8080     # or: npx serve dist
```

The app will be at `http://localhost:8080/`.

## Debug build

The debug build adds the extra inspection tabs (YOLO boxes, detection rows,
regions) and the "Debug report" button:

```bash
cd src/web
VITE_DEBUG=true npm run build
```

## Important notes

- **Cross-origin isolation is not required.** Unlike tools that need
  `SharedArrayBuffer`, MarkOut runs fine on plain static hosting (WebGPU /
  WASM backends are feature-detected at runtime).
- **Serve the `_headers`-less stack as-is** — the app does not rely on
  custom response headers.
- **Model size:** the self-hosted OCR models are a few MB each
  (`src/web/public/models/`) — enable compression/`gzip`/`brotli` on your
  host for faster first load.
- **Cache busting:** Vite fingerprints the JS bundles; the models are
  fetched once and cached by the browser.
- **Language copies:** the multi-page build also emits the translated site
  pages (`de/`, `es/`, `fr/`, `it/`, `pt/`) — see
  [TRANSLATION.md](TRANSLATION.md).
