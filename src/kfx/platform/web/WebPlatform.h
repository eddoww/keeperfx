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
#ifdef __cplusplus
}
#endif
#define KFX_WEB_FRAME_YIELD() kfx_web_frame_yield()
#else
#define KFX_WEB_FRAME_YIELD() do {} while (0)
#endif

#endif
