#ifndef KFX_PLATFORM_WEB_NETWEBSP_H
#define KFX_PLATFORM_WEB_NETWEBSP_H
/* Browser build: network transport over the lobby relay (NetWebSP.c). */

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
uint32_t web_net_ping(int id, uint32_t *variance);
void web_net_wait(unsigned ms);

#ifdef __cplusplus
}
#endif

#endif
