#!/usr/bin/env python3
"""Tie the page to one build of the game.

Usage: web/stamp-version.py <site-dir>

The page's scripts and keeperfx.wasm must come from the same build: a cached
copy of one with a fresh copy of another fails ("LinkError ... function import
requires a callable", or an old loader that lacks newer page features). This
hashes them and makes index.html request every script and stylesheet as
<name>?v=<hash>;
the loader asks for keeperfx.wasm?v=<hash> too (the kfx-build meta tag), so
browser and CDN caches can never mix two builds.

It also writes the kfx-engine meta tag: a hash of keeperfx.wasm alone. A
replay only plays back on the engine that recorded it (web/kfx_replays.js),
and page-only changes must not count as a new engine.
"""
import hashlib
import os
import re
import sys


def main():
    site = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
    path = os.path.join(site, "index.html")
    with open(path, encoding="utf-8") as f:
        html = f.read()
    # Every script the page loads, plus the wasm, goes into the build id, and
    # every script tag gets it: a cached older loader with a newer page (or the
    # reverse) is as broken as a mismatched keeperfx.js/.wasm.
    scripts = sorted(set(re.findall(r'<script src="([A-Za-z0-9_.-]+\.js)(?:\?v=[0-9a-f]*)?"', html)))
    styles = sorted(set(re.findall(r'<link rel="stylesheet" href="([A-Za-z0-9_.-]+\.css)(?:\?v=[0-9a-f]*)?"', html)))
    h = hashlib.sha1()
    for name in scripts + styles + ["keeperfx.wasm"]:
        with open(os.path.join(site, name), "rb") as f:
            h.update(f.read())
    build = h.hexdigest()[:12]
    with open(os.path.join(site, "keeperfx.wasm"), "rb") as f:
        engine = hashlib.sha1(f.read()).hexdigest()[:12]
    html = re.sub(r'<script src="([A-Za-z0-9_.-]+\.js)(\?v=[0-9a-f]*)?"', rf'<script src="\1?v={build}"', html)
    html = re.sub(r'<link rel="stylesheet" href="([A-Za-z0-9_.-]+\.css)(\?v=[0-9a-f]*)?"',
                  rf'<link rel="stylesheet" href="\1?v={build}"', html)
    html = re.sub(r'<meta name="kfx-build" content="[^"]*">', f'<meta name="kfx-build" content="{build}">', html)
    html = re.sub(r'<meta name="kfx-engine" content="[^"]*">', f'<meta name="kfx-engine" content="{engine}">', html)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"build {build}, engine {engine}")


if __name__ == "__main__":
    main()
