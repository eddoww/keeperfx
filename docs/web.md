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
