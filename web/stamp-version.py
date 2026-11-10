#!/usr/bin/env python3
"""Tie the page to one build of the game.

Usage: web/stamp-version.py <site-dir> [--no-sw]

The page's scripts and keeperfx.wasm must come from the same build: a cached
copy of one with a fresh copy of another fails ("LinkError ... function import
requires a callable", or an old loader that lacks newer page features). This
hashes them and makes index.html request every script and stylesheet as
<name>?v=<hash>;
the loader asks for keeperfx.wasm?v=<hash> too (the kfx-build meta tag), so
browser and CDN caches can never mix two builds.

It also stamps the service worker (sw.js, see web/sw.js) with the build and
the files it caches for offline starts: everything index.html loads (scripts,
stylesheets, icons, fonts, the web app manifest and its icons, url()s in the
stylesheets) and keeperfx.wasm, each with its SHA-256. --no-sw ships the
service worker's kill switch instead: it unregisters itself and the page stops
registering it (meta kfx-sw).
"""
import hashlib
import json
import os
import re
import sys

LOCAL = re.compile(r'^(?![a-z][a-z0-9+.-]*:|//|#)([^?#"]+)')  # a relative URL's path
TAG_URL = re.compile(r'<(?:script|link|img|source)\b[^>]*?\b(?:src|href)="([^"]+)"')
CSS_URL = re.compile(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)')
STAMPABLE_SCRIPT = re.compile(r'<script src="([A-Za-z0-9_.-]+\.js)(\?v=[0-9a-f]*)?"')
STAMPABLE_STYLE = re.compile(r'<link rel="stylesheet" href="([A-Za-z0-9_.-]+\.css)(\?v=[0-9a-f]*)?"')


def read(site, name):
    with open(os.path.join(site, name), "rb") as f:
        return f.read()


def local_path(url, base=""):
    m = LOCAL.match(url.strip())
    if not m:
        return None
    return os.path.normpath(os.path.join(os.path.dirname(base), m.group(1))).replace(os.sep, "/")


def shell_files(site, html):
    """Every file the page loads from its own site, relative to it, sorted."""
    found = set()
    for url in TAG_URL.findall(html):
        path = local_path(url)
        if path and os.path.isfile(os.path.join(site, path)):
            found.add(path)
    for path in list(found):
        if path.endswith(".css"):
            for url in CSS_URL.findall(read(site, path).decode("utf-8", "replace")):
                sub = local_path(url, path)
                if sub and os.path.isfile(os.path.join(site, sub)):
                    found.add(sub)
        elif path.endswith(".webmanifest"):
            manifest = json.loads(read(site, path))
            for icon in manifest.get("icons", []) + [i for s in manifest.get("shortcuts", []) for i in s.get("icons", [])]:
                sub = local_path(icon["src"], path)
                if sub and os.path.isfile(os.path.join(site, sub)):
                    found.add(sub)
    found.add("keeperfx.wasm")  # loaded by keeperfx.js
    return sorted(found)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sw_on = "--no-sw" not in sys.argv[1:]
    site = args[0] if args else sys.exit(__doc__)
    path = os.path.join(site, "index.html")
    with open(path, encoding="utf-8") as f:
        html = f.read()
    # The build id covers the page itself, the service worker and every file
    # it loads: a cached older loader with a newer page (or the reverse) is as
    # broken as a mismatched keeperfx.js/.wasm.
    template = re.sub(r'\?v=[0-9a-f]*"', '"', html)
    template = re.sub(r'<meta name="kfx-(build|sw)" content="[^"]*">', r'<meta name="kfx-\1" content="">', template)
    files = shell_files(site, html)
    h = hashlib.sha1(template.encode("utf-8"))
    for name in files:
        h.update(name.encode("utf-8") + b"\0" + read(site, name))
    if os.path.isfile(os.path.join(site, "sw.js")):
        h.update(b"sw.js\0" + unstamp(read(site, "sw.js").decode("utf-8")).encode("utf-8"))
    h.update(b"sw" if sw_on else b"no-sw")
    build = h.hexdigest()[:12]
    html = STAMPABLE_SCRIPT.sub(rf'<script src="\1?v={build}"', html)
    html = STAMPABLE_STYLE.sub(rf'<link rel="stylesheet" href="\1?v={build}"', html)
    html = re.sub(r'<meta name="kfx-build" content="[^"]*">', f'<meta name="kfx-build" content="{build}">', html)
    html = re.sub(r'<meta name="kfx-sw" content="[^"]*">', f'<meta name="kfx-sw" content="{"on" if sw_on else "off"}">', html)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    stamp_service_worker(site, html, files, build, sw_on)
    print(f"build {build}{'' if sw_on else ' (service worker off)'}")


def unstamp(sw_text):
    """sw.js as in web/, whether or not it has been stamped already."""
    sw_text = re.sub(r"^const BUILD = .*;$", "const BUILD = '';", sw_text, count=1, flags=re.M)
    sw_text = re.sub(r"^const ENABLED = .*;$", "const ENABLED = false;", sw_text, count=1, flags=re.M)
    return re.sub(r"^const PRECACHE = .*;$", "const PRECACHE = [];", sw_text, count=1, flags=re.M)


def stamp_service_worker(site, html, files, build, sw_on):
    sw = os.path.join(site, "sw.js")
    if not os.path.isfile(sw):
        return
    # The URLs exactly as the page asks for them (scripts and styles carry ?v=).
    versioned = {m[0] for m in STAMPABLE_SCRIPT.findall(html) + STAMPABLE_STYLE.findall(html)}
    versioned.add("keeperfx.wasm")
    entries = [["./", None]]  # the page (index.html), checked by its kfx-build stamp
    for name in files:
        url = f"{name}?v={build}" if name in versioned else name
        entries.append([url, hashlib.sha256(read(site, name)).hexdigest()])
    with open(sw, encoding="utf-8") as f:
        text = f.read()
    text = re.sub(r"^const BUILD = .*;$", f"const BUILD = '{build}';", text, count=1, flags=re.M)
    text = re.sub(r"^const ENABLED = .*;$", f"const ENABLED = {'true' if sw_on else 'false'};", text, count=1, flags=re.M)
    text = re.sub(r"^const PRECACHE = .*;$", lambda _: f"const PRECACHE = {json.dumps(entries)};", text, count=1, flags=re.M)
    with open(sw, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__":
    main()
