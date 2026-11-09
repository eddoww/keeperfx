#!/usr/bin/env python3
"""Lay out KeeperFX game data for the browser build.

Usage: web/package-data.py <out-dir> <keeperfx-install-dir> [<overlay-dir>...]

<keeperfx-install-dir> is a KeeperFX install, for example an unpacked
keeperfx_*_complete.7z release. Each <overlay-dir> is laid over it in order,
later ones winning; typically the pkg/ directory `make pkg-assemble` makes, so
the data matches this source tree. The result is copied to
<out-dir>/gamedata/ and listed in <out-dir>/gamedata/manifest.json, which the
page uses to create lazy placeholders (see web/kfx_loader.js).

Never shipped: the files that come from the original Dungeon Keeper
(docs/files_required_from_original_dk.txt), which each player supplies from
their own copy; music; program binaries and libraries; player data (saves,
replays, screenshots, logs).
"""
import hashlib
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Largest file written as is; bigger ones are split (see main()).
PART_SIZE = 24 * 1024 * 1024

SKIP_DIRS = {"lib", "save", "replays", "scrshots", "music", "mods"}
SKIP_EXTS = {".exe", ".dll", ".map", ".log", ".so", ".sh", ".7z", ".zip.part"}
SKIP_NAMES = {"keeperfx", "keeperfx_hvlog", "launch.sh", "keeperfx.cfg"}


def original_dk_files():
    path = os.path.join(ROOT, "docs", "files_required_from_original_dk.txt")
    with open(path, encoding="utf-8") as f:
        return {line.strip()[2:].lower() for line in f if line.startswith("./")}


def collect(src, dk_files):
    """Data files of one install dir, as {relative path: absolute path}."""
    found = {}
    for dirpath, dirnames, filenames in os.walk(src):
        rel_dir = os.path.relpath(dirpath, src)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_DIRS]
        dirnames.sort()
        for name in sorted(filenames):
            rel = os.path.normpath(os.path.join(rel_dir, name)).replace(os.sep, "/")
            low = rel.lower()
            if low in dk_files:
                continue  # belongs to the player's own copy of Dungeon Keeper
            if rel_dir == "." and (name in SKIP_NAMES or os.path.splitext(low)[1] in SKIP_EXTS
                                   or name.startswith("keeperfx-launcher")):
                continue
            if os.path.splitext(low)[1] in {".exe", ".dll"}:
                continue
            found[rel] = os.path.join(src, rel)
    return found


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out, layers = sys.argv[1], sys.argv[2:]
    dest = os.path.join(out, "gamedata")
    dk_files = original_dk_files()
    sources = {}
    by_lower = {}  # lower-case path -> key in sources
    for layer in layers:
        if not os.path.isdir(layer):
            sys.exit(f"Not a directory: {layer}")
        # Match case-insensitively, as the game does: an overlay's file
        # replaces the base file whatever its case.
        for rel, path in collect(layer, dk_files).items():
            old = by_lower.get(rel.lower())
            if old is not None:
                del sources[old]
            sources[rel] = path
            by_lower[rel.lower()] = rel

    if os.path.isdir(dest):
        shutil.rmtree(dest)
    entries = []
    total = 0
    # The default config comes from this source tree, not from the install
    # (which may hold a player's edits); the page adjusts its display lines.
    sources["keeperfx.cfg"] = os.path.join(ROOT, "config", "keeperfx.cfg")
    for rel in sorted(sources):
        s = sources[rel]
        d = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        with open(s, "rb") as f:
            data = f.read()
        digest = hashlib.sha1(data).hexdigest()[:12]
        size = len(data)
        total += size
        if size <= PART_SIZE:
            with open(d, "wb") as f:
                f.write(data)
            entries.append([rel, size, digest])
        else:
            # Static hosts cap the size of one file (Cloudflare Pages: 25 MiB),
            # so big files go up as <name>.part0, .part1, ... which the page
            # joins again (web/kfx_loader.js).
            parts = (size + PART_SIZE - 1) // PART_SIZE
            for i in range(parts):
                with open(f"{d}.part{i}", "wb") as f:
                    f.write(data[i * PART_SIZE:(i + 1) * PART_SIZE])
            entries.append([rel, size, digest, parts])

    # Files the page downloads in the background right away (web/prefetch.txt).
    listed = {e[0].lower(): e[0] for e in entries}
    prefetch = []
    with open(os.path.join(ROOT, "web", "prefetch.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and line.lower() in listed:
                prefetch.append(listed[line.lower()])

    with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"files": entries, "prefetch": prefetch}, f, separators=(",", ":"))
    print(f"{len(entries)} files, {total / 1048576:.1f} MiB -> {dest}")


if __name__ == "__main__":
    main()
