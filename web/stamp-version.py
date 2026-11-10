#!/usr/bin/env python3
"""Tie the page to one build of the game.

Usage: web/stamp-version.py <site-dir>

The page's scripts and keeperfx.wasm must come from the same build: a cached
copy of one with a fresh copy of another fails ("LinkError ... function import
requires a callable", or an old loader that lacks newer page features). This
hashes them and makes index.html request every script and stylesheet as
<name>?v=<hash>;
the loader asks for keeperfx.js and keeperfx.wasm with ?v=<hash> too (the
kfx-build meta tag), so browser and CDN caches can never mix two builds.

A site with several engine builds (web/publish-build.py, builds/<id>/) has no
keeperfx.wasm next to the page: each build's files have their own immutable
URL, and the page speaks to all of them through one contract (KFX_WEB_API in
web/kfx_web.js), so only the page's own files are hashed.
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
    engine = ["keeperfx.wasm"] if os.path.exists(os.path.join(site, "keeperfx.wasm")) else []
    for name in scripts + styles + engine:
        with open(os.path.join(site, name), "rb") as f:
            h.update(f.read())
    build = h.hexdigest()[:12]
    html = re.sub(r'<script src="([A-Za-z0-9_.-]+\.js)(\?v=[0-9a-f]*)?"', rf'<script src="\1?v={build}"', html)
    html = re.sub(r'<link rel="stylesheet" href="([A-Za-z0-9_.-]+\.css)(\?v=[0-9a-f]*)?"',
                  rf'<link rel="stylesheet" href="\1?v={build}"', html)
    html = re.sub(r'<meta name="kfx-build" content="[^"]*">', f'<meta name="kfx-build" content="{build}">', html)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"build {build}")


if __name__ == "__main__":
    main()
