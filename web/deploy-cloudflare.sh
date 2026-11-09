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

# Create the project through the API: recent wrangler releases hand
# `pages project create` over to Workers, which needs other permissions.
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects"
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
if ! curl -fsS -H "$AUTH" "$API/$PROJECT" > /dev/null 2>&1; then
    curl -fsS -X POST -H "$AUTH" -H "Content-Type: application/json" "$API" \
        -d "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" > /dev/null
    echo "Created Pages project $PROJECT"
fi
npx --yes wrangler@4 pages deploy "$SITE" --project-name "$PROJECT" --branch main --commit-dirty=true
