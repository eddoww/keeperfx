#!/usr/bin/env bash
# Publish the browser build (build-web/site) to Cloudflare Pages.
#
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... web/deploy-cloudflare.sh [site-dir] [project]
# The token needs the "Cloudflare Pages: Edit" account permission. The project
# is created on first use. Attaching a custom domain is a one-off step in the
# Pages dashboard (or the API), see docs/web.md.
set -euo pipefail

SITE="${1:-$(dirname "$0")/../build-web/site}"
PROJECT="${2:-keeperfx}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

[ -f "$SITE/index.html" ] && [ -f "$SITE/gamedata/manifest.json" ] \
    || { echo "No complete site in $SITE (build keeperfx and run web/package-data.py)" >&2; exit 1; }
# Pages rejects files over 25 MiB; web/package-data.py splits them.
if big=$(find "$SITE" -type f -size +25M | head -1) && [ -n "$big" ]; then
    echo "File too big for Pages: $big" >&2; exit 1
fi

WRANGLER="npx --yes wrangler@4"
$WRANGLER pages project list 2>/dev/null | grep -qw "$PROJECT" \
    || $WRANGLER pages project create "$PROJECT" --production-branch main
$WRANGLER pages deploy "$SITE" --project-name "$PROJECT" --branch main --commit-dirty=true
