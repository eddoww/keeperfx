/******************************************************************************/
/** @file WebLobby.c
 *     Browser build: lets the page run an online lobby it hosts.
 * @par Purpose:
 *     Quick match (web/kfx_quickmatch.js) starts its games by itself. Each
 *     frame of the game's lobby screen the page is told how many players are
 *     in (Module.kfxOnLobby, web/kfx_web.js) and may answer with one order:
 *       "say <text>"          a chat line from this player, seen by everyone
 *       "start <pack> <lvl>"  start that level, as the host typing
 *                             "<pack>:<lvl>" in the chat does
 *       "max <n>"             cap the lobby at n players (0: the lobby
 *                             setting again); not saved in settings.toml
 *     The page decides which map and when; this file only carries it out,
 *     on the game's own thread between frames.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "globals.h"
#include "bflib_basics.h"
#include "bflib_datetm.h"
#include "frontend.h"
#include "front_network.h"
#include "game_legacy.h"
#include "net_exchange_common.h"
#include "net_game.h"
#include "net_lobby.h"
#include "net_main.h"
#include "net_spectator.h"
#include "player_data.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

// web/kfx_web.js
extern int kfx_web_lobby_poll(int players, int max_players, int host, int flags, char *buf, int cap);

enum WebLobbyFlags {
    WLF_ColoursConflict = 0x01,
};

// Players the page capped the lobby at; 0 leaves it to the lobby setting.
static int web_max_players = 0;
static TbClockMSec web_lobby_seen = 0;

int web_lobby_max_players(int configured)
{
    if ((web_max_players >= MIN_NET_USERS) && (web_max_players <= MAX_NET_USERS))
        return web_max_players;
    return configured;
}

static void web_lobby_say(const char *text)
{
    char msg[PLAYER_MP_MESSAGE_LEN];
    // Never "<word>:<number>" or "<word> <number>": the host's chat starts levels with that.
    snprintf(msg, sizeof(msg), "%s%s", (isdigit((unsigned char)text[0]) || text[0] == '_') ? "- " : "", text);
    if (msg[0] == '\0')
        return;
    send_network_chat_message(netstate.my_id, msg);
    process_frontend_chat_message(netstate.my_id, msg);
}

static void web_lobby_start(const char *args)
{
    char pack[64];
    int lvnum = 0;
    if ((sscanf(args, "%63s %d", pack, &lvnum) != 2) || (lvnum <= 0)) {
        WARNLOG("Lobby start from the page: bad order '%s'", args);
        return;
    }
    if (net_number_of_enum_players < 2 || net_player_colours_conflict()) {
        WARNLOG("Lobby start from the page refused: %ld players, colours conflict %d",
            net_number_of_enum_players, (int)net_player_colours_conflict());
        return;
    }
    char msg[PLAYER_MP_MESSAGE_LEN];
    snprintf(msg, sizeof(msg), "%s:%d", pack, lvnum);
    JUSTLOG("Lobby start from the page: %s", msg);
    // What frontnet_start_input does when the host presses Enter on it.
    send_network_chat_message(netstate.my_id, msg);
    process_frontend_chat_message(netstate.my_id, msg);
}

void web_lobby_update(void)
{
    TbClockMSec now = LbTimerClock();
    if ((web_lobby_seen != 0) && (now - web_lobby_seen > 2000) && (web_max_players != 0)) {
        // A new lobby: the cap was for the previous one.
        web_max_players = 0;
        if (network_is_host())
            net_lobby_apply_settings();
    }
    web_lobby_seen = now;
    if (!frontnet_service_selected(FrontendNetSvc_Online))
        return;
    int flags = 0;
    if (net_player_colours_conflict())
        flags |= WLF_ColoursConflict;
    char order[PLAYER_MP_MESSAGE_LEN + 16];
    order[0] = '\0';
    if (kfx_web_lobby_poll((int)net_number_of_enum_players, (int)netstate.max_users, network_is_host() ? 1 : 0,
            flags, order, sizeof(order)) <= 0)
        return;
    if (!network_is_host())
        return;
    if (strncmp(order, "say ", 4) == 0) {
        web_lobby_say(order + 4);
    } else if (strncmp(order, "start ", 6) == 0) {
        web_lobby_start(order + 6);
    } else if (strncmp(order, "max ", 4) == 0) {
        int n = atoi(order + 4);
        web_max_players = ((n >= MIN_NET_USERS) && (n <= MAX_NET_USERS)) ? n : 0;
        if (web_max_players && (web_max_players < net_number_of_enum_players))
            web_max_players = (int)net_number_of_enum_players;
        JUSTLOG("Lobby capped by the page at %d players", web_max_players);
        net_lobby_apply_settings();
    } else {
        WARNLOG("Unknown lobby order from the page: '%s'", order);
    }
}

/** 1 while this browser watches an online game as a spectator, 0 otherwise. A rejoin starts as a spectator and
 *  becomes a player again when the host gives the keeper back, so the page asks rather than going by how the
 *  game was started (web/kfx_loader.js, KFX.watching). */
EMSCRIPTEN_KEEPALIVE int kfx_web_spectating(void)
{
    return (network_is_active() && network_user_is_spectator(netstate.my_id)) ? 1 : 0;
}
