#!/usr/bin/env bash
# Validate manifest. Pack addon into a zip file.
set -euo pipefail

usage() { echo "Usage: $0 [-n|--dry-run] [-h|--help]"; }

DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
		-n|--dry-run) DRY_RUN=1 ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; exit 2 ;;
	esac
done

for tool in python3 zip; do
	command -v "$tool" >/dev/null || { echo "Required tool not found: $tool" >&2; exit 1; }
done

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="$(basename -- "$PROJECT_DIR")"
SRC_DIR="$PROJECT_DIR/src"

# validate manifest JSON with the basic required keys
MANIFEST="$SRC_DIR/manifest.json"
python3 - "$MANIFEST" <<'PY' || exit 1
import json, sys

path = sys.argv[1]
try:
    with open(path) as f:
        manifest = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"Manifest validation error:\n{path}:\n{e}")

missing = [k for k in ("manifest_version", "name", "version") if k not in manifest]
if missing:
    sys.exit(f"Manifest validation error:\n{path}: missing {', '.join(missing)}")
PY

cd "$SRC_DIR"

DIST_DIR="$PROJECT_DIR/dist"
OUT="$DIST_DIR/$PROJECT_NAME.zip"
EXCLUDES=('*.DS_Store' '*~')

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo "Dry run: would write $OUT"
	zip -r -sf "$OUT" . -x "${EXCLUDES[@]}"
	exit 0
fi

# pack zip;
mkdir -p "$DIST_DIR"
zip -r -FS "$OUT" . -x "${EXCLUDES[@]}"
