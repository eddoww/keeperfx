/******************************************************************************/
/** @file SaveAutosave.cpp
 *     Autosave: the game saves itself every so many minutes of play, into autosave files of its own
 *     (fx1auto1.sav ... fx1auto3.sav, the oldest replaced each time) that never take a player's slot.
 * @par Comment:
 *     The interval is settings.autosave_minutes (settings.toml, [gameplay] autosave_minutes); 0 is off.
 *     Only time played counts: not paused, not waiting in a menu that pauses. Only single player levels are
 *     saved: a network game can't be saved (its Save button is off too), nor a replay being watched.
 */
/******************************************************************************/
#include "pre_inc.h"
#include "globals.h"
#include "bflib_basics.h"
#include "bflib_datetm.h"

#include "config.h"
#include "config_campaigns.h"
#include "config_settings.h"
#include "creature_battle.h"
#include "game_legacy.h"
#include "game_loop.h"
#include "gui_topmsg.h"
#include "keeperfx.hpp"
#include "player_data.h"
#include "replay.h"
#include "kfx/platform/IPlatform.h"
#include "kfx/platform/web/WebPlatform.h"
#include "post_inc.h"

#include <cstring>
#include <ctime>

#include "kfx/save/SaveManager_Internal.h"

namespace {

/** A save due while the keeper's creatures fight waits for the fight to end, but no longer than this. */
const TbClockMSec battle_wait_ms = 60 * 1000;
/** Time between two looks at the clock that counts as play at most: a game that stood still (a hidden browser
 *  tab, a debugger) hasn't been played meanwhile. */
const TbClockMSec longest_step_ms = 1000;
/** After a save that failed, try again this much later. */
const TbClockMSec retry_ms = 60 * 1000;
/** A save asked for from outside ("hidden": the browser tab was hidden) needs this much play since the last one,
 *  so a player who switches tabs often doesn't replace all the autosaves with nearly the same game. */
const TbClockMSec outside_min_play_ms = 60 * 1000;

struct AutosaveState {
    TbClockMSec played_ms;   // play since the last autosave
    TbClockMSec last_clock;  // the clock at the last tick, 0 before the first
    TbClockMSec due_since;   // when the save fell due, 0 while it isn't
    GameTurn saved_turn;     // game turn of the last autosave (or level start, or load)
    TbBool saved_turn_set;
};
AutosaveState autosave_state;

TbClockMSec interval_ms()
{
    return (TbClockMSec)settings.autosave_minutes * 60 * 1000;
}

/** Whether the game as it is now can be autosaved. Says why not, for the log, when it can't. */
bool can_autosave(const char **why)
{
    *why = nullptr;
    if (settings.autosave_minutes == 0)
        *why = "autosave is off";
    else if (!gameplay_between_turns())
        *why = "not in a level";
    else if (network_is_active())
        *why = "network game";
    else if (replay.load_enable)
        *why = "replay";
    else if (local_state.rewinding)
        *why = "rewinding";
    else
    {
        const struct PlayerInfo *player = get_my_player();
        if (player_invalid(player) || !flag_is_set(player->allocflags, PlaF_Allocated))
            *why = "no keeper";
        else if (player->victory_state != VicS_Undecided)
            *why = "level is over";
    }
    return (*why == nullptr);
}

/** "Autosave 14:32 Eversmile": when, and which level, in the 29 characters of a save's title. */
void autosave_title(char *out, size_t outlen)
{
    time_t now = time(nullptr);
    struct tm *local = localtime(&now);
    char when[8] = "";
    if (local != nullptr)
        strftime(when, sizeof(when), "%H:%M", local);
    LevelNumber lvnum = get_loaded_level_number();
    const struct LevelInformation *lvinfo = get_level_info(lvnum);
    const char *name = nullptr;
    if (lvinfo != nullptr)
        name = (lvinfo->name_stridx > 0) ? get_string(lvinfo->name_stridx) : lvinfo->name;
    char level[LINEMSG_SIZE];
    if ((name != nullptr) && (name[0] != '\0'))
        snprintf(level, sizeof(level), "%s", name);
    else
        snprintf(level, sizeof(level), "Level %d", (int)lvnum);
    snprintf(out, outlen, "Autosave %s %s", when, level);
}

} // namespace

int SaveManager::AutosaveSlotToWrite()
{
    LoadAutosaves();
    int oldest = 0;
    for (int i = 0; i < AUTOSAVE_SLOTS; i++)
    {
        if ((autosaves_[i].flags & CEF_InUse) == 0)
            return AUTOSAVE_SLOT_FIRST + i;
        if (autosave_times_[i] < autosave_times_[oldest])
            oldest = i;
    }
    return AUTOSAVE_SLOT_FIRST + oldest;
}

bool SaveManager::Autosave(const char *reason)
{
    const int slot = AutosaveSlotToWrite();
    char title[SAVE_TEXTNAME_LEN];
    autosave_title(title, sizeof(title));
    if (!FillSlot(slot, title))
        return false;
    const TbClockMSec started = LbTimerClock();
    if (!Save(slot))
    {
        SAVEWARN("autosave (%s) failed", reason);
        return false;
    }
    const TbClockMSec took = LbTimerClock() - started;
    const char *fname = SlotPath(slot);
    std::unique_ptr<IFileReader> reader = GetPlatform()->GetFileSystem()->OpenReader(fname);
    SAVELOG("autosave (%s): \"%s\" in %s, %ld ms, %u KB, turn %lu", reason, title, fname, (long)took,
        reader ? (unsigned)((reader->Size() + 1023) / 1024) : 0u, (unsigned long)game.play_gameturn);
    reader.reset();
    autosave_times_[slot - AUTOSAVE_SLOT_FIRST] = GetPlatform()->GetFileSystem()->ModifiedTime(SlotPath(slot));
#ifdef __EMSCRIPTEN__
    // The page shows that it happened, and takes the file to browser storage at once.
    KFX_WEB_AUTOSAVED(slot - AUTOSAVE_SLOT_FIRST + 1, title, reason);
#else
    // The browser page shows it in the bar above the game instead.
    show_onscreen_msg(turns_per_second * 2, "Autosaved");
#endif
    return true;
}

/******************************************************************************/
extern "C" {

void SaveManager_AutosaveReset(void)
{
    autosave_state.played_ms = 0;
    autosave_state.last_clock = 0;
    autosave_state.due_since = 0;
    autosave_state.saved_turn = game.play_gameturn;
    autosave_state.saved_turn_set = true;
}

int SaveManager_AutosaveAvailable(void)
{
    const char *why;
    return can_autosave(&why);
}

int SaveManager_AutosaveNow(const char *reason)
{
    const char *why;
    if (!can_autosave(&why))
    {
        SYNCDBG(7, "No autosave (%s): %s", reason, why);
        return false;
    }
    if (autosave_state.saved_turn_set && (autosave_state.saved_turn == game.play_gameturn))
        return false; // nothing happened since the last one
    if ((strcmp(reason, "hidden") == 0) && (autosave_state.played_ms < outside_min_play_ms))
        return false;
    if (!GetSaveManager().Autosave(reason))
    {
        // Try again a little later rather than at every turn
        TbClockMSec interval = interval_ms();
        autosave_state.played_ms = (interval > retry_ms) ? interval - retry_ms : 0;
        autosave_state.due_since = 0;
        return false;
    }
    autosave_state.played_ms = 0;
    autosave_state.due_since = 0;
    autosave_state.saved_turn = game.play_gameturn;
    autosave_state.saved_turn_set = true;
    return true;
}

void SaveManager_AutosaveTick(void)
{
    const TbClockMSec now = LbTimerClock();
    const TbClockMSec last = autosave_state.last_clock;
    autosave_state.last_clock = now;
    if (!autosave_state.saved_turn_set)
        SaveManager_AutosaveReset();
    const char *why;
    if ((last == 0) || !can_autosave(&why) || flag_is_set(game.operation_flags, GOF_Paused))
        return;
    TbClockMSec step = now - last;
    if (step > longest_step_ms)
        step = longest_step_ms;
    autosave_state.played_ms += step;
    if (autosave_state.played_ms < interval_ms())
        return;
    if (autosave_state.due_since == 0)
        autosave_state.due_since = now;
    // Not in the middle of a fight, if it can wait
    if (active_battle_exists(my_player_number) && (now - autosave_state.due_since < battle_wait_ms))
        return;
    SaveManager_AutosaveNow("interval");
}

} // extern "C"
