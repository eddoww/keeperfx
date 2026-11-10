/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file net_compat.c
 *     Which game versions can play multiplayer together.
 * @par Purpose:
 *     See net_compat.h.
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include "net_compat.h"

#include <stddef.h>
#include <stdio.h>
#include "globals.h"
#include <string.h>
#include "net_main.h"
#include "post_inc.h"

const struct NetCompatInfo net_local_compat = {
    NET_COMPAT_MAGIC, NET_PROTOCOL_VERSION, NET_PROTOCOL_OLDEST, NET_SIM_VERSION, NET_CAPABILITIES_LOCAL,
};

TbBool net_compat_read(const char **read_pos, const char *end_pos, struct NetCompatInfo *out)
{
    if (end_pos - *read_pos < (ptrdiff_t)sizeof(*out)) {
        return false;
    }
    struct NetCompatInfo info;
    memcpy(&info, *read_pos, sizeof(info));
    if (info.magic != NET_COMPAT_MAGIC || info.protocol_oldest > info.protocol) {
        return false;
    }
    *out = info;
    *read_pos += sizeof(info);
    return true;
}

char *net_compat_write(char *write_pos)
{
    memcpy(write_pos, &net_local_compat, sizeof(net_local_compat));
    return write_pos + sizeof(net_local_compat);
}

enum NetCompatResult net_compat_check(const struct NetCompatInfo *a, TbBool a_known, const struct GameVersionPacket *a_version,
    const struct NetCompatInfo *b, TbBool b_known, const struct GameVersionPacket *b_version)
{
    if (!a_known || !b_known) {
        if (a_version != NULL && b_version != NULL && net_versions_match(a_version, b_version)) {
            return NetCompat_Legacy;
        }
        return NetCompat_Version;
    }
    if (a->protocol < b->protocol_oldest || b->protocol < a->protocol_oldest) {
        return NetCompat_Protocol;
    }
    if (a->sim != b->sim) {
        return NetCompat_Simulation;
    }
    return NetCompat_Ok;
}

TbBool net_compat_ok(enum NetCompatResult result)
{
    return result == NetCompat_Ok || result == NetCompat_Legacy;
}

enum NetJoinRejection net_compat_join_rejection(enum NetCompatResult result, TbBool remote_known)
{
    if (remote_known && result == NetCompat_Simulation) {
        return NetJoin_GameRules;
    }
    if (remote_known && result == NetCompat_Protocol) {
        return NetJoin_Protocol;
    }
    return NetJoin_Version;
}

uint32_t net_compat_common_capabilities(const struct NetCompatInfo *remote, TbBool remote_known)
{
    if (!remote_known) {
        return NetCap_None;
    }
    return remote->capabilities & net_local_compat.capabilities;
}

enum NetCompatResult net_users_compat(const struct NetUser *a, const struct NetUser *b)
{
    return net_compat_check(&a->compat, a->compat_known, &a->version, &b->compat, b->compat_known, &b->version);
}

void net_compat_format(const struct NetCompatInfo *info, char *out, size_t out_size)
{
    snprintf(out, out_size, "%u-%u/%u", (unsigned)info->protocol_oldest, (unsigned)info->protocol, (unsigned)info->sim);
}

TbBool net_compat_parse(const char *text, struct NetCompatInfo *out)
{
    unsigned oldest, protocol, sim;
    if (text == NULL || sscanf(text, "%u-%u/%u", &oldest, &protocol, &sim) != 3 || oldest > protocol || protocol > 0xFFFF) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    out->magic = NET_COMPAT_MAGIC;
    out->protocol_oldest = (uint16_t)oldest;
    out->protocol = (uint16_t)protocol;
    out->sim = sim;
    return true;
}
