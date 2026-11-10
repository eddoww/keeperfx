#ifndef KFX_PLATFORM_WEB_WEBPLATFORM_H
#define KFX_PLATFORM_WEB_WEBPLATFORM_H
/* Browser build hooks (KeeperFX 1.4). Each is a no-op macro on desktop builds. */

#ifdef __EMSCRIPTEN__
#include "bflib_basics.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Called right after a frame is presented. The browser only shows the canvas
 * and delivers input events when the program yields to it, so this suspends the
 * game (Asyncify) until the next animation frame. Implemented in web/kfx_web.js. */
void kfx_web_frame_yield(void);
/* Tells the page that the local player won or lost the level, with the score
 * and level statistics (WebReport.c). */
struct PlayerInfo;
void web_report_level_result(struct PlayerInfo *player, unsigned char won);
/* The page places the cursor of an uncaptured mouse (WebInput.c): whether the
 * cursor counts as in the window, and whether the page places it. */
TbBool web_input_cursor_inside(TbBool host_inside);
TbBool web_input_mouse_from_page(void);
/* The online lobby screen, each frame (WebLobby.c): the page may order a chat
 * line or a map start for the host's game (quick match). */
void web_lobby_update(void);
#ifdef __cplusplus
}
#endif
#define KFX_WEB_FRAME_YIELD() kfx_web_frame_yield()
#define KFX_WEB_LEVEL_RESULT(player, won) web_report_level_result(player, won)
#define KFX_WEB_CURSOR_INSIDE(inside) web_input_cursor_inside(inside)
#define KFX_WEB_MOUSE_FROM_PAGE() web_input_mouse_from_page()
#define KFX_WEB_LOBBY_UPDATE() web_lobby_update()
#else
#define KFX_WEB_FRAME_YIELD() do {} while (0)
#define KFX_WEB_LEVEL_RESULT(player, won) do {} while (0)
#define KFX_WEB_CURSOR_INSIDE(inside) (inside)
#define KFX_WEB_MOUSE_FROM_PAGE() (0)
#define KFX_WEB_LOBBY_UPDATE() do {} while (0)
#endif

#endif
