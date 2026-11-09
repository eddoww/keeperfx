#!/usr/bin/env python3
"""Lay out KeeperFX game data for the browser build.

Usage: web/package-data.py <keeperfx-install-dir> <out-dir>

<keeperfx-install-dir> is an assembled KeeperFX install (`make pkg-assemble`
output, or an unpacked release). Its data files are copied to
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

SKIP_DIRS = {"lib", "save", "replays", "scrshots", "music", "mods"}
SKIP_EXTS = {".exe", ".dll", ".map", ".log", ".so", ".sh", ".7z", ".zip.part"}
SKIP_NAMES = {"keeperfx", "keeperfx_hvlog", "launch.sh", "keeperfx.cfg"}


def original_dk_files():
    path = os.path.join(ROOT, "docs", "files_required_from_original_dk.txt")
    with open(path, encoding="utf-8") as f:
        return {line.strip()[2:].lower() for line in f if line.startswith("./")}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    dest = os.path.join(out, "gamedata")
    dk_files = original_dk_files()
    files = []
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
            files.append(rel)

    if os.path.isdir(dest):
        shutil.rmtree(dest)
    entries = []
    total = 0
    # The default config comes from this source tree, not from the install
    # (which may hold a player's edits); the page adjusts its display lines.
    sources = {rel: os.path.join(src, rel) for rel in files}
    sources["keeperfx.cfg"] = os.path.join(ROOT, "config", "keeperfx.cfg")
    for rel in sorted(sources):
        s = sources[rel]
        d = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copyfile(s, d)
        with open(s, "rb") as f:
            digest = hashlib.sha1(f.read()).hexdigest()[:12]
        size = os.path.getsize(s)
        total += size
        entries.append([rel, size, digest])

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
