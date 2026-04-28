#!/usr/bin/env bash
# crop_test.sh — Run the regression image set through one or more image processing
# configs and save the results for visual comparison.
#
# Usage:
#   ./scripts/crop_test.sh [output_dir]
#
# Output: <output_dir>/<image_id>/<config_name>.jpg
# Default output dir: /tmp/crop_test_results

set -euo pipefail

MANAGER="http://homeassistant.local:8099"
OUT_DIR="${1:-/tmp/crop_test_results}"

# ---------------------------------------------------------------------------
# Test images — Met Museum IDs (from image_processing_debug_notes.md)
# Parallel arrays: IMAGE_IDS and IMAGE_DESCS (same order)
# ---------------------------------------------------------------------------
IMAGE_IDS=(
  "435765"
  "436103"
  "437878"
  "437936"
  "437030"
  "435837"
  "437173"
  "436838"
  "435896"
  "442488"
  "437248"
)
IMAGE_DESCS=(
  "thick ornate gilt frame"
  "thin/barely-visible border"
  "thin black + narrow gold frame"
  "dark stained wood frame"
  "arch painting no frame DARK BG"
  "dark bg no frame false-positive risk"
  "thin frame warm edge"
  "moderate frame warm edge"
  "multi-layer frame undercrop risk"
  "no frame simple bg"
  "engaged gilt frame (Paolo di Giovanni Fei panel)"
)

# ---------------------------------------------------------------------------
# Processor configs to compare
# Each entry: "config_name|JSON body for PUT /api/web-sources/image-processing"
# ---------------------------------------------------------------------------
# pipeline:null and unifiedProcessor:null are required to force classic
# preProcessor+cropEngine mode — if either is set in the stored config they take precedence.
CONFIGS=(
  'sharp_attention|{"preProcessor":"none","cropEngine":"sharp","cropEngineOptions":{"strategy":"attention"},"pipeline":null,"unifiedProcessor":null}'
  'frame_boundary+sharp|{"preProcessor":"frame_boundary","cropEngine":"sharp","cropEngineOptions":{"strategy":"attention"},"pipeline":null,"unifiedProcessor":null}'
  'frame_boundary+face_aware|{"preProcessor":"frame_boundary","cropEngine":"face_aware","cropEngineOptions":{"scoreThreshold":0.35,"fallbackStrategy":"attention"},"pipeline":null,"unifiedProcessor":null}'
  'face_aware_only|{"preProcessor":"none","cropEngine":"face_aware","cropEngineOptions":{"scoreThreshold":0.35,"fallbackStrategy":"attention"},"pipeline":null,"unifiedProcessor":null}'
  'mean_profile+sharp|{"preProcessor":"mean_profile","cropEngine":"sharp","cropEngineOptions":{"strategy":"attention"},"pipeline":null,"unifiedProcessor":null}'
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
api() {
  local path="$1"; shift
  curl -s -f "$MANAGER/$path" "$@"
}

save_config() {
  api "api/web-sources/config" \
    | python3 -c "import json, sys; d=json.load(sys.stdin); print(json.dumps(d.get('webSources',{}).get('imageProcessing', {})))"
}

set_config() {
  api "api/web-sources/image-processing" \
    -X PUT -H "Content-Type: application/json" -d "$1" > /dev/null
}

met_url() { echo "https://www.metmuseum.org/art/collection/search/$1"; }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "Saving current imageProcessing config..."
ORIGINAL_CONFIG="$(save_config)"
echo "  current: $ORIGINAL_CONFIG"

restore() {
  echo ""
  echo "Restoring original imageProcessing config..."
  local restore_body
  if [ -z "$ORIGINAL_CONFIG" ] || [ "$ORIGINAL_CONFIG" = "{}" ]; then
    restore_body='{"preProcessor":"none","cropEngine":"sharp","cropEngineOptions":{"strategy":"attention"}}'
  else
    restore_body="$ORIGINAL_CONFIG"
  fi
  set_config "$restore_body" || true
  echo "Done."
}
trap restore EXIT

mkdir -p "$OUT_DIR"

total=${#IMAGE_IDS[@]}

for i in $(seq 0 $((total - 1))); do
  id="${IMAGE_IDS[$i]}"
  desc="${IMAGE_DESCS[$i]}"
  img_dir="$OUT_DIR/$id"
  mkdir -p "$img_dir"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[$((i+1))/$total] Met #$id — $desc"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Step 1: fetch raw image (once per source image)
  echo "  Fetching raw..."
  if ! api "api/web-sources/test-fetch" \
      -X POST -H "Content-Type: application/json" \
      -d "{\"specificImage\":\"$(met_url "$id")\",\"rawOnly\":true}" > /dev/null 2>&1; then
    echo "  ERROR: fetch failed for $id, skipping"
    continue
  fi
  echo "  Raw cached."

  # Save raw for reference
  if curl -s -f "$MANAGER/api/web-sources/test-cache/raw-image" \
      -o "$img_dir/0_raw.jpg" 2>/dev/null; then
    echo "  Saved: 0_raw.jpg"
  fi

  # Step 2: run each processor config
  for config_entry in "${CONFIGS[@]}"; do
    config_name="${config_entry%%|*}"
    config_body="${config_entry#*|}"

    echo "  Processing: $config_name..."
    set_config "$config_body"

    if ! api "api/web-sources/test-reprocess" \
        -X POST -H "Content-Type: application/json" -d "{}" > /dev/null 2>&1; then
      echo "    ERROR: reprocess failed"
      continue
    fi

    out_file="$img_dir/${config_name}.jpg"
    if curl -s -f "$MANAGER/api/web-sources/test-cache/image" \
        -o "$out_file" 2>/dev/null; then
      size=$(wc -c < "$out_file" | tr -d ' ')
      echo "    Saved: ${config_name}.jpg (${size} bytes)"
    else
      echo "    ERROR: could not download result image"
    fi

    # Save preprocessed intermediate if available
    pre_file="$img_dir/${config_name}_pre.jpg"
    if curl -s -f "$MANAGER/api/web-sources/test-cache/preprocessed-image" \
        -o "$pre_file" 2>/dev/null; then
      echo "    Saved: ${config_name}_pre.jpg (pre-crop intermediate)"
    else
      rm -f "$pre_file"
    fi
  done
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Done. Results in: $OUT_DIR"
echo ""
for i in $(seq 0 $((total - 1))); do
  echo "  $OUT_DIR/${IMAGE_IDS[$i]}/  — ${IMAGE_DESCS[$i]}"
done
