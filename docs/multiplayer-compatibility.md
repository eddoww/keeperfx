# Which game versions can play multiplayer together

KeeperFX multiplayer is *lockstep*: every computer runs the whole game
simulation itself and only the players' inputs travel over the network. For
that to work, two computers must

1. understand each other's messages (the **network protocol**), and
2. compute exactly the same game from the same inputs (the **simulation**:
   game logic and the rules/config/map data it reads).

Until now a game only accepted players whose version number matched to the
last digit (`VER_MAJOR.VER_MINOR.VER_RELEASE.VER_BUILD`), so every build was
cut off from every other build, including builds that differ only in menus,
graphics, sound, platform code or bug fixes outside the game turn.

## The two versions

`src/net_compat.h` defines them:

| Constant | Meaning | Bump it when |
|---|---|---|
| `NET_PROTOCOL_VERSION` | the wire format: message types and their layouts | a message changes shape or meaning in a way an older build would misread |
| `NET_PROTOCOL_OLDEST` | the oldest protocol version this build still speaks | you drop support for an older format |
| `NET_SIM_VERSION` | the simulation | any change that makes the same inputs give a different game state |

Two builds play together when their protocol ranges overlap
(`[OLDEST, VERSION]`) and their `NET_SIM_VERSION` is equal. Everything else may
differ.

### When to bump `NET_SIM_VERSION`

Bump it for any change that runs during a game turn and changes what it
computes: creatures, rooms, traps, spells, the computer player, scripts and the
Lua API, the order or number of random numbers drawn, packet processing,
config parsing that changes loaded values or defaults, pathfinding results.
When in doubt, bump: the cost of a needless bump is that two builds stop
meeting; the cost of a missed one is games that desync.

You do **not** need to bump it for changes to the shipped rules, config or map
*files*: those are compared at level start (`src/net_filecheck.c`), and a
player whose files differ from the host's is sent back to the lobby with the
list of differing files.

### The guard

The rule above is easy to forget, so it needs a check that does not depend on
anyone remembering. Proposed (and available locally as
`tools/netbench/simcompat.sh` on the test bench branch): two builds play an
AI-only multiplayer game against each other for a few thousand turns over
loopback; if they desync, resync, or end with a different state hash, the
simulation differs. In CI this would run the pull request's build against the
build of the last `NET_SIM_VERSION` change (the merge base works too) and fail
when they diverge with the same `NET_SIM_VERSION`. A replay-based variant (play
a replay recorded by the old build with the new one; the replay already stores
per-turn checksums) needs no network and fits a unit-test job.

## Capability flags

Optional features that need both sides' support are capability flags
(`enum NetCapabilities`). Each side announces its flags; both use only those
they share (`net_user_has_capability()`). So a newer build can add a feature
without a protocol bump and still play with an older build that lacks it.
The first one is `NetCap_DeltaResync` (a resync sends only the parts of the
game state that differ).

## On the wire

The versions travel in a 16-byte block (`struct NetCompatInfo`: magic `KFXC`,
protocol, oldest protocol, simulation version, capabilities) appended to:

- the login message (client to host) and the host's login reply;
- the user updates the host sends about each player;
- the lobby metadata published to the matchmaking server, LAN and the browser
  lobby list, as `"netCompat": "<oldest>-<protocol>/<sim>"`, also sent with the
  matchmaking `list` and `punch` requests.

Older builds ignore trailing bytes and unknown JSON fields, so nothing breaks
for them.

A host refuses an incompatible player with a specific reason. The player's
game shows "The host runs a game version with different game rules" when the
simulation differs, and the existing "different version" message otherwise.
The lobby list greys out lobbies the player cannot join by the same rules.

Replays record `net_sim_version` in their header; a replay from a build with
the same simulation version plays without the "different version" warning.

## Builds from before this scheme

A build without the block is matched the old way, by exact version number,
in both directions. Because every new build has a new build number, old and new
builds are separated once; from then on, builds that share the simulation
version meet regardless of build number. The one existing exception is kept:
a host still lets the stable release (1.4.0.5136) in so it can see the
version-mismatch message in the lobby.

The matchmaking server is a separate project. If it filters lobbies or punch
requests by `version`, it has to compare `netCompat` instead when both sides
send one (`web/server/src/netcompat.js` has the comparison in JavaScript);
until then it keeps separating builds by version, which is safe.

## The browser site

Each engine build on the site records its key (`netCompat` in
`builds/index.json`, written by `web/publish-build.py` from the build's
`src/net_compat.h`; the `kfx-net-compat` meta tag for the engine next to the
page). The lobby list, invites and quick match use it: a lobby whose key is
compatible with the running build is joined without switching version; quick
match pairs keepers whose keys are compatible. Pages, builds and lobbies
without a key fall back to the exact build, as before.

## The limit

With lockstep, two builds whose simulation differs can never play together:
there is no way to "translate" a game computed one way into one computed
another way. The gain is that the many builds that do not touch the
simulation (fixes and features in menus, rendering, sound, platforms,
networking, the web page) stay compatible with each other.
