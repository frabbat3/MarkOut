# Mark2Text — Highlight Editor

Editor web **locale** (per uso personale, non esposto a internet) per rivedere e
modificare i bounding box degli highlight rilevati sui PDF in `batch_output/`.

Ogni sottocartella di `batch_output/` contiene un `.pdf` e un `results.json` con i
bounding box (in coordinate normalizzate 0–1 rispetto alla pagina).

## Avvio

```bash
cd editor
python3 server.py
```

Apri nel browser: **http://127.0.0.1:8765**

Il server si collega solo a `127.0.0.1` (non è raggiungibile dalla rete/internet).
Nessuna dipendenza esterna: usa la libreria standard di Python e una copia locale
di PDF.js (in `vendor/`) con i suoi asset (font standard, CMap, moduli WASM).

Opzioni:
```bash
python3 server.py --port 9000        # porta diversa
python3 server.py --normalize-all    # riscrive tutti i results.json nella
                                     # struttura canonica (vedi sotto) ed esce
```

## Struttura dei JSON

Tutti i `results.json` vengono mantenuti con la stessa struttura del `results.json`
di riferimento del progetto. Vengono rimossi i campi inutili
(`model`, `conf_threshold` a livello file; `class`, `class_id`, `confidence` per
ogni box). Per ogni box rimangono solo `bbox` e `bbox_yolo`, con `bbox_yolo`
ricalcolato da `bbox` (così restano sempre coerenti):

```json
{
  "source_pdf": "...",
  "total_pages": 24,
  "total_detections": 1041,
  "pages": {
    "0": [ { "bbox": {"x1":..,"y1":..,"x2":..,"y2":..},
             "bbox_yolo": {"cx":..,"cy":..,"w":..,"h":..} } ],
    "1": [ ... ]
  }
}
```

La normalizzazione avviene sia a caricamento sia a ogni salvataggio; può essere
applicata a tutti i file in un colpo solo con `--normalize-all`.

## Controlli

| Azione | Tasto / Mouse |
|---|---|
| Cambia PDF (cartella) | **Frecce su / giù** |
| Cambia pagina | **Frecce destra / sinistra** |
| Seleziona / sposta un box | **Click** sul box, poi trascina |
| Ridimensiona un box | Trascina una delle **8 maniglie** |
| Elimina il box selezionato | **Canc** (o **Backspace**) |
| Crea un nuovo box | **Click sul primo angolo**, poi **click sull'angolo opposto** (su un'area vuota della pagina) |
| Unisci box sovrapposti ≥ 40% | Pulsante **Merge** |
| Annulla ultima operazione | **Ctrl+Z** |
| Zoom | Pulsanti **+ / − / Fit / 1:1**, oppure **Ctrl + rotellina**, oppure tasti **+ / − / 0** |
| Annulla creazione / selezione | **Esc** |
| Salva subito | Pulsante **Save** |

I box sono disegnati con un bordo ciano luminoso e un alone scuro (e rosso, più
evidente, quello selezionato) per fare contrasto su qualsiasi sfondo della pagina.

### Merge
Unisce tutti i box della pagina corrente che si sovrappongono per almeno il 40%
(coefficiente = area intersezione / area del box più piccolo). L'unione è
**transitiva**: se A si sovrappone a B e B a C, anche A, B e C finiscono nello
stesso box risultato (il bounding box che li contiene tutti).

## Salvataggio

Le modifiche vengono **scritte sul `results.json`** quando si cambia pagina o PDF
(e anche alla chiusura della scheda, e col pulsante Save). Lo stato "non salvato"
è segnalato in basso a destra nella barra strumenti.

## File del progetto

- `server.py` — server HTTP locale + normalizzazione JSON
- `index.html`, `app.js`, `styles.css` — interfaccia dell'editor
- `vendor/pdf.mjs`, `vendor/pdf.worker.mjs` — PDF.js (locale, offline)
- `vendor/standard_fonts/` — font standard (Helvetica/Times/Courier…) per i PDF
  che non incorporano i font; senza questi il testo non verrebbe renderizzato
- `vendor/cmaps/` — CMap per font CID (es. CJK)
- `vendor/wasm/` — moduli WASM per decodifica JBIG2 / JPEG2000 / gestione colore;
  senza `wasmUrl` le immagini JBIG2 (comuni nei PDF scansionati) verrebbero
  silenziosamente saltate e apparirebbero vuote
- `batch_output/` — i PDF e i `results.json`
- `results.json` — file di riferimento per la struttura
