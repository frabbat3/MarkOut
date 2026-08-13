#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Se node_modules non esiste, installa le dipendenze
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
  dev)
    echo "🚀 Avvio server di sviluppo MarkOut..."
    npm run dev -- --port 8080 --host
    ;;
  preview)
    echo "🚀 Avvio server di preview (produzione)..."
    npm run preview -- --port 8080 --host
    ;;
  build)
    echo "🏗️  Build di produzione..."
    npm run build
    echo "🚀 Avvio server di preview..."
    npm run preview -- --port 8080 --host
    ;;
  *)
    echo "❌ Modalità sconosciuta: $MODE"
    echo "Usa: start.sh [dev|preview|build] [debug|--debug]"
    exit 1
    ;;
esac
