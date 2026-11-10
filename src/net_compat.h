/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file net_compat.h
 *     Which game versions can play multiplayer together.
 * @par Purpose:
 *     Multiplayer is lockstep: every computer runs the same simulation from
 *     the same inputs. Two builds can play together when they agree on two
 *     things, which are versioned here instead of comparing build numbers:
 *
 *     NET_PROTOCOL_VERSION   the network wire format: message types and
 *                            layouts. Bump it when a message changes shape.
 *                            NET_PROTOCOL_OLDEST is the oldest version this
 *                            build still speaks; two builds talk when their
 *                            ranges overlap.
 *     NET_SIM_VERSION        the simulation: game logic, the meaning of
 *                            packets, anything that makes the same inputs
 *                            give a different game state. Bump it with every
 *                            change that would make a game between the old
 *                            and the new build desync. Builds that differ
 *                            only in menus, rendering, sound, platform code,
 *                            the network transport or the web page keep it
 *                            and stay compatible.
 *
 *     Rules for bumping NET_SIM_VERSION (when in doubt, bump):
 *       - any change under src/ that runs during game turns and changes what
 *         they compute (creatures, rooms, spells, AI, scripts, Lua API,
 *         random number use, packet processing, config parsing that changes
 *         loaded values or defaults);
 *       - a changed default in the shipped rules/configs does NOT need a
 *         bump: data files are compared at level start (net_filecheck.c);
 *       - the guard: tools/netbench/simcompat.sh plays a recorded game with
 *         two builds; if they desync, the simulation changed.
 *
 *     Optional features are capability flags (NetCap_*): both sides announce
 *     theirs and use only what both have, so a newer build can still play
 *     with an older one that lacks a feature.
 *
 *     The versions travel in an extension block appended to the login
 *     message and its reply, the user updates and the lobby metadata. Builds
 *     from before this scheme send no block: they are matched by exact
 *     version number as before.
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#ifndef DK_NET_COMPAT_H
#define DK_NET_COMPAT_H

#include "bflib_basics.h"
#include "bflib_netsession.h"

#ifdef __cplusplus
extern "C" {
#endif

#define NET_PROTOCOL_VERSION 1
#define NET_PROTOCOL_OLDEST 1
#define NET_SIM_VERSION 1

#define NET_COMPAT_MAGIC 0x4358464BU /* "KFXC" */

enum NetCapabilities {
    NetCap_None = 0,
    NetCap_DeltaResync = 0x0001,  // resync sends only the parts of the game state that differ (net_resync.cpp)
};
#define NET_CAPABILITIES_LOCAL (NetCap_DeltaResync)

#pragma pack(1)
struct NetCompatInfo {
    uint32_t magic;
    uint16_t protocol;
    uint16_t protocol_oldest;
    uint32_t sim;
    uint32_t capabilities;
};
#pragma pack()

enum NetCompatResult {
    NetCompat_Ok,
    NetCompat_Legacy,      // no compatibility block on one side, exact versions matched
    NetCompat_Version,     // no block on one side and the version numbers differ
    NetCompat_Protocol,    // network formats have no version in common
    NetCompat_Simulation,  // game rules differ: would desync
};

struct GameVersionPacket;

extern const struct NetCompatInfo net_local_compat;

/** Reads a compatibility block at *read_pos (if there is one) and advances past it. */
TbBool net_compat_read(const char **read_pos, const char *end_pos, struct NetCompatInfo *out);
/** Writes the local block, returns the new write position. */
char *net_compat_write(char *write_pos);
enum NetCompatResult net_compat_check(const struct NetCompatInfo *a, TbBool a_known, const struct GameVersionPacket *a_version,
    const struct NetCompatInfo *b, TbBool b_known, const struct GameVersionPacket *b_version);
TbBool net_compat_ok(enum NetCompatResult result);
/** The reason a host gives when refusing a user; builds without the block only know NetJoin_Version. */
enum NetJoinRejection net_compat_join_rejection(enum NetCompatResult result, TbBool remote_known);
uint32_t net_compat_common_capabilities(const struct NetCompatInfo *remote, TbBool remote_known);
/** "<protocol_oldest>-<protocol>/<sim>", as used in lobby metadata. */
void net_compat_format(const struct NetCompatInfo *info, char *out, size_t out_size);
TbBool net_compat_parse(const char *text, struct NetCompatInfo *out);

#ifdef __cplusplus
}
#endif

#endif
