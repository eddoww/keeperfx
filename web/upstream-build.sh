#!/usr/bin/env bash
# Build the browser port for an upstream KeeperFX build and publish it next to
# the builds the site already offers (docs/web.md, "Game versions").
#
#   1. find the upstream build: the newest alpha (or stable release) on
#      keeperfx.net, or the one given;
#   2. stop if the site already has it, built from this port (unless --force);
#   3. rebase the port's commits onto that upstream commit in a scratch
#      worktree: fails if they no longer apply;
#   4. compile it (version and build number as upstream's own build);
#   5. package the game data: the latest complete release with that build's
#      alpha patch laid over it, as desktop players have it;
#   6. add it to the builds layout (web/publish-build.py) and smoke test it in
#      a headless browser (web/smoke-test.mjs);
#   7. with --upload, upload it to R2 (web/upload-builds.sh). The index goes
#      last, so the site only sees the new build once everything is there.
# Any failure stops the script with a non-zero exit and leaves the site as it
# was. $WORK/result.json says what happened (for CI).
#
# Usage: web/upstream-build.sh [options]
#   --channel alpha|stable  which upstream builds to follow (default alpha)
#   --commit SHA            build this upstream commit instead of the newest
#   --port REF              the browser port to apply (default HEAD)
#   --upstream REF          upstream master in this clone (default origin/master)
#   --work DIR              scratch space (default /tmp/kfx-upstream)
#   --deps DIR              wasm dependencies (web/build-deps.sh output; built if missing)
#   --builds-url URL        the deployed builds/ (to compare with and add to)
#   --layout DIR            builds layout to add to (default $WORK/layout)
#   --dk DIR                a Dungeon Keeper folder: the smoke test then plays a level
#   --upload [BUCKET]       upload to R2 (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
#   --upload-local DIR      upload to wrangler's local R2 in DIR instead (testing)
#   --default CHANNEL|ID    make this the site's default (publish-build.py --default)
#   --force                 build even if the site already has this build
#   JOBS=4                  parallel compile jobs (always under nice)
#
# Exit codes: 0 done or nothing to do, 10 the port does not apply, 11 the
# build failed, 12 game data failed, 13 the smoke test failed, 14 the upload
# failed, 2 bad usage or upstream not reachable.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CHANNEL=alpha COMMIT="" PORT=HEAD UPSTREAM=origin/master WORK=/tmp/kfx-upstream DEPS="" BUILDS_URL="" LAYOUT=""
DK="" UPLOAD="" BUCKET=keeperfx-data FORCE="" DEFAULT="" WHERE=()
while [ $# -gt 0 ]; do
    case "$1" in
        --channel) CHANNEL="$2"; shift 2 ;;
        --commit) COMMIT="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --upstream) UPSTREAM="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --deps) DEPS="$2"; shift 2 ;;
        --builds-url) BUILDS_URL="$2"; shift 2 ;;
        --layout) LAYOUT="$2"; shift 2 ;;
        --dk) DK="$2"; shift 2 ;;
        --upload) UPLOAD=1; if [ $# -gt 1 ] && [[ "$2" != --* ]]; then BUCKET="$2"; shift; fi; shift ;;
        --upload-local) UPLOAD=1; WHERE=(--local --persist-to "$(cd "$2" && pwd)"); shift 2 ;;
        --default) DEFAULT="$2"; shift 2 ;;
        --force) FORCE=1; shift ;;
        *) echo "Unknown option $1" >&2; exit 2 ;;
    esac
done
JOBS="${JOBS:-4}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
LAYOUT="${LAYOUT:-$WORK/layout}"
DEPS="${DEPS:-$WORK/deps/prefix}"
RESULT="$WORK/result.json"
SRC="$WORK/src"
STAGE="$WORK/stage"

result() { # status message [extra json fields]
    local extra="${3:-}"
    [ -n "$extra" ] || extra='{}'
    python3 - "$RESULT" "$1" "$2" "$extra" <<'PY'
import json, sys
path, status, message, extra = sys.argv[1:]
json.dump({"status": status, "message": message, **json.loads(extra)}, open(path, "w"), indent=1)
PY
    echo "== $1: $2"
}
die() { result "$2" "$3" "${4:-}"; exit "$1"; }

# ---- 1. Which upstream build ----------------------------------------------------
cd "$REPO"
PORT_SHA="$(git rev-parse --verify "$PORT^{commit}")"
if [ -z "$COMMIT" ]; then
    INFO="$(python3 "$HERE/upstream.py" latest "$CHANNEL" --repo "$REPO")" || die 2 unreachable "keeperfx.net did not answer"
    COMMIT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["commit"] or "")' "$INFO")"
    [ -n "$COMMIT" ] || die 2 unknown-commit "Could not tell which commit the newest $CHANNEL build is"
    DATE="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["date"])' "$INFO")"
    NOTES="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["notes"])' "$INFO")"
else
    DATE="$(git log -1 --format=%cI "$COMMIT")"
    NOTES="https://github.com/dkfans/keeperfx/commits/$COMMIT"
fi
git cat-file -e "$COMMIT^{commit}" 2>/dev/null || die 2 unknown-commit "Commit $COMMIT is not in this clone: git fetch origin --tags"
COMMIT="$(git rev-parse "$COMMIT")"
NUMBER="$(git rev-list --count "$COMMIT")"
eval "$(git show "$COMMIT:version.mk" | grep -E '^VER_(MAJOR|MINOR|RELEASE)=[0-9]+$')"
VERSION="$VER_MAJOR.$VER_MINOR.$VER_RELEASE.$NUMBER"
if [ "$CHANNEL" = alpha ]; then SUFFIX=Alpha; else SUFFIX=""; fi
echo "== upstream $CHANNEL $VERSION ($COMMIT, $DATE), port $PORT_SHA"
INFO_JSON="{\"version\": \"$VERSION\", \"upstream\": \"$COMMIT\", \"port\": \"$PORT_SHA\", \"channel\": \"$CHANNEL\"}"

# ---- 2. Already published? --------------------------------------------------------
PREV_UPSTREAM=""
if [ -n "$BUILDS_URL" ]; then
    PUB="$(python3 "$HERE/upstream.py" published "$BUILDS_URL" "$CHANNEL" --commit "$COMMIT" --port "$PORT_SHA")" \
        || die 2 unreachable "Could not read $BUILDS_URL"
    PREV_UPSTREAM="$(python3 -c 'import json,sys; p=json.loads(sys.argv[1])["newest"]; print(p["upstream"] if p else "")' "$PUB")"
    HAS="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["has"])' "$PUB")"
    if [ -z "$FORCE" ] && [ "$HAS" = True ]; then
        result up-to-date "The site already offers $VERSION built from this port" "$INFO_JSON"
        exit 0
    fi
fi

# ---- 3. Apply the port ---------------------------------------------------------------
# Rebased in a worktree of its own, then checked out in $SRC, where only the
# files that differ from the last run change (so a rerun compiles little).
BASE="$(git merge-base "$PORT_SHA" "$UPSTREAM")"
REBASE="$WORK/rebase"
git worktree prune
if [ -e "$REBASE/.git" ]; then
    git -C "$REBASE" rebase --abort > /dev/null 2>&1 || true
    git -C "$REBASE" checkout -q -f --detach "$PORT_SHA"
else
    git worktree add -q --detach "$REBASE" "$PORT_SHA"
fi
cd "$REBASE"
if ! git -c user.name=web-builds -c user.email=web-builds@localhost rebase --onto "$COMMIT" "$BASE" > "$WORK/rebase.log" 2>&1; then
    CONFLICTS="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
    git rebase --abort || true
    die 10 port-does-not-apply "The port's commits do not apply to $VERSION ($COMMIT); conflicts in: $CONFLICTS" "$INFO_JSON"
fi
BUILT_SHA="$(git rev-parse HEAD)"
echo "== port applied: $(git rev-list --count "$COMMIT..HEAD") commits on $COMMIT"
cd "$REPO"
if [ -e "$SRC/.git" ]; then git -C "$SRC" checkout -q -f --detach "$BUILT_SHA"; else git worktree add -q --detach "$SRC" "$BUILT_SHA"; fi
cd "$SRC"

# ---- 4. Compile ------------------------------------------------------------------------
if [ ! -f "$DEPS/lib/libSDL3.a" ]; then
    echo "== building the wasm dependencies into $DEPS"
    JOBS="$JOBS" nice -n 19 web/build-deps.sh "$DEPS" > "$WORK/deps.log" 2>&1 || die 11 build-failed "web/build-deps.sh failed (see deps.log)" "$INFO_JSON"
fi
{
    emcmake cmake -S . -B build-web -G Ninja -DCMAKE_BUILD_TYPE=Release -DKFX_WEB_DEPS="$DEPS" \
        -DBUILD_NUMBER="$NUMBER" -DPACKAGE_SUFFIX="$SUFFIX" &&
    nice -n 19 cmake --build build-web -j "$JOBS" --target web-site
} > "$WORK/build.log" 2>&1 || die 11 build-failed "The build failed for $VERSION: $(grep -m3 -E 'error:|Error ' "$WORK/build.log" | tr '\n' ' ')" "$INFO_JSON"

# ---- 5. Game data -------------------------------------------------------------------------
STABLE="$(python3 "$HERE/upstream.py" latest stable)" || die 2 unreachable "keeperfx.net did not answer"
TAG="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["tag"])' "$STABLE")"
COMPLETE="$WORK/complete-$TAG"
if [ ! -d "$COMPLETE" ]; then
    URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["download"])' "$STABLE")"
    echo "== downloading $URL"
    curl -fsSL -o "$WORK/complete.7z" "$URL" && mkdir -p "$COMPLETE.tmp" && 7z x -y -o"$COMPLETE.tmp" "$WORK/complete.7z" > /dev/null \
        && mv "$COMPLETE.tmp" "$COMPLETE" && rm -f "$WORK/complete.7z" || die 12 data-failed "Could not get $URL" "$INFO_JSON"
fi
LAYERS=("$COMPLETE")
if [ "$CHANNEL" = alpha ]; then
    PATCH="$WORK/alpha-$NUMBER"
    if [ ! -d "$PATCH" ]; then
        URL="https://keeperfx.net/download/alpha/keeperfx-${VER_MAJOR}_${VER_MINOR}_${VER_RELEASE}_${NUMBER}-Alpha-patch.7z"
        if curl -fsSL -o "$WORK/patch.7z" "$URL"; then
            mkdir -p "$PATCH.tmp" && 7z x -y -o"$PATCH.tmp" "$WORK/patch.7z" > /dev/null && mv "$PATCH.tmp" "$PATCH" && rm -f "$WORK/patch.7z"
        else
            # No alpha patch for this commit: make this tree's data the way the
            # alpha workflow does (needs the native tools: gcc, make, libpng).
            echo "== no alpha patch at $URL; packaging the data from the source"
            (cd "$SRC" && nice -n 19 make -j "$JOBS" BUILD_NUMBER="$NUMBER" PACKAGE_SUFFIX="$SUFFIX" pkg-enginegfx pkg-assemble) \
                > "$WORK/pkg.log" 2>&1 || die 12 data-failed "No alpha patch and make pkg failed (see pkg.log)" "$INFO_JSON"
            PATCH="$SRC/pkg"
        fi
    fi
    LAYERS+=("$PATCH")
fi
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp build-web/site/keeperfx.js build-web/site/keeperfx.wasm "$STAGE/"
python3 web/package-data.py "$STAGE" "${LAYERS[@]}" > "$WORK/data.log" 2>&1 || die 12 data-failed "web/package-data.py failed (see data.log)" "$INFO_JSON"
tail -1 "$WORK/data.log"

# ---- 6. Add to the layout and smoke test ------------------------------------------------
if [ -n "$BUILDS_URL" ]; then python3 "$HERE/publish-build.py" pull "$LAYOUT" "$BUILDS_URL"; fi
CHANGES="$WORK/changes.json"
if [ -n "$PREV_UPSTREAM" ] && git -C "$REPO" cat-file -e "$PREV_UPSTREAM^{commit}" 2>/dev/null; then
    python3 "$HERE/upstream.py" changes "$PREV_UPSTREAM" "$COMMIT" --repo "$REPO" > "$CHANGES"
else
    python3 "$HERE/upstream.py" changes "$COMMIT~10" "$COMMIT" --repo "$REPO" > "$CHANGES"
fi
ADD_ARGS=(--site "$STAGE" --version "$VERSION" --channel "$CHANNEL" --date "$DATE" --upstream "$COMMIT"
          --port "$PORT_SHA" --notes "$NOTES" --changes "$CHANGES" --checkout "$SRC")
[ -n "$DEFAULT" ] && ADD_ARGS+=(--default "$DEFAULT")
python3 "$HERE/publish-build.py" add "$LAYOUT" "${ADD_ARGS[@]}" | tee "$WORK/add.log"
BUILD_ID="$(python3 -c 'import json,sys; i=json.load(open(sys.argv[1])); print(next(b["id"] for b in i["builds"] if b["upstream"]==sys.argv[2] and b["port"]==sys.argv[3]))' \
    "$LAYOUT/builds/index.json" "$COMMIT" "$PORT_SHA")"
INFO_JSON="{\"version\": \"$VERSION\", \"upstream\": \"$COMMIT\", \"port\": \"$PORT_SHA\", \"channel\": \"$CHANNEL\", \"id\": \"$BUILD_ID\"}"

# The page of this port, the new build from the layout. A build that is only
# in the deployed site (pulled manifests, no engine) is not needed here.
PAGE="$WORK/page"
rm -rf "$PAGE" && mkdir -p "$PAGE"
(cd build-web/site && cp -r index.html 404.html site.css kfx_*.js icon.png fonts "$PAGE/")
rm -f "$PAGE/keeperfx.js" "$PAGE/keeperfx.wasm"
python3 web/stamp-version.py "$PAGE" > /dev/null
PORT_NO=$((20000 + RANDOM % 20000))
python3 web/serve.py "$PAGE" --port "$PORT_NO" --layout "$LAYOUT" > "$WORK/serve.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:$PORT_NO/" && break; sleep 0.5; done
SMOKE_DIR="${SMOKE_NODE_DIR:-$WORK/smoke}"
if [ ! -d "$SMOKE_DIR/node_modules/playwright-core" ]; then
    mkdir -p "$SMOKE_DIR" && (cd "$SMOKE_DIR" && npm init -y > /dev/null && npm install --no-audit --no-fund playwright-core@1 > /dev/null)
fi
SMOKE=0
(cd "$SMOKE_DIR" && node "$HERE/smoke-test.mjs" "http://127.0.0.1:$PORT_NO/" "$BUILD_ID" ${DK:+"$DK"}) > "$WORK/smoke.log" 2>&1 || SMOKE=$?
cat "$WORK/smoke.log"
[ "$SMOKE" = 0 ] || die 13 smoke-test-failed "$(grep -m1 -E 'SMOKE FAIL|Error' "$WORK/smoke.log")" "$INFO_JSON"
kill $SERVER 2>/dev/null || true

# ---- 7. Upload -------------------------------------------------------------------------------
if [ -n "$UPLOAD" ]; then
    "$HERE/upload-builds.sh" "$LAYOUT" "$BUCKET" "${WHERE[@]}" > "$WORK/upload.log" 2>&1 \
        || die 14 upload-failed "Upload to R2 failed (see upload.log); the site still has its previous builds" "$INFO_JSON"
    result published "Published $BUILD_ID" "$INFO_JSON"
else
    result built "Built $BUILD_ID into $LAYOUT (not uploaded)" "$INFO_JSON"
fi
