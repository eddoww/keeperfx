#!/usr/bin/env python3
"""What upstream KeeperFX has published, for keeping the browser site's
engine builds up to date (see docs/web.md, "Game versions").

Upstream (dkfans/keeperfx) publishes:
  - stable releases: GitHub releases, tags vX.Y.Z, with a complete 7z;
  - alpha builds: every push to master is built by the "Alpha Patches"
    workflow and served on keeperfx.net as keeperfx-X_Y_Z_<N>-Alpha-patch.7z,
    where N = `git rev-list --count <commit>` (the engine's build number, so
    it reports itself as X.Y.Z.N Alpha).
keeperfx.net has a small API for both:
  https://keeperfx.net/api/v1/release/alpha/latest
  https://keeperfx.net/api/v1/release/stable/latest

Commands (each prints JSON):
  latest alpha|stable [--repo DIR]
      The newest upstream build: version, build number, commit, date, title,
      download URL. The commit comes from GitHub (the workflow run), or from
      the build number in a local clone of upstream master (--repo).
  commit <N> --repo DIR [--ref origin/master]
      The master commit whose build number is N.
  changes <from> <to> --repo DIR
      Upstream commits between two commits, newest first, as
      [{"title", "url"}] with links to the pull requests.
  published <builds-url> alpha|stable [--commit SHA --port SHA]
      What a site already offers of that channel: {"newest": its newest
      build or null, "has": whether one was built from that upstream commit
      and port commit}.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://keeperfx.net/api/v1/release"
GITHUB = "https://github.com/dkfans/keeperfx"
GITHUB_API = "https://api.github.com/repos/dkfans/keeperfx"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "keeperfx-web-builds", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()


def commit_for_build(repo, number, ref="origin/master"):
    """The commit on ref's first-parent line whose rev-list count is number."""
    head = int(git(repo, "rev-list", "--count", ref))
    if number > head:
        return None
    # Walk back along first parents; counts drop by the size of each merge.
    for sha in git(repo, "rev-list", "--first-parent", ref).splitlines():
        n = int(git(repo, "rev-list", "--count", sha))
        if n == number:
            return sha
        if n < number:
            return None
    return None


def cmd_latest(args):
    data = get_json(f"{API}/{args.channel}/latest")
    if args.channel == "alpha":
        b = data["alpha_build"]
        number = int(b["version"].rsplit(".", 1)[1])
        commit = None
        try:
            run = get_json(f"{GITHUB_API}/actions/runs/{b['workflow_run_id']}")
            commit = run.get("head_sha")
        except (urllib.error.URLError, KeyError, ValueError):
            pass
        if not commit and args.repo:
            commit = commit_for_build(args.repo, number)
        out = {
            "channel": "alpha", "version": b["version"], "build": number, "commit": commit,
            "date": b["timestamp"], "title": b.get("workflow_title", ""), "download": b["download_url"],
            "notes": f"{GITHUB}/commits/{commit}" if commit else "https://keeperfx.net/downloads/alpha",
        }
    else:
        r = data["release"]
        commit = None
        if args.repo:
            try:
                commit = git(args.repo, "rev-list", "-n1", r["tag"])
            except subprocess.CalledProcessError:
                pass
        out = {
            "channel": "stable", "version": r["version"], "tag": r["tag"], "commit": commit,
            "date": r["timestamp"], "title": r["name"], "download": r["download_url"],
            "notes": f"{GITHUB}/releases/tag/{r['tag']}",
        }
    print(json.dumps(out, indent=1))


def cmd_commit(args):
    print(json.dumps(commit_for_build(args.repo, args.number, args.ref)))


def cmd_changes(args):
    log = git(args.repo, "log", "--first-parent", "--format=%H%x09%s", f"{args.since}..{args.to}")
    out = []
    for line in log.splitlines()[:args.max]:
        sha, title = line.split("\t", 1)
        pr = re.search(r"\(#(\d+)\)\s*$", title)
        out.append({"title": re.sub(r"\s*\(#\d+\)\s*$", "", title),
                    "url": f"{GITHUB}/pull/{pr.group(1)}" if pr else f"{GITHUB}/commit/{sha}"})
    print(json.dumps(out, indent=1))


def cmd_published(args):
    base = args.url if args.url.endswith("/") else args.url + "/"
    try:
        index = get_json(base + "index.json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(json.dumps({"newest": None, "has": False}))
            return
        raise
    builds = [b for b in index.get("builds", []) if b.get("channel") == args.channel]
    newest = builds[0] if builds else None
    has = any(b.get("upstream") == args.commit and b.get("port") == args.port for b in builds) if args.commit else False
    print(json.dumps({"newest": newest and {k: newest.get(k) for k in ("id", "version", "upstream", "port", "date")},
                      "has": has}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("latest")
    p.add_argument("channel", choices=["alpha", "stable"])
    p.add_argument("--repo")
    p.set_defaults(func=cmd_latest)
    p = sub.add_parser("commit")
    p.add_argument("number", type=int)
    p.add_argument("--repo", required=True)
    p.add_argument("--ref", default="origin/master")
    p.set_defaults(func=cmd_commit)
    p = sub.add_parser("changes")
    p.add_argument("since")
    p.add_argument("to")
    p.add_argument("--repo", required=True)
    p.add_argument("--max", type=int, default=40)
    p.set_defaults(func=cmd_changes)
    p = sub.add_parser("published")
    p.add_argument("url")
    p.add_argument("channel", choices=["alpha", "stable"])
    p.add_argument("--commit", help="upstream commit to look for")
    p.add_argument("--port", help="port commit to look for")
    p.set_defaults(func=cmd_published)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
