# Translating MarkOut

MarkOut ships in 6 languages: **English** (source language), **Deutsch**,
**Español**, **Français**, **Italiano** and **Português**.

Translations live in two places, both under `src/web/`:

1. **UI strings** — `public/locales/<lang>.json`, keyed by `data-i18n`
   attributes. Loaded at runtime by `src/src/i18n.js`.
2. **Static page copies** — each language has a full translated copy of the
   site pages: `de/`, `es/`, `fr/`, `it/`, `pt/` (mirror of the root
   `index.html`, `about.html`, `services.html`, `how-it-works.html`,
   `privacy.html`, `terms.html`, `contact.html`, `thank-you.html`,
   `404.html`).

## Adding a new language

1. **Copy the locale file**
   ```bash
   cd src/web
   cp public/locales/en.json public/locales/xx.json   # xx = ISO code
   ```
   Translate every value in `xx.json`. Keys must stay identical.

2. **Copy the static pages**
   ```bash
   mkdir xx
   cp about.html contact.html how-it-works.html index.html privacy.html \
      services.html terms.html thank-you.html 404.html xx/
   ```
   Translate the visible text in each page (keep `data-i18n` attributes
   unchanged — they point to the locale file; the inline text is the
   no-JS/fallback copy and must match the locale values).

3. **Register the language**
   - `src/web/src/i18n.js` — add the language to the list of available
     locales.
   - `src/web/src/pages.js` — add the language switcher entry.
   - `src/web/vite.config.js` — add the pages to the multi-page build input
     (the `PAGES` map, one entry per file, e.g. `'xx/index'`).

4. **Verify**
   ```bash
   npm run dev
   # check every page in the new language, then
   npm run build
   ```

## Updating an existing language

- UI strings: edit `public/locales/<lang>.json`.
- Static pages: edit the corresponding files in `<lang>/`.
- Keep the two in sync: the runtime uses the locale JSON, but search
  engines and no-JS visitors see the static copy.

## Conventions

- Keep the **English source** as the reference for meaning.
- Technical terms stay in English where natural (YOLO, OCR, Markdown,
  GPU/WebGPU, WASM).
- The pipeline behaves identically in every language — translations only
  touch presentation, never logic.
