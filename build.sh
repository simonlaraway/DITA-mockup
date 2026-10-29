#!/usr/bin/env bash
# Mock DITA -> HTML5 publishing pipeline.
# Usage: ./build.sh            build every deliverable in project.xml
#        ./build.sh user       build one deliverable (user | admin | api)
#        SOURCEMAP=1 ./build.sh  also tag HTML elements with their DITA source location
#                                (used by staging previews; never set for production)
set -euo pipefail

DITA_OT_VERSION="4.4.1"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DITA_HOME="$ROOT/tools/dita-ot-$DITA_OT_VERSION"
DITA="$DITA_HOME/bin/dita"

# Stage 0: make sure the toolkit is available.
if [[ ! -x "$DITA" ]]; then
  echo "==> Downloading DITA-OT $DITA_OT_VERSION"
  mkdir -p "$ROOT/tools"
  zip="$ROOT/tools/dita-ot-$DITA_OT_VERSION.zip"
  curl -fL -o "$zip" \
    "https://github.com/dita-ot/dita-ot/releases/download/$DITA_OT_VERSION/dita-ot-$DITA_OT_VERSION.zip"
  unzip -q "$zip" -d "$ROOT/tools"
  rm "$zip"
  chmod +x "$DITA"
fi

# Deliverable <output href>s in project.xml resolve against --output.
# Install/refresh local DITA-OT plugins (plugins/*) when their contents change.
for plugin in "$ROOT"/plugins/*/; do
  [[ -f "$plugin/plugin.xml" ]] || continue
  name="$(basename "$plugin")"
  hash="$(cd "$plugin" && find . -type f -print0 | sort -z | xargs -0 shasum | shasum | cut -d' ' -f1)"
  stamp="$DITA_HOME/plugins/$name/.installed-hash"
  if [[ "$(cat "$stamp" 2>/dev/null)" != "$hash" ]]; then
    echo "==> Installing plugin $name"
    rm -rf "$DITA_HOME/plugins/$name"
    cp -R "$plugin" "$DITA_HOME/plugins/$name"
    "$DITA" install   # re-integrate all plugins in $DITA_HOME/plugins
    echo "$hash" > "$stamp"
  fi
done

args=(--project="$ROOT/project.xml" --output="$ROOT/out")
if [[ "${SOURCEMAP:-}" == "1" ]]; then
  args+=(-Dcorgi.sourcemap=yes)
fi
if [[ $# -gt 0 ]]; then
  args+=(--deliverable="$1")
fi

echo "==> Publishing (${1:-all deliverables})"
cd "$ROOT"
# Start clean so pages for deleted topics don't linger.
rm -rf "out/${1:-}"
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
# Serve files as-is on GitHub Pages (no Jekyll processing).
touch "$ROOT/out/.nojekyll"
echo "==> Done. Output in $ROOT/out/"
