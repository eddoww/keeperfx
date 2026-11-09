/******************************************************************************/
/** @file NetMatchmakingWeb.c
 *     Browser build: online lobbies and the other network pieces a browser
 *     can't run as-is.
 * @par Purpose:
 *     Replaces net_matchmaking.c (curl WebSocket to the KeeperFX matchmaking
 *     server, UDP hole punching) with the page's own lobby service
 *     (web/server): the lobby list comes from GET /api/lobbies and a hosted
 *     lobby's metadata goes over the host's relay connection (NetWebSP.c), in
 *     the same JSON form as the desktop matchmaking protocol.
 *     Also replaces net_portforward.cpp (UPnP) and refuses socket creation
 *     outright (the link step wraps the socket syscall): Emscripten would
 *     otherwise emulate UDP over WebSockets and have the page try the STUN and
 *     game hosts the enet code names, which cannot work.
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
#include <SDL3/SDL.h>
#include <json-dom.h>
#include "bflib_netsession.h"
#include "net_matchmaking.h"
#include "net_portforward.h"
#include "net_lobby.h"
#include "kfx/platform/web/NetWebSP.h"
#include "post_inc.h"

// web/kfx_web.js
extern void kfx_lobby_request(void);
extern int kfx_lobby_take(char *buf, int cap);

#define HEARTBEAT_MS 60000
#define LOBBY_JSON_MAX (256 * 1024)

struct TbNetworkSessionNameEntry matchmaking_sessions[MATCHMAKING_SESSIONS_MAX];
TbBool matchmaking_enabled = 1;
char matchmaking_ws_url[MATCHMAKING_URL_MAX] = "";
char matchmaking_ip_url[MATCHMAKING_URL_MAX] = "";
int matchmaking_session_count = 0;
char join_lobby_id[MATCHMAKING_ID_MAX] = {0};

static char last_metadata[SESSION_METADATA_MAX];
static char start_metadata[LINEMSG_SIZE * 6 + 64];
static TbBool start_pending;
static Uint64 next_heartbeat;
static char lobby_json[LOBBY_JSON_MAX];

void matchmaking_set_server(const char *host) { (void)host; }

void matchmaking_connect_async(void)
{
    matchmaking_request_list();
}

int matchmaking_request_list(void)
{
    kfx_lobby_request();
    return 0;
}

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

/** Parses {"lobbies":[{id, name, ...metadata}]} like net_matchmaking.c does. */
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
            if (!id || !name || !*id || strlen(id) >= SESSION_LOBBY_ID_MAX_LEN || strcmp(id, own) == 0)
                continue;
            struct TbNetworkSessionNameEntry *session = &matchmaking_sessions[count++];
            memset(session, 0, sizeof(*session));
            session->in_use = 1;
            session->id = count;
            snprintf(session->text, sizeof(session->text), "%s", name);
            snprintf(session->join_address, sizeof(session->join_address), "%s", id);
            snprintf(session->lobby_id, sizeof(session->lobby_id), "%s", id);
            net_session_parse_metadata(session, lobby);
        }
    }
    matchmaking_session_count = count;
    value_fini(&root);
}

int matchmaking_create(const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, int direct_ipv4_port)
{
    (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)direct_ipv4_port;
    // The relay created the lobby when the host connected (NetWebSP.c);
    // what remains is publishing its name and settings.
    last_metadata[0] = '\0';
    start_metadata[0] = '\0';
    start_pending = false;
    next_heartbeat = 0;
    matchmaking_service();
    return web_net_is_host() ? 0 : -1;
}

void matchmaking_start_game(int map_number, const char *map_name)
{
    char escaped[LINEMSG_SIZE * 6 + 1];
    escape_json(escaped, sizeof(escaped), map_name ? map_name : "");
    snprintf(start_metadata, sizeof(start_metadata), "\"mapNumber\":%d,\"mapName\":\"%s\",", map_number, escaped);
    start_pending = true;
}

/** Host: publish lobby metadata when it changes, and keep the listing alive. */
void matchmaking_service(void)
{
    if (!web_net_is_host())
        return;
    struct LobbyAdvertisement ad;
    net_lobby_advertisement(&ad);
    char request[SESSION_METADATA_MAX + sizeof(start_metadata) + 128];
    if (ad.metadata[0] && (start_pending || strcmp(ad.metadata, last_metadata) != 0)) {
        const char *action = start_pending ? "game_started" : "update";
        const char *fields = start_pending ? start_metadata : "";
        int used = snprintf(request, sizeof(request), "{\"action\":\"%s\",%s%s}", action, fields, ad.metadata);
        if (used > 0 && used < (int)sizeof(request)) {
            web_net_send_text(request);
            snprintf(last_metadata, sizeof(last_metadata), "%s", ad.metadata);
            start_pending = false;
        }
    }
    Uint64 now = SDL_GetTicks();
    if (now >= next_heartbeat) {
        next_heartbeat = now + HEARTBEAT_MS;
        web_net_send_text("{\"action\":\"ping\"}");
    }
}

void matchmaking_disconnect(enum NetSessionPhase phase)
{
    if (web_net_is_host())
        web_net_send_text(phase == NetPhase_InGame ? "{\"action\":\"delete\"}" : "{\"action\":\"cancel\"}");
    matchmaking_session_count = 0;
}

int matchmaking_punch(const char *lobby_id, const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, PunchAddresses *output)
{
    (void)lobby_id; (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)output;
    return -1; // no hole punching: the relay connects everyone
}

int matchmaking_poll_punch(PunchAddresses *output) { (void)output; return 0; }

void port_forward_set_mapping(uint16_t port) { (void)port; }

int __wrap___syscall_socket(int domain, int type, int protocol, int unused1, int unused2, int unused3)
{
    (void)domain; (void)type; (void)protocol; (void)unused1; (void)unused2; (void)unused3;
    return -EAFNOSUPPORT;
}
