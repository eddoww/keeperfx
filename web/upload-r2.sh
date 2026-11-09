#!/usr/bin/env bash
# Upload the game data (build-web/site/gamedata, made by web/package-data.py)
# to the R2 bucket the page can download it from (wrangler.jsonc DATA_URL).
#
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... web/upload-r2.sh [site-dir] [bucket]
# The token needs "Workers R2 Storage: Edit". Objects go to gamedata/<path>,
# the same paths as in the site, so the data URL is <bucket domain>/gamedata/.
# The manifest is not uploaded: it is deployed with the page, which keeps the
# page and the file list it expects in step. Files are requested as
# <path>?v=<hash> and cached for good; re-uploading changed files is enough.
# Dungeon Keeper's own files are never in gamedata/ (web/package-data.py).
set -euo pipefail

SITE="${1:-$(dirname "$0")/../build-web/site}"
BUCKET="${2:-keeperfx-data}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
DATA="$(cd "$SITE/gamedata" && pwd)"
[ -f "$DATA/manifest.json" ] || { echo "No game data in $SITE/gamedata" >&2; exit 1; }

LIST="$(mktemp --suffix=.json)"
trap 'rm -f "$LIST"' EXIT
# Every file except the manifest, as [{"key": ..., "file": ...}].
python3 - "$DATA" "$LIST" <<'PY'
import json, os, sys
data, out = sys.argv[1], sys.argv[2]
items = []
for dirpath, _, files in os.walk(data):
    for name in files:
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, data).replace(os.sep, "/")
        if rel != "manifest.json":
            items.append({"key": f"gamedata/{rel}", "file": path})
json.dump(items, open(out, "w"))
print(f"{len(items)} files to upload", file=sys.stderr)
PY

cd "$(dirname "$0")/server"
npx wrangler r2 bulk put "$BUCKET" --remote --filename "$LIST" --concurrency 8 \
    --cache-control "public, max-age=31536000, immutable"
