/******************************************************************************/
/** @file NetMatchmakingWeb.c
 *     Browser build (KeeperFX 1.4): the online lobby list from the site.
 * @par Purpose:
 *     Stands in for net_matchmaking.c (curl WebSocket to the KeeperFX
 *     matchmaking server, UDP hole punching) and net_portforward.cpp (UPnP),
 *     which a browser cannot do. Lobbies are listed by the site's own server
 *     (GET /api/lobbies, through web/kfx_web.js), hosting and joining go
 *     through its relay (NetWebSP.c), and a host publishes its lobby's name,
 *     players and state as text frames on its relay socket. Only lobbies of
 *     this very version are listed: the game refuses any other at login.
 *     Raw sockets are refused, so nothing in the game tries to reach the
 *     network another way.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <SDL2/SDL.h>
#include <json-dom.h>
#include "bflib_netsession.h"
#include "net_main.h"
#include "net_matchmaking.h"
#include "net_portforward.h"
#include "ver_defs.h"
#include "kfx/platform/web/NetWebSP.h"
#include "post_inc.h"

// web/kfx_web.js
extern void kfx_lobby_request(void);
extern int kfx_lobby_take(char *buf, int cap);

#define HEARTBEAT_MS 60000
#define LOBBY_JSON_MAX (256 * 1024)
#define METADATA_MAX 1024
#define STR_(x) #x
#define STR(x) STR_(x)
#define THIS_VERSION STR(VER_MAJOR) "." STR(VER_MINOR) "." STR(VER_RELEASE) "." STR(VER_BUILD)

struct TbNetworkSessionNameEntry matchmaking_sessions[MATCHMAKING_SESSIONS_MAX];
int matchmaking_session_count = 0;
char join_lobby_id[MATCHMAKING_ID_MAX] = {0};

static char last_metadata[METADATA_MAX];
static TbBool was_locked;
static Uint64 next_heartbeat;
static char lobby_json[LOBBY_JSON_MAX];

static void escape_json(char *out, size_t out_size, const char *in)
{
    size_t o = 0;
    for (; *in && o + 7 < out_size; in++) {
        unsigned char c = (unsigned char)*in;
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = (char)c;
        } else if (c < 0x20) {
            o += (size_t)snprintf(out + o, out_size - o, "\\u%04x", c);
        } else {
            out[o++] = (char)c;
        }
    }
    out[o] = '\0';
}

void matchmaking_connect_async(void)
{
    matchmaking_request_list();
}

int matchmaking_connect(void)
{
    return 0;
}

int matchmaking_request_list(void)
{
    kfx_lobby_request();
    return 0;
}

/** Parses {"lobbies":[{id, name, version, joinable, ...}]}. */
void matchmaking_refresh_sessions(void)
{
    int len = kfx_lobby_take(lobby_json, sizeof(lobby_json));
    if (len < 0)
        return;
    VALUE root = {0};
    if (json_dom_parse(lobby_json, (size_t)len, NULL, 0, &root, NULL) != 0) {
        value_fini(&root);
        return;
    }
    const char *own = web_net_is_host() ? web_net_room_code() : "";
    VALUE *lobbies = value_dict_get(&root, "lobbies");
    int count = 0;
    if (value_type(lobbies) == VALUE_ARRAY) {
        for (int i = 0; i < (int)value_array_size(lobbies) && count < MATCHMAKING_SESSIONS_MAX; i++) {
            VALUE *lobby = value_array_get(lobbies, i);
            const char *id = value_string(value_dict_get(lobby, "id"));
            const char *name = value_string(value_dict_get(lobby, "name"));
            const char *version = value_string(value_dict_get(lobby, "version"));
            if (!id || !name || !*id || strlen(id) >= SESSION_LOBBY_ID_MAX_LEN || strcmp(id, own) == 0)
                continue;
            // Another version's lobby would refuse us at login anyway.
            if (!version || strcmp(version, THIS_VERSION) != 0)
                continue;
            VALUE *joinable = value_dict_get(lobby, "joinable");
            struct TbNetworkSessionNameEntry *session = &matchmaking_sessions[count++];
            memset(session, 0, sizeof(*session));
            session->in_use = 1;
            session->id = count;
            session->joinable = (value_type(joinable) == VALUE_BOOL) ? value_bool(joinable) : 1;
            snprintf(session->text, sizeof(session->text), "%s", name);
            snprintf(session->join_address, sizeof(session->join_address), "%s", id);
            snprintf(session->lobby_id, sizeof(session->lobby_id), "%s", id);
        }
    }
    matchmaking_session_count = count;
    value_fini(&root);
}

int matchmaking_create(const char *name, int udp_ipv4_port, int udp_ipv6_port)
{
    (void)name; (void)udp_ipv4_port; (void)udp_ipv6_port;
    // The relay created the lobby when the host connected (NetWebSP.c);
    // what remains is publishing its name and players.
    last_metadata[0] = '\0';
    was_locked = 0;
    next_heartbeat = 0;
    web_matchmaking_service();
    return web_net_is_host() ? 0 : -1;
}

/** The lobby as the site's lobby list shows it (the alpha's field names). */
static void lobby_metadata(char *out, size_t size)
{
    char name[sizeof(netstate.users[0].name) * 6];
    escape_json(name, sizeof(name), netstate.users[SERVER_ID].name);
    int used = snprintf(out, size, "\"name\":\"%s\",\"version\":\"%s\",\"phase\":\"%s\",\"joinable\":%s,"
        "\"maxPlayers\":%u,\"spectatorSupport\":0,\"players\":[", name, THIS_VERSION,
        netstate.locked ? "In-Game" : "Lobby", netstate.locked ? "false" : "true", netstate.max_players);
    int n = 0;
    for (NetUserId i = 0; i < (NetUserId)netstate.max_players && i < MAX_NET_USERS; i++) {
        if (netstate.users[i].progress != USER_LOGGEDIN || used <= 0 || used >= (int)size)
            continue;
        char player[sizeof(netstate.users[0].name) * 6];
        escape_json(player, sizeof(player), netstate.users[i].name);
        used += snprintf(out + used, size - used, "%s\"%s\"", n++ ? "," : "", player);
    }
    if (used > 0 && used + 2 < (int)size) {
        out[used++] = ']';
        out[used] = '\0';
    } else {
        out[0] = '\0';
    }
}

/** Host: publish lobby metadata when it changes, and keep the listing alive. */
void web_matchmaking_service(void)
{
    if (!web_net_is_host())
        return;
    char metadata[METADATA_MAX];
    lobby_metadata(metadata, sizeof(metadata));
    if (metadata[0] && strcmp(metadata, last_metadata) != 0) {
        char request[METADATA_MAX + 64];
        const char *action = (netstate.locked && !was_locked) ? "game_started" : "update";
        int used = snprintf(request, sizeof(request), "{\"action\":\"%s\",%s}", action, metadata);
        if (used > 0 && used < (int)sizeof(request)) {
            web_net_send_text(request);
            snprintf(last_metadata, sizeof(last_metadata), "%s", metadata);
            was_locked = netstate.locked;
        }
    }
    Uint64 now = SDL_GetTicks64();
    if (now >= next_heartbeat) {
        next_heartbeat = now + HEARTBEAT_MS;
        web_net_send_text("{\"action\":\"ping\"}");
    }
}

void matchmaking_disconnect(void)
{
    if (web_net_is_host())
        web_net_send_text(netstate.locked ? "{\"action\":\"delete\"}" : "{\"action\":\"cancel\"}");
    matchmaking_session_count = 0;
}

int matchmaking_punch(const char *lobby_id, int udp_ipv4_port, int udp_ipv6_port, PunchAddresses *output)
{
    (void)lobby_id; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)output;
    return -1; // no hole punching: the relay connects everyone
}

int matchmaking_poll_punch(PunchAddresses *output) { (void)output; return 0; }

int port_forward_add_mapping(uint16_t port) { (void)port; return -1; }
void port_forward_remove_mapping(void) {}

int __wrap___syscall_socket(int domain, int type, int protocol, int unused1, int unused2, int unused3)
{
    (void)domain; (void)type; (void)protocol; (void)unused1; (void)unused2; (void)unused3;
    return -EAFNOSUPPORT;
}
