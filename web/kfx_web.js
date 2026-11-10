// JavaScript side of the KeeperFX browser build, linked with --js-library.
//
// Lazy game data: the page (web/kfx_loader.js) creates every data file as an
// empty in-memory placeholder carrying `node.kfxLazy = {url, size}`. The
// syscall wrappers in src/kfx/platform/web/WebFileSystem.c ask here whether a
// path is such a placeholder, and download it on first open.
//
// Page/engine contract: KFX_WEB_API = 1
// One page (web/kfx_loader.js, kfx_versions.js, kfx_site.js) can run several
// engine builds (web/publish-build.py records this number for each one, and
// the page only offers builds whose number it supports). The contract is what
// the page and an engine expect of each other: the Module hooks used here and
// in the loader (kfxFetchData, kfxLazyPending and node.kfxLazy, kfxHostQuery,
// kfxOnHosting, kfxOnLevelResult, kfxOnFrame, kfxOnLobby), the command line the loader
// passes (-server, -connect CODE, -spectate), the /persist layout and the /api
// routes the engine calls. Raise the number when a change here or in the
// engine needs a page that knows about it, and add it to SUPPORTED_API in
// web/kfx_versions.js once the page handles both.

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
  //
  // The socket is a resumable link (room.js, "Resumable links"): frames carry
  // [seq u32][ack u32], sent frames are kept until the relay acknowledges
  // them, and when the socket drops (network blip, sleep) this reconnects on
  // its own and both sides resend what the other missed. The game sees one
  // unbroken connection that was slow for a while. Changes are announced to
  // the page as `kfx:net` events (web/kfx_rejoin.js):
  //   {state: 'joined' | 'up' | 'reconnecting' | 'host-down' | 'peer-down' |
  //    'peer-up' | 'lost' | 'closed', code, host, role, ...}

  $kfxNet: { ws: null, frames: [], texts: [], state: 0, closeCode: 0, link: null, ticker: null, frozenUntil: 0 },

  $kfxNetEmit: (detail) => {
    Module.kfxNetStatus = detail;
    try { document.dispatchEvent(new CustomEvent('kfx:net', { detail })); } catch (e) { /* no page */ }
  },

  // Link timing (ms). The relay treats a socket silent for 15 s as dropped.
  // A page that only listens (a spectator) acknowledges every ACK_EVERY frames or ACK ms.
  $kfxNetCfg: { PING: 5000, DEAD: 15000, GRACE: 90000, ACK: 5000, ACK_EVERY: 128, MAX_OUT: 32 * 1024 * 1024 },

  // A one-second tick that background tabs do not slow down: a worker's
  // messages are events, not timers, so the browser's timer throttling for
  // hidden tabs does not apply to them.
  $kfxNetTicker__deps: ['$kfxNet', '$kfxNetTick'],
  $kfxNetTicker: () => {
    if (kfxNet.ticker) return;
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'text/javascript' })));
      w.onmessage = () => kfxNetTick();
      kfxNet.ticker = w;
    } catch (e) {
      kfxNet.ticker = setInterval(kfxNetTick, 1000);
    }
    // The page is going away for good (closed tab, reload, navigation): say
    // so, so the relay does not hold the seat for a return that cannot come.
    window.addEventListener('pagehide', () => {
      const ws = kfxNet.ws;
      if (ws && ws.readyState === 1 && kfxNet.link) { try { ws.send('{"type":"bye"}'); } catch (e) {} }
    });
    window.addEventListener('online', () => { if (kfxNet.link) kfxNet.link.retryAt = 0; kfxNetTick(); });
  },

  $kfxNetSendBytes__deps: ['$kfxNet', '$kfxNetCfg'],
  $kfxNetSendBytes: (l, bytes) => {
    const data = new Uint8Array(8 + bytes.length);
    const view = new DataView(data.buffer);
    view.setUint32(0, ++l.outSeq, true);
    view.setUint32(4, l.inSeq, true);
    data.set(bytes, 8);
    if (l.out) {
      l.out.push({ seq: l.outSeq, data });
      l.outBytes += data.length;
      if (l.outBytes > kfxNetCfg.MAX_OUT) { l.out = null; l.final = true; } // too far behind to resume
    }
    const ws = kfxNet.ws;
    if (l.phase === 'up' && ws && ws.readyState === 1 && Date.now() >= kfxNet.frozenUntil) {
      ws.send(data);
      l.sinceAck = 0;
      l.lastSent = Date.now();
    }
    return 1;
  },

  $kfxNetSendAck__deps: ['$kfxNet'],
  $kfxNetSendAck: (l) => {
    const ws = kfxNet.ws;
    if (!ws || ws.readyState !== 1 || l.phase !== 'up' || Date.now() < kfxNet.frozenUntil) return;
    const data = new Uint8Array(8);
    new DataView(data.buffer).setUint32(4, l.inSeq, true);
    ws.send(data);
    l.sinceAck = 0;
    l.lastSent = Date.now();
  },

  $kfxNetTrim: (l, ack) => {
    if (!l.out) return;
    let n = 0;
    while (n < l.out.length && l.out[n].seq <= ack) l.outBytes -= l.out[n++].data.length;
    if (n) l.out.splice(0, n);
  },

  // Relay notices inside the stream, passed on to the page.
  $kfxNetControl__deps: ['$kfxNetEmit'],
  $kfxNetControl: (l, f) => {
    const base = { code: l.code, host: l.host, role: l.role };
    switch (f[0]) {
      case 8: kfxNetEmit({ ...base, state: 'joined' }); break;                        // ACCEPTED
      case 9: l.final = true; l.closing = f.length > 2 ? f[2] : 0; break;              // CLOSING
      case 10: kfxNetEmit({ ...base, state: 'peer-down', conn: f[1] }); break;         // LINK_DOWN
      case 11: kfxNetEmit({ ...base, state: 'peer-up', conn: f[1] }); break;           // LINK_UP
      case 12: kfxNetEmit({ ...base, state: 'host-down', seconds: f.length > 2 ? f[2] : 60 }); break;
      case 13: kfxNetEmit({ ...base, state: 'up' }); break;                            // HOST_UP
      default: break;
    }
  },

  $kfxNetAttach__deps: ['$kfxNet', '$kfxNetCfg', '$kfxNetTrim', '$kfxNetControl', '$kfxNetLost', '$kfxNetResumed', '$kfxNetSendAck', '$kfxNetEmit'],
  $kfxNetAttach: (ws) => {
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (kfxNet.ws === ws && !(kfxNet.link && kfxNet.link.phase === 'reconnecting')) kfxNet.state = 1; };
    ws.onmessage = (ev) => {
      if (kfxNet.ws !== ws || Date.now() < kfxNet.frozenUntil) return;
      const l = kfxNet.link;
      if (l) l.lastIn = Date.now();
      if (typeof ev.data === 'string') {
        if (ev.data === 'pong') return;
        if (l && ev.data.startsWith('{"type":"link"')) {
          const m = JSON.parse(ev.data);
          l.id = m.id;
          l.secret = m.secret;
          return;
        }
        if (l && ev.data.startsWith('{"type":"resumed"')) { kfxNetResumed(JSON.parse(ev.data).ack >>> 0); return; }
        if (l && l.host && !l.code) {
          const m = /"code":"([A-Za-z0-9]+)"/.exec(ev.data);
          if (m) { l.code = m[1]; kfxNetEmit({ state: 'up', code: l.code, host: true, role: 'host' }); }
        }
        kfxNet.texts.push(ev.data);
        return;
      }
      let data = new Uint8Array(ev.data);
      if (l && l.id) {
        if (data.length < 8) return;
        const view = new DataView(ev.data);
        const seq = view.getUint32(0, true);
        kfxNetTrim(l, view.getUint32(4, true));
        if (seq === 0 || seq <= l.inSeq) return;
        if (seq !== l.inSeq + 1) {
          // Something went missing: reconnect and have it resent.
          ws.onclose = null;
          try { ws.close(3409, 'gap'); } catch (e) {}
          kfxNetLost(1006);
          return;
        }
        l.inSeq = seq;
        data = data.subarray(8);
        if (++l.sinceAck >= kfxNetCfg.ACK_EVERY) kfxNetSendAck(l);
        if (data.length >= 2 && data[0] >= 8) kfxNetControl(l, data);
      }
      kfxNet.frames.push(data);
    };
    ws.onclose = (ev) => {
      // (A test freeze hides the close too; the silence check finds it after.)
      if (kfxNet.ws === ws && Date.now() >= kfxNet.frozenUntil) kfxNetLost(ev.code);
    };
    ws.onerror = () => {};
  },

  // The socket closed. Resume if the link allows it, else report it closed.
  $kfxNetLost__deps: ['$kfxNet', '$kfxNetCfg', '$kfxNetEmit'],
  $kfxNetLost: (closeCode) => {
    const l = kfxNet.link;
    kfxNet.ws = null;
    const now = Date.now();
    if (l && l.id && l.code && !l.final && closeCode < 4000 && now < (l.deadline || Infinity)) {
      if (l.phase !== 'reconnecting') {
        l.phase = 'reconnecting';
        l.since = now;
        l.deadline = now + kfxNetCfg.GRACE;
        l.attempt = 0;
      }
      l.retryAt = now + Math.min(500 * 2 ** l.attempt, 3000);
      kfxNetEmit({ state: 'reconnecting', code: l.code, host: l.host, role: l.role, since: l.since, deadline: l.deadline, attempt: l.attempt });
      return;
    }
    kfxNet.state = 2;
    kfxNet.closeCode = closeCode;
    if (l) {
      kfxNet.link = null;
      if (l.id) kfxNetEmit({ state: 'lost', code: l.code, host: l.host, role: l.role, closeCode, reason: l.closing });
    }
  },

  $kfxNetResume__deps: ['$kfxNet', '$kfxNetAttach'],
  $kfxNetResume: () => {
    const l = kfxNet.link;
    l.attempt++;
    l.attemptAt = Date.now();
    const url = new URL(`/api/rooms/${l.code}`, location.href);
    url.search = `resume=${l.id}&secret=${l.secret}&ack=${l.inSeq}&link=1`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(url.href); } catch (e) { l.retryAt = Date.now() + 3000; return; }
    kfxNet.ws = ws;
    kfxNetAttach(ws);
  },

  // The relay took us back: resend what it has not seen.
  $kfxNetResumed__deps: ['$kfxNet', '$kfxNetTrim', '$kfxNetEmit'],
  $kfxNetResumed: (ack) => {
    const l = kfxNet.link;
    const ws = kfxNet.ws;
    if (!l || !ws) return;
    kfxNetTrim(l, ack);
    for (const { data } of l.out || []) {
      new DataView(data.buffer).setUint32(4, l.inSeq, true);
      ws.send(data);
    }
    for (const text of l.textQueue.splice(0)) ws.send(text);
    l.phase = 'up';
    l.deadline = 0;
    l.sinceAck = 0;
    l.lastSent = l.lastIn = Date.now();
    kfxNet.state = 1;
    kfxNetEmit({ state: 'up', resumed: true, code: l.code, host: l.host, role: l.role, after: Date.now() - l.since });
  },

  $kfxNetTick__deps: ['$kfxNet', '$kfxNetCfg', '$kfxNetSendAck', '$kfxNetLost', '$kfxNetResume'],
  $kfxNetTick: () => {
    const l = kfxNet.link;
    const now = Date.now();
    if (!l || now < kfxNet.frozenUntil) return;
    const cfg = kfxNetCfg;
    if (l.phase === 'reconnecting') {
      if (now >= l.deadline) {
        const ws = kfxNet.ws;
        if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
        l.final = true;
        kfxNetLost(4408);
      } else if (!kfxNet.ws && now >= l.retryAt && navigator.onLine !== false) {
        kfxNetResume();
      } else if (kfxNet.ws && kfxNet.ws.readyState !== 1 && now - l.attemptAt > 10000) {
        const ws = kfxNet.ws; // an attempt that hangs: give up on it, try again
        ws.onclose = null;
        try { ws.close(); } catch (e) {}
        kfxNet.ws = null;
        l.retryAt = now;
      }
      return;
    }
    const ws = kfxNet.ws;
    if (!ws || !l.id) return;
    if (ws.readyState > 1) { kfxNetLost(1006); return; } // closed while frozen
    if (ws.readyState !== 1) return;
    if (l.sinceAck > 0 && now - l.lastSent >= cfg.ACK) kfxNetSendAck(l);
    if (now - l.lastPing >= cfg.PING && (now - l.lastSent >= cfg.PING || now - l.lastIn >= cfg.PING)) {
      ws.send('ping'); // answered by the relay's runtime, without waking it
      l.lastPing = now;
    }
    if (now - l.lastIn >= cfg.DEAD) {
      // Nothing at all came back, not even a pong: the connection is gone
      // even if the browser has not noticed (sleep, a dead network path).
      ws.onclose = null;
      try { ws.close(3000, 'silent'); } catch (e) {}
      kfxNetLost(1006);
    }
  },

  // path: e.g. "rooms/host" or "rooms/ABCDE?role=player". Returns 1 if started.
  kfx_net_open__deps: ['$kfxNet', '$kfxNetAttach', '$kfxNetTicker', '$UTF8ToString'],
  kfx_net_open: (pathPtr) => {
    if (kfxNet.ws) { kfxNet.ws.onclose = null; try { kfxNet.ws.close(); } catch (e) {} }
    const path = UTF8ToString(pathPtr);
    const url = new URL(`/api/${path}`, location.href);
    // Joining from the game's own lobby list: the page checks the lobby's
    // workshop maps (web/kfx_workshop.js).
    const joining = path.match(/^rooms\/([A-Za-z0-9]+)/);
    if (joining && joining[1] !== 'host') Module.kfxOnJoining?.(joining[1]);
    // The page's host options (unlisted lobby), see web/kfx_loader.js.
    if (path === 'rooms/host' && Module.kfxHostQuery) url.search = Module.kfxHostQuery;
    url.searchParams.set('link', '1');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    kfxNet.frames = [];
    kfxNet.texts = [];
    kfxNet.state = 0; // 0 connecting, 1 open, 2 closed
    kfxNet.closeCode = 0;
    const host = path.startsWith('rooms/host');
    const now = Date.now();
    kfxNet.link = {
      host, code: host ? null : (/^rooms\/([A-Za-z0-9]+)/.exec(path) || [])[1],
      role: host ? 'host' : ((/role=(\w+)/.exec(path) || [])[1] || 'player'),
      id: null, secret: null, inSeq: 0, outSeq: 0, out: [], outBytes: 0, sinceAck: 0,
      lastIn: now, lastSent: now, lastPing: now, phase: 'up', textQueue: [],
    };
    let ws;
    try { ws = new WebSocket(url.href); } catch (e) { kfxNet.state = 2; kfxNet.link = null; return 0; }
    kfxNet.ws = ws;
    kfxNetAttach(ws);
    kfxNetTicker();
    Module.kfxNetDebug = {
      // Tests: drop the socket as a network failure would, or stop hearing
      // and sending for a while (a dead connection the browser has not noticed).
      drop: () => kfxNet.ws && kfxNet.ws.close(3001, 'test drop'),
      freeze: (ms) => { kfxNet.frozenUntil = Date.now() + ms; },
      get link() { const l = kfxNet.link; return l && { phase: l.phase, code: l.code, inSeq: l.inSeq, outSeq: l.outSeq, unacked: l.out ? l.out.length : -1 }; },
    };
    return 1;
  },

  // 0 connecting, 1 open (or reconnecting), 2 closed (and all queued frames read).
  kfx_net_state__deps: ['$kfxNet'],
  kfx_net_state: () => {
    if (kfxNet.link && kfxNet.link.phase === 'reconnecting') return 1;
    return (kfxNet.state === 2 && (kfxNet.frames.length || kfxNet.texts.length)) ? 1 : kfxNet.state;
  },

  kfx_net_close_code__deps: ['$kfxNet'],
  kfx_net_close_code: () => kfxNet.closeCode,

  kfx_net_close__deps: ['$kfxNet', '$kfxNetEmit'],
  kfx_net_close: () => {
    const ws = kfxNet.ws;
    const l = kfxNet.link;
    kfxNet.ws = null;
    kfxNet.link = null;
    kfxNet.state = 2;
    kfxNet.frames = [];
    kfxNet.texts = [];
    if (ws) {
      ws.onclose = null;
      try {
        if (ws.readyState === 1 && l && l.id) ws.send('{"type":"bye"}'); // leaving on purpose
        ws.close(1000, 'bye');
      } catch (e) {}
    }
    if (l && l.id) kfxNetEmit({ state: 'closed', code: l.code, host: l.host, role: l.role });
  },

  kfx_net_send__deps: ['$kfxNet', '$kfxNetSendBytes'],
  kfx_net_send: (ptr, len) => {
    const l = kfxNet.link;
    if (l && l.id) return kfxNetSendBytes(l, HEAPU8.slice(ptr, ptr + len));
    const ws = kfxNet.ws;
    if (!ws || ws.readyState !== 1) return 0;
    ws.send(HEAPU8.slice(ptr, ptr + len));
    return 1;
  },

  kfx_net_send_text__deps: ['$kfxNet', '$UTF8ToString'],
  kfx_net_send_text: (ptr) => {
    const l = kfxNet.link;
    if (l && l.phase === 'reconnecting') {
      if (l.textQueue.length < 16) l.textQueue.push(UTF8ToString(ptr));
      return 1;
    }
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

  // The game's online lobby screen, each frame (src/kfx/platform/web/WebLobby.c):
  // Module.kfxOnLobby({players, maxPlayers, host, coloursConflict}) may return
  // one order for the host's game: "say <text>", "start <pack> <level>" or
  // "max <n>". Its first call also tells the page that this engine takes orders.
  kfx_web_lobby_poll__deps: ['$stringToUTF8', '$lengthBytesUTF8'],
  kfx_web_lobby_poll: (players, maxPlayers, host, flags, buf, cap) => {
    let order = '';
    try {
      order = Module.kfxOnLobby?.({ players, maxPlayers, host: !!host, coloursConflict: !!(flags & 1) }) || '';
    } catch (e) {
      err(`KeeperFX: lobby: ${e}`);
    }
    if (typeof order !== 'string' || !order || lengthBytesUTF8(order) + 1 > cap) return 0;
    stringToUTF8(order, buf, cap);
    return lengthBytesUTF8(order);
  },

  // Lets the page show the code of a hosted lobby (invite link).
  kfx_net_hosting__deps: ['$UTF8ToString'],
  kfx_net_hosting: (codePtr) => {
    Module.kfxOnHosting?.(codePtr ? UTF8ToString(codePtr) : null);
  },
});
