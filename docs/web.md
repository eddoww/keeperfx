# KeeperFX in the browser

KeeperFX builds to WebAssembly with Emscripten and runs in a web page: the same
game, renderers and campaigns as the desktop builds, served as static files.

## Playing

Open the page and choose the folder of your **Dungeon Keeper** or **Dungeon
Keeper Gold** install (the GOG release works) when asked. The page reads only
the 16 files listed in [files_required_from_original_dk.txt](files_required_from_original_dk.txt),
plus the soundtrack (`keeper02.ogg` ... `keeper07.ogg`) when the folder has it.
They are kept in the browser's IndexedDB storage and never leave the computer.
Saves, settings, replays and screenshots are kept there too; for a signed-in
player, saves, campaign progress and settings also go to their account (see
"Cloud saves").

- The game sits in a frame on the Play page, with its buttons in the bar above
  it: **Fill tab** hides the site around it, **Fullscreen** (or F11) shows the
  game alone. To leave fullscreen press F11 again, rest the pointer at the top
  edge for the exit button, or use Esc; Chrome and Edge leave Esc to the game
  there and exit when it is held.
- The game's hand follows the mouse without capturing it, so the pointer can
  leave the game for the page and Esc opens the game's menu at the first
  press. Pushing the pointer against the game's edge, or up to 24 pixels past
  it (and over the black bars around it in fullscreen), scrolls the view.
  Possessing a creature locks the mouse to the game (the browser's pointer
  lock) for steering: Esc frees it there, a click on the game takes it back,
  and leaving the creature lets it go. **Lock mouse** above the game keeps it
  locked all the time instead, as `CAPTURE_CURSOR` does on the desktop (click
  to capture, Esc releases it, so the menu takes a second press); the choice
  is kept in the browser.
- The game saves itself every 5 minutes of play, and when the tab is hidden or
  closed and on **Leave**; the start screen offers **Continue where you left
  off** (see "Autosave").
- Screenshots (Shift+C) are saved in the browser and also handed to the
  browser as downloads.
- The game data downloads as the game needs it; the files a normal start uses
  are fetched in the background as soon as the page opens. Later visits load
  them from the browser cache.
- The site can be installed as an app and played solo without a connection
  once its data is downloaded (see "App and offline play").

The site around the game is one document with a page per URL fragment:
`#/` (home), `#/play`, `#/lobbies`, `#/workshop` (with `#/workshop/<category>`,
`#/workshop/installed` and `#/workshop/item/<id>`), `#/fame` (Hall of Fame, with
`#/fame/levels/<campaign>/<level>` and `#/keeper/<name>`) and `#/guide`. The
lobbies, the workshop, the Hall of Fame, replays (`#/replays`, `#/replay/<id>`)
and watching (`#/watch/<CODE>`) need the site's server (see "Online play"); on
plain static hosting they are left out. While a game runs, links to the other
pages open in a new tab.

It needs a browser with WebAssembly and WebGL 2 (current Chrome, Edge, Firefox
and Safari have both; it has been tested in Chromium).

### Touch screens and controllers

Tablets and phones (held sideways) play by touch, and a controller works
wherever the browser sees one. Mouse and keyboard play is unchanged; the page
shows the hints for whichever was used last.

**Touch** (`web/kfx_touch.js`): the game's cursor goes to the finger.

| Gesture | Does |
|---|---|
| Tap | Left click |
| Drag | Left button held (mark tiles to dig, paint rooms) |
| Hold still (0.45 s) | Right click, held until the finger lifts (drop, slap, cancel) |
| Two-finger tap | Right click under the first finger |
| Two-finger drag / pinch / twist | Scroll / zoom / rotate the dungeon view |

A bar on the right of the game has **Menu** (Esc), **Right** (taps become
right clicks until pressed again), **Keys** (the device's keyboard, for save
names, chat and the keeper name) and **More**: Space, Enter, map, pause,
Shift and Ctrl (held until pressed again), turn and zoom keys, fullscreen and
hiding the bar. In creature possession a drag turns, a hold keeps attacking, a
stick on the left walks and **Leave** returns to the dungeon. Held upright, the
page asks for the device to be turned. Where a page element can't go
fullscreen (iPhone Safari), Fullscreen fills the tab instead; on a touch
screen "fill the tab" also hides the bar above the game. Phones and tablets
that can't pick a folder can choose the 16 Dungeon Keeper files themselves.

**Controllers** use the desktop build's own controller scheme (SDL gamepad;
the browser's Gamepad API underneath): right stick moves the hand, left stick
scrolls, RT and LT are left and right click, the D-pad jumps between buttons,
Start is the menu. The Guide page lists all buttons. A browser shows a
controller to the page only after one of its buttons is pressed; the game
takes it then, and when it is plugged in or out during play.

**Resolution**: on a touch-only device the game renders in landscape at most
about 1.2 megapixels (0.8 when the browser reports 2 GB of memory or less), for
example 1612x744 on a 2532x1170 phone and 1314x914 on a 1180x820 iPad.
`?cfg=INGAME_RES=...` still overrides it.

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
- The mouse is not captured outside possession (the page writes
  `CAPTURE_CURSOR=OFF` unless the player chose Lock mouse; builds from before
  this keep it on). Keep `RELATIVE_MOUSE_MODE=ON` (the default): it is what
  locks the pointer in possession. The game still moves its cursor to the
  screen centre at some points (starting a level, the land view) and a page
  cannot move the system pointer, but the page places the cursor at the
  pointer again on the next move, so the two never stay apart.

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

The game's own `-loadgame <file or slot>` (in `?args=`, or a start choice's
`args`) loads that save instead of showing the main menu, e.g.
`-loadgame fx1auto2.sav` or `-loadgame 3`; Continue on the start screen uses it.

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

The site also gets the app files: `sw.js` (stamped with the build, see "App
and offline play"), `manifest.webmanifest` and `icons/`. The icons are made
from `res/keeperfx_icon512-24bpp.png` by `web/make-icons.py` (Pillow) and
committed. `-DKFX_WEB_SERVICE_WORKER=OFF` builds the service worker's kill
switch instead.

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

`sw.js` must not be cached for long (a new build reaches players through it),
and `manifest.webmanifest` should be `application/manifest+json`; `web/_headers`
says so for hosts that read it. The Worker's static assets read `_headers`
too.

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

## Autosave

A browser tab is a fragile place for a long level: closed by accident, a
crash, a browser restart, a dropped connection. So the game saves itself.

- **What the player sees**: every 5 minutes of play the game writes an
  autosave, and the bar above the game says "Autosaved 14:32" next to the
  cloud saves indicator (it lights up briefly; hovering says more, a click
  opens the saves). Nothing stops or asks. Autosaves are at the top of the
  game's Load Game lists (main menu and in game), named after the time and the
  level ("Autosave 14:32 Eversmile"), and in the site's Saves dialog. The
  start screen offers **Continue where you left off** with the newest save,
  an autosave or the player's own, saying which level and how long ago; it
  starts the game straight into it. The game's own Continue Game button does
  the same, since an autosave moves the continue link like any save.
- **Slots**: three files of their own, `fx1auto1.sav` ... `fx1auto3.sav`,
  the oldest (by file time) replaced each time, so one or two steps back
  are there after an unlucky one. They never take or touch a player's slot
  (`fx1gNNNN.sav`).
- **When**: after the set minutes of play (paused time, and time the tab
  stood still, don't count); a save that falls due while the keeper's
  creatures fight waits for the fight to end, up to a minute. Also when the
  tab is hidden (switching tabs, minimising, and the first thing that happens
  when a tab or the browser is closed), if there has been a minute of play
  since the last one, and on **Leave**. Pagehide alone is not relied on: the
  browser gives no time there, and the regular saves cover a tab that dies
  without warning.
- **Where not**: online games (the engine has no save for a network game; its
  Save button is off there too), replays, watching (a spectator is in a
  network game), a finished level, and outside a level (menus, the land view,
  level loading, movies, the statistics screen). While paused nothing is
  counted; a hide or Leave still saves if anything happened since.
- **The setting**: `autosave_minutes` in the `[gameplay]` section of
  `save/settings.toml` (0 is off, at most 60), 5 by default in the browser
  and **off by default on the desktop**, where nothing changes unless a
  player sets it. The page offers off, 2, 5, 10, 15 and 30 minutes on the
  start screen and in the Saves dialog; during a game it changes the running
  game's setting (`kfx_web_autosave_set`), otherwise it edits the file. Cloud
  saves carry `settings.toml`, so a signed-in player's choice follows them.
- **Safety**: the game writes every save to `<name>.tmp` and renames it over
  the old file (`FileSystemLb::WriteAll`), so a failed write leaves the old
  one. In the browser the file then reaches IndexedDB in one
  `FS.syncfs` transaction, which the page starts right after the autosave;
  a tab killed before it commits keeps the previous state whole (tested:
  SIGKILL right after an autosave leaves the one before, loadable).
- **Cloud saves**: an autosave writes two files (the autosave and the
  continue link), so with the default it costs 24 uploads an hour, 60 at the
  shortest choice (2 minutes), and at most about 120 with hide saves (one per
  minute of play at most), against the limit of 240. A refused upload (409)
  is not counted. Autosaves changed in two browsers take the newest (with a
  backup), like the continue link: they are never kept both into a player's
  slot, and they don't produce a "saved to your account" toast. An imported
  autosave file gets a player slot of its own.
- **Cost**: a save encodes the whole game state, about 18.5 MB before
  compression (things, creature controls, the map), whatever the level, to
  250-300 KB. In the headless test browser on a busy machine an autosave took
  110-165 ms (level 1 and level 20 alike), one dropped frame or a few; before
  the encoder work below it took 180-260 ms. The save code now copies runs of
  fields whose memory layout is their stored layout in one go (same bytes,
  checked against the field-by-field encoder and by `tests/save`), and the
  config overlay skips fields that did not change (63 ms to 3 ms). What is
  left is roughly half the encoding of things and creature controls (their
  unions are still walked field by field) and half zlib.

How it fits together: `src/kfx/save/SaveAutosave.cpp` (when, which file, the
title), `gameplay_between_turns()` in `game_loop.c` (the game is whole between
two turns, also while it waits for the next frame, so the page may call in
then), the autosave slots in the save manager (slots `AUTOSAVE_SLOT_FIRST` and
up, past every `fx1gNNNN.sav`), and `-loadgame`. Browser only:
`src/kfx/platform/web/WebAutosave.c` (`kfx_web_autosave_now`, `_state`,
`_set`, and `Module.kfxOnAutosave` after each one) and "Autosave" and
"Continue where you left off" in `web/kfx_loader.js`.

## App and offline play

The site is an installable web app. **Install** in the top bar (where the
browser offers it, Chrome and Edge on the desktop and Android) puts KeeperFX
on the desktop or home screen in its own window; the same dialog says how in
Safari (iOS: Share → Add to Home Screen; macOS: File → Add to Dock) and
Firefox (Android: menu → Install; the desktop Firefox has no app install).

**Offline play** (the same dialog, the top bar chip, or the start screen)
downloads game data for solo play without a connection. The player's
Dungeon Keeper files, saves and settings are in IndexedDB already. The data is
grouped by the game's folders (`web/kfx_offline.js`, from the manifest at
run time):

| Group | What | Size (current data) |
|---|---|---|
| Essentials | everything outside `campgns/`, `levels/`, `multiplayer/`; the original campaign (`campgns/keeporig*`, speech in the game's language); the manifest's `prefetch` list; every map's level info (`.lof`/`.lif`, which the menus read) | about 157 MB |
| Each other campaign | `campgns/<name>.cfg`'s `campgns/<name>`, `_lnd`, `_crtr`, `_cfgs` and speech folders | 7 to 25 MB each |
| Free play and multiplayer maps | the rest of `levels/` and `multiplayer/` | about 39 MB |
| Speech in other languages | `sound/speech_*.dat` and campaign speech folders not in the game's language | about 175 MB |
| Everything | all of it | about 532 MB |

(MB here are MiB, as the page shows them.) A download can be paused and
resumed, carries on after a reload, and tops itself up when a new release
changes data files. It checks `navigator.storage.estimate()` first and asks
for persistent storage (`navigator.storage.persist()`); installed apps get it
without asking in Chromium. **Free the space** removes all downloaded data
(saves and DK files stay), and each campaign can be removed on its own.

Offline, the top bar shows **Offline**, the online pages (lobbies, Hall of
Fame) and the host/join choices are hidden, and the start screen says whether
the essentials are on the device. If the game opens a file that is not
downloaded, the page says which download it belongs to (and the game carries
on where it can; it stops only if the file is essential). A level won offline
is kept, like a guest's, and sent to the Hall of Fame once the player is back
online and signed in. When the connection comes back the page reconnects to
the server without a reload, even during a game.

### How it works

- `web/sw.js` is the service worker. `web/stamp-version.py` writes into it
  the build id and the list of files the page loads (taken from `index.html`:
  scripts, stylesheets, icons, fonts, the manifest and its icons, `url()`s in
  the stylesheets; plus `keeperfx.wasm`), each with its SHA-256. A page
  script added to `index.html` is picked up by itself.
- Install fetches all of them into `keeperfx-shell-<build>` and checks every
  hash (the page by its `kfx-build` stamp). If any file is from another build
  (a deploy in between, a stale CDN copy) the install fails and the current
  build stays; the browser tries again on its next update check. So a page and
  its engine always come from one build.
- The page (`/`, any query) is served from that cache, so it starts without a
  connection and never mixes builds. `/api/*` and `/site.json` are never
  cached; offline they fail at once (503), and the site drops to solo play.
  `gamedata/manifest.json` comes from the network, with the last good copy
  kept (`keeperfx-meta`) for offline starts. Game data is not touched by the
  worker: the loader keeps it in `keeperfx-gamedata` as before, and the
  offline downloads go into the same cache.
- **Updates**: a deploy changes `sw.js` (its build id), the browser installs
  it in the background and it waits. The page then shows "A new version of
  KeeperFX is ready": **Reload** switches over (`skipWaiting`, then the page
  reloads). During a game the bar says the game is not interrupted and
  **Reload now** asks first; a request from one tab is refused while another
  tab is in a game (BroadcastChannel). An update found waiting when a page
  opens, with no game in any tab, is applied at once. Activation deletes the
  previous build's cache.
- **Kill switch**, two ways: build with `-DKFX_WEB_SERVICE_WORKER=OFF`
  (`stamp-version.py --no-sw`), which ships a `sw.js` that deletes its caches
  and unregisters itself and a page that no longer registers one; or, without
  a build, set `SERVICE_WORKER` to `"off"` in `web/server/wrangler.jsonc`:
  `site.json` then says `"serviceWorker": false` and every page that loads
  online unregisters it and reloads once from the network. Removing `sw.js`
  from the site also makes browsers drop it (a 404 unregisters).
- `site.json`'s `dataUrl` is remembered in the browser, so offline the page
  still looks for data where it was downloaded from; the worker leaves other
  origins alone, so a bucket only needs the CORS it already has. When the
  server names a different data origin, copies from the old one are pruned.
- Plain static hosting works the same (no `site.json`: no online features,
  and nothing to queue). Service workers need HTTPS (or `localhost`).
- Not tested: Safari (iOS/macOS) and Firefox. iOS keeps a home screen app's
  storage separate from Safari's, so the data is downloaded again there.

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

When the port no longer merges with upstream, merge it by hand
(`git merge origin/master` on the port branch), fix the conflicts, push; the next run
builds from it.

## Online play

When the site runs on its Worker (`web/server`, below), it has:

- **Lobbies** (`#/lobbies`): the open games, live, each with its players, map
  and state, and **Join** or **Watch** (spectate) buttons. **Host a game** asks
  for a lobby name and whether the lobby is public or invite only (not listed).
  A host gets a five-letter code and an invite link (`?join=CODE`) in the bar
  above the game. The start screen offers the same choices, and the game's own
  Multiplayer → Online screen lists the public lobbies too.
- **Find a game** (quick match), on the home page, the lobbies page and the
  start screen: choose **2 keepers** or **Any size** (2 to 4) and wait; the
  panel shows how long, and everyone sees how many keepers are looking. When
  others are found, one of them (preferably one whose game is ready on the
  start screen) gets an unlisted lobby opened for them, and the others join it
  by themselves: nobody types a code. Once they are in, the game starts by
  itself on a random map for that many keepers, after a 10 s countdown the
  host can cancel to pick the map themselves. Details below, under "Quick
  match".
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

- **Watching** live games: games in progress show under **Live now** on the
  home and Lobbies pages, with the number of spectators, a **Watch** button
  (the game's spectator mode, `-spectate -connect CODE`; joining halfway
  through works, the spectator's game catches up first) and a watch link
  `#/watch/<CODE>` to share. Players also find **Watch link** next to the
  lobby code above the game. The host's lobby settings decide whether a game
  takes spectators.
- **Replays** (`#/replays`, see below): published games anyone can watch from
  a link, linked from the Hall of Fame boards and keeper pages.

Browser players play each other; desktop KeeperFX uses UDP, which browsers
cannot.

### Cloud saves

A signed-in player's saves follow their account: a save made in one browser
can be loaded in another. The bar above the game says where the saves are
("Saved to your account", "Syncing saves…", "Offline: saved in this
browser"); clicking it, or **Saves** in the account dialog, lists them with
their size and date, to download (export) or delete, plus the versions that
were replaced. **Import save files** takes files from the `save` folder of
desktop KeeperFX (`fx1g0001.sav`, campaign `.cid` files, `settings.toml`);
saves from another game version are offered too, and the game says if it
can't load one.

- **What syncs**: the files the game writes to `save/`: save slots
  (`fx1gNNNN.sav`), autosaves (`fx1auto1.sav` ... `fx1auto3.sav`), the
  continue link (`fx1lastf.sav`), campaign progress
  (`<campaign>.cid`), campaign high scores (`*.dat`) and `settings.toml`
  without the lines that belong to one machine or are set by the page
  (`player_name`, `lobby_name`, `reconnect_token`,
  `switching_vidmodes_index`). Never the Dungeon Keeper files or music
  (`/persist/dk`, `/persist/music`), replays or screenshots; the server
  accepts only those save file names.
- **When**: before the game starts (the game reads its saves at start), when
  the player signs in, and a few seconds after the game writes a file. The
  page looks at the save folder every 2 s in memory; the server is only
  called when something changed (and once per page load).
- **Conflicts**: every file has a revision on the server, and the browser
  remembers which one it last agreed on (`/persist/cloudsaves.json`). An
  upload names that revision and is refused if another browser has replaced
  the file since, so an old tab or a device that was offline can never
  overwrite newer saves. Then: a save slot changed in two places keeps both
  (one moves to a free slot, and the player is told); campaign progress
  changed in two places is a question for the player at the next game start
  ("This browser" or "Your account"); the continue link, high scores and
  settings take the newest. During a game, files the game may hold in memory
  (campaign progress, settings) are not replaced; that waits for the next
  start.
- **Signing in with saves already in the browser** (a guest, or a browser
  that synced with another account): the player is asked whether those saves
  go to the account or stay in this browser only. A new, empty account in a
  browser no account used just takes them. Until the player answers, nothing
  in the browser changes.
- **Nothing is thrown away**: what a download replaces is copied to
  `/persist/cloudbackup` (the last 30), and the server keeps one previous
  version of a file that is deleted or replaced by a browser that had not
  seen it.
- **Limits** (`web/server/src/saves.js`): 8 MB per file (a save is about
  0.25 MB early in the campaign), 64 MB and 200 files per player, 240
  uploads and deletes per player and hour. The files are in a private R2
  bucket (`SAVES`), with an index in D1 (`0011_cloudsaves.sql`). A save costs
  one Worker request and one R2 write per file the game changed (usually the
  slot and the continue link); opening the page costs one request.

Without the `SAVES` binding the API answers 501 and the page hides it all.

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
- On the page, `web/kfx_loader.js` starts the game (`window.KFX`),
  `web/kfx_site.js` is everything around it: the pages, sign-in, lobbies,
  tavern and records, `web/kfx_workshop.js` is the workshop, and
  `web/kfx_quickmatch.js` is Find a game; its server side is
  `web/server/src/quickmatch.js`, which runs inside the tavern. `web/kfx_cloudsaves.js` syncs the saves
  with the account (`web/server/src/saves.js`). `web/kfx_offline.js` is the app part (service worker,
  install, offline downloads).

  tavern and records; `web/kfx_rejoin.js` handles dropped connections
  (below).
- In the game, `src/kfx/platform/web/NetWebSP.c` is the network transport
  (`struct NetSP`, as `bflib_enet.cpp` is for UDP) over that WebSocket, and
  `NetMatchmakingWeb.c` is the lobby list and lobby publishing. The game's
  multiplayer code (lockstep, resync, lobbies) is unchanged, except that
  gameplay packets are sent once instead of three times: the relay never
  loses them.
- Passwords are stretched in the browser (PBKDF2-SHA256, 600,000 rounds) and
  the server keeps a salted hash of the result, so it never sees them.

### Replays

The game records every level it plays (`AUTOMATIC_REPLAYS=ON`, the default:
`replays/{campaign,freeplay,multiplayer}/<date>_..._map<N>_v<version>.fxpkt`,
the newest `MAX_REPLAYS` of each kind), and in the browser those files are
kept in IndexedDB with the saves. A replay holds the start of the level and
every keeper's orders, turn by turn; it is written as the game goes (flushed
each turn), with a checksum of the game's state every turn. `-packetload
<file>` plays one back: the game runs the level again from those orders and
logs "Out of sync" when the state stops matching. So a replay only plays as
it happened on the same engine with the same rules data (configs, creature
and map files); any change to either makes it drift.

On the site (`web/kfx_replays.js`, server side `web/server/src/replays.js`):

- **Recording** is automatic, as above. The page tags each new recording with
  its build id: the engine (a hash of `keeperfx.wasm`, the `kfx-engine` meta
  tag from `web/stamp-version.py`) and the rules (a hash of the manifest
  entries under `fxdata/`, `creatrs/`, `levels/`, `campgns/`, `multiplayer/`
  other than pictures and sound). Recordings made before this feature have no
  tag; they can be watched locally with a warning but not published.
- **Publishing**: when a level ends, a toast over the game offers **Publish
  replay** (signed-in players; the file as it is at that moment). Older
  recordings are under "Recorded in this browser" on `#/replays`. The upload
  carries the level, result, score, length, players (from the lobby, for
  online games), game version and build id; it goes to R2 (`DATA` bucket,
  `replays/<id>.fxpkt`) with a row in D1 (`replays`,
  `migrations/0012_replays.sql`). The tavern announces it.
- **Watching**: `#/replay/<id>` shows the replay and whether it matches the
  site's current build. **Watch** starts the game with `-packetload
  watch/<id>.fxpkt -q` (`KFX.start({mode: 'replay'})`); a first-time viewer is
  asked for their Dungeon Keeper folder first and the replay then starts by
  itself. When it ends the page offers to watch again. During playback the
  page reads the game's log and says so if the game reports "Out of sync".
- **Version drift**: a replay from another build is not started from its
  page; it says why, offers the file (for the KeeperFX version named on the
  page) and a "play it anyway" link. Results are never sent to the Hall of
  Fame from a replay or while spectating.
- **Limits** (vars in `wrangler.jsonc`): files up to `REPLAY_MAX_MB` (8 MB; a
  short level is tens of KB, about 20 KB a minute early on, and the game's own
  cap is `REPLAY_MAX_SIZE`, 32 MB), at most
  `REPLAY_MAX_PER_USER` (40) replays and `REPLAY_USER_MB` (64 MB) per keeper,
  `REPLAY_PER_HOUR` (12) uploads an hour, and `REPLAY_TOTAL_MB` (4 GB) for
  all replays together, well inside R2's free 10 GB with the game data. The
  same file is never stored twice for a keeper. The server checks the file is
  a KeeperFX replay (`KFXS` magic and a `REPL` chunk) and that the details are
  plausible; like the Hall of Fame, they come from the player's browser.
  Keepers (and `ADMIN_USERS`) can remove their replays.
- **Cost**: listing and opening a replay are one Worker request and a D1 read
  each; the file is served by the Worker from R2 once per edge location and
  then from Cloudflare's cache (`immutable`). Nothing polls: "Live now" is
  drawn from the lobby list the page already keeps up to date through the
  tavern. Spectators use the lobby relay like players: the host's game sends
  each spectator its turns, which adds about one relay message per spectator
  per turn to that game's Durable Object traffic.

Traffic: a two-player game sends about 25 messages a second per player
through the relay, which the Workers free plan (100,000 Durable Object requests
a day, incoming WebSocket messages counted 20:1) covers for roughly ten hours of
two-player games a day; Workers Paid lifts that.

### The Workshop

`#/workshop` lists the [KeeperFX Workshop](https://keeperfx.net/workshop) on
keeperfx.net: search, categories, sorting, and a page per item with its
screenshots, description, author, rating and a link back to keeperfx.net.
**Add to my game** downloads an item into the browser; **Play** starts one of
its maps straight away (`-campaign <pack> -level <n>`, against computer
keepers for multiplayer maps); **Host online** opens a lobby with the map that
starts once enough keepers have joined (`-server -waitusers N -campaign <pack>
-level L`); when that level ends everyone goes back to the menus like any
multiplayer game (in the browser, `-level` with `-server` or `-connect` no
longer means single-level mode, which closed the game at the end of the
level); **Remove** deletes it.
Campaigns are started from the game's own Campaigns menu, so they keep their
story, land view and saves.

What installs:

| Kind | In the browser |
|---|---|
| Maps, map packs, multiplayer maps and packs | Yes |
| Campaigns | Yes (up to 128 MB per download) |
| Mods, creatures, applications, other | No: they need hand edits to the game's own files, or are desktop programs. The page says so and links to keeperfx.net. |

How an item is laid out (`web/kfx_workshop.js`): the archive (zip, 7z or rar,
unpacked by [libarchive.js](https://github.com/nika-begiashvili/libarchivejs),
`web/vendor/`, loaded only when needed) is placed as desktop KeeperFX would
have it. A map pack or campaign `.cfg` in the archive (one with
`LEVELS_LOCATION`) decides where its folders go under `levels/`, `campgns/`
or `multiplayer/`. Loose map files, which desktop players copy into an
existing pack, get a map pack of their own instead: `levels/ws<id>.cfg` or
`multiplayer/ws<id>.cfg`, named after the item and copied from the pack their
folder names (e.g. `classic`), else `standard`/`modern`. Nothing replaces a
file of the game itself, and two items may not share a file. Lua scripts are
checked for LuaJIT-only features (`ffi`, `goto`), which the browser's Lua 5.1
lacks; the item page warns when it finds them.

Installed files are kept in their own IndexedDB database
(`keeperfx-workshop`), not in `/persist`, so a second tab saving its
`/persist` cannot drop them. At start the loader lists them in `/kfx` as lazy
placeholders like the game data (`kfxws:<id>/<path>` URLs), read when the game
opens them.

Online: the host's page adds `workshop=<id>.<file>,...` to the lobby (the map
picked on the workshop page, or else every installed multiplayer item), the
relay puts it in the lobby's metadata, and a joiner's page installs exactly
those versions before the game connects. The lobby list and invites show
them. Someone joining from the game's own lobby list instead is told to get
the maps first, with a button that joins again through the page. The game's
check that all players' loaded files match the host's still applies.

The Worker (`web/server/src/workshop.js`) reaches keeperfx.net for the page,
which cannot itself (no CORS there):

| Route | Upstream, caching |
|---|---|
| `GET /api/workshop/catalogue` | keeperfx.net's `/api/v1/workshop/search` with a blank query (every item, about 1 MB), passed through unparsed; refreshed at most every 6 hours per Cloudflare location, with a copy in R2 for when keeperfx.net is down |
| `GET /api/workshop/item/<id>` | `/api/v1/workshop/item/<id>` (files) and the item's page (screenshots); 1 hour |
| `GET /api/workshop/file/<id>/<file>` | `/workshop/download/...` once, then kept in the private R2 bucket `keeperfx-workshop` (binding `WORKSHOP`); served only while keeperfx.net still lists the file |

Every request to keeperfx.net carries a `KeeperFX-Web/1.0` User-Agent naming
this site. Screenshots load from keeperfx.net directly. Do not give the
`keeperfx-workshop` bucket a public domain: files must only go out while
keeperfx.net offers them.

### Quick match

The queue lives in the tavern Durable Object and uses the WebSocket every page
already has open to it, so it needs no new connection, no polling and no
binding: queued players are marked on their sockets' hibernation attachments
(closing the tab takes a player out of the queue), and matches and open seats
are kept in the tavern's storage. The protocol is described at the top of
`quickmatch.js`.

- Matching happens whenever someone joins or leaves the queue, oldest first.
  **2 keepers** pairs with anyone; **Any size** players are grouped together
  (up to 4), or with a 2-keeper player when no one else is there. A match
  needs one player who can host: a player without their Dungeon Keeper files
  yet can queue and join (the game starts once the files are added) but is
  never made host, so two such players are not matched with each other.
- The host's page starts the game with an unlisted lobby
  (`/api/rooms/host?unlisted=1&qm=<match>.<token>`). As soon as that lobby
  exists the Worker tells the tavern, which sends its code to the others; they
  are never told to join a lobby that is not there yet.
- A player whose game is running (they queued, then played solo meanwhile) is
  asked before it is left; the page reloads and picks the match up again.
- If the host leaves, fails to open the lobby, or takes too long (the others
  give up after three minutes), the others go back in the queue in their old
  place. If everyone else leaves before the lobby opens, the host's lobby is
  kept open for the next player who looks.
- An **Any size** lobby with room keeps taking quick-match players until its
  game starts. After 90 seconds alone in the queue a player is offered to
  open a public lobby instead; it is listed as usual, and quick match sends
  the next players to it.
- **The game starts by itself.** The host's page runs the lobby
  (`web/kfx_quickmatch.js`, "Automatic start"); the engine only carries out
  its orders (below). The rule:
  - **2 keepers**: the lobby is capped at 2 players and starts as soon as the
    second keeper is in.
  - **Any size**: capped at 4. It starts when 4 are in; otherwise once every
    matched keeper is in (one who has not arrived 60 s after the lobby
    opened is not waited for), 20 s after the last keeper arrived, or 45 s
    while the tavern says other keepers are looking (quick match sends them
    to this lobby while it has room).
  - Then a 10 s countdown, shown over the host's game ("starting River sides
    (2 keepers) in 7 s", with **Cancel**) and said in every player's lobby
    chat at 10 and 5 s. Cancelling (or **Pick the map myself** while it
    waits) leaves the lobby to the host, as before. A keeper arriving or
    leaving during the countdown starts it again, with a map for the new
    number; below 2 it waits again.
  - The map is a random one of Bullfrog's original multiplayer maps, the
    "Bullfrog levels" pack (`multiplayer/original`, classic rules), made for
    exactly that many keepers: levels 50-59 for 2, 60-69 for 3, 70-79 for 4.
    They come with every KeeperFX install, so every player has them.
  - A public lobby opened after a long wait (above) starts the same way, as
    does a lobby the matched keepers left before it opened.
- **After the level** everyone lands where a normally started multiplayer
  game ends: the level statistics, then the game's Online Lobbies screen;
  the game keeps running, and Find a game works again from the site.
- **The page and the engine**: on each frame of the game's online lobby
  screen the engine calls `Module.kfxOnLobby({players, maxPlayers, host,
  coloursConflict})` (`src/kfx/platform/web/WebLobby.c`, `web/kfx_web.js`);
  the page may answer with one order for the host's game: `say <text>` (a
  chat line from the host), `start <pack> <level>` (what the host typing
  `<pack>:<level>` in the lobby chat does) or `max <n>` (cap the lobby; not
  saved in the player's settings, and dropped when the next lobby opens). An
  engine without the hook never calls it; the page then says to pick a map
  and press Start, as before, so older builds keep working and
  `KFX_WEB_API` stays 1.

Cost on the free plan: queueing is one WebSocket message per player (1/20 of
a request), plus one when the game's state changes while queued. A match costs
the tavern one Durable Object request when the host's lobby opens, and the
quick-match lobby another when its game starts and when it closes; sending a
player to an open seat first asks that lobby whether it has room (one request).
So a two-player match costs about three requests, against roughly 170 a
minute of play for the game itself through the relay.

### Dropped connections

A network blip, a laptop going to sleep or a reload no longer has to end an
online game.

- **Short drops resume by themselves.** The game's WebSocket is a resumable
  link (`web/kfx_web.js` and `web/server/src/room.js`, "Resumable links"):
  every frame carries a sequence number and an acknowledgement, both ends
  keep what the other has not acknowledged, and when the socket drops the page
  reconnects with the link's id and secret (backoff 0.5, 1, 2, then every 3 s,
  for up to 90 s) and both resend what was missed. The game only sees a pause.
  The page shows "Reconnecting…" over the game.
- **A joiner's seat is held.** While a joiner is away the relay keeps their
  connection number and tells the host (`LINK_DOWN`); the host's game waits
  15 s for them (`PEER_TIMEOUT_MS`, as ENet does on the desktop), showing the
  game's own "waiting for" countdown, with the game held up for everyone in
  the meantime. If they are not back by then it times them out like the
  desktop build: the game **pauses**, the computer takes over their keeper,
  and the seat stays open for their return until that keeper is defeated or
  the level is decided. A page that says goodbye (below) is let go at once,
  without the pause.
- **A dropped player does not decide the game.** For a grace period
  (`REJOIN_GRACE_SECONDS`, default 180) a dropped human's keeper still
  counts as an opponent, so a one-against-one game is not won by the drop.
  See "Rejoin grace" below.
- **Rejoining after a reload or a crash.** The page remembers the lobby
  (`localStorage` `kfx.rejoin`) and offers "Rejoin your game" on the home,
  lobbies and start pages, and on the stage after a lost connection (with a
  10 s countdown). The game then joins as a spectator and the host gives the
  keeper back (`src/net_spectator.c`: seat, then a resync of the whole game).
  An invite link reloaded by a player of that game rejoins too.
- **Only the same player gets the seat back.** For a resumed link the relay
  checks the link's 128-bit secret, which only that page has. For a rejoin
  the host compares the game's own reconnect token: a random 64-bit number
  that each browser keeps in its `save/settings.toml` and sends at login. A
  different browser that tries the same lobby becomes a spectator (when the
  lobby allows them) or is turned away; it never gets the keeper.
- **A host's lobby is held for 60 s.** When the host's connection drops the
  relay keeps the lobby and the joiners' connections, buffers their traffic,
  and tells them ("Host disconnected, waiting for them to come back"); a
  Durable Object alarm ends the lobby if the host is not back in time. The
  host's page resumes exactly as a joiner's does. A host whose page was
  reloaded or closed cannot come back (the game exists only in that page;
  there is no host migration), so a page that is going away says so first
  (`{"type": "bye"}` on `pagehide`) and the lobby closes at once, as before.
  Joiners' pages say goodbye the same way, so a reload hands their keeper to
  the computer at once instead of holding everyone up for 15 s.
- **Silent connections.** A page pings when it has sent nothing for 5 s
  (from a worker's timer, which browsers do not slow down in background
  tabs, so a hidden tab is never taken for gone); the runtime answers
  without waking the Durable Object. A socket the relay has heard nothing
  from for 15 s, and a page that has heard nothing for 15 s, count as
  dropped: a laptop that went to sleep without closing its connection.

Limits: unacknowledged frames live in the Durable Object's memory. If it is
restarted (a deploy, an eviction) while a link is down, or a page falls more
than 16 MB behind, the resume is refused (close 4410): a joiner then rejoins
through the game, a host's game carries on alone. Deploying the Worker
therefore still ends the games in progress.

#### Rejoin grace

When a human's keeper is handed to the computer (timed out or left), it
becomes a *placeholder*. Without a grace period the engine counted
placeholders as gone (`all_dungeons_destroyed` skipped them), so in a
one-against-one game the remaining player won the moment the other dropped,
and there was nothing left to rejoin.

- **How long**: `REJOIN_GRACE_SECONDS` in `keeperfx.cfg` (0 to 3600; the
  browser build's default is 180, the desktop's 0, which is the old
  behaviour). Only the host's value counts: it goes into the host's user
  preferences in game turns (`UPref_RejoinGraceTurns`, `src/user_prefs.h`),
  which every player and the replay receive at the start. On the site:
  `?cfg=REJOIN_GRACE_SECONDS=40` for a host.
- **Deterministic**: the drop is processed in sync with the simulation (the
  leave packet), and sets `PlayerInfo.rejoin_deadline_turn` to that game turn
  plus the grace (saved and resynced like other player fields). Until that
  turn the placeholder counts as an opponent (`placeholder_awaiting_return`,
  `src/player_utils.c`); nothing reads the clock. Game turns stop while the
  game is paused, and so does the grace.
- **Meanwhile the computer plays the keeper**, as before (it was already
  what a dropped keeper did). Pausing the whole game for minutes would hold
  the remaining player hostage, and a keeper that does nothing could be
  walked over: the computer defends the dungeon at about the strength of a
  human, and gives it back when the player returns (`seat_network_user`).
  The timeout still pauses the game once, so the remaining player chooses
  when to go on.
- **The remaining player** sees "Keeper X disconnected: waiting 2:41 for them
  to return" (with "(game paused)" while paused) under the paused message.
  If X rejoins in time (the site's "Rejoin your game"), the keeper is theirs
  again and the game goes on. If not, the placeholder stops counting when
  the grace runs out and the usual victory check decides: on a map whose
  script wins by `ALL_DUNGEONS_DESTROYED` (all of the original multiplayer
  maps), the remaining player wins then. Leaving earlier (quitting the
  level) records nothing, neither win nor loss.
- **The host** cannot come back (no host migration), so when the host is
  lost every placeholder stops counting at once, as before.
- **Hall of Fame**: a result counts dropped humans' keepers as humans (so a
  win by expiry is an online game like any other), and its statistics say
  how many of them had not come back (`keepersDropped`). A player who
  rejoined reports their own result as usual when the level ends.
- **Replays and spectators** see the same: the grace and the deadline are
  part of the game state, and the notice is drawn for anyone watching.

Cost: the link adds no messages while a game runs (the acknowledgements
ride on the game's own frames). A page that only listens (a spectator) sends
a bare acknowledgement every 128 frames or 5 s, about one message every
five seconds; an idle page sends one ping per 5 s, answered by the runtime
(an auto-response, which does not run the Durable Object). Each resume
attempt is one request, each dropped host one alarm, each dropped player one
storage write, and a page that remembers a game asks `/api/lobbies/<CODE>`
when it opens (and at most every 10 s on navigation). Nothing polls.

### Running the Worker

```sh
cd web/server
npm install
npm run dev            # local: http://127.0.0.1:8787, with local D1 and Durable Objects
```

To deploy, create the D1 database and the workshop's R2 bucket once (put the
database id in `wrangler.jsonc`), then:

```sh
npx wrangler d1 create keeperfx
npx wrangler r2 bucket create keeperfx-workshop   # private; see "The Workshop"
npx wrangler d1 migrations apply keeperfx --remote
npx wrangler deploy
```

Run the `migrations apply` step again whenever `web/server/migrations` gains a
file (the Hall of Fame tables are `0002_scores.sql`, cloud saves
`0011_cloudsaves.sql`), before `deploy`. Cloud saves also need their private
R2 bucket, once: `npx wrangler r2 bucket create keeperfx-saves` (no public
domain: it is only read through `/api/saves`).

file (the Hall of Fame tables are `0002_scores.sql`, replays
`0012_replays.sql`), before `deploy`. Replays are stored in the R2 bucket
bound as `DATA`.

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
- **Keyboard**: SDL reads keys from the window, whatever has focus, and
  cancels their default action, except keydown while the game takes text (chat,
  a save's name, the high score name), so the browser still makes the keypress
  the text comes from. A page link or button that kept the focus (the Hall of
  Fame link a player clicked during a game, which opened in a new tab) was
  then pressed by Enter: winning a level, Space, then Enter on the high score
  name opened the Hall of Fame again. The rule now (`web/kfx_loader.js`,
  "the game owns it while it runs"): while a game runs, the page keeps the
  keys only in an open dialog and in a text field (the touch keyboard's
  stand-in, the sign-in fields); the game doesn't see those. Any other key is
  the game's: on any other page control its default action is cancelled (the
  typed character is passed to SDL as a keypress) and the focus goes back to
  the canvas. Focus also goes back to the canvas when a game starts, after a
  click on a page control, and when something else moves it to one (a dialog
  closing).
- **Mouse**: outside possession the page places the game's cursor, as it
  does for touch: a capture `pointermove` listener on the window
  (`web/kfx_loader.js`, "The mouse") calls `kfx_web_mouse_point` in
  `src/kfx/platform/web/WebInput.cpp` with the pointer's position across the
  canvas, clamped to it, and whether it counts as inside the game (over the
  canvas, within 24 CSS pixels of its edge, over the stage's black bars, or a
  button pressed on the game still held). Inside sets the cursor and drives
  edge panning (`KFX_WEB_CURSOR_INSIDE`); outside leaves the cursor where it
  is and stops panning. SDL's own motion events are ignored for the cursor
  then (`KFX_WEB_MOUSE_FROM_PAGE` in `bflib_inputctrl.cpp`); its button events
  are used as before. Dragging the small map, where the game puts the cursor
  back in the middle every frame and scrolls by the motion, gets the motion
  (for touch too). When the game grabs the mouse (`LOCK_CURSOR_IN_POSSESSION`,
  or `CAPTURE_CURSOR`), SDL's relative mode asks for the pointer lock, but
  Emscripten defers that request to the next keyboard event; so the page
  locks the pointer itself when `kfx_web_input_context` reports the grab (bit
  32), which the browser allows for a few seconds after the click that
  possessed the creature, and unlocks it when the grab ends. Otherwise SDL
  locks it on the next click on the game, and the page says so.
  `kfx_web_mouse_capture` switches Lock mouse while a game runs. Toasts over
  the game sit at its top and only their buttons and links take clicks.
- **Touch input**: `web/kfx_touch.js` follows the fingers with touch events
  (they keep their coordinates under pointer lock, pointer events don't) and
  keeps them from SDL (capture listeners on `#stage` stop the touch pointer
  events before SDL's canvas listeners). It calls into
  `src/kfx/platform/web/WebInput.cpp`: `kfx_web_touch_point` sets the game
  cursor from canvas coordinates (`WindowSystemSDL::WindowToGame`), or moves it
  relatively in possession, where the game steers by the cursor's offset from
  the centre; `kfx_web_touch_button`/`_wheel` are mouse buttons and wheel steps;
  `kfx_web_touch_pan`/`_rotate` are applied to the local dungeon camera
  (`KFX_WEB_CAMERA_INPUT` in `local_camera.c`) at 65536 / zoom map units per
  screen pixel across, stretched by the camera's pitch up and down. While touch
  is in use the cursor counts as inside the window only while a finger is down
  (`KFX_WEB_CURSOR_INSIDE`), so a tap near the edge doesn't keep scrolling.
  The game finds the tile under the cursor while it draws, so the page waits
  two drawn frames after moving the cursor before it presses a button, and
  holds keys for at least three frames. `kfx_web_input_context` tells the page
  whether a level, possession, a text field or a menu is up.
- **Network**: `net_matchmaking.c` and `net_portforward.cpp` (curl, UPnP) are
  replaced by `src/kfx/platform/web/NetMatchmakingWeb.c`, which also refuses
  socket creation, so Emscripten never tries to reach game or STUN hosts over
  WebSockets; online play uses `NetWebSP.c` (see "Online play").
