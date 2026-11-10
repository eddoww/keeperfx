/******************************************************************************/
/** @file NetWebSP.c
 *     Browser build: network transport over the lobby relay.
 * @par Purpose:
 *     Implements struct NetSP (net_main.h), as bflib_enet.cpp does for UDP,
 *     on top of one WebSocket to the relay (web/server/src/room.js). The host
 *     opens a new lobby and gets a code; players join with that code. All
 *     traffic goes through the relay: joiners talk only to the host, the host
 *     addresses each joiner by the relay's connection number, which this file
 *     maps to game user ids.
 *     WebSockets are reliable and ordered, so the "unsequenced" channel uses
 *     the same path. Waiting for a message yields to the browser (Asyncify).
 *     A dropped socket is resumed by the page (web/kfx_web.js) without losing
 *     frames; meanwhile the relay tells the host LINK_DOWN, and the host gives
 *     that player PEER_TIMEOUT_MS to come back before timing them out, as
 *     ENet does on the desktop (the game then pauses, the computer keeps
 *     their keeper, and they can rejoin through the spectator seat).
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "bflib_datetm.h"
#include "globals.h" // ERRORLOG
#include "net_main.h"
#include "net_matchmaking.h"
#include "kfx/platform/web/NetWebSP.h"
#include "post_inc.h"

// web/kfx_web.js
extern int kfx_net_open(const char *path);
extern int kfx_net_state(void);
extern int kfx_net_close_code(void);
extern void kfx_net_close(void);
extern int kfx_net_send(const void *data, int len);
extern int kfx_net_send_text(const char *text);
extern int kfx_net_next(void *buf, int cap);
extern int kfx_net_next_text(char *buf, int cap);
extern void kfx_net_hosting(const char *code);
extern int kfx_net_rtt(int *variance);

// Frame ops, see web/server/src/room.js.
enum {
    OP_SEND = 1, OP_DATA = 1, OP_BROADCAST = 2, OP_ACCEPT = 3, OP_REJECT = 4, OP_KICK = 5,
    OP_CONNECT = 6, OP_DISCONNECT = 7, OP_ACCEPTED = 8, OP_CLOSING = 9,
    OP_LINK_DOWN = 10, OP_LINK_UP = 11, OP_HOST_DOWN = 12, OP_HOST_UP = 13,
    // PEER_RTT(conn, ms u16, variance u16): the other end's round trip to the
    // relay (each page measures its own, web/kfx_web.js); conn 0 is the host's.
    // Relays from before it never send it; engines from before it ignore it.
    OP_PEER_RTT = 14,
};
#define RELAY_HOST_LEFT 255
#define MAX_RELAY_CONN 256
#define NO_USER 0xFFFF
#define CONNECT_TIMEOUT_MS 15000
#define MAX_FRAME (4 * 1024 * 1024 + 2)

enum WebRole { WEB_NONE, WEB_HOST, WEB_CLIENT };

struct QueuedMsg {
    struct QueuedMsg *next;
    size_t size;
    char data[];
};

static enum WebRole role = WEB_NONE;
static NetDropCallback drop_callback;
static char room_code[16];
static TbBool server_dropped;           // client: drop of SERVER_ID already reported
// Host side: relay connection <-> game user.
static uint16_t conn_user[MAX_RELAY_CONN];
static uint8_t user_conn[MAX_NET_CONNECTIONS];
// Host side: when a joiner's socket dropped (LINK_DOWN), 0 while connected.
static TbClockMSec conn_down_at[MAX_RELAY_CONN];
// Round trips to the relay reported by the other end (PEER_RTT), 0: unknown.
// Host side per joined connection; a joiner keeps the host's in slot 0.
static uint16_t conn_rtt[MAX_RELAY_CONN];
static uint16_t conn_rtt_var[MAX_RELAY_CONN];
// Incoming messages per source user.
static struct QueuedMsg *queue_head[MAX_NET_CONNECTIONS];
static struct QueuedMsg *queue_tail[MAX_NET_CONNECTIONS];
static unsigned char *frame_buf;
static unsigned char *send_buf;

static void clear_queue(NetUserId user)
{
    if (user >= MAX_NET_CONNECTIONS)
        return;
    struct QueuedMsg *msg = queue_head[user];
    while (msg) {
        struct QueuedMsg *next = msg->next;
        free(msg);
        msg = next;
    }
    queue_head[user] = queue_tail[user] = NULL;
}

static void enqueue(NetUserId user, const void *data, size_t size)
{
    if (user >= MAX_NET_CONNECTIONS)
        return;
    struct QueuedMsg *msg = malloc(sizeof(*msg) + size);
    if (!msg) {
        ERRORLOG("Out of memory for a network message");
        return;
    }
    msg->next = NULL;
    msg->size = size;
    memcpy(msg->data, data, size);
    if (queue_tail[user])
        queue_tail[user]->next = msg;
    else
        queue_head[user] = msg;
    queue_tail[user] = msg;
}

static void reset_state(void)
{
    for (NetUserId u = 0; u < MAX_NET_CONNECTIONS; u++) {
        clear_queue(u);
        user_conn[u] = 0;
    }
    for (int c = 0; c < MAX_RELAY_CONN; c++) {
        conn_user[c] = NO_USER;
        conn_down_at[c] = 0;
        conn_rtt[c] = 0;
        conn_rtt_var[c] = 0;
    }
    room_code[0] = '\0';
    server_dropped = false;
}

static void send_frame(int op, int conn, const void *payload, size_t size)
{
    if (size + 2 > MAX_FRAME)
        return;
    send_buf[0] = (unsigned char)op;
    send_buf[1] = (unsigned char)conn;
    if (size)
        memcpy(send_buf + 2, payload, size);
    kfx_net_send(send_buf, (int)(size + 2));
}

static void report_drop(NetUserId user, enum NetDropReason reason)
{
    clear_queue(user);
    if (drop_callback)
        drop_callback(user, reason);
}

/** Client: the relay or host went away. Reported once. */
static void client_lost_server(void)
{
    if (role != WEB_CLIENT || server_dropped)
        return;
    server_dropped = true;
    report_drop(SERVER_ID, NETDROP_DISCONNECT);
}

static void note_peer_rtt(const unsigned char *f, int len)
{
    if (len < 6)
        return;
    int conn = f[1];
    conn_rtt[conn] = (uint16_t)(f[2] | (f[3] << 8));
    conn_rtt_var[conn] = (uint16_t)(f[4] | (f[5] << 8));
}

static void handle_host_frame(const unsigned char *f, int len,
    enum NetJoinRejection (*new_user)(NetUserId *assigned_id, enum NetConnectionRole role))
{
    int op = f[0], conn = f[1];
    switch (op) {
    case OP_CONNECT: {
        enum NetConnectionRole joining = (len > 2 && f[2] == 1) ? NetRole_Spectator : NetRole_Player;
        NetUserId id = INVALID_USER_ID;
        enum NetJoinRejection reason = (new_user ? new_user : OnNewUser)(&id, joining);
        if (reason == NetJoin_Accepted && id < MAX_NET_CONNECTIONS) {
            conn_user[conn] = id;
            conn_down_at[conn] = 0;
            conn_rtt[conn] = 0;
            conn_rtt_var[conn] = 0;
            user_conn[id] = (uint8_t)conn;
            LbNetLog("Web: connection %d accepted as user %d\n", conn, (int)id);
            send_frame(OP_ACCEPT, conn, NULL, 0);
        } else {
            unsigned char r = (unsigned char)(reason == NetJoin_Accepted ? NetJoin_Locked : reason);
            LbNetLog("Web: connection %d rejected, reason %d\n", conn, (int)r);
            send_frame(OP_REJECT, conn, &r, 1);
        }
        break;
    }
    case OP_DATA:
        if (conn_user[conn] != NO_USER)
            enqueue(conn_user[conn], f + 2, len - 2);
        break;
    case OP_DISCONNECT: {
        NetUserId id = conn_user[conn];
        conn_user[conn] = NO_USER;
        conn_down_at[conn] = 0;
        if (id != NO_USER) {
            user_conn[id] = 0;
            LbNetLog("Web: user %d disconnected\n", (int)id);
            report_drop(id, NETDROP_DISCONNECT);
        }
        break;
    }
    case OP_LINK_DOWN:
        if (conn_user[conn] != NO_USER && !conn_down_at[conn]) {
            conn_down_at[conn] = LbTimerClock() | 1;
            LbNetLog("Web: user %d lost their connection, waiting for them\n", (int)conn_user[conn]);
        }
        break;
    case OP_LINK_UP:
        if (conn_down_at[conn]) {
            conn_down_at[conn] = 0;
            LbNetLog("Web: user %d reconnected\n", (int)conn_user[conn]);
        }
        break;
    case OP_PEER_RTT:
        note_peer_rtt(f, len);
        break;
    default:
        break;
    }
}

/** Host: forgets the relay connection of user `id` and tells the game it left. */
static void host_lose_user(int conn, enum NetDropReason reason)
{
    NetUserId id = conn_user[conn];
    conn_user[conn] = NO_USER;
    conn_down_at[conn] = 0;
    if (id == NO_USER)
        return;
    user_conn[id] = 0;
    report_drop(id, reason);
}

/** Host: players whose connection stayed down too long time out. */
static void host_check_dropped_links(void)
{
    TbClockMSec now = LbTimerClock();
    for (int conn = 1; conn < MAX_RELAY_CONN; conn++) {
        if (!conn_down_at[conn] || now - conn_down_at[conn] < PEER_TIMEOUT_MS)
            continue;
        LbNetLog("Web: user %d did not come back, timing out\n", (int)conn_user[conn]);
        unsigned char r = NetJoin_Accepted;
        send_frame(OP_KICK, conn, &r, 1); // the relay frees the seat
        host_lose_user(conn, NETDROP_TIMEOUT);
    }
}

static void handle_client_frame(const unsigned char *f, int len)
{
    switch (f[0]) {
    case OP_DATA:
        enqueue(SERVER_ID, f + 2, len - 2);
        break;
    case OP_CLOSING:
        if (len > 2 && f[2] < NetJoin_Count)
            net_join_rejection = (enum NetJoinRejection)f[2];
        break;
    case OP_PEER_RTT:
        note_peer_rtt(f, len);
        break;
    default:
        break;
    }
}

/** Reads everything the relay has sent so far. */
static void pump(enum NetJoinRejection (*new_user)(NetUserId *assigned_id, enum NetConnectionRole role))
{
    if (role == WEB_NONE)
        return;
    int len;
    while ((len = kfx_net_next(frame_buf, MAX_FRAME)) >= 0) {
        if (len < 2 || len > MAX_FRAME)
            continue;
        if (role == WEB_HOST)
            handle_host_frame(frame_buf, len, new_user);
        else
            handle_client_frame(frame_buf, len);
    }
    if (kfx_net_state() == 2) {
        if (role == WEB_CLIENT) {
            client_lost_server();
        } else if (role == WEB_HOST && room_code[0]) {
            ERRORLOG("Web: lost the connection to the lobby relay");
            room_code[0] = '\0';
            kfx_net_hosting(NULL);
            // Nobody can reach us any more: let the game carry on without them.
            for (int conn = 1; conn < MAX_RELAY_CONN; conn++)
                host_lose_user(conn, NETDROP_DISCONNECT);
        }
    } else if (role == WEB_HOST) {
        host_check_dropped_links();
    }
}

/** Waits (yielding to the browser) until the socket opens or fails. */
static TbBool wait_open(void)
{
    TbClockMSec end = LbTimerClock() + CONNECT_TIMEOUT_MS;
    while (kfx_net_state() == 0) {
        if (LbTimerClock() > end)
            return false;
        emscripten_sleep(10);
    }
    return kfx_net_state() == 1;
}

/******************************************************************************/

static TbError web_init(NetDropCallback cb)
{
    drop_callback = cb;
    if (!frame_buf)
        frame_buf = malloc(MAX_FRAME);
    if (!send_buf)
        send_buf = malloc(MAX_FRAME);
    if (!frame_buf || !send_buf)
        return Lb_FAIL;
    reset_state();
    return Lb_OK;
}

static void web_disconnect(void)
{
    if (role == WEB_HOST)
        kfx_net_hosting(NULL);
    kfx_net_close();
    role = WEB_NONE;
    reset_state();
}

static void web_exit(void)
{
    web_disconnect();
    drop_callback = NULL;
}

static TbError web_host(const char *session, void *options)
{
    (void)session; (void)options;
    web_disconnect();
    role = WEB_HOST;
    if (!kfx_net_open("rooms/host") || !wait_open()) {
        ERRORLOG("Web: could not reach the lobby server");
        web_disconnect();
        return Lb_FAIL;
    }
    // The relay names the lobby: {"type":"created","code":"ABCDE"}.
    TbClockMSec end = LbTimerClock() + CONNECT_TIMEOUT_MS;
    char text[256];
    while (!room_code[0]) {
        int n = kfx_net_next_text(text, sizeof(text));
        if (n >= 0) {
            const char *key = strstr(text, "\"code\":\"");
            if (key) {
                key += 8;
                size_t i = 0;
                while (key[i] && key[i] != '"' && i + 1 < sizeof(room_code)) {
                    room_code[i] = key[i];
                    i++;
                }
                room_code[i] = '\0';
            }
            continue;
        }
        if (kfx_net_state() != 1 || LbTimerClock() > end) {
            ERRORLOG("Web: the lobby server did not create a lobby");
            web_disconnect();
            return Lb_FAIL;
        }
        emscripten_sleep(10);
    }
    LbNetLog("Web: hosting lobby %s\n", room_code);
    kfx_net_hosting(room_code);
    return Lb_OK;
}

static TbError web_join(const char *session, void *options)
{
    (void)options;
    const char *code = join_lobby_id[0] ? join_lobby_id : session;
    char path[96];
    snprintf(path, sizeof(path), "rooms/%.16s?role=%s", code,
             net_join_role == NetRole_Spectator ? "spectator" : "player");
    web_disconnect();
    role = WEB_CLIENT;
    if (!kfx_net_open(path) || !wait_open()) {
        LbNetLog("Web: could not open lobby %s\n", code);
        web_disconnect();
        return Lb_FAIL;
    }
    // Wait for the host to accept us (ACCEPTED) or refuse (CLOSING/close).
    TbClockMSec end = LbTimerClock() + CONNECT_TIMEOUT_MS;
    for (;;) {
        int len;
        while ((len = kfx_net_next(frame_buf, MAX_FRAME)) >= 0) {
            if (len < 2)
                continue;
            if (frame_buf[0] == OP_ACCEPTED) {
                snprintf(room_code, sizeof(room_code), "%s", code);
                LbNetLog("Web: joined lobby %s\n", code);
                return Lb_OK;
            }
            handle_client_frame(frame_buf, len);
        }
        if (kfx_net_state() == 2 || LbTimerClock() > end) {
            LbNetLog("Web: lobby %s refused or did not answer\n", code);
            web_disconnect();
            return Lb_FAIL;
        }
        emscripten_sleep(10);
    }
}

static void web_update(enum NetJoinRejection (*new_user)(NetUserId *assigned_id, enum NetConnectionRole role))
{
    pump(new_user);
    if (role == WEB_HOST)
        matchmaking_service(); // lobby list metadata; no advertising thread here
}

static void web_sendmsg_single(NetUserId destination, const char *buffer, size_t size)
{
    if (role == WEB_CLIENT) {
        send_frame(OP_SEND, 0, buffer, size);
    } else if (role == WEB_HOST && destination < MAX_NET_CONNECTIONS && user_conn[destination]) {
        send_frame(OP_SEND, user_conn[destination], buffer, size);
    }
}

static void web_sendmsg_all(const char *buffer, size_t size)
{
    if (role == WEB_CLIENT)
        send_frame(OP_SEND, 0, buffer, size);
    else if (role == WEB_HOST)
        send_frame(OP_BROADCAST, 0, buffer, size);
}

static TbBool wait_message(NetUserId source, unsigned timeout)
{
    if (source >= MAX_NET_CONNECTIONS)
        return false;
    pump(NULL);
    if (queue_head[source])
        return true;
    if (timeout == 0)
        return false;
    TbClockMSec end = LbTimerClock() + timeout;
    while (!queue_head[source] && LbTimerClock() < end && role != WEB_NONE) {
        emscripten_sleep(1);
        pump(NULL);
    }
    return queue_head[source] != NULL;
}

static size_t web_msgready(NetUserId source, unsigned timeout)
{
    return wait_message(source, timeout) ? queue_head[source]->size : 0;
}

static size_t web_peekmsg(NetUserId source, const char **buffer)
{
    *buffer = NULL;
    if (!wait_message(source, 0))
        return 0;
    *buffer = queue_head[source]->data;
    return queue_head[source]->size;
}

static size_t web_readmsg(NetUserId source, char *buffer, size_t max_size)
{
    if (!wait_message(source, 0))
        return 0;
    struct QueuedMsg *msg = queue_head[source];
    queue_head[source] = msg->next;
    if (!queue_head[source])
        queue_tail[source] = NULL;
    size_t n = msg->size < max_size ? msg->size : max_size;
    memcpy(buffer, msg->data, n);
    free(msg);
    return n;
}

static void web_drop_user(NetUserId id, enum NetJoinRejection reason)
{
    LbNetLog("Web: dropping user %d\n", (int)id);
    clear_queue(id);
    if (role == WEB_HOST && id < MAX_NET_CONNECTIONS && user_conn[id]) {
        unsigned char r = (unsigned char)reason;
        int conn = user_conn[id];
        send_frame(OP_KICK, conn, &r, 1);
        conn_user[conn] = NO_USER;
        conn_down_at[conn] = 0;
        user_conn[id] = 0;
    }
    if (drop_callback)
        drop_callback(id, NETDROP_MANUAL);
}

static void web_reassign_user(NetUserId old_id, NetUserId new_id)
{
    if (old_id >= MAX_NET_CONNECTIONS || new_id >= MAX_NET_CONNECTIONS)
        return;
    clear_queue(old_id);
    clear_queue(new_id);
    if (role != WEB_HOST)
        return;
    if (user_conn[new_id]) {
        unsigned char r = NetJoin_Accepted;
        send_frame(OP_KICK, user_conn[new_id], &r, 1); // a stale connection held that seat
        conn_user[user_conn[new_id]] = NO_USER;
        conn_down_at[user_conn[new_id]] = 0;
    }
    int conn = user_conn[old_id];
    user_conn[new_id] = (uint8_t)conn;
    user_conn[old_id] = 0;
    if (conn)
        conn_user[conn] = new_id;
}

/**
 * Round trip between this game and user `id`'s, in ms; 0 if not known.
 * Everything goes through the relay, so it is the sum of both ends' round
 * trips to it: each page measures its own and the relay passes it on
 * (PEER_RTT). A host gets it for each joiner; a joiner only for the host,
 * which is all it talks to (as with ENet).
 */
uint32_t web_net_ping(int id, uint32_t *variance)
{
    int own_var = 0;
    int own = kfx_net_rtt(&own_var);
    int conn = -1;
    if (role == WEB_CLIENT && id == SERVER_ID)
        conn = 0;
    else if (role == WEB_HOST && id >= 0 && id < MAX_NET_CONNECTIONS && user_conn[id])
        conn = user_conn[id];
    if (conn < 0 || own <= 0 || conn_rtt[conn] == 0) {
        if (variance)
            *variance = 0;
        return 0;
    }
    if (variance)
        *variance = (uint32_t)own_var + conn_rtt_var[conn];
    return (uint32_t)own + conn_rtt[conn];
}

const char *web_net_room_code(void)
{
    return room_code;
}

TbBool web_net_is_host(void)
{
    return role == WEB_HOST && room_code[0] != '\0';
}

void web_net_send_text(const char *text)
{
    if (role == WEB_HOST)
        kfx_net_send_text(text);
}

struct NetSP *InitWebSP(void)
{
    static struct NetSP sp = {
        .init = web_init,
        .exit = web_exit,
        .disconnect = web_disconnect,
        .host = web_host,
        .join = web_join,
        .update = web_update,
        .sendmsg_single = web_sendmsg_single,
        .sendmsg_single_unsequenced = web_sendmsg_single,
        .sendmsg_all = web_sendmsg_all,
        .msgready = web_msgready,
        .peekmsg = web_peekmsg,
        .readmsg = web_readmsg,
        .drop_user = web_drop_user,
        .reassign_user = web_reassign_user,
    };
    return &sp;
}
