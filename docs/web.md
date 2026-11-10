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
- Click the game to capture the mouse (the browser's pointer lock, like
  `CAPTURE_CURSOR` on the desktop); press Esc to release it.
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
lobbies, the workshop and the Hall of Fame need the site's server (see "Online
play"); on plain static hosting they are left out. While a game runs, links to the other

`#/` (home), `#/play`, `#/lobbies`, `#/fame` (Hall of Fame, with
`#/fame/levels/<campaign>/<level>` and `#/keeper/<name>`), `#/replays` (with
`#/replay/<id>`), `#/watch/<CODE>` and `#/guide`. The lobbies, the Hall of
Fame, replays and watching need the site's server (see "Online play"); on
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
| `?join=CODE` | An invite: the start screen offers to join that lobby (`&spectate` to watch) |
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
data in `gamedata/`). Any static host with HTTPS works; no special headers are
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
  by themselves: nobody types a code. The host then picks the map and presses
  Start in the game's lobby screen, as in any lobby; the page says so. Details
  below, under "Quick match".
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
  (`fx1gNNNN.sav`), the continue link (`fx1lastf.sav`), campaign progress
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
starts once enough keepers have joined (`-waitusers`); **Remove** deletes it.
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
- The start is not automated. The game can start a hosted lobby by itself
  (`-server -waitusers N -level L`), but `-level` puts it in single-level mode,
  which quits the game when the level ends; the host picks the map instead.

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
  the level is decided.
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
therefore still ends the games in progress. In a game where every other
human has dropped, the engine counts their keepers as gone
(`all_dungeons_destroyed` skips placeholders), so in a one-against-one game
the remaining player wins as soon as the other is timed out or leaves: only
drops that resume within the 15 s keep such a game going.

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
- **Network**: `net_matchmaking.c` and `net_portforward.cpp` (curl, UPnP) are
  replaced by `src/kfx/platform/web/NetMatchmakingWeb.c`, which also refuses
  socket creation, so Emscripten never tries to reach game or STUN hosts over
  WebSockets; online play uses `NetWebSP.c` (see "Online play").
