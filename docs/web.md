# KeeperFX in the browser

KeeperFX builds to WebAssembly with Emscripten and runs in a web page: the same
game, renderers and campaigns as the desktop builds, served as static files.

## Playing

Open the page and choose the folder of your **Dungeon Keeper** or **Dungeon
Keeper Gold** install (the GOG release works) when asked. The page reads only
the 16 files listed in [files_required_from_original_dk.txt](files_required_from_original_dk.txt),
plus the soundtrack (`keeper02.ogg` ... `keeper07.ogg`) when the folder has it.
They are kept in the browser's IndexedDB storage and never leave the computer.
Saves, settings, replays and screenshots are kept there too.

- The game sits in a frame on the Play page, with its buttons in the bar above
  it: **Fill tab** hides the site around it, **Fullscreen** (or F11) shows the
  game alone. To leave fullscreen press F11 again, rest the pointer at the top
  edge for the exit button, or use Esc; Chrome and Edge leave Esc to the game
  there and exit when it is held.
- Click the game to capture the mouse (the browser's pointer lock, like
  `CAPTURE_CURSOR` on the desktop); press Esc to release it.
- Screenshots (Shift+C) are saved in the browser and also handed to the
  browser as downloads.
- The game data downloads as the game needs it; the files a normal start uses
  are fetched in the background as soon as the page opens. Later visits load
  them from the browser cache.

The site around the game is one document with a page per URL fragment:
`#/` (home), `#/play`, `#/lobbies`, `#/fame` (Hall of Fame, with
`#/fame/levels/<campaign>/<level>` and `#/keeper/<name>`) and `#/guide`. The
lobbies and the Hall of Fame need the site's server (see "Online play"); on
plain static hosting they are left out. While a game runs, links to the other
pages open in a new tab.

It needs a browser with WebAssembly and WebGL 2 (current Chrome, Edge, Firefox
and Safari have both; it has been tested in Chromium).

### Differences from the desktop build

- **Online play is between browsers only**, through the site's own lobby
  server (see "Online play"); LAN play is not available. Skirmish against the
  computer works.
- **Lua 5.1 instead of LuaJIT**, which has no WebAssembly backend. It is patched
  with the LuaJIT/Lua 5.2 functions KeeperFX and its scripts use
  (`web/lua51-luajit-compat.patch`) and has LuaJIT's `bit` module, so level and
  campaign scripts behave the same. Mods that use LuaJIT's `ffi` or `jit`
  modules are not supported. Lua bytecode differs between the two, so a save
  from a desktop build whose scripts stored compiled functions may not load in
  the browser, or the other way round.
- The display modes in `keeperfx.cfg` are replaced with windowed modes sized to
  the screen (exact in fullscreen); the page scales the picture to its frame.
- Keep `RELATIVE_MOUSE_MODE=ON` (the default). With it off, the game moves its
  cursor to the screen centre at some points (starting a level, the land
  view) and expects the system pointer to follow, which a web page cannot do,
  so the two drift apart until the pointer leaves the page and comes back.

## URL options

| Option | Effect |
|---|---|
| `?args=-nointro%20-level%201` | Command line arguments for the game |
| `?renderer=software` | `RENDERER` setting (`opengl` or `software`) |
| `?cfg=KEY=VALUE;KEY=VALUE` | Override any `keeperfx.cfg` line |
| `?dk=<url>` | Import the DK files from a folder served at `<url>` instead of asking (lower-case names: `data/main.pal`, `sound/atmos1.sbk`, ..., plus optional `keeper02.ogg` ... `keeper07.ogg`) |
| `?build=<id \| version \| channel>` | Run that game version for this visit, e.g. `?build=alpha`, `?build=1.4.0.5603` (see "Game versions") |
| `?join=CODE` | An invite: the start screen offers to join that lobby (`&spectate` to watch); without `?build` the page picks the lobby's version |
| `?autostart` | Skip the start screen; with `?join=CODE` or `?host` (`&unlisted`) go straight online |
| `?debug` | Log each game data download to the console |

A player can keep their own config by storing it as `/persist/keeperfx.cfg`.

A deployment can set the same DK source for everyone with a `site.json` next
to `index.html`, e.g. `{"dkUrl": "dk/"}`; the page then imports from there and
only shows the folder picker if that fails. Only do this where you are allowed
to serve those files, such as a private deployment: the build never includes
them, so they would have to be added to the site by hand.

## Building

Install and activate the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(tested with Emscripten 7.0), then:

```sh
source /path/to/emsdk/emsdk_env.sh

# 1. Third-party libraries, compiled to wasm from pinned sources (once).
web/build-deps.sh build-web/deps/prefix

# 2. The game and the page around it (web/). Output: build-web/site/
#    {index.html,site.css,kfx_*.js,fonts/,keeperfx.js,keeperfx.wasm}. After a
#    change to the page alone, `ninja -C build-web web-site` copies it again.
emcmake cmake -S . -B build-web -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-web --target keeperfx

# 3. Game data: an unpacked keeperfx_*_complete.7z release with this tree's
#    data (make pkg-enginegfx pkg-assemble -> pkg/) laid over it.
make pkg-enginegfx pkg-assemble
web/package-data.py build-web/site /path/to/keeperfx_complete pkg
```

`web/package-data.py` never copies the original Dungeon Keeper files, even if
the install it reads contains them.

To try it locally, serve the site and point `--dk` at your own DK folder:

```sh
web/serve.py build-web/site --dk "/path/to/Dungeon Keeper Gold"
# then open http://localhost:8080/?dk=dk
```

## Hosting

`build-web/site` is a static site (about 530 MB in 5,500 files, mostly game
data in `gamedata/`). That is the single-build layout a plain CMake build
makes; for several versions side by side see "Game versions". Any static host with HTTPS works; no special headers are
needed (the build uses no threads, so no cross-origin isolation). Serve `.wasm`
as `application/wasm`. Files under `gamedata/` are requested as
`<path>?v=<content hash>`, so they can be cached for good; `web/_headers` says
so for hosts that read it (Cloudflare Pages, Netlify).

Files over 24 MiB are stored as `<name>.part0`, `.part1`, ... and joined by the
page, so hosts with a per-file limit (Cloudflare Pages: 25 MiB) take the site
as it is.

### Cloudflare Pages

Free, with no bandwidth limit for static files.

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... web/deploy-cloudflare.sh
```

The token needs the *Cloudflare Pages: Edit* account permission. The first run
creates the `keeperfx` project (`https://keeperfx.pages.dev`); later runs upload
only the files that changed. `web/404.html` must stay in the site: without it
Pages answers every missing path with `index.html` and status 200. To use your own
domain, add it under the project's *Custom domains*; for a domain on the same
Cloudflare account that also creates its DNS record.

### Game data on R2

The Worker can send players to an R2 bucket for the game data instead of
serving `gamedata/` itself. The bucket `keeperfx-data` is public on
`keeper-data.edwindejong.net`, with CORS for the site. To switch over:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... web/upload-r2.sh   # objects go to gamedata/<path>
# then in web/server/wrangler.jsonc: "DATA_URL": "https://keeper-data.edwindejong.net/gamedata/"
cd web/server && npx wrangler deploy
```

The page reads `dataUrl` from `/site.json` (answered by the Worker from
`DATA_URL`). The manifest always comes with the page, so upload changed data
before deploying a page whose manifest names it.

Do not publish Dungeon Keeper's own files: each player supplies their own.

## Game versions

The site can offer several builds of the game side by side: the newest
alpha, older alphas that lobbies or invites still use, and a stable release
once one can be built (below). Players pick one on the start screen or with
the version button in the game's frame bar; the page remembers the choice.

### How upstream publishes KeeperFX

- **Stable releases** are GitHub releases (tags `vX.Y.Z`) with a complete
  `keeperfx_X_Y_Z_complete.7z`. The latest is 1.4.0 (tag `v1.4.0`,
  2026-07-04), cut from a release branch that left master on 2026-06-08.
- **Alpha builds** are made from every push to master by the *Alpha Patches*
  workflow and served on keeperfx.net as
  `keeperfx-1_4_0_<N>-Alpha-patch.7z`, with `N = git rev-list --count <commit>`
  (about 110 master commits, so as many alpha builds, in the month to
  2026-11-10). The
  game reports itself as `1.4.0.<N> Alpha`; a stable build as `1.4.0.<N>`
  with N counted at its tag (1.4.0 is 1.4.0.5136).
- keeperfx.net answers `https://keeperfx.net/api/v1/release/alpha/latest`
  and `.../stable/latest` (version, workflow run, date, download); the
  workflow run on GitHub names the commit. `web/upstream.py` reads these.

The version comes from `version.mk` (major, minor, release) and the build
number CMake is given (`-DBUILD_NUMBER`, `-DPACKAGE_SUFFIX`, see
`ver_defs.h.in`). Without them a build says `1.4.0.0`, and online play then
lets two different builds meet: the game refuses a join only when the
version numbers differ (`net_versions_match`). Every build the site offers
therefore carries upstream's own number.

### What can be built

The port needs SDL3 (master since build 5272, 2026-08-05), the CMake
modules (5267), the platform layer (5276) and the OpenGL renderer (5389,
2026-09-12). Stable 1.4.0 has none of them: applying the port to `v1.4.0`
conflicts in its very first commit (CMakeLists.txt, the CMake modules, the
sound, platform and renderer files are missing or different; 617 files and
about 80,000 lines differ in `src/`). A stable channel appears once
upstream's next release is cut from a master that has them; until then the
site offers alpha builds only, and keeps a few older ones.

New features reach the browser with the alpha that has them. *Hellhound
mode* (co-op on any single-player map: in an online lobby, pick a map under
"Single-Player Maps (co-op)..." and give both players the same colour; they
then share one keeper) came with alpha 5603 (PR #5581, 2026-11-09), two
commits after the master the first web build was made from; it has been
played between two browsers on the site's relay. Co-op multiplayer maps
(PR #4757) were already in 1.4.0.

Keeping up with master is cheap so far: rebasing the port's 21 commits onto
master two commits later (`f75ddc07b`, Hellhound mode) applied without a
conflict and compiled first time. The port touches 26 files outside `web/`,
mostly new ones (`src/kfx/platform/web/`, `WebBundle.cmake`) and guarded
lines, so conflicts should be rare and small; the CMake modules and
`RenderThreadManager` are the likeliest places.

### Layout and hosting

`web/publish-build.py` keeps the builds in one folder:

```
builds/index.json                 the builds (channel, version, upstream commit, date, changes)
builds/<id>/keeperfx.js|.wasm     the engine; <id> is <version>-<hash>, so these never change
builds/<id>/manifest.json         its game data list ("layout": "cas")
data/<hash>[.partN]               game data, stored once by content hash
```

One build's data is 4,808 distinct files, 538 MiB (5,660 paths: many are
the same file). The next build adds its engine (8.6 MiB) and only the files
that differ: 21 files, 2 MiB from alpha 5601 to 5603; about 100 files,
4 MiB across five weeks of alphas. Each channel keeps its newest three
builds (`--keep-count`) plus any marked `keep`; older ones are retired and,
14 days later, deleted with the data no other build uses.

The page stays on the Worker (static assets: a few dozen files), the builds
and data go to the R2 bucket. The Worker's static assets would fit two or
three versions (20,000 files, 25 MiB each), but each new build would then be
a Worker deploy; with R2 a new build is an upload and the page picks it up
from `index.json`. Three alphas and a stable come to about 600 MB, within
R2's free 10 GB.

```sh
# a site's current builds -> a local layout (only the index and manifests)
web/publish-build.py pull work/layout https://keeper-data.edwindejong.net/builds/
# add a build: a dir with keeperfx.js, keeperfx.wasm and gamedata/ (web/package-data.py)
web/publish-build.py add work/layout --site build-web/site --version 1.4.0.5603 --channel alpha \
    --upstream <commit> --notes <url> --changes changes.json
web/publish-build.py list work/layout
web/publish-build.py set work/layout --default alpha     # or --keep ID, --remove ID
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... web/upload-builds.sh work/layout
```

`upload-builds.sh` uploads new data first, then the build, then
`index.json`, and deletes retired files last, so a failure leaves the site
on its previous builds. The page finds the builds at `builds/` next to it,
or where `site.json` says (`buildsUrl`). For the Worker, set `BUILDS_URL` in
`wrangler.jsonc` to the bucket's public address
(`https://keeper-data.edwindejong.net/builds/`), or `BUILDS_FROM` to `r2` to
have the Worker serve `/builds/` and `/data/` from the bucket itself (handy
locally; in production every data file would then be a Worker request). A
site without `builds/index.json` runs the one engine next to the page, as a
plain CMake build makes it. Locally: `web/serve.py <page> --layout <layout>`.

### Choosing and switching

`web/kfx_versions.js` decides which build a visit runs: `?build=` in the
address, else the version of the lobby an invite (`?join=CODE`) leads to,
else the player's choice (a channel, which follows its newest build, or one
exact build), else `index.json`'s `default` (a channel or build id; `alpha`
now). The start screen shows the version, what changed upstream (the
commits since the previous build, linked to their pull requests) and a
dialog to switch; the frame bar shows it too. Switching reloads the page
into the other build. During a game the page asks first; the game is lost
unless saved.

One page runs every build. The page and an engine talk through a small
contract (Module hooks, the loader's command line, `/persist`, the `/api`
routes the engine calls), numbered `KFX_WEB_API` in `web/kfx_web.js`. Each
build records its number in `index.json` and the page offers only builds
whose number it knows (`SUPPORTED_API` in `kfx_versions.js`). Raise it when
an engine-side change needs a matching page, and keep the page able to run
the builds still offered. Page deploys and engine builds are therefore
independent: a new build needs no page deploy, and a page deploy keeps the
builds.

### Saves, online play and records across versions

- **Saves and settings** are shared by all versions (`/persist/save`).
  Saves use a self-describing format (`src/kfx/save/FORMAT.txt`) that reads
  across builds: tested both ways between 1.4.0.5601 and 1.4.0.5603 (which
  changed the format, minor 9 to 10): each loads the other's saves of a
  campaign level with a "made by version" warning. Saves from builds before
  5523 (2026-10-18) cannot be read by any later build, but no web build is
  that old. Fields a version moves can be lost (5603 moved the things in a
  keeper's hand), so before a different build first runs the page copies the
  saves to `/persist/backups/<previous build>` (the last three); the version
  dialog can put them back.
- **Online play** needs the same build on every side. A hosted lobby records
  its build; the Lobbies page shows each lobby's version, and joining one on
  another version reloads into that version first. Invite links carry
  `&build=`, and older links without it resolve to the lobby's version. If
  a player still reaches a lobby of another version (the game's own lobby
  list shows them all), the game refuses: "The host is using a different
  game version". Lobbies of a build the site no longer offers are shown but
  not joinable.
- **Game data** is cached in the browser by content hash, so a switch only
  downloads the files that differ (3 files to start level 1 on 5601 after
  5603), and the cache keeps the data of the last few versions used.
- **Hall of Fame** results record the version that played them (shown with
  recent games). The boards are shared by all versions.

### Following upstream automatically

`.github/workflows/web-upstream.yml` runs every four hours (and by hand):
it asks keeperfx.net for the newest alpha, compares it with the deployed
`builds/index.json`, and if the site lacks it (or has it from an older port
revision), runs `web/upstream-build.sh`, which

1. rebases the port onto that upstream commit (exit 10 if it no longer
   applies, naming the conflicting files),
2. compiles it with upstream's build number (exit 11 on errors),
3. packages the data: the latest complete release with that alpha's patch
   laid over it, as desktop players have it (exit 12),
4. adds it to the layout and loads it in headless Chromium until it asks for
   the DK files (exit 13 if it does not; with `--dk` it plays a level),
5. uploads it (exit 14 on failure).

A failure fails the run and opens (or comments on) an issue in the fork;
the site keeps its previous builds. The workflow needs this branch on the
fork, the secrets `CLOUDFLARE_API_TOKEN` (Account → *Workers R2 Storage:
Edit*) and `CLOUDFLARE_ACCOUNT_ID`, and the variable `KFX_BUILDS_URL` (the
deployed `builds/`); without the variable it does nothing. Run the same
thing by hand with:

```sh
source /path/to/emsdk/emsdk_env.sh
web/upstream-build.sh --work /tmp/kfx-upstream --builds-url https://keeper-data.edwindejong.net/builds/ \
    --dk "/path/to/Dungeon Keeper" --upload        # without --upload it stops before publishing
```

When the port no longer applies, rebase it by hand
(`git rebase origin/master` on the port branch), fix, push; the next run
builds from it.

## Online play

When the site runs on its Worker (`web/server`, below), it has:

- **Lobbies** (`#/lobbies`): the open games, live, each with its players, map
  and state, and **Join** or **Watch** (spectate) buttons. **Host a game** asks
  for a lobby name and whether the lobby is public or invite only (not listed).
  A host gets a five-letter code and an invite link (`?join=CODE`) in the bar
  above the game. The start screen offers the same choices, and the game's own
  Multiplayer → Online screen lists the public lobbies too.
- **The tavern**, on the lobbies page: who has the site open, a chat for
  signed-in players, and news lines (a lobby opened, someone won a level). Set
  `CHAT` to `off` in `wrangler.jsonc` to close the chat; names in
  `ADMIN_USERS` can remove lines and mute players.
- **Hall of Fame** (`#/fame`): when a level ends, the game tells the page
  (`src/kfx/platform/web/WebReport.c`: level, score, turns, statistics), and
  the page sends it in for a signed-in player. Each level keeps a keeper's
  best score and fastest win; a keeper's renown is the sum of their best
  scores. A guest's wins wait in the browser and are sent after signing in.
  Games with cheats allowed are recorded but not ranked. The numbers come from
  the player's own browser, so this is an honour system: the server only
  checks that they are plausible and limits how many a player can send.

Browser players play each other; desktop KeeperFX uses UDP, which browsers
cannot.

Accounts are optional: a signed-in player's account name is their keeper name
(a guest can type one on the start screen). Players sign in with a name and
password, or with Discord when it is set up.

How it fits together:

- `web/server` is a Cloudflare Worker: it serves the static site and `/api`.
  Accounts and the Hall of Fame live in D1 (SQLite). Each lobby is a Durable
  Object (`Room`) that relays the game's traffic over WebSockets between the
  host and the players; another (`Directory`) keeps the lobby list, and a
  third (`Tavern`) holds the pages' WebSockets for presence, chat and news,
  and tells them when the lobby list changes.
- On the page, `web/kfx_loader.js` starts the game (`window.KFX`) and
  `web/kfx_site.js` is everything around it: the pages, sign-in, lobbies,
  tavern and records.
- In the game, `src/kfx/platform/web/NetWebSP.c` is the network transport
  (`struct NetSP`, as `bflib_enet.cpp` is for UDP) over that WebSocket, and
  `NetMatchmakingWeb.c` is the lobby list and lobby publishing. The game's
  multiplayer code (lockstep, resync, lobbies) is unchanged, except that
  gameplay packets are sent once instead of three times: the relay never
  loses them.
- Passwords are stretched in the browser (PBKDF2-SHA256, 600,000 rounds) and
  the server keeps a salted hash of the result, so it never sees them.

Traffic: a two-player game sends about 25 messages a second per player
through the relay, which the Workers free plan (100,000 Durable Object requests
a day, incoming WebSocket messages counted 20:1) covers for roughly ten hours of
two-player games a day; Workers Paid lifts that.

### Running the Worker

```sh
cd web/server
npm install
npm run dev            # local: http://127.0.0.1:8787, with local D1 and Durable Objects
```

To deploy, create the D1 database once and put its id in `wrangler.jsonc`, then:

```sh
npx wrangler d1 create keeperfx
npx wrangler d1 migrations apply keeperfx --remote
npx wrangler deploy
```

Run the `migrations apply` step again whenever `web/server/migrations` gains a
file (the Hall of Fame tables are `0002_scores.sql`), before `deploy`.

For Discord sign-in, create an application at discord.com/developers with
the redirect `https://<your site>/api/auth/discord/callback`, set
`DISCORD_CLIENT_ID` in `wrangler.jsonc` and `npx wrangler secret put DISCORD_CLIENT_SECRET`.

## How it works

- **Build**: `build/cmake/modules` has an Emscripten branch next to the Windows
  and Linux ones (`Platforms`, `Dependencies`, `Helpers`, `WebBundle`).
  `web/build-deps.sh` builds SDL3, SDL3_image, SDL3_mixer, zlib/minizip, spng,
  centijson, astronomy, enet6, Lua and a smacker-only ffmpeg.
- **Main loop**: the game keeps its own blocking loop. Asyncify lets it pause:
  after each presented frame it waits for the browser's next animation frame
  (`kfx_web_frame_yield` in `web/kfx_web.js`), and `SDL_Delay` sleeps the same
  way. The OpenGL renderer's render thread runs inline on the game thread
  (`RenderThreadManager`).
- **Graphics**: the OpenGL renderer runs on WebGL 2. Its GLSL 3.30 shaders are
  rewritten to GLSL ES 3.00 at compile time (`GLResourceMapper.cpp`), and the
  GL 3.1-3.3 functions WebGL 2 has are loaded by hand (`GLFunctions.cpp`).
  The software renderer works too.
- **Files**: the page creates every data file as an empty placeholder from
  `gamedata/manifest.json`. The open and stat syscalls are wrapped at link time
  (`src/kfx/platform/web/WebFileSystem.c`): opening a placeholder downloads it,
  and stat reports its real size without downloading. `/persist` is an IndexedDB
  filesystem; `save/`, `replays/`, `scrshots/` and `music/` link into it.
- **Audio**: Emscripten's OpenAL (effects) and SDL audio (music, speech,
  movies) on Web Audio. The page resumes them on the first click or key.
- **Network**: `net_matchmaking.c` and `net_portforward.cpp` (curl, UPnP) are
  replaced by `src/kfx/platform/web/NetMatchmakingWeb.c`, which also refuses
  socket creation, so Emscripten never tries to reach game or STUN hosts over
  WebSockets; online play uses `NetWebSP.c` (see "Online play").
