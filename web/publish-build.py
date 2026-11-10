#!/usr/bin/env python3
"""Keep several KeeperFX engine builds side by side for the browser site.

Layout (a local folder, mirrored to the R2 bucket by web/upload-builds.sh):

  builds/index.json            the builds players can choose (no-cache)
  builds/<id>/keeperfx.js      the engine; <id> changes with every byte of it,
  builds/<id>/keeperfx.wasm    so everything under builds/<id>/ is immutable
  builds/<id>/manifest.json    the game data list of that build
  data/<hash>[.partN]          game data, stored once by content hash and
                               shared by every build that has the same file

A second build costs only its engine (about 9 MB) and the data files that
differ, usually a few MB. The page (web/kfx_versions.js) reads index.json,
picks a build and loads builds/<id>/keeperfx.js; the data URLs are
<index.json>/../data/<hash>.

Commands:

  add <layout> --site <dir> --version 1.4.0.5603 --channel alpha [options]
      Add the build in <dir> (keeperfx.js, keeperfx.wasm and gamedata/ with
      manifest.json, as web/package-data.py makes it) to <layout>. A build of
      the same version made from an older port is retired. Then, only with
      --keep-referenced, prune: each channel offers its newest --keep-count
      builds (and any build marked "keep", and the default); an older build
      that a published replay was recorded with stays, "archived" (the page
      runs it for its replays but does not offer it), and the others move to
      "retired". A retired build's files are deleted --grace-days later
      (players who started it just before may still be loading its data),
      together with the data no other build uses. Without --keep-referenced
      nothing is pruned: every build stays offered (about 10 MB each in R2:
      its engine and the data files that changed).
      Writes <layout>/plan.json: what web/upload-builds.sh must upload
      and delete, in a safe order (data, then the build, then index.json last,
      so a failure half way leaves the site on its previous builds).

      --keep-referenced URL: the site's /api/replays/builds (web/server/src/
      replays.js), which lists the builds published replays need; if it does
      not answer, the command fails rather than delete what replays need.
      "none" prunes without asking (old replays of pruned builds can then only
      be downloaded, not watched).

      Each build records the page features its engine has ("features",
      web/kfx_versions.js supports()), found in the source tree it was built
      from (--checkout) or given with --features. A port branch made for an
      older release (stable 1.4: web-stable-1.4) describes itself in
      web/build-info.json in its tree: {"lacks": [page features it does not
      have], "saves": "<kind>"} (its saves are of another kind than the
      alpha builds', so the page keeps them in a folder of their own);
      --lacks and --saves override it.

  pull <layout> <builds-url>
      Fetch index.json and the manifests of the builds a deployed site lists
      (retired ones too) into <layout>, so `add` knows which data files are
      already uploaded. Engines and data are not downloaded.

  list <layout>
      Show the builds in <layout>.

  set <layout> [--default CHANNEL|ID] [--keep ID] [--unkeep ID] [--remove ID]
      Change the default build or pin / unpin / retire one by hand.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_FORMAT = 1
CHANNELS = {
    "stable": {"name": "Stable", "about": "The latest KeeperFX release, the game as most desktop players have it. "
                                           "It has its own saves and lobbies, and lacks the newest features."},
    "alpha": {"name": "Alpha", "about": "A recent build of KeeperFX's development version, with the newest features. "
                                         "It can have bugs that the stable version does not."},
    "dev": {"name": "Test", "about": "A build made by hand for testing."},
}
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Page features that need the engine's help, and how to see that a source tree
# has them. A build without one gets a page that leaves the feature out.
FEATURES = {
    "loadgame": ("src/main.cpp", '"loadgame"'),  # -loadgame: autosave "Continue"
    "mpmods": ("src/main.cpp", '"mpmods"'),      # -mpmods: Workshop mods in online lobbies
}


def build_info(checkout):
    """web/build-info.json of a port branch: {"lacks": [...], "saves": "..."} or {}."""
    try:
        with open(os.path.join(checkout, "web", "build-info.json"), encoding="utf-8") as f:
            info = json.load(f)
    except OSError:
        return {}
    except ValueError as e:
        sys.exit(f"{checkout}/web/build-info.json: {e}")
    lacks = info.get("lacks", [])
    saves = info.get("saves", "")
    if not isinstance(lacks, list) or not all(isinstance(x, str) for x in lacks) or not isinstance(saves, str):
        sys.exit(f"{checkout}/web/build-info.json: lacks must be a list of names, saves a string")
    return {"lacks": lacks, "saves": saves}


def detect_features(checkout):
    found = []
    for name, (path, needle) in FEATURES.items():
        try:
            with open(os.path.join(checkout, path), encoding="utf-8", errors="replace") as f:
                if needle in f.read():
                    found.append(name)
        except OSError:
            pass
    return found


def referenced_builds(url):
    """Build ids that published replays need (web/server/src/replays.js);
    none for --keep-referenced none."""
    if url == "none":
        return set()
    try:
        data = fetch_json(url)
        return set(data["builds"])
    except Exception as e:  # noqa: BLE001 - any failure must stop the pruning
        sys.exit(f"Could not read the builds replays need from {url} ({e}); nothing pruned. "
                 "Retry, or pass --keep-referenced none to prune anyway.")


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def web_api_version(checkout):
    """The page/engine contract version the engine was built against (web/kfx_web.js)."""
    path = os.path.join(checkout, "web", "kfx_web.js")
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"KFX_WEB_API\s*=?\s*(\d+)", f.read())
        return int(m.group(1)) if m else 1
    except OSError:
        return 1


def write_json(path, data, **kw):
    """Write through a new file: layouts are often hard-linked copies (cp -al)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, **kw)
        f.write("\n")
    os.replace(path + ".tmp", path)


def load_index(layout):
    path = os.path.join(layout, "builds", "index.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            index = json.load(f)
        if index.get("format", 1) > INDEX_FORMAT:
            sys.exit(f"{path} is a newer index format than this script knows")
        return index
    return {"format": INDEX_FORMAT, "default": "alpha", "data": "../data/", "channels": {}, "builds": [], "retired": []}


def save_index(layout, index):
    index["updated"] = now_iso()
    used = {b["channel"] for b in index["builds"]}
    index["channels"] = {c: {**CHANNELS.get(c, {"name": c.title(), "about": ""}), **index.get("channels", {}).get(c, {})}
                         for c in sorted(used, key=lambda c: list(CHANNELS).index(c) if c in CHANNELS else 99)}
    write_json(os.path.join(layout, "builds", "index.json"), index, indent=1)


def read_manifest(layout, build_id):
    path = os.path.join(layout, "builds", build_id, "manifest.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def blob_names(manifest):
    """Object names under data/ that a manifest uses."""
    names = set()
    for entry in manifest["files"]:
        digest = entry[2]
        parts = entry[3] if len(entry) > 3 else 1
        if parts > 1:
            names.update(f"{digest}.part{i}" for i in range(parts))
        else:
            names.add(digest)
    return names


def link_or_copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def sha1_of(*paths):
    h = hashlib.sha1()
    for p in paths:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


def cmd_add(args):
    layout, site = args.layout, args.site
    gamedata = os.path.join(site, "gamedata")
    for need in ("keeperfx.js", "keeperfx.wasm", "gamedata/manifest.json"):
        if not os.path.exists(os.path.join(site, need)):
            sys.exit(f"{site} has no {need} (build keeperfx and run web/package-data.py)")
    if args.channel not in CHANNELS and not re.fullmatch(r"[a-z]{2,16}", args.channel):
        sys.exit(f"Bad channel name: {args.channel}")
    with open(os.path.join(gamedata, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("layout") == "cas":
        sys.exit("The site's manifest is already a content-addressed one; give the output of web/package-data.py")

    js, wasm = os.path.join(site, "keeperfx.js"), os.path.join(site, "keeperfx.wasm")
    digest = sha1_of(js, wasm, os.path.join(gamedata, "manifest.json"))[:8]
    build_id = args.id or f"{args.version}-{digest}"
    if not ID_RE.match(build_id):
        sys.exit(f"Bad build id: {build_id}")

    index = load_index(layout)
    known = {b["id"] for b in index["builds"]}
    if build_id in known:
        print(f"{build_id} is already published; nothing to do")
        write_plan(layout, [], [], [])
        return

    # Data files: data/<hash>, or <hash>.partN for files the packager split.
    os.makedirs(os.path.join(layout, "data"), exist_ok=True)
    uploads = []
    remote = set()
    for b in index["builds"] + index.get("retired", []):
        try:
            remote |= blob_names(read_manifest(layout, b["id"]))
        except OSError:
            sys.exit(f"Missing builds/{b['id']}/manifest.json in {layout}: run `pull` first")
    total = 0
    new_bytes = 0
    for entry in manifest["files"]:
        rel, size, file_hash = entry[0], entry[1], entry[2]
        parts = entry[3] if len(entry) > 3 else 1
        total += size
        names = [f"{file_hash}.part{i}" for i in range(parts)] if parts > 1 else [file_hash]
        srcs = [os.path.join(gamedata, f"{rel}.part{i}") for i in range(parts)] if parts > 1 else [os.path.join(gamedata, rel)]
        for name, src in zip(names, srcs):
            dst = os.path.join(layout, "data", name)
            if os.path.exists(dst):
                if parts == 1 and os.path.getsize(dst) != size:
                    sys.exit(f"Hash collision or damaged file: data/{name} ({rel})")
            else:
                link_or_copy(src, dst)
            if name not in remote:
                remote.add(name)
                uploads.append(f"data/{name}")
                new_bytes += os.path.getsize(src)

    # The build itself.
    bdir = os.path.join(layout, "builds", build_id)
    os.makedirs(bdir, exist_ok=True)
    link_or_copy(js, os.path.join(bdir, "keeperfx.js"))
    link_or_copy(wasm, os.path.join(bdir, "keeperfx.wasm"))
    write_json(os.path.join(bdir, "manifest.json"), {**manifest, "layout": "cas"}, separators=(",", ":"))
    build_files = [f"builds/{build_id}/{n}" for n in ("keeperfx.js", "keeperfx.wasm", "manifest.json")]

    changes = []
    if args.changes:
        with open(args.changes, encoding="utf-8") as f:
            changes = json.load(f)[:40]
    build = {
        "id": build_id,
        "channel": args.channel,
        "version": args.version,
        "title": args.title or f"{CHANNELS.get(args.channel, {}).get('name', args.channel.title())} {args.version}",
        "date": args.date or now_iso(),
        "published": now_iso(),
        "upstream": args.upstream or "",
        "port": args.port or "",
        "notes": args.notes or "",
        "changes": changes,
        "api": args.api or web_api_version(args.checkout),
        "features": sorted(f for f in args.features.split(",") if f) if args.features is not None
        else detect_features(args.checkout),
        "engineBytes": os.path.getsize(wasm) + os.path.getsize(js),
        "dataFiles": len(manifest["files"]),
        "dataBytes": total,
    }
    info = build_info(args.checkout)
    lacks = sorted(f for f in args.lacks.split(",") if f) if args.lacks is not None else info.get("lacks", [])
    saves = args.saves if args.saves is not None else info.get("saves", "")
    if saves and not re.fullmatch(r"[A-Za-z0-9._-]{1,32}", saves):
        sys.exit(f"Bad saves kind: {saves}")
    if lacks:
        build["lacks"] = lacks
    if saves:
        build["saves"] = saves
    if args.keep:
        build["keep"] = True
    index["builds"].insert(0, build)
    # Newest first: by upstream date, then (same upstream build, newer port) by publication.
    index["builds"].sort(key=lambda b: (b["date"], b.get("published", "")), reverse=True)
    if args.default:
        index["default"] = args.default

    # The same upstream build made again (a newer port): it replaces the old one.
    for old in [b for b in index["builds"] if b is not build and b["channel"] == build["channel"]
                and b["version"] == build["version"] and not b.get("keep")]:
        index["builds"].remove(old)
        index.setdefault("retired", []).append({"id": old["id"], "version": old["version"],
                                                "channel": old["channel"], "retired": now_iso()})
        print(f"{old['id']} is replaced by {build_id}")

    if args.keep_referenced:
        deletes = prune(layout, index, args.keep_count, args.grace_days, referenced_builds(args.keep_referenced))
    else:
        print("Not pruning (no --keep-referenced): every build stays offered")
        deletes = prune(layout, index, 10 ** 6, args.grace_days, None)
    save_index(layout, index)
    write_plan(layout, uploads, build_files, deletes)
    print(f"Added {build_id}: {len(uploads)} new data files ({new_bytes / 1048576:.1f} MiB) of "
          f"{len(manifest['files'])}, engine {build['engineBytes'] / 1048576:.1f} MiB; "
          f"{len(deletes)} objects to delete")


def prune(layout, index, keep_count, grace_days, referenced=None):
    """Retire builds beyond each channel's newest keep_count, except those in
    `referenced` (replays need them), which stay archived (referenced None:
    not a pruning pass, archived builds stay as they are); return the objects
    of builds retired more than grace_days ago that nothing else uses."""
    seen = {}
    active = []
    retired = index.setdefault("retired", [])
    stamp = now_iso()
    for b in index["builds"]:
        n = seen.get(b["channel"], 0)
        if b.get("archived") and n < keep_count and referenced is not None:
            b.pop("archived")  # offered again (a newer build was removed)
        if not b.get("archived"):
            seen[b["channel"]] = n + 1
        if (n < keep_count and not b.get("archived")) or b.get("keep") or b["id"] == index.get("default"):
            active.append(b)
        elif referenced is None and b.get("archived"):
            active.append(b)  # not a pruning pass: stays as it is
        elif referenced is not None and b["id"] in referenced:
            if not b.get("archived"):
                print(f"{b['id']} is archived: published replays need it")
            b["archived"] = True
            active.append(b)
        else:
            retired.append({"id": b["id"], "version": b["version"], "channel": b["channel"], "retired": stamp})
    index["builds"] = active

    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=grace_days)
    expired = [r for r in retired if parse_iso(r["retired"]) <= cutoff]
    if not expired:
        return []
    still_used = set()
    for b in active + [r for r in retired if r not in expired]:
        still_used |= blob_names(read_manifest(layout, b["id"]))
    deletes = []
    for r in expired:
        try:
            names = blob_names(read_manifest(layout, r["id"]))
        except OSError:
            names = set()
        for name in sorted(names - still_used):
            deletes.append(f"data/{name}")
            still_used.add(name)  # once
            try:
                os.unlink(os.path.join(layout, "data", name))
            except OSError:
                pass
        for n in ("keeperfx.js", "keeperfx.wasm", "manifest.json"):
            deletes.append(f"builds/{r['id']}/{n}")
        shutil.rmtree(os.path.join(layout, "builds", r["id"]), ignore_errors=True)
    index["retired"] = [r for r in retired if r not in expired]
    return deletes


def write_plan(layout, data_uploads, build_files, deletes):
    plan = {
        "data": data_uploads,           # immutable, upload first
        "build": build_files,           # immutable, then
        "index": "builds/index.json",   # no-cache, last
        "delete": deletes,              # after the index no longer names them
    }
    write_json(os.path.join(layout, "plan.json"), plan, indent=1)


def fetch_json(url):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "keeperfx-publish"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def cmd_pull(args):
    base = args.url if args.url.endswith("/") else args.url + "/"
    try:
        index = fetch_json(base + "index.json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"No builds published at {base} yet: starting empty")
            save_index(args.layout, load_index(args.layout))
            return
        raise
    for b in index.get("builds", []) + index.get("retired", []):
        if not ID_RE.match(b["id"]):
            sys.exit(f"Bad build id in the published index: {b['id']!r}")
        manifest = fetch_json(f"{base}{b['id']}/manifest.json")
        write_json(os.path.join(args.layout, "builds", b["id"], "manifest.json"), manifest, separators=(",", ":"))
    write_json(os.path.join(args.layout, "builds", "index.json"), index, indent=1)
    print(f"Pulled {len(index.get('builds', []))} builds, {len(index.get('retired', []))} retired, from {base}")


def cmd_list(args):
    index = load_index(args.layout)
    print(f"default: {index.get('default')}")
    for b in index["builds"]:
        flags = " keep" if b.get("keep") else ""
        print(f"  {b['id']:32} {b['channel']:7} {b['version']:12} {b['date'][:10]} api {b.get('api')}{flags}")
    for r in index.get("retired", []):
        print(f"  {r['id']:32} retired {r['retired'][:10]}")


def cmd_set(args):
    index = load_index(args.layout)
    ids = {b["id"]: b for b in index["builds"]}
    if args.default:
        if args.default not in ids and args.default not in {b["channel"] for b in index["builds"]}:
            sys.exit(f"No build or channel {args.default}")
        index["default"] = args.default
    for i in args.keep or []:
        ids[i]["keep"] = True
    for i in args.unkeep or []:
        ids[i].pop("keep", None)
    deletes = []
    for i in args.remove or []:
        b = ids.pop(i)
        index["builds"].remove(b)
        index.setdefault("retired", []).append({"id": i, "version": b["version"], "channel": b["channel"], "retired": now_iso()})
    deletes = prune(args.layout, index, 10 ** 6, args.grace_days)
    save_index(args.layout, index)
    write_plan(args.layout, [], [], deletes)
    cmd_list(args)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("layout")
    a.add_argument("--site", required=True, help="dir with keeperfx.js, keeperfx.wasm, gamedata/")
    a.add_argument("--version", required=True, help="e.g. 1.4.0.5603 (what the engine reports)")
    a.add_argument("--channel", required=True, help="alpha | stable | dev")
    a.add_argument("--id", help="build id (default: <version>-<hash of the engine and data list>)")
    a.add_argument("--title", help='shown in the selector (default: "Alpha 1.4.0.5603")')
    a.add_argument("--date", help="when upstream made it (ISO 8601)")
    a.add_argument("--upstream", help="upstream commit")
    a.add_argument("--port", help="commit of the browser port it was built from")
    a.add_argument("--notes", help="link to the release notes / changes")
    a.add_argument("--changes", help="JSON file: [{title, url}] of what is new")
    a.add_argument("--api", type=int, help="page/engine contract version (default: from web/kfx_web.js)")
    a.add_argument("--checkout", default=ROOT, help="source tree it was built from (for --api)")
    a.add_argument("--keep", action="store_true", help="never prune this build")
    a.add_argument("--default", help="make this channel or build id the default")
    a.add_argument("--keep-count", type=int, default=3, help="builds each channel offers (default 3)")
    a.add_argument("--keep-referenced", metavar="URL",
                   help="prune, keeping the builds replays need: the site's /api/replays/builds, or 'none'")
    a.add_argument("--features", help="comma-separated page features the engine has (default: found in --checkout)")
    a.add_argument("--lacks", help="comma-separated page features the engine lacks (default: --checkout's web/build-info.json)")
    a.add_argument("--saves", help="kind of saves, if not the alpha builds' (default: --checkout's web/build-info.json)")
    a.add_argument("--grace-days", type=float, default=14)
    a.set_defaults(func=cmd_add)
    p = sub.add_parser("pull")
    p.add_argument("layout")
    p.add_argument("url", help="where builds/ is served, e.g. https://keeper-data.example/builds/")
    p.set_defaults(func=cmd_pull)
    ls = sub.add_parser("list")
    ls.add_argument("layout")
    ls.set_defaults(func=cmd_list)
    s = sub.add_parser("set")
    s.add_argument("layout")
    s.add_argument("--default")
    s.add_argument("--keep", action="append")
    s.add_argument("--unkeep", action="append")
    s.add_argument("--remove", action="append")
    s.add_argument("--grace-days", type=float, default=14)
    s.set_defaults(func=cmd_set)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
