#ifndef KFX_PLATFORM_WEB_WEBPLATFORM_H
#define KFX_PLATFORM_WEB_WEBPLATFORM_H
/* Browser build hooks. Each is a no-op macro on desktop builds. */

#ifdef __EMSCRIPTEN__
#include "bflib_basics.h"
#include "bflib_video.h"
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
/* Touch and mouse input from the page (WebInput.cpp): whether the cursor
 * counts as in the window (with touch, only while a finger is down; with the
 * mouse, while it is over the game or near its edge), whether the page places
 * the cursor itself (an uncaptured mouse), and the two-finger pan and twist,
 * applied to the local dungeon camera. */
struct Camera;
TbBool web_input_cursor_inside(TbBool host_inside);
TbBool web_input_mouse_from_page(void);
void web_input_apply_camera(struct Camera *cam);
/* The game's online lobby screen (WebLobby.c): each frame the page sees the
 * lobby and may order a chat line, a level start or a player cap; the cap
 * replaces the lobby's own maximum while set. */
void web_lobby_update(void);
int web_lobby_max_players(int configured);
/* The game's resolution follows its frame on the page (WebVideo.c): the
 * modes for levels (kind 0) and the front end (kind 1) take the size the page
 * asked for, and a level switches to it between frames. */
TbScreenMode web_video_mode(int kind, TbScreenMode configured);
void web_video_update(void);
#ifdef __cplusplus
}
#endif
#define KFX_WEB_FRAME_YIELD() kfx_web_frame_yield()
#define KFX_WEB_LEVEL_RESULT(player, won) web_report_level_result(player, won)
#define KFX_WEB_CURSOR_INSIDE(inside) web_input_cursor_inside(inside)
#define KFX_WEB_MOUSE_FROM_PAGE() web_input_mouse_from_page()
#define KFX_WEB_CAMERA_INPUT(cam) web_input_apply_camera(cam)
#define KFX_WEB_LOBBY_UPDATE() web_lobby_update()
#define KFX_WEB_LOBBY_MAX_PLAYERS(configured) web_lobby_max_players(configured)
#define KFX_WEB_VIDEO_MODE(kind, configured) web_video_mode(kind, configured)
#define KFX_WEB_VIDEO_UPDATE() web_video_update()
#else
#define KFX_WEB_FRAME_YIELD() do {} while (0)
#define KFX_WEB_LEVEL_RESULT(player, won) do {} while (0)
#define KFX_WEB_CURSOR_INSIDE(inside) (inside)
#define KFX_WEB_MOUSE_FROM_PAGE() (0)
#define KFX_WEB_CAMERA_INPUT(cam) do {} while (0)
#define KFX_WEB_LOBBY_UPDATE() do {} while (0)
#define KFX_WEB_LOBBY_MAX_PLAYERS(configured) (configured)
#define KFX_WEB_VIDEO_MODE(kind, configured) (configured)
#define KFX_WEB_VIDEO_UPDATE() do {} while (0)
#endif

#endif
