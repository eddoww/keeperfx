/******************************************************************************/
/** @file WebAutosave.c
 *     Browser build: autosave and the page.
 * @par Purpose:
 *     The page is told of each autosave (Module.kfxOnAutosave, web/kfx_loader.js), so it can show it in the
 *     bar above the game and take the file to browser storage at once. The page asks for one itself when the
 *     tab is hidden or the player leaves the game (kfx_web_autosave_now). The game is then waiting between
 *     two frames; the save manager refuses unless it is between two turns of a level
 *     (gameplay_between_turns).
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include <emscripten.h>
#include "bflib_basics.h"
#include "config_settings.h"
#include "kfx/save/SaveManager.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

// web/kfx_web.js
extern void kfx_web_autosaved(int number, const char *title, const char *reason);

void web_report_autosave(int number, const char *title, const char *reason)
{
    kfx_web_autosaved(number, title, reason);
}

/** Saves now if it makes sense (see SaveManager_AutosaveNow). why: 1 the tab is hidden, 2 the player leaves.
 *  Returns 1 when a save was written. */
EMSCRIPTEN_KEEPALIVE int kfx_web_autosave_now(int why)
{
    return SaveManager_AutosaveNow((why == 2) ? "leave" : "hidden") ? 1 : 0;
}

/** Sets the autosave interval (minutes, 0: off) of the running game, and keeps it in settings.toml. */
EMSCRIPTEN_KEEPALIVE void kfx_web_autosave_set(int minutes)
{
    if (minutes < 0)
        minutes = 0;
    if (minutes > AUTOSAVE_MINUTES_MAX)
        minutes = AUTOSAVE_MINUTES_MAX;
    settings.autosave_minutes = (uint8_t)minutes;
    save_settings();
}

/** The autosave interval in minutes (0: off), and +256 when the game could be autosaved now. */
EMSCRIPTEN_KEEPALIVE int kfx_web_autosave_state(void)
{
    return settings.autosave_minutes + (SaveManager_AutosaveAvailable() ? 256 : 0);
}
