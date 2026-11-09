// JavaScript side of the KeeperFX browser build, linked with --js-library.
//
// Lazy game data: the page (web/kfx_loader.js) creates every data file as an
// empty in-memory placeholder carrying `node.kfxLazy = {url, size}`. The
// syscall wrappers in src/kfx/platform/web/WebFileSystem.c ask here whether a
// path is such a placeholder, and download it on first open.

addToLibrary({
  // Yield to the browser after each presented frame, so the canvas is shown
  // and input events arrive. Waits for the next animation frame (the display's
  // refresh, like vsync); in a hidden tab, where animation frames stop, it
  // falls back to a short timeout so the game keeps running.
  kfx_web_frame_yield__deps: ['$Asyncify'],
  kfx_web_frame_yield__async: true,
  kfx_web_frame_yield: () => Asyncify.handleSleep((wakeUp) => {
    Module.kfxFrames = (Module.kfxFrames || 0) + 1;
    Module.kfxOnFrame?.();
    if (document.hidden) {
      setTimeout(wakeUp, 0);
    } else {
      requestAnimationFrame(() => wakeUp());
    }
  }),

  $kfxLazyNode__deps: ['$FS', '$SYSCALLS', '$UTF8ToString'],
  $kfxLazyNode: (dirfd, pathPtr) => {
    if (!Module.kfxLazyPending) return null;
    try {
      var path = SYSCALLS.calculateAt(dirfd, UTF8ToString(pathPtr));
      var node = FS.lookupPath(path, { follow: true }).node;
      return node.kfxLazy ? node : null;
    } catch (e) {
      return null; // no such file: let the real syscall report it
    }
  },

  kfx_web_lazy_size__deps: ['$kfxLazyNode'],
  kfx_web_lazy_size: (dirfd, pathPtr) => {
    var node = kfxLazyNode(dirfd, pathPtr);
    return node ? node.kfxLazy.size : -1;
  },

  kfx_web_lazy_fetch__deps: ['$kfxLazyNode', '$Asyncify'],
  kfx_web_lazy_fetch__async: true,
  kfx_web_lazy_fetch: (dirfd, pathPtr) => Asyncify.handleAsync(async () => {
    var node = kfxLazyNode(dirfd, pathPtr);
    if (!node) return 0;
    var lazy = node.kfxLazy;
    try {
      var data = await Module.kfxFetchData(lazy.url, lazy.size);
      // Another open may have finished the same download while we waited.
      if (node.kfxLazy) {
        node.contents = data;
        node.usedBytes = data.length;
        delete node.kfxLazy;
        Module.kfxLazyPending--;
      }
      return 0;
    } catch (e) {
      err(`KeeperFX: could not download ${lazy.url}: ${e}`);
      return -{{{ cDefs.EIO }}};
    }
  }),

  // ---- Online play (src/kfx/platform/web/NetWebSP.c, NetMatchmakingWeb.c) --
  // One WebSocket to the lobby relay (web/server/src/room.js). Frames are
  // queued here and pulled by the game each update.

  $kfxNet: { ws: null, frames: [], texts: [], state: 0, closeCode: 0 },

  // path: e.g. "rooms/host" or "rooms/ABCDE?role=player". Returns 1 if started.
  kfx_net_open__deps: ['$kfxNet', '$UTF8ToString'],
  kfx_net_open: (pathPtr) => {
    if (kfxNet.ws) { try { kfxNet.ws.close(); } catch (e) {} }
    const path = UTF8ToString(pathPtr);
    const url = new URL(`/api/${path}`, location.href);
    // The page's host options (unlisted lobby), see web/kfx_loader.js.
    if (path === 'rooms/host' && Module.kfxHostQuery) url.search = Module.kfxHostQuery;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    kfxNet.frames = [];
    kfxNet.texts = [];
    kfxNet.state = 0; // 0 connecting, 1 open, 2 closed
    kfxNet.closeCode = 0;
    let ws;
    try { ws = new WebSocket(url.href); } catch (e) { kfxNet.state = 2; return 0; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (kfxNet.ws === ws) kfxNet.state = 1; };
    ws.onmessage = (ev) => {
      if (kfxNet.ws !== ws) return;
      if (typeof ev.data === 'string') kfxNet.texts.push(ev.data);
      else kfxNet.frames.push(new Uint8Array(ev.data));
    };
    ws.onclose = (ev) => { if (kfxNet.ws === ws) { kfxNet.state = 2; kfxNet.closeCode = ev.code; } };
    ws.onerror = () => {};
    kfxNet.ws = ws;
    return 1;
  },

  // 0 connecting, 1 open, 2 closed (and all queued frames read).
  kfx_net_state__deps: ['$kfxNet'],
  kfx_net_state: () => (kfxNet.state === 2 && (kfxNet.frames.length || kfxNet.texts.length)) ? 1 : kfxNet.state,

  kfx_net_close_code__deps: ['$kfxNet'],
  kfx_net_close_code: () => kfxNet.closeCode,

  kfx_net_close__deps: ['$kfxNet'],
  kfx_net_close: () => {
    const ws = kfxNet.ws;
    kfxNet.ws = null;
    kfxNet.state = 2;
    kfxNet.frames = [];
    kfxNet.texts = [];
    if (ws) { try { ws.close(1000, 'bye'); } catch (e) {} }
  },

  kfx_net_send__deps: ['$kfxNet'],
  kfx_net_send: (ptr, len) => {
    const ws = kfxNet.ws;
    if (!ws || ws.readyState !== 1) return 0;
    ws.send(HEAPU8.slice(ptr, ptr + len));
    return 1;
  },

  kfx_net_send_text__deps: ['$kfxNet', '$UTF8ToString'],
  kfx_net_send_text: (ptr) => {
    const ws = kfxNet.ws;
    if (!ws || ws.readyState !== 1) return 0;
    ws.send(UTF8ToString(ptr));
    return 1;
  },

  // Next binary frame: copies up to cap bytes, returns its full length, or -1.
  kfx_net_next__deps: ['$kfxNet'],
  kfx_net_next: (buf, cap) => {
    const f = kfxNet.frames.shift();
    if (!f) return -1;
    HEAPU8.set(f.subarray(0, Math.min(cap, f.length)), buf);
    return f.length;
  },

  // Next text frame as a NUL-terminated string, returns its length, or -1.
  kfx_net_next_text__deps: ['$kfxNet', '$stringToUTF8', '$lengthBytesUTF8'],
  kfx_net_next_text: (buf, cap) => {
    const t = kfxNet.texts.shift();
    if (t === undefined) return -1;
    stringToUTF8(t, buf, cap);
    return lengthBytesUTF8(t);
  },

  // Lobby list: start a GET /api/lobbies; kfx_lobby_take gets the JSON.
  $kfxLobby: { pending: false, text: null },
  kfx_lobby_request__deps: ['$kfxLobby'],
  kfx_lobby_request: () => {
    if (kfxLobby.pending) return;
    kfxLobby.pending = true;
    fetch('/api/lobbies', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null)
      .then((t) => { kfxLobby.pending = false; if (t) kfxLobby.text = t; });
  },
  kfx_lobby_take__deps: ['$kfxLobby', '$stringToUTF8', '$lengthBytesUTF8'],
  kfx_lobby_take: (buf, cap) => {
    const t = kfxLobby.text;
    if (t === null) return -1;
    kfxLobby.text = null;
    if (lengthBytesUTF8(t) + 1 > cap) return -1;
    stringToUTF8(t, buf, cap);
    return lengthBytesUTF8(t);
  },

  // The local player won or lost a level (src/kfx/platform/web/WebReport.c).
  kfx_web_level_result__deps: ['$UTF8ToString'],
  kfx_web_level_result: (jsonPtr) => {
    try { Module.kfxOnLevelResult?.(JSON.parse(UTF8ToString(jsonPtr))); } catch (e) { err(`KeeperFX: level result: ${e}`); }
  },

  // Lets the page show the code of a hosted lobby (invite link).
  kfx_net_hosting__deps: ['$UTF8ToString'],
  kfx_net_hosting: (codePtr) => {
    Module.kfxOnHosting?.(codePtr ? UTF8ToString(codePtr) : null);
  },
});
