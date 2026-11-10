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
- The game draws at the size and shape of the space it has, in device pixels:
  the frame (as large as the page allows, from 21:9 to 4:3), the whole tab or
  the screen, and it follows a window being resized or a device being turned.
  A level takes any shape from 3:4 to 32:9; the menus, the campaign map and
  the movies stay between 4:3 and 16:9, the shapes they were drawn for, and
  get black bars in a space of another shape (see "Resolution").
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

**Resolution**: on a touch-only device the game renders at most about 1.2
megapixels (0.8 when the browser reports 2 GB of memory or less), for example
1612x744 on a 2532x1170 phone and 1314x914 on a 1180x820 iPad. Held upright, a
level is drawn at 3:4 at the most (the game's panels scale with the width
there). `?cfg=INGAME_RES=...` (or `FRONTEND_RES`) still overrides it, and then
the game keeps that size.

### Differences from the desktop build

- **Online play is between browsers only**, through the site's own lobby
  server (see "Online play"); LAN play is not available. Skirmish against the
  computer works.
- **Lua 5.1 patched to behave like LuaJIT** instead of LuaJIT, which has no
  WebAssembly backend; see "Lua" under "How it works". Scripts written for
  desktop KeeperFX run unchanged, `goto` included, and `math.random` gives the
  same numbers for the same seed. Lua bytecode differs between the two, so a
  save from a desktop build whose scripts stored compiled functions may not
  load in the browser, or the other way round.
- The display modes in `keeperfx.cfg` are replaced with windowed modes sized to
  the game's frame, and the page changes them as the frame changes (see
  "Resolution" under "How it works"). Builds from before this use the screen's
  size, and the page scales that picture to its frame.
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
| `?build=<id \| version \| channel>` | Run that game version for this visit, e.g. `?build=alpha`, `?build=1.4.0.5603`; `?build=page` runs the engine next to the page (see "Game versions") |
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
  game's setting (`kfx_web_autosave_set`), otherwise it edits the file. In
  the game, the Options panel (Esc) has an "Autosave" bar under its icons:
  left click for the next of off, 1, 2, 5, 10, 15 and 30 minutes, right
  click for the one before. Cloud saves carry `settings.toml`, so a
  signed-in player's choice follows them.
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

(MB here are MiB, as the page shows them.) With game versions on (see "Game
versions") the essentials also count the version's engine (about 9 MB), a
file the data list names under several paths is counted once (the shared data
is stored by content), and the dialog says which version the data is for;
Everything is then about 546 MB. A download can be paused and
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

### Offline play with game versions

With several game versions (next section) the engine is not next to the
page but in `builds/<id>/` on the data bucket, and the page reads
`builds/index.json` to choose one. Offline neither is reachable, so:

- **The index**: the last `builds/index.json` that loaded is kept in
  `localStorage` (`kfx.buildsIndex`, with its URL). When the index cannot be
  reached (offline, a timeout, a server error) the page uses that copy; when
  the server says there is none (404, or `site.json` without `buildsUrl`) the
  copy is forgotten.
- **The engine**: each start online puts the running version's
  `keeperfx.js`, `keeperfx.wasm` and `manifest.json` into the cache
  `keeperfx-engines` (`Versions.cacheEngine()`, from the browser's HTTP
  cache, so no second download), and `sw.js` answers any
  `builds/<id>/keeperfx.js|.wasm|manifest.json` from there first, on this
  origin or the bucket's (they never change). The cache keeps the versions
  used lately (three), the others are deleted.
- **Which version starts offline**: the usual choice (below); if that
  version's engine is not on the device, the newest one used lately that is,
  with a note ("... is not on this device, so this offline start uses ...");
  if none is, the engine next to the page (which the worker precaches). The
  version dialog offline greys out the versions not on the device.
- **The data**: downloads go to `keeperfx-gamedata` by content hash, as for
  a single build. The player's wanted groups are remembered, so when the
  default moves to a newer alpha the next visit with a connection tops them up
  for the new version: only the files that changed (2 to 4 MB per alpha so
  far) plus its engine. Data used only by versions no longer used lately is
  dropped at the next start (the loader keeps the files of the current
  version and of the last three used). The offline dialog lists what is kept
  for **Other game versions** (their engines and files) with a Remove button;
  **Free the space** also removes the engines.
- Offline, `site.json` does not answer either; the builds URL is the one
  stored with the index.

Tested in headless Chromium with the Worker and the builds bucket both
stopped: a chosen version started offline and played level 1; with that
version's engine removed, the next version on the device started; with no
engine on the device, the engine next to the page.
- Not tested: Safari (iOS/macOS) and Firefox. iOS keeps a home screen app's
  storage separate from Safari's, so the data is downloaded again there.

## Game versions

The site can offer several builds of the game side by side: the newest
alpha, older alphas that lobbies or invites still use, and the latest stable
release (1.4.0, through a backport: see "Stable releases"). Players pick one
on the start screen or with the version button in the game's frame bar; the
page remembers the choice.

On keeper.edwindejong.net this is switched on by the Worker var `BUILDS_URL`
(`https://keeper-data.edwindejong.net/builds/`). Everyone gets the newest
alpha unless they picked a version; a pick of the newest of a kind keeps
following it, a pick of an older build stays on that build. Old builds stay
available so old replays play on the engine that recorded them (see "Keeping
builds"). **Rollback**: set `BUILDS_URL` to `""` in `web/server/wrangler.jsonc`
and deploy the Worker; pages then run the engine next to them again, as before
(the page forgets its stored index and the engines it kept for offline
starts). Nothing in the bucket needs to change either way.

Before switching it on, the published builds should be ones made by
`publish-build.py` from this page's era: a build without `"features"` in
`index.json` (any build published before them) gets a page without
Continue and without Workshop mods online (see "Engine features"). The
first published build (alpha 5603, port 271c857) predates both and is
correctly treated so; rebuild the default with the current port before going
live (`web/upstream-build.sh --force`, or the workflow with *force*), then
deploy the Worker.

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
`ver_defs.h.in`). Without them a build says `1.4.0.0`. Which builds play
online together no longer depends on that number but on the network
protocol and simulation versions in `src/net_compat.h`
(docs/multiplayer-compatibility.md); builds from before those versions are
still matched by exact version number, so every build the site offers
carries upstream's own number.

### What can be built

The port on this branch needs SDL3 (master since build 5272, 2026-08-05),
the CMake modules (5267), the platform layer (5276) and the OpenGL renderer
(5389, 2026-09-12). Stable 1.4.0 has none of them: applying the port to
`v1.4.0` conflicts in its very first commit (CMakeLists.txt, the CMake
modules, the sound, platform and renderer files are missing or different;
617 files and about 80,000 lines differ in `src/`). So the stable channel is
built from a backport branch of its own, `web-stable-1.4` (see "Stable
releases"); alpha builds come from this branch.

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

### Stable releases

The stable channel offers the latest KeeperFX release as the KeeperFX team
released it: its own game (simulation, rules, campaigns) and its own
complete data package, with only what a browser needs added. 1.4 is an SDL2
game with a software renderer, so the browser glue of this branch (written
for master's SDL3 platform layer and OpenGL renderer) was carried over by
hand rather than rebased.

**The backport, `web-stable-1.4`**: tag `v1.4.0` plus a few commits:

- `web/WebBuild.cmake` (used when configured with `emcmake`): SDL2,
  SDL2_mixer, SDL2_image and SDL2_net from Emscripten's own ports (SDL 2.32,
  SDL_mixer 2.8.0: what 1.4 shipped with, or close), OpenAL from Emscripten,
  and the same pinned wasm libraries as the alphas (`web/build-deps.sh`; the
  kfx-deps versions of 1.4 and master are the same: Lua 5.1 with the LuaJIT
  compatibility patch, enet6, ffmpeg, astronomy, centijson, spng, zlib). It
  builds only the engine (`build-web/site/keeperfx.js`, `.wasm`).
- The glue from this branch, cut down to 1.4: lazy data download
  (`WebFileSystem.c`), the frame yield after each presented frame, level
  results for the Hall of Fame (`WebReport.c`), online play through the
  site's relay (`NetWebSP.c`, `NetMatchmakingWeb.c` on 1.4's simpler network
  interface: no spectators, no rejoin), the page's mouse and touch calls
  (`WebInput.cpp`, with `CAPTURE_CURSOR` read in the browser build), the
  lobby orders quick match uses (`WebLobby.c`, which starts a map the way
  1.4's own `-level` autostart does: `pack:level` in the lobby chat), the
  keeper name from the page, and the two compile fixes for wasm (no
  `execinfo.h`, no ADPCM tags in Emscripten's OpenAL). `web/kfx_web.js` is a
  copy of this branch's (`KFX_WEB_API` 1), so the engine speaks the page's
  current contract.
- `web/build-info.json`: what the page should know (below).

Nothing of 1.4's game changes; every change is under `__EMSCRIPTEN__` or in
files only the browser build compiles. It reports itself as upstream's
release does: `1.4.0.5136` (`BUILD_NUMBER` = `git rev-list --count v1.4.0`,
`PACKAGE_SUFFIX` empty).

**What stable has and lacks** compared with the alpha: single player,
campaigns, saves (the game's own Save/Load menu), skirmish, the Hall of Fame,
online play between stable players through the relay (hosting, joining,
invites, the lobby list, quick match with its automatic start), Workshop maps
and mods played solo, the uncaptured mouse, edge scrolling, Lock mouse,
touch taps and holds, controllers, offline play. It lacks (the page hides
them for it):

| Lacks | Because | The page |
|---|---|---|
| `autosave` | 1.4 has no autosave and no `-loadgame` | no Continue box, no autosave interval |
| `cloudsaves` | its saves are of another format (below) | its saves stay in the browser; the Saves dialog shows them, local only |
| `replays` | 1.4 records no automatic replays | no "publish replay" after a level |
| `spectate` | 1.4 has no spectators (and so no rejoining) | no watch link; its lobbies publish no spectator places, so the site offers no Watch or Rejoin for them |
| `touchcamera` | the two-finger pan and twist need the alpha's local camera; 1.4 moves its camera by synced packets | the two-finger hint is hidden (pinch zoom still works) |
| `waitusers` | no `-waitusers` | hosting a Workshop map online starts a plain lobby (the host picks the map) |

Also missing: the game's resolution does not follow the frame (no
`kfx_web_set_resolution`: the page scales the picture, as with the first
alpha builds), the OpenGL renderer (1.4 draws in software), a quick-match
lobby cap (`max` is ignored: 1.4's lobby size is fixed), 1.4's lobby takes no
lobby name (it is named after the host), and its saves are large (about
50 MB each in browser storage, the old format).

**Future stable releases**: the workflow finds a new release on keeperfx.net
and builds it with the port for its version: a branch
`web-stable-<major>.<minor>` if there is one (a patch release such as 1.4.1
is merged into `web-stable-1.4`), else this branch (the next release, cut
from a master that has SDL3 and the renderer, should take this branch's
port as an alpha does: merged when it is newer than the port's base, or the
port's commits rebased onto it). If neither applies, the run fails with
`backport-needed` and opens the issue "A new stable KeeperFX release needs a
browser backport branch"; the site keeps its previous stable build. Making
one: branch from the release tag, carry the browser glue over as
`web-stable-1.4` does (its commits show what that takes; start from this
branch's files when the release has the platform layer), add
`web/build-info.json`, push it as `web-stable-<major>.<minor>` and run the
workflow with channel `stable`.

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
4 MiB across five weeks of alphas. See "Keeping builds" for which builds
stay.

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

### Keeping builds

Replays only play back on the build that recorded them, so builds are not
thrown away lightly:

- `publish-build.py add` prunes only when given `--keep-referenced <url>`:
  the site's `/api/replays/builds` (`web/server/src/replays.js`), which lists
  the engine builds published replays were recorded with. Then each channel
  offers its newest three builds (`--keep-count`), plus any marked `keep`
  and the default; an older build a replay needs stays in `index.json` as
  `"archived": true` (the page runs it for a replay, a lobby or a link that
  names it, but does not offer it in the version dialog); the rest are
  retired and, 14 days later, deleted with the data no other build uses. If
  the URL does not answer, `add` stops rather than delete what a replay
  needs. `--keep-referenced none` prunes without asking.
- Without `--keep-referenced` nothing is pruned: every build stays offered.
- The workflow passes it when the repository variable `KFX_SITE_URL` is set
  (`web/upstream-build.sh --site`); it is not set yet, so for now every
  build is kept. Cost: each new alpha adds its engine (8.6 MiB) and the
  data files that changed (2 to 4 MiB so far), about 10 to 13 MiB a build;
  with upstream at about 110 alphas a month (the workflow builds at most one
  every four hours) that is up to about 1.3 GB a month in R2, whose free tier
  is 10 GB. Set `KFX_SITE_URL=https://keeper.edwindejong.net` once that
  matters; archived builds then cost only their own files.

### Engine features

Some page features need the engine's help, and older builds lack it. Each
build records them in `index.json` (`"features"`, found in the source tree
it was built from by `publish-build.py`, or `--features a,b`), and the page
asks `Versions.supports(name)`; a build without the list has none of them,
and the engine next to the page has all the page knows:

| Feature | Needs | Without it |
|---|---|---|
| `loadgame` | `-loadgame` (autosave's Continue) | the start screen shows no Continue box (the game's own Continue Game still works) |
| `mpmods` | `-mpmods` (Workshop mods online) | lobbies are hosted and joined without the player's mods (an engine without `-mpmods` refused the whole command line) |

Engine exports the page checks for itself (autosave, resolution, mouse,
`kfxOnLobby` for quick match's automatic start) need no entry.

A build made for an older release also says what it **lacks** of what the
page otherwise assumes (`"lacks"`, e.g. `["autosave", "cloudsaves",
"replays", "spectate", "touchcamera", "waitusers"]` for stable 1.4; see
"Stable releases"), and whether its **saves** are of another kind than the
alpha builds' (`"saves": "1.4"`). Both come from `web/build-info.json` in
the port branch it was built from (or `publish-build.py add --lacks/--saves`);
a build without them lacks nothing and shares the alpha builds' saves, so the
builds published before keep working as they did. `Versions.supports(name)`
answers for both kinds (`loadgame` and `mpmods` must be listed; any other
name is there unless lacked), and the page sets `body.lacks-<name>` for CSS.

### Choosing and switching

`web/kfx_versions.js` decides which build a visit runs: `?build=` in the
address, else the version of the lobby an invite (`?join=CODE`) leads to,
else the player's choice (a channel, which follows its newest build, or one
exact build), else `index.json`'s `default` (a channel or build id; `alpha`
now, so the newest alpha). If the index cannot be loaded, is empty or lists
no build this page can run, the page runs the engine next to it (the site's
own build), so a fault in the bucket never stops the site. The start screen shows the version, what changed upstream (the
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

- **Saves and settings** are shared by all alpha versions (`/persist/save`).
  A build with `"saves"` in `index.json` (stable 1.4: its game writes the
  same file names, `fx1g0001.sav`, `fx1contn.sav`, `settings.toml`, in its
  own format) keeps saves, settings and campaign progress in a folder of its
  own, `/persist/save-<saves>` (`Versions.saveDir`): switching between the
  two asks first ("Stable 1.4.0.5136 keeps its own saves ... Switch?"), and
  the other version's files stay untouched for when the player switches back.
  Those saves are not sent to the account (cloud saves only carry the shared
  folder) and are not part of the version-switch backups below.
- Between alpha versions, saves use a self-describing format (`src/kfx/save/FORMAT.txt`) that reads
  across builds: tested both ways between 1.4.0.5601 and 1.4.0.5603 (which
  changed the format, minor 9 to 10): each loads the other's saves of a
  campaign level with a "made by version" warning. Saves from builds before
  5523 (2026-10-18) cannot be read by any later build, but no web build is
  that old. Fields a version moves can be lost (5603 moved the things in a
  keeper's hand), so before a different build first runs the page copies the
  saves to `/persist/backups/<previous build>` (the last three); the version
  dialog can put them back. The start screen's **Continue where you left
  off** says when the save was made by another version ("made with version
  1.4.0.5601, this is 1.4.0.5603"); it loads, with the game's own warning.
  Autosaves and cloud saves are the same files, so they behave the same.
- **Online play** needs builds that can play together: the same network
  protocol range and simulation version (`netCompat`, "<oldest>-<protocol>/<sim>",
  docs/multiplayer-compatibility.md). Each build in `index.json` records its
  key (`web/publish-build.py` reads it from the build's `src/net_compat.h`;
  the engine next to the page has the `kfx-net-compat` meta tag), and a hosted
  lobby publishes it with its metadata. Joining a lobby whose key is
  compatible with the running build needs no switch; otherwise the page
  reloads into a compatible build (the lobby's own if the site offers it).
  Lobbies, builds and pages without a key (older ones) need the exact build,
  as before: a hosted lobby records its build, invite links carry `&build=`,
  and older links without it resolve to the lobby's version. If a player
  still reaches a lobby it cannot play with (the game's own lobby list shows
  them all), the game refuses: "The host runs a game version with different
  game rules", or "The host is using a different game version" (with a
  1.4 host, the lobby shows the version mismatch and the game does not start). Lobbies of
  a build the site no longer offers are shown but not joinable. A lobby
  hosted with the engine next to the page records `build=page`.
- **Quick match** pairs keepers who can play together: compatible keys
  (`web/server/src/netcompat.js`), or the same build for pages without one
  (the page sends `build` and `compat` with `qm-join`; seats keep those of
  their lobby). The "keepers looking" count is still everyone's.
- **Game data** is cached in the browser by content hash, so a switch only
  downloads the files that differ (3 files to start level 1 on 5601 after
  5603), and the cache keeps the data of the last few versions used.
- **Hall of Fame** results record the version that played them (shown with
  recent games), stable's included. The boards are shared by all versions.
- **Replays** record the build (below, "Replays"); watching one loads that
  build when the site still has it.
- **Workshop** items are data, so they work with every version; Workshop
  mods in online lobbies need an engine with `-mpmods` (see "Engine
  features").

### Following upstream automatically

`.github/workflows/web-upstream.yml` runs every four hours (and by hand):
for each channel, the newest alpha and the latest stable release
(`KFX_CHANNELS`, default `alpha stable`), it asks keeperfx.net for the
newest build, compares it with the deployed `builds/index.json`
(`web/upstream-build.sh --check`), and for each the site lacks (or has from
an older port revision) runs `web/upstream-build.sh`, one channel after the
other, which

1. picks the port for the channel (`--port auto`): this branch for an
   alpha; for a stable release the branch `web-stable-<major>.<minor>` if
   the repository has one (the workflow fetches `web-stable-*`), else this
   branch;
2. brings it onto that upstream commit: a backport branch takes a later
   release of its line by a merge; this branch merges a newer upstream in,
   or has its commits rebased onto an older or unrelated one (exit 10 if it
   no longer applies, naming the conflicting files; for a stable release
   with no backport of its own, status `backport-needed`),
3. compiles it with upstream's build number (exit 11 on errors),
4. packages the data: for an alpha, the latest complete release with that
   alpha's patch laid over it, as desktop players have it; for a stable
   release, its own complete package (exit 12),
5. adds it to the layout and loads it, with this branch's page (the page
   players get, whichever port the engine came from), in headless Chromium
   until it asks for the DK files (exit 13 if it does not; with `--dk` it
   plays a level),
6. uploads it (exit 14 on failure).

The default stays the newest alpha (`index.json` `"default": "alpha"`); a
stable build only becomes the default with `--default stable`.

A failure fails that channel's run and opens (or comments on) an issue in
the fork ("Web build for the newest upstream alpha failed", or "A new stable
KeeperFX release needs a browser backport branch"); the site keeps its
previous builds. The workflow needs this branch on the
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
builds from it. The same for `web-stable-1.4` and a patch release
(`git merge v1.4.1`). Build the stable channel by hand with
`--channel stable` (it finds `web-stable-1.4` itself; `--port` names
another).

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
- **Other game versions**: with game versions on, the engine part of a
  recording's tag is the build id (`1.4.0.5603-18d8d4c5.<rules>`). Watching a
  replay recorded with another build the site still has (offered or
  archived, or the engine next to the page) reloads the page into that build
  and plays it there (`KFX.start({mode: 'replay', build})`); the replay's
  page says so. `GET /api/replays/builds` lists the builds published replays
  need, for the builds pipeline (see "Keeping builds").
- **Version drift**: a replay from a build the site no longer has is not
  started from its page; it says why, offers the file (for the KeeperFX
  version named on the page) and a "play it anyway" link. Results are never sent to the Hall of
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

Every kind installs with one click except desktop programs:

| Kind | In the browser |
|---|---|
| Maps, map packs, multiplayer maps and packs | Yes |
| Campaigns | Yes (up to 128 MB per download) |
| Mods, creatures, "Other" | Yes, as a mod layer (below); switch on and off and order them under **My mods** (`#/workshop/mine`) |
| Applications | No: map editors, launchers and other tools are programs for a computer. The page links to the download on keeperfx.net. |

How an item is laid out (`web/kfx_wslayout.js`, shared with the survey tool
below): the archive (zip, 7z or rar, unpacked by
[libarchive.js](https://github.com/nika-begiashvili/libarchivejs),
`web/vendor/`, loaded only when needed; archives inside it are opened too,
except sprite zips; a download that is no archive is that one file) is
placed as desktop KeeperFX would have it. A map pack or campaign `.cfg` in
the archive (one with `LEVELS_LOCATION`) decides where its folders go under
`levels/`, `campgns/` or `multiplayer/`; one that plays the game's own levels
with its own creatures or rules (its `LEVELS_LOCATION` is a folder of the
game) is a campaign too, and a generic name (`campaign.cfg`) becomes
`ws<id>.cfg`. Loose map files, which desktop players copy into an existing
pack, get a map pack of their own: `levels/ws<id>.cfg` or
`multiplayer/ws<id>.cfg`, named after the item and copied from the pack their
folder names (e.g. `classic`), else `standard`/`modern`. A copy of a campaign
KeeperFX ships itself is reported as already in the game.

Everything that changes the game becomes a **mod layer**, using the engine's
own mod system (`src/config_mods.c`): `mods/<name>/` holds `fxdata/`
(configs, which the engine merges over its own block by block, sprite zips,
`lua/init.lua`), `creatrs/`, `data/` (textures), `sound/`, `music/`,
`keeperfx.cfg`, or a campaign's own `_cfgs`/`_crtr` folders, and
`mods/load_order.cfg` lists the mods in three layers: after the base game,
after the campaign, after the map. Nothing of the game is replaced, so
switching a mod off or removing it leaves the game as it was.

- Items packaged as mods (`mods/<name>/...`) keep their folder name and the
  layer their own `load_order.cfg` gives.
- Items made to be copied over the game ("extract into your KeeperFX folder")
  become `mods/ws<id>/`; a campaign's `_cfgs`/`_crtr` files load after the
  campaign.
- Items with manual steps ("add these lines to magic.cfg / objects.cfg",
  "put the zip in fxdata, the cfg in creatrs, add the name to creature.cfg")
  have them done: config parts (in `.cfg`, `.ini`, `.toml` or `.txt` files)
  go into the config their blocks belong to (`[shotN]` to `magic.cfg`,
  `[objectN]` to `objects.cfg`...), sprite zips to `fxdata/` (a folder of
  frames with its `sprites.json` is zipped), creature files to `creatrs/`,
  and each new creature is added by a small generated `fxdata/lua/init.lua`
  calling `NewCreatureType` in `OnModGameStart_ws<id>`, the way packaged
  creature mods do it, so creature mods never overwrite each other's creature
  lists. The item page says "the author's manual steps are done for you".
- Things the engine does not take from mods are left out and named on the
  item page: replacement sound banks and speech (`sound/*.dat`,
  `campgns/keeporig_rus/`), fonts, `ldata/` pictures. An item that is only
  that is refused.

Which mods are on, and their order, is the player's (`localStorage`
`kfx.mods`). Each start writes `mods/load_order.cfg` for that game
(`Workshop.prepareStart()`); **Start without mods** (start screen, My mods,
and the exit panel after a game with mods crashed) adds `-nomods`. Two mods
that set the same key of the same config block, or add the same creature,
are listed as a conflict (the later one wins), and so are conflicts an author
declares in the description. Links in an item's description that say it
"requires" another item are offered for installation with it (asked once).

Lua scripts are checked for the LuaJIT parts the browser's Lua lacks (`ffi`
and `jit`, which desktop KeeperFX does not give scripts either, and
`string.buffer`); the item page warns when it finds them. No Workshop script
used them in November 2026.

Installed files are kept in their own IndexedDB database
(`keeperfx-workshop`), not in `/persist`, so a second tab saving its
`/persist` cannot drop them. At start the loader lists them in `/kfx` as lazy
placeholders like the game data (`kfxws:<id>/<path>` URLs), read when the game
opens them.

Online: the host's page adds `workshop=<id>.<file>,...,<id>.<file>.m,...` to
the lobby: the map picked on the workshop page (or else every installed
multiplayer item), then the mods ticked in the host dialog, in load order
(".m"). The relay puts it in the lobby's metadata; the Lobbies page, invites,
the watch page and Live now show them, and Join becomes **Install N mods and
join**. A joiner's (or spectator's) page installs exactly those versions,
turns on exactly those mods for that game and starts it with `-mpmods`; mods
added just for a lobby stay off in the player's own set afterwards. Mods that
only change textures, sounds or music stay each player's own. Quick match
lobbies run without mods. Someone joining from the game's own lobby list
(whose game runs with their own set) is told the lobby uses mods or maps, with
a button that joins again through the page.

Upstream turns mods off whenever the game is online (#4664: players with
different mods desynced). `-mpmods` (browser build only, `src/config_mods.c`)
keeps them: the page guarantees the same set, and the engine's check that
every loaded file matches the host's (#5582: configs, creature files, sprite
zips, Lua, maps; not textures, sounds or music) sends a player whose files
differ back to the lobby with the list, e.g. `File differs ... mods/
instant_charge_up/fxdata/rules.cfg (only loaded by host)`. Replays start
without mods.

#### The workshop survey

`web/tools/workshop-survey/` checks the installer against the whole
Workshop. `fetch.mjs` fetches politely (one request at a time with a pause,
`KeeperFX-Web/1.0` User-Agent) into `~/.cache/kfx-workshop-survey/`
(`api/`, `pages/`, `files/<id>/<file>/`), never twice: `node fetch.mjs
catalogue`, `items`, `pages nofiles`, `files all --max-mb 128`.
`survey.mjs` unpacks every cached archive with bsdtar and runs
`web/kfx_wslayout.js` over it with the site's game data
(`~/.cache/kfx-web-base/site/gamedata`): per category, what installs and why
the rest does not; `--legacy [commit]` runs the installer of an older commit
instead; `--json` writes the per-item results.

The Worker (`web/server/src/workshop.js`) reaches keeperfx.net for the page,
which cannot itself (no CORS there):

| Route | Upstream, caching |
|---|---|
| `GET /api/workshop/catalogue` | keeperfx.net's `/api/v1/workshop/search` with a blank query (every item, about 1 MB), passed through unparsed; refreshed at most every 6 hours per Cloudflare location, with a copy in R2 for when keeperfx.net is down |
| `GET /api/workshop/item/<id>` | `/api/v1/workshop/item/<id>` (files) and the item's page (screenshots, whether keeperfx.net marks it as meant for modders and mapmakers, and its files when the API lists none, as it does for most uploads since August 2026); 1 hour |
| `GET /api/workshop/file/<id>/<file>` | `/workshop/download/...` once, then kept in the private R2 bucket `keeperfx-workshop` (binding `WORKSHOP`); served only while keeperfx.net still lists the file |

Every request to keeperfx.net carries a `KeeperFX-Web/1.0` User-Agent naming
this site. Screenshots load from keeperfx.net directly. A local Worker can be
pointed at a mirror with the var `WORKSHOP_UPSTREAM` (tests only). Do not give the
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
So a two-player match costs about three requests, against roughly 135 a
minute of play for the game itself through the relay (two players; see "How
well online play copes" for three and four).

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
- **Silent connections.** A page pings every 2 s (from a worker's timer,
  which browsers do not slow down in background tabs, so a hidden tab is
  never taken for gone); the runtime answers without waking the Durable
  Object, and the answer also measures the page's round trip (see "How well
  online play copes"). A socket the relay has heard nothing
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
five seconds; a page sends one ping per 2 s, answered by the runtime
(an auto-response, which does not run the Durable Object), and reports its
round trip when it changed or every 10 s (one message). Each resume
attempt is one request, each dropped host one alarm, each dropped player one
storage write, and a page that remembers a game asks `/api/lobbies/<CODE>`
when it opens (and at most every 10 s on navigation). Nothing polls.

### How well online play copes, measured

Online play in the browser was measured with a test rig (branch
`net/web-robust-bench`, `tools/netbench/web/README.md`): two to four headless
Chromium pages play a level through a local relay (`wrangler dev`), each
behind its own impaired link (latency, jitter, TCP's head-of-line delay for a
lost packet, a bandwidth cap, outages that stall or reset the connection), a
slow computer, or a page that behaves as a hidden tab. Every keeper is
played by the computer; each page reports turns per second, time spent waiting
for others, input lag, the delay from a player's input to its effect, resyncs,
desyncs and drops. "Before" is `web` at 8fb10fe54 (November 2026) with its
relay; "after" adds the changes below.

One game of 2000 turns per row (100 s at 20 turns a second), one run each,
"before → after". Round trips are a joiner's to the host through the relay;
"waiting" is the most any page spent waiting for others' turns; "input to
effect" is the delay from a player's input to the turn it acts in; relay
messages are what the Durable Object is billed for (20 count as one request).

| Condition | Turns/s | Waiting (s) | Input lag (turns, avg) | Input to effect (ms, median) | Relay messages/s | Bytes/s per link, up |
|---|---|---|---|---|---|---|
| clean (2 players) | 20.01 → 20.01 | 0.3 → 0.5 | 0.97 → 0.97 | 51 → 51 | 52.4 → 44.7 | 2455 → 643 |
| 50 ms round trip | 20.00 → 20.01 | 8.0 → 0.6 | 1.26 → 0.97 | 59 → 51 | 61.2 → 44.8 | 4087 → 659 |
| 150 ms | 19.88 → 19.91 | 2.3 → 1.7 | 3.73 → 2.31 | 200 → 102 | 53.3 → 45.0 | 2630 → 690 |
| 300 ms | 19.58 → 19.63 | 5.1 → 3.2 | 6.45 → 4.19 | 349 → 202 | 54.7 → 44.4 | 2878 → 707 |
| 150 ms, jitter 40 ms | 19.86 → 19.89 | 1.9 → 1.6 | 3.82 → 2.92 | 200 → 151 | 52.8 → 44.7 | 2497 → 697 |
| 150 ms, 3% loss | 19.46 → 18.86 | 4.5 → 10.6 (4.7 in another run) | 8.52 → 8.26 | 450 → 449 | 52.5 → 43.9 | 2425 → 786 |
| joiner at 48 kbit/s, 100 ms | 19.92 → 20.00 | 1.4 → 1.0 | 2.19 → 1.12 | 100 → 51 | 52.3 → 44.7 | 2434 → 662 |
| 2 s outage | 19.45 → 19.45 | 3.2 → 3.3 | 0.97 → 0.97 | 51 → 51 | 52.2 → 43.8 | 2403 → 635 |
| 10 s outage | 17.79 → 17.79 | 12.9 → 13.1 | 0.97 → 0.97 | 51 → 50 | 51.8 → 41.2 | 2247 → 589 |
| 20 s outage | 16.69 → 16.68 | 20.3 → 20.3 | 0.97 → 0.97 | 51 → 51 | 53.6 → 40.3 | 2116 → 573 |
| 10 s outage, connection reset | 18.20 → 18.20 | 10.5 → 10.6 | 0.97 → 0.97 | 51 → 51 | 51.6 → 41.8 | 2273 → 608 |
| slow joiner (+60 ms a turn) | 15.00 → 15.00 | 119.8 → 124.4 | 11.23 → 1.91 | 861 → 197 | 57.9 → 40.0 | 4334 → 1470 |
| joiner's tab hidden for 40 s | 14.42 → 19.86 | 51.4 → 0.9 | 0.97 → 0.97 | 55 → 51 | 53.9 → 44.3 | 3488 → 658 |
| host's tab hidden for 40 s | 14.46 → 19.94 | 41.0 → 1.1 | 0.97 → 0.97 | 55 → 50 | 51.8 → 44.8 | 3369 → 664 |
| 2 forced desyncs (delta resync) | 19.84 → 19.82 | 0.5 → 0.5 | 0.97 → 0.97 | 51 → 51 | 52.4 → 44.4 | 2668 → 893 |
| same, joiner at 128 kbit/s | 19.10 → 19.14 | 4.4 → 4.6 | 1.88 → 1.63 | 101 → 99 | 51.5 → 43.6 | 2703 → 949 |
| 3 players, 100 ms | 19.79 → 19.82 | 2.1 → 2.1 | 2.92 → 2.91 | 150 → 150 | 163.2 → 105.1 | 4262 → 957 |
| 4 players, 100 ms | 19.78 → 19.81 | 2.1 → 2.1 | 2.92 → 2.92 | 150 → 150 | 332.8 → 145.6 | 4794 → 955 |
| drawing (SwiftShader) | 19.94 → 19.97 | 0.7 → 0.6 | 1.17 → 0.97 | 50 → 50 | 53.4 → 44.7 | 2579 → 658 |
| drawing, 150 ms | 19.75 → 19.84 | 2.2 → 1.6 | 3.80 → 2.68 | 200 → 150 | 53.4 → 44.9 | 2599 → 683 |

Every game finished in sync. For comparison the desktop build over UDP
(`tools/netbench`) settles on 1, 2 and 4 turns at 50, 150 and 300 ms.

Reading it:

- **Outages** were already survived (the resumable links); the game stops
  for as long as the network is gone, which nothing can avoid in lockstep. A
  connection that stays up waits for TCP's next retransmission (in the rig's
  model of it, 12.6 s after a 10 s outage); after 15 s of silence the page
  resumes over a new connection instead, so a 20 s outage stops the game for
  20 s.
- **Loss** is the weak spot of a TCP transport: a lost packet holds up
  everything behind it until it is resent (the rig models it as 200 ms plus
  the round trip). At 3% that happens every second or two, and the game
  covers it with a long input lag or waits. Those delays are real, so the cap
  allows them. Only an unordered transport would fix it (WebRTC data channels
  between players, or WebTransport datagrams, which Durable Objects don't
  offer); the desktop build over UDP stays at 1 turn with 5% loss.
- **Drawing**: the test machine draws with software GL, which is slower than
  any real GPU; a frame takes long enough that even a clean link needs 1-2
  turns. With a GPU expect the no-drawing rows.

What changed (engine, `src/kfx/platform/web/NetWebSP.c` and `web/kfx_web.js`,
and relay, `web/server/src/room.js`):

- **Round trips over the relay.** The engine's input lag control and turn
  timing use the round trip to each player (`GetPing`), which only ENet
  measured: in the browser it was 0. So the host's cap on the input lag
  (`input_lag_network_cap`) never applied (a slow computer pushed the input
  lag to its maximum of 12 turns, 600 ms), and a joiner's clock ran a one-way
  delay behind the host's, which roughly doubled the input lag the game
  settled on (4 turns instead of 2 at 150 ms). Now each page measures its own
  round trip to the relay every 2 s (the "ping" the relay's runtime answers
  without waking the Durable Object; the time comes from the message event,
  so a busy page doesn't inflate it) and reports it (`{"type": "rtt", "ms",
  "var"}`); the relay passes a joiner's to the host and the host's to the
  joiners as a `PEER_RTT` frame (op 14), and `GetPing` is the sum of both ends'
  (`web_net_ping`). The lobby and the in-game panel show the ping too.
- **Waiting without spinning.** A page only receives messages while the game
  yields to the browser. A game waiting for a late packet drew a frame at
  most once per turn and spun in between, so a packet that had already
  arrived waited for the next frame (and a core burned meanwhile). It now
  sleeps until the next message arrives (`web_net_wait`, `kfx_net_wait`:
  Asyncify sleep woken by the WebSocket's message event) whenever it did not
  present a frame. The network waits in `NetWebSP.c` (resyncs, the lobby)
  sleep the same way instead of polling every millisecond.
- **Hidden tabs keep their pace.** Browsers wake a hidden tab's timers at
  most once a second, and a game in a background tab woke from a timer for
  every frame and sleep: it played one or two turns a second, and lockstep
  held everyone else to that pace for as long as the tab stayed hidden.
  Sleeps (`emscripten_sleep`, which `SDL_Delay` uses) and a hidden tab's
  frames now wake from a worker's timer, which is not throttled. The game
  keeps drawing in the background, at most 40 frames a second. A tab the
  browser freezes or discards entirely (after a long time hidden, or to save
  memory) still stops; then the relay's silence check and the host's
  15 s wait hand its keeper to the computer, as for a dropped connection.
- **Less traffic.** The WebSocket links never lose a message, so the engine's
  repair history (each player's last 40 turns, compressed, five times a
  second, against UDP packet loss) is only sent while a game waits for
  packets or starts (where a peer may not have been ready). That cut the
  bytes on a link by three quarters. With three or four players the host sent
  its own turn and each player's relayed turn once per recipient; a relay
  that announces `MULTICAST` (op 15, listed in its link message as `"ops":
  [15]`) now gets one message for them all (`sendmsg_multi`, a new optional
  `NetSP` member). The relay is billed per incoming message (20 count as
  one request), so this more than halves the cost of a four-player game (333 → 146
  messages a second; a two-player game went from 52 to 45, about 135
  requests a minute).

**Compatibility.** Nothing in the game's own messages changed, and the
simulation is untouched, so `NET_PROTOCOL_VERSION` and `NET_SIM_VERSION` stay
as they are: builds with and without these changes play together. Between
page and relay, everything new is optional: the relay sends `PEER_RTT` only to
pages that report their own round trip, and `MULTICAST` only exists for
engines that saw it in the link message. Engines published before (alphas,
the stable 1.4 port) never report a round trip and never see either op, so a
new relay serves them as before; a new engine on an old relay gets no round
trips (the cap stays off, as before) and sends one message per recipient.
Checked with the rig
(`compat.mjs`; a game of two or three, 45 s of play, turns flowing on every
page): the stable 1.4 port and the published alpha 5603 on the new relay;
an engine from before as host with a new joiner, and a new host with an old
and a new joiner (MULTICAST to an old joiner); three new engines on the old
relay (one message per recipient, no round trips); a spectator joining a
running game on the new relay.

**Not measured**: real browsers' hidden-tab throttling (headless Chromium
cannot hide a page; the rig applies Chrome's documented rules itself, see
`hidden.js`), Chrome's stronger throttling after five hidden minutes and tab
freezing, Firefox and Safari, Cloudflare's own network and Durable Object
placement (the rig's relay runs locally), and real GPUs (the test machine
renders with SwiftShader, so the drawing rows show a slow computer).

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
  `web/build-deps.sh --only lua <prefix>` rebuilds one of them (Lua is also
  rebuilt by itself whenever its patch changes).
- **Lua**: LuaJIT, which desktop KeeperFX uses, is an interpreter written in
  assembly per CPU plus a JIT, with no WebAssembly target, so the browser
  build uses PUC Lua 5.1.5 with `web/lua51-luajit-compat.patch`. LuaJIT is Lua
  5.1 plus extensions, so the patch adds the extensions rather than moving to a
  newer Lua (5.3 and later have integers: `GetSlab(x/3, y/3)` would raise
  errors there, and numbers would print as `3.0`). What it adds, all as LuaJIT
  2.1 does it: `goto`/labels (Lua 5.2's design, upvalues closed through the A
  field of `OP_JMP`; `goto` stays a valid name when no name follows it);
  LuaJIT's `math.random` generator, per Lua state rather than the C library's
  `rand()` (which the engine reseeds from the clock when a level starts); the
  5.2/5.3 functions LuaJIT has (`load`/`loadfile` with mode and environment,
  `xpcall` arguments, `table.move`, `math.log(x, base)`, `string.rep` with a
  separator, `%a`/`%g`, `\x`/`\z`/`\u{}` escapes, hexadecimal fractions, ...)
  and `require "table.new"`/`"table.clear"`; LuaBitOp is linked in as `bit`.
  Not there: `ffi` and `jit` (KeeperFX does not open them on the desktop
  either), `string.buffer`, `1LL` literals. LuaJIT's newer syntax (bit
  operators, `continue`, `?.`, compound assignment; LuaJIT 2.1 from July 2026)
  is not in the desktop releases either, which link LuaJIT from April 2025.
  Two things still differ from the desktop and cannot be patched cheaply: the
  order in which `pairs()` visits keys (each Lua hashes differently) and error
  message texts. Browser players only meet browser players online, so
  lockstep is not affected, but a desktop replay of a script that acts in
  `pairs()` order may play out differently in the browser.
- **Main loop**: the game keeps its own blocking loop. Asyncify lets it pause:
  after each presented frame it waits for the browser's next animation frame
  (`kfx_web_frame_yield` in `web/kfx_web.js`), and `SDL_Delay` sleeps the same
  way (`emscripten_sleep`, replaced there); in a hidden tab both wake from a
  worker's timer, which browsers do not throttle. A game waiting for the
  network sleeps until the next message arrives (`kfx_net_wait`). The page
  only gets network messages while the game yields. The OpenGL renderer's
  render thread runs inline on the game thread (`RenderThreadManager`).
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
- **Resolution**: the page asks the engine to draw at the size of the stage
  (`kfx_web_set_resolution(game_w, game_h, front_w, front_h)` in
  `src/kfx/platform/web/WebVideo.c`, called from "The game's resolution" in
  `web/kfx_loader.js`), in device pixels, once the stage has kept its size for
  350 ms (so a window being dragged doesn't switch every frame; CSS scaling
  bridges the gap) and not while a button pressed on the game is held. Limits:
  at least 640x480 (the classic size, which the panels fit; a smaller stage
  gets a larger picture scaled down), at most 3840x2160, the touch pixel
  budget above, even sizes. A level follows shapes from 3:4 to 32:9; past
  them the page letterboxes. The engine keeps two windowed modes per use
  (`WEB_GAME_A/B`, `WEB_FRONT_A/B`) and hands them out from
  `get_game_vidmode()`, `get_frontend_vidmode()` and `get_movies_vidmode()`,
  resizing the one that isn't on screen; a level or the front end therefore
  opens at the latest size. In a level the switch happens at once, at the top
  of the gameplay loop (`KFX_WEB_VIDEO_UPDATE` in `game_loop.c`), the way the
  resolution key does it (`setup_screen_mode`, then `reinit_all_menus`): the
  screen buffers, the GUI sprites and the sprite heap are reloaded, which
  takes about one frame. Pause, possession, the map screen and open menus
  carry on; a level still loading picks the size up when it starts. The front
  end (menus, land view, lobby, statistics, movies) lays its screens out once
  when they open, so it isn't switched while open: it gets a size between 4:3
  and 16:9 the next time it opens, and the page scales it with bars
  meanwhile. Resolution is local: drawing, the GUI and the mouse depend on it,
  nothing synchronised between players does (players on different screens
  already play together on the desktop). The framed stage takes the space the
  page has (`site.css`: the column's width and the height under the bar,
  between 21:9 and 4:3); Fill tab pins the frame to the visible tab
  (`position: fixed`), not to `100vh`, which can be taller than what the
  browser shows and left the picture lower than centred. The page uses the
  hook only when the engine exports it and the player has no `INGAME_RES` or
  `FRONTEND_RES` of their own; otherwise the resolution is the screen's, as
  before, and the stage takes the game's shape (`.fixed-shape`).
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
