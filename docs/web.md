# KeeperFX 1.4 in the browser

This branch (`web-stable-1.4`) is KeeperFX 1.4.0 (tag `v1.4.0`) with what it
takes to run in a browser, for the stable channel of the browser site
(https://keeper.edwindejong.net). The site, its page and the tools that build
and publish engines live on the `web` branch; its `docs/web.md` ("Game
versions", "Stable releases") is the full write-up. This branch only makes
the engine, `keeperfx.js` and `keeperfx.wasm`, which the site's page runs.

The game is 1.4.0's: its simulation, rules and data are unchanged. Every
change is in a file only the browser build compiles (`web/`,
`src/kfx/platform/web/`) or under `#ifdef __EMSCRIPTEN__`.

## Building

```sh
source ~/emsdk/emsdk_env.sh                       # Emscripten 7.0.0
web/build-deps.sh <prefix>                        # once: Lua, ffmpeg, enet6, zlib, spng, ...
emcmake cmake -S . -B build-web -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DKFX_WEB_DEPS=<prefix> -DBUILD_NUMBER=5136 -DPACKAGE_SUFFIX=
nice -n 19 cmake --build build-web -j 4           # -> build-web/site/keeperfx.js, keeperfx.wasm
web/package-data.py <out> <unpacked keeperfx_1_4_0_complete.7z>   # -> <out>/gamedata/
```

SDL2, SDL2_mixer, SDL2_image and SDL2_net come from Emscripten's ports
(downloaded on the first build). On the `web` branch,
`web/upstream-build.sh --channel stable` does all of it, picks this branch by
its name, and adds the build to the site's builds (`web/publish-build.py`,
which reads `web/build-info.json` here: the page features this engine lacks
and the kind of saves it writes).

## What was added

- `web/WebBuild.cmake`: the Emscripten build (CMakeLists.txt includes it
  under `emcmake`).
- `web/kfx_web.js`: the page/engine contract (a copy of the `web` branch's,
  `KFX_WEB_API` 1), linked into the engine.
- `src/kfx/platform/web/`: lazy game data download (`WebFileSystem.c`),
  level results (`WebReport.c`), online play through the site's relay
  (`NetWebSP.c`, `NetMatchmakingWeb.c`), mouse and touch from the page
  (`WebInput.cpp`), lobby orders for quick match (`WebLobby.c`).
- Hooks: a yield to the browser after each presented frame
  (`bflib_video.c`), the level result (`player_utils.c`), the page's mouse
  (`bflib_inputctrl.cpp`, `bflib_mouse.cpp`, `CAPTURE_CURSOR` in
  `config_keeperfx.c`), the web relay instead of UDP (`net_main.c`,
  `net_lobby.c`), the keeper name the page gives and the lobby orders
  (`front_network.c`), and two compile fixes (`bflib_crash.c`,
  `bflib_sndlib.cpp`).

A later 1.4.x release is merged into this branch (`git merge v1.4.1`).
