#ifndef KFX_PLATFORM_WEB_NETWEBSP_H
#define KFX_PLATFORM_WEB_NETWEBSP_H
/* Browser build (KeeperFX 1.4): network transport over the lobby relay (NetWebSP.c). */

#include "bflib_basics.h"

#ifdef __cplusplus
extern "C" {
#endif

struct NetSP;
struct NetSP *InitWebSP(void);
/** Code of the lobby this browser hosts or joined, "" if none. */
const char *web_net_room_code(void);
TbBool web_net_is_host(void);
/** Host only: send a JSON text frame (lobby metadata) to the relay. */
void web_net_send_text(const char *text);
/** Host: publish the lobby's metadata when it changes (NetMatchmakingWeb.c). */
void web_matchmaking_service(void);

#ifdef __cplusplus
}
#endif

#endif
