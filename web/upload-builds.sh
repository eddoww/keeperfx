#!/usr/bin/env bash
# Upload what `web/publish-build.py add` prepared (<layout>/plan.json) to the
# R2 bucket the site loads its engine builds and game data from.
#
# Usage: web/upload-builds.sh <layout> [bucket] [--local --persist-to DIR]
#   CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set unless --local.
#   The token needs "Workers R2 Storage: Edit" on the account.
#
# Order matters: new data files first, then the build's own files, then
# builds/index.json, which is what makes players see the build. If anything
# fails before the index is written the site keeps its previous builds. Only
# then are retired builds and their unused data deleted.
set -euo pipefail

LAYOUT="$(cd "$1" && pwd)"; shift
BUCKET="keeperfx-data"
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then BUCKET="$1"; shift; fi
WHERE=(--remote)
if [ $# -gt 0 ]; then WHERE=("$@"); fi
if [ "${WHERE[0]}" = "--remote" ]; then
    : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
    : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
fi
PLAN="$LAYOUT/plan.json"
[ -f "$PLAN" ] || { echo "No $PLAN: run web/publish-build.py add first" >&2; exit 1; }

cd "$(dirname "$0")/server"
WRANGLER=(npx wrangler)
IMMUTABLE="public, max-age=31536000, immutable"

LIST="$(mktemp --suffix=.json)"
trap 'rm -f "$LIST"' EXIT
python3 - "$LAYOUT" "$PLAN" "$LIST" <<'PY'
import json, os, sys
layout, plan, out = sys.argv[1:]
keys = json.load(open(plan))["data"]
json.dump([{"key": k, "file": os.path.join(layout, k)} for k in keys], open(out, "w"))
print(f"{len(keys)} data files to upload", file=sys.stderr)
PY
if [ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$LIST")" != 0 ]; then
    "${WRANGLER[@]}" r2 bulk put "$BUCKET" "${WHERE[@]}" --filename "$LIST" --concurrency 8 \
        --content-type application/octet-stream --cache-control "$IMMUTABLE"
fi

put() { # key content-type cache-control
    "${WRANGLER[@]}" r2 object put "$BUCKET/$1" "${WHERE[@]}" --file "$LAYOUT/$1" \
        --content-type "$2" --cache-control "$3" > /dev/null
    echo "uploaded $1"
}
for key in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["build"]))' "$PLAN"); do
    case "$key" in
        *.wasm) put "$key" application/wasm "$IMMUTABLE" ;;
        *.js) put "$key" "text/javascript; charset=utf-8" "$IMMUTABLE" ;;
        *) put "$key" "application/json" "$IMMUTABLE" ;;
    esac
done
put builds/index.json application/json "no-cache"

for key in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["delete"]))' "$PLAN"); do
    "${WRANGLER[@]}" r2 object delete "$BUCKET/$key" "${WHERE[@]}" > /dev/null && echo "deleted $key"
done
