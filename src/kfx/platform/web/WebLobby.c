/******************************************************************************/
/** @file WebLobby.c
 *     Browser build (KeeperFX 1.4): the page sees the online lobby screen.
 * @par Purpose:
 *     Each frame of the lobby screen the page is told how many keepers are in
 *     (web/kfx_web.js, Module.kfxOnLobby) and may answer with one order for
 *     the host's game, as with the alpha builds: "say <text>" (a chat line)
 *     or "start <pack> <level>" (start that map). Quick match uses them to
 *     start the game by itself. 1.4 starts a map the way its own -level
 *     autostart does: the host "types" <pack>:<level> into the lobby chat.
 *     "max <n>" (capping the lobby) is not carried out: 1.4's lobby has a
 *     fixed size.
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
#include "globals.h"
#include "bflib_basics.h"
#include "bflib_keybrd.h"
#include "frontend.h"
#include "front_network.h"
#include "net_game.h"
#include "net_main.h"
#include "player_data.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

// web/kfx_web.js
extern int kfx_web_lobby_poll(int players, int max_players, int host, int flags, char *buf, int cap);

/** A map start ordered by the page, sent once the lobby's connections have
 * settled (as 1.4's own -level autostart waits for them). */
static char pending_start[PLAYER_MP_MESSAGE_LEN];

/** Sends a chat line from the host, as pressing Enter on the typed text does. */
static void web_lobby_send(const char *text)
{
    struct PlayerInfo *player = get_my_player();
    snprintf(player->mp_message_text, PLAYER_MP_MESSAGE_LEN, "%s", text);
    lbInkey = KC_RETURN;
}

void web_lobby_update(void)
{
    if (!frontnet_service_selected(FrontendNetSvc_Online))
        return;
    TbBool host = (my_player_number == get_host_player_id());
    if (pending_start[0] != '\0') {
        if (!host || net_number_of_enum_players < 2) {
            pending_start[0] = '\0'; // someone left: the page orders again
        } else if (!frontnet_is_waiting_for_ping_stabilization()) {
            JUSTLOG("Lobby start from the page: %s", pending_start);
            web_lobby_send(pending_start);
            pending_start[0] = '\0';
        }
    }
    char order[PLAYER_MP_MESSAGE_LEN + 16];
    order[0] = '\0';
    if (kfx_web_lobby_poll((int)net_number_of_enum_players, (int)netstate.max_players, host ? 1 : 0,
            0, order, sizeof(order)) <= 0)
        return;
    if (!host)
        return;
    if (strncmp(order, "say ", 4) == 0) {
        // Never "<word>:<number>" or "<word> <number>": the host's chat starts
        // levels with that (try_starting_level_from_chat in front_network.c).
        const char *text = order + 4;
        const char *sep = strchr(text, ':');
        if (sep == NULL)
            sep = strchr(text, ' ');
        size_t at = sep ? (size_t)(sep - text) + 1 : 0;
        while (sep && text[at] == ' ')
            at++;
        char msg[PLAYER_MP_MESSAGE_LEN];
        if (sep && (isdigit((unsigned char)text[at]) || text[at] == '_'))
            snprintf(msg, sizeof(msg), "%.*s- %s", (int)at, text, text + at);
        else
            snprintf(msg, sizeof(msg), "%s", text);
        if (msg[0] != '\0')
            web_lobby_send(msg);
    } else if (strncmp(order, "start ", 6) == 0) {
        char pack[64];
        int lvnum = 0;
        if ((sscanf(order + 6, "%63s %d", pack, &lvnum) != 2) || (lvnum <= 0) || (net_number_of_enum_players < 2)) {
            WARNLOG("Lobby start from the page refused: '%s', %ld players", order, net_number_of_enum_players);
            return;
        }
        snprintf(pending_start, sizeof(pending_start), "%s:%d", pack, lvnum);
    } else if (strncmp(order, "max ", 4) == 0) {
        JUSTLOG("Lobby cap from the page ignored (%s): 1.4's lobby has a fixed size", order + 4);
    } else {
        WARNLOG("Unknown lobby order from the page: '%s'", order);
    }
}
