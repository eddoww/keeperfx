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
`#/` (home), `#/play`, `#/lobbies`, `#/workshop` (with `#/workshop/<category>`,
`#/workshop/installed` and `#/workshop/item/<id>`), `#/fame` (Hall of Fame, with
`#/fame/levels/<campaign>/<level>` and `#/keeper/<name>`) and `#/guide`. The
lobbies, the workshop and the Hall of Fame need the site's server (see "Online
play"); on plain static hosting they are left out. While a game runs, links to the other
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
- On the page, `web/kfx_loader.js` starts the game (`window.KFX`),
  `web/kfx_site.js` is everything around it: the pages, sign-in, lobbies,
  tavern and records, and `web/kfx_workshop.js` is the workshop.
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
