#ifndef KFX_PLATFORM_WEB_WEBPLATFORM_H
#define KFX_PLATFORM_WEB_WEBPLATFORM_H
/* Browser build hooks. Each is a no-op macro on desktop builds. */

#ifdef __EMSCRIPTEN__
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
#ifdef __cplusplus
}
#endif
#define KFX_WEB_FRAME_YIELD() kfx_web_frame_yield()
#define KFX_WEB_LEVEL_RESULT(player, won) web_report_level_result(player, won)
#else
#define KFX_WEB_FRAME_YIELD() do {} while (0)
#define KFX_WEB_LEVEL_RESULT(player, won) do {} while (0)
#endif

#endif
