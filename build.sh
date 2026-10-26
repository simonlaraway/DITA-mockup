#!/usr/bin/env bash
# Mock DITA -> HTML5 publishing pipeline.
# Usage: ./build.sh            build every deliverable in project.xml
#        ./build.sh user       build one deliverable (user | admin)
set -euo pipefail

DITA_OT_VERSION="4.4.1"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DITA_HOME="$ROOT/tools/dita-ot-$DITA_OT_VERSION"
DITA="$DITA_HOME/bin/dita"

# Stage 0: make sure the toolkit is available.
if [[ ! -x "$DITA" ]]; then
  echo "==> Downloading DITA-OT $DITA_OT_VERSION"
  zip="$ROOT/tools/dita-ot-$DITA_OT_VERSION.zip"
  curl -fL -o "$zip" \
    "https://github.com/dita-ot/dita-ot/releases/download/$DITA_OT_VERSION/dita-ot-$DITA_OT_VERSION.zip"
  unzip -q "$zip" -d "$ROOT/tools"
  rm "$zip"
  chmod +x "$DITA"
fi

# Deliverable <output href>s in project.xml resolve against --output.
args=(--project="$ROOT/project.xml" --output="$ROOT/out")
if [[ $# -gt 0 ]]; then
  args+=(--deliverable="$1")
fi

echo "==> Publishing (${1:-all deliverables})"
cd "$ROOT"
mkdir -p out
"$DITA" "${args[@]}" 2>&1 | tee out/build.log

# DITA-OT can exit 0 even when it reports errors, so check the log too.
# Message IDs ending in E (error) or F (fatal), e.g. [DOTJ088E].
if grep -qE '\[DOT[A-Z]+[0-9]+[EF]\]' out/build.log; then
  echo "==> FAILED: errors in out/build.log" >&2
  exit 1
fi
# Landing page linking the deliverables (served at the site root on GitHub Pages).
cp "$ROOT/theme/index.html" "$ROOT/out/index.html"
echo "==> Done. Output in $ROOT/out/"
