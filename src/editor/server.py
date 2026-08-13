#!/usr/bin/env python3
"""
Mark2Text Highlight Editor - local web server.

Personal, offline editor to review/edit highlight bounding boxes over PDF pages.
Binds to 127.0.0.1 only (never exposed to the network/internet).

Run:
    python3 server.py                # start editor on http://127.0.0.1:8765
    python3 server.py --normalize-all  # rewrite every results.json to the
                                       # canonical structure (like results.json)
    python3 server.py --port 9000
"""
import json
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))

# Carica il batch output directory: prima batch_output(3), poi batch_output
_CANDIDATES = ["batch_output(3)", "batch_output"]
BATCH = None
for _c in _CANDIDATES:
    _p = os.path.join(ROOT, _c)
    if os.path.isdir(_p):
        BATCH = _p
        break
if BATCH is None:
    BATCH = os.path.join(ROOT, "batch_output(3)")

# Directory sorgente con PDF non processati
SOURCE_PDF_DIR = os.path.join(ROOT, "pdf")

# ---- data helpers ---------------------------------------------------------

def list_folders():
    """Cartelle processate: con results.json e PDF (locale o in source/)."""
    names = []
    if not os.path.isdir(BATCH):
        return names
    for name in sorted(os.listdir(BATCH)):
        d = os.path.join(BATCH, name)
        if not os.path.isdir(d):
            continue
        has_json = os.path.exists(os.path.join(d, "results.json"))
        if not has_json:
            continue
        # Il PDF può essere locale o nella cartella sorgente
        has_pdf_local = any(f.lower().endswith(".pdf") for f in os.listdir(d))
        has_pdf_source = os.path.isfile(os.path.join(SOURCE_PDF_DIR, name + ".pdf"))
        if has_pdf_local or has_pdf_source:
            names.append(name)
    return names


def list_source_pdfs():
    """Lista i PDF dalla cartella sorgente (es. pdf/)."""
    if not os.path.isdir(SOURCE_PDF_DIR):
        return []
    pdfs = []
    for f in sorted(os.listdir(SOURCE_PDF_DIR)):
        if f.lower().endswith(".pdf"):
            pdfs.append(f)
    return pdfs


def source_pdf_path(filename):
    return os.path.join(SOURCE_PDF_DIR, filename)


def json_path(folder):
    return os.path.join(BATCH, folder, "results.json")


def pdf_path(folder):
    # Cerca PDF locale nella cartella batch
    d = os.path.join(BATCH, folder)
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.lower().endswith(".pdf"):
                return os.path.join(d, f)
    # Cerca PDF nella cartella sorgente
    src = os.path.join(SOURCE_PDF_DIR, folder + ".pdf")
    if os.path.isfile(src):
        return src
    # Cerca con qualsiasi estensione .pdf (nome che inizia col folder name)
    if os.path.isdir(SOURCE_PDF_DIR):
        for f in os.listdir(SOURCE_PDF_DIR):
            if f.lower().endswith(".pdf") and os.path.splitext(f)[0] == folder:
                return os.path.join(SOURCE_PDF_DIR, f)
    return None


def batch_folder_path(folder):
    return os.path.join(BATCH, folder)


def normalize(data):
    """
    Bring a results.json dict to the canonical structure used by the editor
    and identical (in fields) to the project's reference results.json:

        {
          "source_pdf": "...",
          "total_pages": N,
          "total_detections": M,
          "pages": {"0": [ {"bbox": {...}, "bbox_yolo": {...}}, ... ], ...}
        }

    Drops: model, conf_threshold (top level) and class, class_id, confidence
    (per box). bbox_yolo is always recomputed from bbox so the two stay
    consistent.
    """
    existing = data.get("pages", {}) or {}
    try:
        total_pages = int(data.get("total_pages", len(existing)))
    except (TypeError, ValueError):
        total_pages = len(existing)

    pages = {}
    for i in range(total_pages):
        boxes = existing.get(str(i), []) or []
        clean = []
        for b in boxes:
            bb = b.get("bbox")
            if not bb:
                continue
            try:
                x1 = float(bb["x1"]); y1 = float(bb["y1"])
                x2 = float(bb["x2"]); y2 = float(bb["y2"])
            except (KeyError, TypeError, ValueError):
                continue
            if x2 < x1: x1, x2 = x2, x1
            if y2 < y1: y1, y2 = y2, y1
            clean.append({
                "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "bbox_yolo": {
                    "cx": round((x1 + x2) / 2, 12),
                    "cy": round((y1 + y2) / 2, 12),
                    "w": round(x2 - x1, 12),
                    "h": round(y2 - y1, 12),
                },
            })
        pages[str(i)] = clean

    total = sum(len(v) for v in pages.values())
    return {
        "source_pdf": data.get("source_pdf", ""),
        "total_pages": total_pages,
        "total_detections": total,
        "pages": pages,
    }


def load_data(folder):
    with open(json_path(folder), "r", encoding="utf-8") as f:
        return normalize(json.load(f))


def save_data(folder, data):
    norm = normalize(data)
    os.makedirs(os.path.dirname(json_path(folder)), exist_ok=True)
    with open(json_path(folder), "w", encoding="utf-8") as f:
        json.dump(norm, f, indent=2, ensure_ascii=False)
    return norm


def normalize_all():
    folders = list_folders()
    print(f"Normalizing {len(folders)} folder(s)...")
    for name in folders:
        before = json.load(open(json_path(name), "r", encoding="utf-8"))
        before_keys = list(before.keys())
        box_keys = None
        for v in before.get("pages", {}).values():
            if v:
                box_keys = list(v[0].keys())
                break
        after = normalize(before)
        save_data(name, after)
        print(f"  - {name}: "
              f"top {before_keys} -> {list(after.keys())} | "
              f"box {box_keys} -> {list(after['pages']['0'][0].keys()) if after['pages']['0'] else '[]'}")
    print("Done.")


# ---- static file map ------------------------------------------------------

STATIC = {
    "/": os.path.join(ROOT, "index.html"),
    "/index.html": os.path.join(ROOT, "index.html"),
    "/app.js": os.path.join(ROOT, "app.js"),
    "/styles.css": os.path.join(ROOT, "styles.css"),
    "/vendor/pdf.mjs": os.path.join(ROOT, "vendor", "pdf.mjs"),
    "/vendor/pdf.worker.mjs": os.path.join(ROOT, "vendor", "pdf.worker.mjs"),
    "/HT_detector_v7.8.onnx": os.path.join(ROOT, "HT_detector_v7.8.onnx"),
    # static asset folders served for individual files (fonts/cmaps for PDF.js)
    "/vendor/standard_fonts/": os.path.join(ROOT, "vendor", "standard_fonts"),
    "/vendor/cmaps/": os.path.join(ROOT, "vendor", "cmaps"),
    "/vendor/wasm/": os.path.join(ROOT, "vendor", "wasm"),
}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".wasm": "application/wasm",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".onnx": "application/octet-stream",
}


def file_mime(path):
    ext = os.path.splitext(path)[1].lower()
    return MIME.get(ext, "application/octet-stream")


def send_file(handler, path, accept_ranges=True):
    """Serve a file with optional HTTP Range support (for PDF.js)."""
    size = os.path.getsize(path)
    ctype = file_mime(path)
    rng = handler.headers.get("Range") if accept_ranges else None
    start, end = 0, size - 1
    partial = False
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            partial = True
            s, e = m.group(1), m.group(2)
            start = int(s) if s else 0
            end = int(e) if e else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                handler.send_response(416)
                handler.send_header("Content-Range", f"bytes */{size}")
                handler.end_headers()
                return
    length = end - start + 1
    handler.send_response(206 if partial else 200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(length))
    if accept_ranges:
        handler.send_header("Accept-Ranges", "bytes")
    if partial:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if handler.command == "HEAD":
        return
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


def send_json(handler, obj, status=200):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


# ---- HTTP handler ---------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Mark2TextEditor/1.0"

    def log_message(self, *args):
        pass  # keep console quiet

    # routing
    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        path = parsed.path

        if path == "/api/data":
            folders = set(list_folders())
            folder = (qs.get("folder", [""])[0] or "")
            if folder not in folders:
                return send_json(self, {"error": "unknown folder"}, 400)
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception as e:
                return send_json(self, {"error": f"bad json: {e}"}, 400)
            norm = save_data(folder, data)
            return send_json(self, {"ok": True, "total_detections": norm["total_detections"]})

        if path == "/api/create-batch-output":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception as e:
                return send_json(self, {"error": f"bad json: {e}"}, 400)
            pdf_name = body.get("pdf_name", "")
            results = body.get("results", {})
            if not pdf_name:
                return send_json(self, {"error": "no pdf_name"}, 400)
            folder_name = os.path.splitext(pdf_name)[0]
            out_dir = os.path.join(BATCH, folder_name)
            os.makedirs(out_dir, exist_ok=True)
            # Copia il PDF originale nella cartella di output
            src_pdf = source_pdf_path(pdf_name)
            dst_pdf = os.path.join(out_dir, pdf_name)
            if os.path.isfile(src_pdf) and not os.path.isfile(dst_pdf):
                import shutil
                shutil.copy2(src_pdf, dst_pdf)
            # Salva results.json
            results["source_pdf"] = results.get("source_pdf", pdf_name)
            norm = save_data(folder_name, results)
            return send_json(self, {"ok": True, "folder": folder_name, "total_detections": norm["total_detections"]})

        return send_json(self, {"error": "not found"}, 404)

    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        path = parsed.path

        if path == "/api/folders":
            return send_json(self, {"folders": list_folders()})

        if path == "/api/data":
            folders = set(list_folders())
            folder = (qs.get("folder", [""])[0] or "")
            if folder not in folders:
                return send_json(self, {"error": "unknown folder"}, 400)
            try:
                return send_json(self, load_data(folder))
            except Exception as e:
                return send_json(self, {"error": str(e)}, 500)

        if path == "/api/pdf":
            folders = set(list_folders())
            folder = (qs.get("folder", [""])[0] or "")
            if folder not in folders:
                return send_json(self, {"error": "unknown folder"}, 400)
            p = pdf_path(folder)
            if not p or not os.path.exists(p):
                return send_json(self, {"error": "pdf not found"}, 404)
            return send_file(self, p, accept_ranges=True)

        # ---- API per elaborazione PDF lato client ----

        if path == "/api/list-source-pdfs":
            return send_json(self, {"pdfs": list_source_pdfs()})

        if path == "/api/check-batch-exists":
            pdf_name = qs.get("pdf", [""])[0] or ""
            if not pdf_name:
                return send_json(self, {"exists": False, "error": "no pdf name"}, 400)
            folder_name = os.path.splitext(pdf_name)[0]
            fp = os.path.join(BATCH, folder_name, "results.json")
            exists = os.path.isfile(fp)
            return send_json(self, {"exists": exists, "folder": folder_name})

        if path == "/api/source-pdf":
            pdf_name = qs.get("pdf", [""])[0] or ""
            if not pdf_name:
                return send_json(self, {"error": "no pdf name"}, 400)
            p = source_pdf_path(pdf_name)
            if not os.path.isfile(p):
                return send_json(self, {"error": "pdf not found"}, 404)
            return send_file(self, p, accept_ranges=True)

        # static asset folders served by prefix (PDF.js standard fonts & cmaps).
        # Skips the "/" root entry (also ends with "/") which is handled below.
        for prefix, base_dir in STATIC.items():
            if len(prefix) > 1 and prefix.endswith("/") and path.startswith(prefix):
                rel = path[len(prefix):].replace("\\", "/")
                if rel.startswith("/") or ".." in rel.split("/") or not rel:
                    return send_json(self, {"error": "bad path"}, 400)
                fp = os.path.join(base_dir, rel)
                if os.path.isfile(fp):
                    return send_file(self, fp, accept_ranges=False)
                return send_json(self, {"error": "static not found"}, 404)

        if path in STATIC:
            p = STATIC[path]
            if os.path.exists(p):
                return send_file(self, p, accept_ranges=False)
            return send_json(self, {"error": "static not found"}, 404)

        return send_json(self, {"error": "not found"}, 404)


def main():
    args = sys.argv[1:]
    if "--normalize-all" in args:
        normalize_all()
        return

    host = "127.0.0.1"
    port = 8765
    for i, a in enumerate(args):
        if a == "--host" and i + 1 < len(args):
            host = args[i + 1]
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])

    if not os.path.isdir(BATCH):
        os.makedirs(BATCH, exist_ok=True)
        print(f"NOTICE: created batch output directory at {BATCH}")

    source_pdfs = list_source_pdfs()
    if source_pdfs:
        print(f" Found {len(source_pdfs)} PDF(s) in source folder '{os.path.basename(SOURCE_PDF_DIR)}/'.")
        print(f" The editor will process them automatically on first access.")

    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}"
    print("=" * 60)
    print(" Mark2Text Highlight Editor")
    print("=" * 60)
    print(f" Batch output:  {BATCH}")
    if os.path.isdir(SOURCE_PDF_DIR):
        print(f" Raw PDF source: {SOURCE_PDF_DIR}")
    else:
        print(f" (no pdf/ folder found at {SOURCE_PDF_DIR})")
    batch_count = len(list_folders())
    print(f" Processed folders: {batch_count}")
    print(f" Raw PDFs ready: {len(source_pdfs)}")
    print(f" URL: {url}")
    print(" Bound to 127.0.0.1 (not exposed to the network).")
    print(" Press Ctrl+C to stop.")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
