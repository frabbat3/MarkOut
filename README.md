# Holo Web - Landing Page

Una semplice landing page dimostrativa per GitHub Pages.

## Come pubblicare su GitHub Pages

1. **Crea un repository** su [GitHub](https://github.com/new)
2. **Carica i file** nel repository:
   ```bash
   git init
   git add .
   git commit -m "Primo commit - landing page"
   git branch -M main
   git remote add origin https://github.com/<TUO_UTENTE>/<NOME_REPO>.git
   git push -u origin main
   ```
3. **Attiva GitHub Pages**:
   - Vai su Settings > Pages del tuo repository
   - Seleziona `main` come branch e `/ (root)` come cartella
   - Il sito sarà disponibile su `https://<TUO_UTENTE>.github.io/<NOME_REPO>/`

## Struttura

```
├── index.html    # Pagina principale
├── style.css     # Stili
├── script.js     # Interattività (form)
└── README.md     # Questo file
```
