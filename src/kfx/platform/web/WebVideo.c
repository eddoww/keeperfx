/******************************************************************************/
/** @file WebVideo.c
 *     Browser build: the game's resolution follows its frame on the page.
 * @par Purpose:
 *     The page (web/kfx_loader.js) watches the size of the frame the game
 *     sits in and, once it has been stable for a moment, asks for a new size
 *     with kfx_web_set_resolution(): one for a level, which takes the frame's
 *     shape, and one for the front end (menus, land view, movies), whose
 *     screens are laid out once when they open and which the page keeps
 *     between 4:3 and 16:9.
 *     The sizes live in video modes of their own, two for each so that a new
 *     size never has to be written into the mode on screen. The game asks for
 *     its modes as before (get_game_vidmode() and friends, see vidmode.c) and
 *     gets these whenever the page has set a size, so a level or the front
 *     end opens at the latest size. During a level the switch is made at once,
 *     between two frames of the gameplay loop (web_video_update()), the way the
 *     desktop game's resolution key does it. Resolution is local: nothing the
 *     players share depends on it.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <string.h>
#include <emscripten.h>
#include "globals.h"
#include "bflib_basics.h"
#include "bflib_mouse.h"
#include "bflib_video.h"
#include "frontend.h"
#include "gui_frontmenu.h"
#include "keeperfx.hpp"
#include "vidmode.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

/* The largest size the game is asked for (the page's own limit is lower). */
#define WEB_VIDEO_MIN_W 320
#define WEB_VIDEO_MIN_H 240
#define WEB_VIDEO_MAX_W 7680
#define WEB_VIDEO_MAX_H 4320

enum { WEB_VIDEO_GAME = 0, WEB_VIDEO_FRONT = 1, WEB_VIDEO_KINDS };

static const char *const slot_names[WEB_VIDEO_KINDS][2] = {
    {"WEB_GAME_A", "WEB_GAME_B"},
    {"WEB_FRONT_A", "WEB_FRONT_B"},
};
static TbScreenMode slots[WEB_VIDEO_KINDS][2];
/** The size the page asked for, 0 until it does. */
static int want_w[WEB_VIDEO_KINDS], want_h[WEB_VIDEO_KINDS];

static int clamp_size(int v, int lo, int hi)
{
    v = (v < lo) ? lo : (v > hi) ? hi : v;
    return v & ~1;
}

/** The page asks for a size for levels and one for the front end, in pixels. */
EMSCRIPTEN_KEEPALIVE void kfx_web_set_resolution(int game_w, int game_h, int front_w, int front_h)
{
    want_w[WEB_VIDEO_GAME] = clamp_size(game_w, WEB_VIDEO_MIN_W, WEB_VIDEO_MAX_W);
    want_h[WEB_VIDEO_GAME] = clamp_size(game_h, WEB_VIDEO_MIN_H, WEB_VIDEO_MAX_H);
    want_w[WEB_VIDEO_FRONT] = clamp_size(front_w, WEB_VIDEO_MIN_W, WEB_VIDEO_MAX_W);
    want_h[WEB_VIDEO_FRONT] = clamp_size(front_h, WEB_VIDEO_MIN_H, WEB_VIDEO_MAX_H);
}

/** Slot i of a kind, registered on first use (after the config's modes). */
static TbScreenMode slot_mode(int kind, int i)
{
    TbScreenMode mode = slots[kind][i];
    if ((mode == Lb_SCREEN_MODE_INVALID) || (strcmp(LbScreenGetModeInfo(mode)->Desc, slot_names[kind][i]) != 0))
    {
        mode = LbRegisterVideoMode(slot_names[kind][i], want_w[kind], want_h[kind], 32, Lb_VF_RGBCOLOR | Lb_VF_WINDOWED);
        if (mode == Lb_SCREEN_MODE_INVALID)
            mode = LbRecogniseVideoModeString(slot_names[kind][i]);
        slots[kind][i] = mode;
    }
    return mode;
}

static TbBool mode_has_size(TbScreenMode mode, int w, int h)
{
    TbScreenModeInfo *mdinfo = LbScreenGetModeInfo(mode);
    return (mdinfo->Width == w) && (mdinfo->Height == h);
}

/** The mode to use instead of a configured one: one of the kind's two
 * slots with the size the page wants. The mode on screen is never resized;
 * the other slot is. */
TbScreenMode web_video_mode(int kind, TbScreenMode configured)
{
    if ((configured == Lb_SCREEN_MODE_INVALID) || (want_w[kind] <= 0) || (want_h[kind] <= 0))
        return configured;
    TbScreenMode active = LbScreenActiveMode();
    TbScreenMode spare = Lb_SCREEN_MODE_INVALID;
    for (int i = 0; i < 2; i++)
    {
        TbScreenMode mode = slot_mode(kind, i);
        if (mode == Lb_SCREEN_MODE_INVALID)
            continue;
        if (mode_has_size(mode, want_w[kind], want_h[kind]))
            return mode;
        if (mode != active)
            spare = mode;
    }
    if (spare == Lb_SCREEN_MODE_INVALID)
        return configured; // no free mode slot left
    TbScreenModeInfo *mdinfo = LbScreenGetModeInfo(spare);
    mdinfo->Width = want_w[kind];
    mdinfo->Height = want_h[kind];
    return spare;
}

/** Once per frame of a level: switch to the size the page asked for, the way
 * the resolution key does (switch_to_next_video_mode_wrapper()). */
void web_video_update(void)
{
    if ((want_w[WEB_VIDEO_GAME] <= 0) || (want_h[WEB_VIDEO_GAME] <= 0))
        return;
    TbScreenMode active = LbScreenActiveMode();
    if (mode_has_size(active, want_w[WEB_VIDEO_GAME], want_h[WEB_VIDEO_GAME]))
        return;
    TbScreenMode mode = web_video_mode(WEB_VIDEO_GAME, active);
    if ((mode == Lb_SCREEN_MODE_INVALID) || (mode == active))
        return;
    float fx = (float)lbDisplay.MMouseX / (float)(lbDisplay.MouseWindowX + lbDisplay.MouseWindowWidth);
    float fy = (float)lbDisplay.MMouseY / (float)(lbDisplay.MouseWindowY + lbDisplay.MouseWindowHeight);
    TbScreenModeInfo *mdinfo = LbScreenGetModeInfo(mode);
    SYNCLOG("Following the page: %dx%d", (int)mdinfo->Width, (int)mdinfo->Height);
    if (setup_screen_mode(mode, false) == Lb_SCREEN_MODE_INVALID)
    {
        // Back to the mode we had; stop asking for the size that failed.
        ERRORLOG("Can't switch to %dx%d", (int)mdinfo->Width, (int)mdinfo->Height);
        want_w[WEB_VIDEO_GAME] = want_h[WEB_VIDEO_GAME] = 0;
        if (setup_screen_mode(active, false) == Lb_SCREEN_MODE_INVALID)
        {
            FatalError = 1;
            exit_keeper = 1;
            return;
        }
    }
    TbBool reload_video = menu_is_active(GMnu_VIDEO);
    if (menu_is_active(GMnu_CREATURE_QUERY1))
        vid_change_query_menu = GMnu_CREATURE_QUERY1;
    else if (menu_is_active(GMnu_CREATURE_QUERY2))
        vid_change_query_menu = GMnu_CREATURE_QUERY2;
    else if (menu_is_active(GMnu_CREATURE_QUERY3))
        vid_change_query_menu = GMnu_CREATURE_QUERY3;
    else if (menu_is_active(GMnu_CREATURE_QUERY4))
        vid_change_query_menu = GMnu_CREATURE_QUERY4;
    reinit_all_menus();
    if (reload_video)
        turn_on_menu(GMnu_VIDEO);
    LbMouseSetPosition((long)(fx * (lbDisplay.MouseWindowX + lbDisplay.MouseWindowWidth)),
        (long)(fy * (lbDisplay.MouseWindowY + lbDisplay.MouseWindowHeight)));
}
