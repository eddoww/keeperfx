/******************************************************************************/
/** @file WebReport.c
 *     Browser build: tells the page how a level ended.
 * @par Purpose:
 *     When the local player wins or loses a level, the page gets one JSON
 *     object with the level, the score and the level statistics
 *     (Module.kfxOnLevelResult, web/kfx_loader.js). The site's Hall of Fame
 *     (web/server/src/scores.js) is built from these.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <stdio.h>
#include <string.h>
#include "globals.h"
#include "bflib_basics.h"
#include "player_data.h"
#include "player_utils.h"
#include "dungeon_data.h"
#include "config.h"
#include "config_campaigns.h"
#include "config_strings.h"
#include "game_legacy.h"
#include "game_merge.h"
#include "net_game.h"
#include "ver_defs.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

// web/kfx_web.js
extern void kfx_web_level_result(const char *json);

static size_t append_json_string(char *out, size_t size, size_t used, const char *in)
{
    if (used + 1 < size)
        out[used++] = '"';
    for (; in && *in && used + 8 < size; in++) {
        unsigned char c = (unsigned char)*in;
        if (c == '"' || c == '\\') {
            out[used++] = '\\';
            out[used++] = (char)c;
        } else if (c < 0x20) {
            used += (size_t)snprintf(out + used, size - used, "\\u%04x", c);
        } else {
            out[used++] = (char)c;
        }
    }
    if (used + 1 < size)
        out[used++] = '"';
    out[used] = '\0';
    return used;
}

#define APPEND(...) do { \
    if (used < sizeof(json)) used += (size_t)snprintf(json + used, sizeof(json) - used, __VA_ARGS__); \
    if (used >= sizeof(json)) return; \
} while (0)
#define APPEND_STRING(text) do { \
    used = append_json_string(json, sizeof(json), used, text); \
    if (used + 64 >= sizeof(json)) return; \
} while (0)

void web_report_level_result(struct PlayerInfo *player, TbBool won)
{
    static char json[4096];
    size_t used = 0;
    struct Dungeon *dungeon = get_dungeon(player->id_number);
    const struct LevelStats *st = &dungeon->lvstats;
    LevelNumber lvnum = get_loaded_level_number();
    struct LevelInformation *lvinfo = get_level_info(lvnum);
    const char *lvname = "";
    if (lvinfo != NULL)
        lvname = (lvinfo->name_stridx > 0) ? get_string(lvinfo->name_stridx) : lvinfo->name;
    const char *kind = "other";
    if (is_singleplayer_level(lvnum))
        kind = "campaign";
    else if (is_multiplayer_level(lvnum))
        kind = "multiplayer";
    else if (is_freeplay_level(lvnum))
        kind = "freeplay";

    // KeeperFX 1.4 has no placeholder keepers for dropped humans, so
    // keepersDropped is always 0 here.
    int humans = 0;
    int keepers = 0;
    int dropped = 0;
    for (PlayerNumber i = 0; i < PLAYERS_COUNT; i++) {
        struct PlayerInfo *other = get_player(i);
        if (!player_exists(other) || !player_is_keeper(i))
            continue;
        keepers++;
        if ((other->allocflags & PlaF_CompCtrl) == 0)
            humans++;
    }

    APPEND("{\"won\":%s,\"version\":\"%d.%d.%d.%d\",\"campaign\":", won ? "true" : "false",
        VER_MAJOR, VER_MINOR, VER_RELEASE, VER_BUILD);
    APPEND_STRING(campaign.fname);
    APPEND(",\"campaignName\":");
    APPEND_STRING(campaign.display_name[0] ? campaign.display_name : campaign.name);
    APPEND(",\"level\":%d,\"levelIndex\":%d,\"levelName\":", (int)lvnum,
        is_singleplayer_level(lvnum) ? (int)array_index_for_singleplayer_level(lvnum) : -1);
    APPEND_STRING(lvname);
    APPEND(",\"kind\":\"%s\",\"online\":%s,\"cheats\":%s,\"humans\":%d,\"keepers\":%d",
        kind, network_is_active() ? "true" : "false",
        game.easter_eggs_enabled ? "true" : "false", humans, keepers);
    APPEND(",\"score\":%ld,\"turns\":%lu,\"turnsPerSecond\":%d",
        (long)st->player_score, (unsigned long)get_gameturn(), (int)turns_per_second);
    APPEND(",\"stats\":{\"creatures\":%lu,\"goldMined\":%lu,\"battlesWon\":%lu,\"battlesLost\":%lu"
        ",\"keepersDestroyed\":%lu,\"roomsBuilt\":%lu,\"areaClaimed\":%lu,\"rockDug\":%lu"
        ",\"slaps\":%lu,\"researched\":%lu,\"trapsMade\":%lu,\"doorsMade\":%lu"
        ",\"tortured\":%lu,\"sacrificed\":%lu,\"chickensEaten\":%lu,\"backsStabbed\":%lu,\"keepersDropped\":%d}}",
        (unsigned long)st->num_creatures, (unsigned long)st->gold_mined,
        (unsigned long)st->battles_won, (unsigned long)st->battles_lost,
        (unsigned long)st->keepers_destroyed, (unsigned long)st->rooms_constructed,
        (unsigned long)st->area_claimed, (unsigned long)st->rock_dug_out,
        (unsigned long)st->num_slaps, (unsigned long)st->things_researched,
        (unsigned long)st->manufactured_traps, (unsigned long)st->manufactured_doors,
        (unsigned long)st->creatures_tortured, (unsigned long)st->creatures_sacrificed,
        (unsigned long)st->chickens_eaten, (unsigned long)st->backs_stabbed, dropped);
    kfx_web_level_result(json);
}
