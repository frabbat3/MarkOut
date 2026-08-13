# Contributing to MarkOut

Thank you for considering contributing to **MarkOut**! This document
outlines how to contribute, report issues, and get involved.

---

## Ways to contribute

- **Reporting bugs** — open an issue using the
  [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). If possible,
  run the site with `VITE_DEBUG=true` and attach the **Debug report** text:
  it dumps the entire pipeline state (YOLO boxes, detections, regions, OCR
  status) and makes bugs much easier to reproduce.
- **Feature requests** — open an issue with the
  [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
- **Translations** — see [TRANSLATION.md](TRANSLATION.md).
- **Code contributions** — submit a pull request with the
  [PR template](.github/pull_request_template.md).
- **Documentation** — improve the README, the codebase map or the guides.
- **Testing** — try the app on your own PDFs and report anything odd.

## Development setup

```bash
# Clone the repository
git clone https://github.com/frabbat3/MarkOut.git
cd MarkOut/src/web

# Install dependencies
npm install

# Start the dev server
npm run dev

# Debug build (extra UI tabs + debug report)
VITE_DEBUG=true npm run dev -- --port 8080 --host
```

Requirements: Node.js ≥ 20, npm. All AI models are self-hosted in the repo
(`src/web/HT_detector_v7.9.onnx`, `src/web/public/models/`) — no external
downloads are needed.

## Project conventions

- **No frameworks**: the app is vanilla JS (ES2022 modules). Keep it that way.
- **Modules live in `src/web/src/`** — see the codebase map in the
  [README](README.md#codebase-map):
  - `app/` — orchestration (`createApp.js` is the pipeline)
  - `config/` — tunables (`pipeline.js`) and device profile (`device.js`)
  - `services/` — YOLO, PDF, OCR services
  - `domain/` — pure logic: layout, OCR crops, text healing, linking
  - `presentation/` — UI, Markdown export, debug report
- **The same algorithms drive the pipeline and the debug views** — no
  hidden logic. If you change layout/assignment code, the debug report must
  keep working (it uses the same functions).
- **Determinism**: the pipeline must produce the same output on the same
  input, desktop and mobile.
- Comments are mixed Italian/English — pick one and be consistent within
  the change.

## Pull request checklist

- [ ] Linked issue (`Fixes #123`) or clear description of the change
- [ ] Manual test with `VITE_DEBUG=true npm run dev`
- [ ] Debug report still works
- [ ] No new dependencies without discussion
- [ ] README / codebase map updated if files or flow changed

## Code of Conduct & Security

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security
issue? See [SECURITY.md](SECURITY.md) — please do **not** open a public
issue.
