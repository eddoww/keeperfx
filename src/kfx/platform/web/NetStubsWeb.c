/******************************************************************************/
/** @file NetStubsWeb.c
 *     Browser build: online matchmaking and router port forwarding.
 * @par Purpose:
 *     Browsers have no raw TCP/UDP sockets, curl or UPnP, so net_matchmaking.c
 *     and net_portforward.cpp are not built for the web. These stand-ins keep
 *     the online lobby switched off; the rest of the game is unaffected.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include "net_matchmaking.h"
#include "net_portforward.h"
#include "post_inc.h"

struct TbNetworkSessionNameEntry matchmaking_sessions[MATCHMAKING_SESSIONS_MAX];
TbBool matchmaking_enabled = 0;
char matchmaking_ws_url[MATCHMAKING_URL_MAX] = "";
char matchmaking_ip_url[MATCHMAKING_URL_MAX] = "";
int matchmaking_session_count = 0;
char join_lobby_id[MATCHMAKING_ID_MAX] = {0};

void matchmaking_set_server(const char *host) { (void)host; }
void matchmaking_connect_async(void) {}
int matchmaking_request_list(void) { return -1; }
void matchmaking_disconnect(enum NetSessionPhase phase) { (void)phase; }
void matchmaking_start_game(int map_number, const char *map_name) { (void)map_number; (void)map_name; }
void matchmaking_service(void) {}
void matchmaking_refresh_sessions(void) { matchmaking_session_count = 0; }
int matchmaking_create(const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, int direct_ipv4_port)
{
    (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)direct_ipv4_port;
    return -1;
}
int matchmaking_punch(const char *lobby_id, const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, PunchAddresses *output)
{
    (void)lobby_id; (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)output;
    return -1;
}
int matchmaking_poll_punch(PunchAddresses *output) { (void)output; return 0; }

void port_forward_set_mapping(uint16_t port) { (void)port; }
