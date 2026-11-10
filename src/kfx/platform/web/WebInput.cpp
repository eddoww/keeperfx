/******************************************************************************/
/** @file WebInput.cpp
 *     Browser build: touch and mouse input from the page.
 * @par Purpose:
 *     The page (web/kfx_touch.js) turns finger gestures into calls here, and
 *     SDL never sees the touches. A touch puts the game cursor exactly under
 *     the finger (absolute), so the game moving its own cursor (the land view,
 *     the start of a level) can't leave the two apart the way it does with an
 *     unlocked mouse. Taps and holds become mouse buttons, a two-finger drag
 *     pans the dungeon view and a twist rotates it (applied by the local
 *     camera, see KFX_WEB_CAMERA_INPUT). In creature possession, where the game
 *     steers by the cursor's distance from the screen centre, a finger drag is
 *     passed on as relative motion instead.
 *     The mouse works the same way while the game doesn't hold it
 *     (web/kfx_loader.js): the page puts the cursor where the pointer is, so
 *     no pointer lock is needed and Esc stays an ordinary key. Only when the
 *     game grabs the mouse (creature possession, or CAPTURE_CURSOR=ON) does
 *     SDL take it with the browser's pointer lock and pass relative motion.
 *     The page also asks what the game is doing (kfx_web_input_context) to
 *     show the controls that fit and to lock the pointer when the game grabs.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <math.h>
#include <string.h>
#include <emscripten.h>
#include <SDL3/SDL.h>
#include "globals.h"
#include "bflib_basics.h"
#include "bflib_inputctrl.h"
#include "bflib_mouse.h"
#include "bflib_mshandler.hpp"
#include "bflib_planar.h"
#include "bflib_video.h"
#include "engine_camera.h"
#include "frontend.h"
#include "frontmenu_ingame_map.h"
#include "keeperfx.hpp"
#include "local_camera.h"
#include "player_data.h"
#include "kfx/platform/WindowSystemSDL.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

/** Touch is the input in use: the page says so on the first touch and stops
 * on a real mouse move. */
static bool touch_mode = false;
/** A finger is on the game (for edge panning, as with a mouse in the window). */
static bool touch_held = false;
/** Last finger position in game pixels, for relative motion in possession. */
static bool touch_has_last = false;
static float touch_last_x, touch_last_y;
/** The page places the mouse cursor (an uncaptured mouse); whether it is over
 * the game or near its edge, and its last position in game pixels. */
static bool mouse_from_page = false;
static bool mouse_inside = false;
static bool mouse_has_last = false;
static float mouse_last_x, mouse_last_y;
/** Gesture input waiting for the local camera, in game pixels and degrees. */
static float pending_pan_x, pending_pan_y, pending_rotate;

/** The page's normalised canvas position (0..1) in game pixels. */
static void canvas_to_game(float nx, float ny, float *gx, float *gy)
{
    WindowSystemSDL *ws = GetSDLWindowSystem();
    int ww = 0, wh = 0;
    ws->GetWindowSize(&ww, &wh);
    ws->WindowToGame(nx * ww, ny * wh, gx, gy);
}

static bool steering_by_cursor(void)
{
    return (frontend_menu_state == FeSt_INITIAL)
        && (get_user_view_type(get_my_user()) == PVT_CreatureContrl)
        && !a_menu_window_is_active();
}

/** Dragging the small map: the game puts the cursor back in the middle of the
 * view every frame and scrolls by how far it moved, so it needs motion, not a
 * position. */
static bool dragging_small_map(void)
{
    return (frontend_menu_state == FeSt_INITIAL) && (grabbed_small_map != 0);
}

/** Moves the cursor by the motion from (*last_x, *last_y) to (gx, gy). */
static void move_cursor_by(float gx, float gy, float *last_x, float *last_y)
{
    struct TbPoint delta;
    delta.x = (long)(gx - *last_x);
    delta.y = (long)(gy - *last_y);
    if (delta.x != 0 || delta.y != 0) {
        *last_x += delta.x;
        *last_y += delta.y;
        mouseControl(MActn_MOUSEMOVE, &delta);
    }
}

extern "C" {

EMSCRIPTEN_KEEPALIVE void kfx_web_touch_mode(int on)
{
    touch_mode = (on != 0);
    if (!touch_mode) {
        touch_held = false;
        touch_has_last = false;
    }
}

/** A finger touched (down=1) or left (down=0) the game. */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_contact(int down)
{
    touch_mode = true;
    touch_held = (down != 0);
    touch_has_last = false;
}

/** Puts the game cursor under the finger: nx, ny are 0..1 across the canvas. */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_point(float nx, float ny)
{
    if (!lbMouseInstalled)
        return;
    touch_mode = true;
    last_used_input_device = ID_Keyboard_Mouse;
    float gx = 0.0f, gy = 0.0f;
    canvas_to_game(nx, ny, &gx, &gy);
    if (steering_by_cursor() || dragging_small_map()) {
        if (touch_has_last) {
            move_cursor_by(gx, gy, &touch_last_x, &touch_last_y);
        } else {
            touch_has_last = true;
            touch_last_x = gx;
            touch_last_y = gy;
        }
        return;
    }
    touch_has_last = true;
    touch_last_x = gx;
    touch_last_y = gy;
    pointerHandler.SetMousePosition((long)SDL_floorf(gx), (long)SDL_floorf(gy));
}

/** The mouse pointer moved (an uncaptured mouse): nx, ny are 0..1 across the
 * canvas, clamped to it by the page. inside: the pointer is over the game or
 * near its edge (edge panning), or a button pressed on the game is held;
 * otherwise the cursor stays where it is. Ignored while the game holds the
 * mouse: SDL then passes the pointer lock's relative motion. */
EMSCRIPTEN_KEEPALIVE void kfx_web_mouse_point(float nx, float ny, int inside)
{
    if (!lbMouseInstalled)
        return;
    touch_mode = false;
    touch_held = false;
    mouse_from_page = true;
    mouse_inside = (inside != 0);
    if (lbMouseGrabbed || !mouse_inside) {
        mouse_has_last = false;
        return;
    }
    last_used_input_device = ID_Keyboard_Mouse;
    float gx = 0.0f, gy = 0.0f;
    canvas_to_game(nx, ny, &gx, &gy);
    if (dragging_small_map()) {
        if (mouse_has_last)
            move_cursor_by(gx, gy, &mouse_last_x, &mouse_last_y);
        else {
            mouse_last_x = gx;
            mouse_last_y = gy;
        }
        mouse_has_last = true;
        return;
    }
    mouse_has_last = true;
    mouse_last_x = gx;
    mouse_last_y = gy;
    pointerHandler.SetMousePosition((long)SDL_floorf(gx), (long)SDL_floorf(gy));
}

/** The player's choice: the game keeps the mouse (pointer lock, Esc releases
 * it) as the desktop game does, or only in possession. Same as CAPTURE_CURSOR. */
EMSCRIPTEN_KEEPALIVE void kfx_web_mouse_capture(int on)
{
    if (!lbMouseInstalled)
        return;
    lbMouseGrab = (on != 0);
    LbGrabMouseCheck(MG_OnFocusGained);
}

/** button: 0 left, 1 right, 2 middle. */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_button(int button, int down)
{
    static const unsigned int actions[3][2] = {
        {MActn_LBUTTONUP, MActn_LBUTTONDOWN},
        {MActn_RBUTTONUP, MActn_RBUTTONDOWN},
        {MActn_MBUTTONUP, MActn_MBUTTONDOWN},
    };
    if (!lbMouseInstalled || button < 0 || button > 2)
        return;
    last_used_input_device = ID_Keyboard_Mouse;
    struct TbPoint none = {0, 0};
    mouseControl(actions[button][down ? 1 : 0], &none);
}

/** One mouse wheel step at the cursor (zoom in the dungeon view). */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_wheel(int up)
{
    if (!lbMouseInstalled)
        return;
    struct TbPoint none = {0, 0};
    mouseControl(up ? MActn_WHEELMOVEUP : MActn_WHEELMOVEDOWN, &none);
}

/** Two-finger drag: the fingers moved by dx, dy (canvas fractions). */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_pan(float dx, float dy)
{
    float x0, y0, x1, y1;
    canvas_to_game(0.5f, 0.5f, &x0, &y0);
    canvas_to_game(0.5f + dx, 0.5f + dy, &x1, &y1);
    pending_pan_x += x1 - x0;
    pending_pan_y += y1 - y0;
}

/** Two-finger twist, in degrees (clockwise positive). */
EMSCRIPTEN_KEEPALIVE void kfx_web_touch_rotate(float degrees)
{
    pending_rotate += degrees;
}

/** What the game is doing, for the page's controls (web/kfx_touch.js):
 *  1 in a level, 2 possessing a creature, 4 typing text, 8 parchment map,
 *  16 a game menu window is open, 32 the game holds the mouse (it wants the
 *  pointer locked). */
EMSCRIPTEN_KEEPALIVE int kfx_web_input_context(void)
{
    int ctx = 0;
    if (frontend_menu_state == FeSt_INITIAL && lbScreenInitialised) {
        ctx |= 1;
        if (get_user_view_type(get_my_user()) == PVT_CreatureContrl)
            ctx |= 2;
        if (get_local_view_type() == PVT_MapScreen)
            ctx |= 8;
        if (a_menu_window_is_active())
            ctx |= 16;
    }
    if (lbScreenInitialised && LbIsTextInputActive())
        ctx |= 4;
    if (lbMouseInstalled && lbMouseGrabbed)
        ctx |= 32;
    return ctx;
}

} // extern "C"

TbBool web_input_cursor_inside(TbBool host_inside)
{
    // Edge panning and the like: with touch, the cursor is "in the window"
    // only while a finger is down, so a tap near the edge doesn't keep
    // scrolling the view after the finger is gone.
    if (touch_mode)
        return touch_held;
    // An uncaptured mouse: the page knows whether it is over the game, or
    // just past its edge (the frame on the page has no screen edge to stop
    // the pointer at).
    if (web_input_mouse_from_page())
        return mouse_inside;
    return host_inside;
}

TbBool web_input_mouse_from_page(void)
{
    return mouse_from_page && !touch_mode && !lbMouseGrabbed;
}

void web_input_apply_camera(struct Camera *cam)
{
    if (cam == NULL)
        return;
    const bool dungeon_view = (cam->view_mode == PVM_IsoWibbleView) || (cam->view_mode == PVM_IsoStraightView)
        || (cam->view_mode == PVM_FrontView);
    if (!dungeon_view) {
        pending_pan_x = pending_pan_y = pending_rotate = 0.0f;
        return;
    }
    if ((pending_pan_x != 0.0f || pending_pan_y != 0.0f) && cam->view_mode != PVM_FrontView) {
        // Move the view with the fingers, along the screen's axes as the
        // arrow keys do. Map units per screen pixel: 65536 / zoom across
        // (measured against the renderer's own picking), and the camera's
        // pitch stretches that up and down the screen.
        const unsigned long scaled_zoom = scale_camera_zoom_to_screen(cam->zoom);
        const float zoom = (float)(scaled_zoom > 0 ? scaled_zoom : 1);
        const float across = 65536.0f / zoom * pixel_size;
        int32_t pitch = cam->rotation_angle_y & ANGLE_MASK;
        if (pitch > DEGREES_180)
            pitch -= DEGREES_360;
        float tilt = fabsf(sinf(pitch * 2.0f * (float)M_PI / DEGREES_360));
        if (tilt < 0.3f)
            tilt = 0.3f;
        // Fingers moving right drag the map right: the camera goes left.
        const long dist_x = (long)(-pending_pan_x * across);
        const long dist_y = (long)(-pending_pan_y * across / tilt);
        MapCoord x = cam->mappos.x.val;
        MapCoord y = cam->mappos.y.val;
        x = move_coord_with_angle_x(x, dist_x, cam->rotation_angle_x + DEGREES_90);
        y = move_coord_with_angle_y(y, dist_x, cam->rotation_angle_x + DEGREES_90);
        x = move_coord_with_angle_x(x, dist_y, cam->rotation_angle_x + DEGREES_180);
        y = move_coord_with_angle_y(y, dist_y, cam->rotation_angle_x + DEGREES_180);
        view_set_camera_position(cam, x, y);
        cam->velocity_x = 0;
        cam->velocity_y = 0;
    }
    pending_pan_x = pending_pan_y = 0.0f;
    if (pending_rotate != 0.0f && cam->view_mode != PVM_FrontView) {
        const int32_t step = (int32_t)(pending_rotate * DEGREES_360 / 360.0f);
        if (step != 0) {
            cam->rotation_angle_x = (cam->rotation_angle_x + step) & ANGLE_MASK;
            cam->velocity_rotation = 0;
            pending_rotate -= step * 360.0f / DEGREES_360;
        }
    } else {
        pending_rotate = 0.0f;
    }
}

