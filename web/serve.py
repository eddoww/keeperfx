#!/usr/bin/env python3
"""Local test server for the browser build.

Usage: web/serve.py [site-dir] [--port 8080] [--dk <Dungeon Keeper folder>] [--layout <dir>]

Serves site-dir (default build-web/site). With --dk, also serves the 16 files
KeeperFX needs from your own Dungeon Keeper install at /dk/ (case-insensitive,
as GOG ships them in upper case), so http://localhost:8080/?dk=dk skips the
folder picker. Only for local testing: never publish your DK files.
With --layout, /builds/ and /data/ come from that folder (several engine
builds, made by web/publish-build.py) instead of the site dir.
"""
import argparse
import http.server
import mimetypes
import os
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_ci(base, rel):
    """Resolve rel under base ignoring case; None if absent."""
    path = base
    for part in rel.split("/"):
        if not part:
            continue
        try:
            match = next(n for n in os.listdir(path) if n.lower() == part.lower())
        except (StopIteration, FileNotFoundError, NotADirectoryError):
            return None
        path = os.path.join(path, match)
    return path if os.path.isfile(path) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site", nargs="?", default=os.path.join(ROOT, "build-web", "site"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--dk", help="your Dungeon Keeper folder, served at /dk/")
    ap.add_argument("--layout", help="engine builds folder (web/publish-build.py), served at /builds/ and /data/")
    args = ap.parse_args()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=args.site, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            # So another local site can use this one's gamedata/ as its dataUrl
            # (never the DK files under /dk/).
            if self.path.startswith(("/gamedata/", "/builds/", "/data/")):
                self.send_header("Access-Control-Allow-Origin", "*")
            super().end_headers()

        def translate_path(self, path):
            rel = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
            if args.dk and rel.startswith("/dk/"):
                found = find_ci(args.dk, rel[4:])
                if found is None:  # GOG keeps the music in the top folder
                    found = find_ci(args.dk, os.path.basename(rel))
                return found or os.path.join(args.site, "__missing__")
            if args.layout and (rel.startswith("/builds/") or rel.startswith("/data/")):
                parts = [p for p in rel.split("/") if p and p not in (".", "..")]
                return os.path.join(args.layout, *parts)
            return super().translate_path(path)

        def guess_type(self, path):
            if path.endswith(".wasm"):
                return "application/wasm"
            return super().guess_type(path)

    mimetypes.add_type("application/manifest+json", ".webmanifest")
    mimetypes.add_type("application/wasm", ".wasm")
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as srv:
        print(f"Serving {args.site} on http://localhost:{args.port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()
