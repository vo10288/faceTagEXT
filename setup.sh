#!/usr/bin/env bash
# setup.sh – Scarica face-api.min.js e i modelli necessari
# Esegui dalla cartella dell'estensione: bash setup.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Face Tagger v2 – Setup ==="
echo ""

# 1. face-api.min.js
echo "[1/2] Scarico face-api.min.js …"
curl -sL -o face-api.min.js \
  "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js"
echo "      ✓ face-api.min.js"

# 2. Modelli
echo "[2/2] Scarico modelli (~6 MB) …"
mkdir -p models
BASE="https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"

for f in \
  ssd_mobilenetv1_model-shard1 \
  ssd_mobilenetv1_model-shard2 \
  ssd_mobilenetv1_model-weights_manifest.json \
  face_landmark_68_model-shard1 \
  face_landmark_68_model-weights_manifest.json \
  face_recognition_model-shard1 \
  face_recognition_model-shard2 \
  face_recognition_model-weights_manifest.json
do
  echo "      → $f"
  curl -sL -o "models/$f" "$BASE/$f"
done

echo ""
echo "=== Setup completato! ==="
echo ""
echo "Carica in Chrome:"
echo "  1. chrome://extensions"
echo "  2. Modalità sviluppatore ON"
echo "  3. Carica estensione non pacchettizzata → seleziona: $SCRIPT_DIR"
