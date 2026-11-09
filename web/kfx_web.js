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
});
