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

- Click the game to capture the mouse (the browser's pointer lock, like
  `CAPTURE_CURSOR` on the desktop); press Esc to release it.
- Fullscreen: F11, or the button that appears in the top right corner on hover.
- Screenshots (Shift+C) are saved in the browser and also handed to the
  browser as downloads.
- The game data downloads as the game needs it; the files a normal start uses
  are fetched in the background as soon as the page opens. Later visits load
  them from the browser cache.

It needs a browser with WebAssembly and WebGL 2 (current Chrome, Edge, Firefox
and Safari have both; it has been tested in Chromium).

### Differences from the desktop build

- **No online or LAN multiplayer.** Browsers cannot open the UDP/TCP sockets
  it uses, so the page refuses to create any (hosting or joining reports
  "Unable to create game"). Skirmish against the computer works.
- **Lua 5.1 instead of LuaJIT**, which has no WebAssembly backend. It is patched
  with the LuaJIT/Lua 5.2 functions KeeperFX and its scripts use
  (`web/lua51-luajit-compat.patch`) and has LuaJIT's `bit` module, so level and
  campaign scripts behave the same. Mods that use LuaJIT's `ffi` or `jit`
  modules are not supported. Lua bytecode differs between the two, so a save
  from a desktop build whose scripts stored compiled functions may not load in
  the browser, or the other way round.
- The display modes in `keeperfx.cfg` are replaced with windowed modes sized to
  the page; the page scales the picture to the window.

## URL options

| Option | Effect |
|---|---|
| `?args=-nointro%20-level%201` | Command line arguments for the game |
| `?renderer=software` | `RENDERER` setting (`opengl` or `software`) |
| `?cfg=KEY=VALUE;KEY=VALUE` | Override any `keeperfx.cfg` line |
| `?dk=<url>` | Import the DK files from a folder served at `<url>` instead of asking (lower-case names) |
| `?autostart` | Skip the Play button |
| `?debug` | Log each game data download to the console |

A player can keep their own config by storing it as `/persist/keeperfx.cfg`.

## Building

Install and activate the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(tested with Emscripten 7.0), then:

```sh
source /path/to/emsdk/emsdk_env.sh

# 1. Third-party libraries, compiled to wasm from pinned sources (once).
web/build-deps.sh build-web/deps/prefix

# 2. The game. Output: build-web/site/{index.html,kfx_loader.js,keeperfx.js,keeperfx.wasm}
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

`build-web/site` is a static site (about 550 MB, mostly game data in
`gamedata/`). Any static host works, including GitHub Pages; no special headers
are needed (the build uses no threads, so no cross-origin isolation). Serve
`.wasm` as `application/wasm`. Files under `gamedata/` are requested as
`<path>?v=<content hash>`, so they can be cached for a long time.

Do not publish Dungeon Keeper's own files: each player supplies their own.

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
  replaced by `src/kfx/platform/web/NetStubsWeb.c`, which also refuses socket
  creation, so Emscripten never tries to reach game or STUN hosts over
  WebSockets.
