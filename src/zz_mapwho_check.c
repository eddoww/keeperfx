/* Debug only: validate the mapwho (per-subtile thing lists) invariant.
 * Env:
 *   KFX_MWC=1            check at the end of every turn (after update())
 *   KFX_MWC_THING=A-B    also check after every thing update in turns A..B
 *   KFX_FF=N             force local_state.fast_forward = N every turn
 *   KFX_MWC_WATCH=idx    log mappos/links of thing idx before/after each thing update in KFX_MWC_THING turns
 */
#include "pre_inc.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "globals.h"
#include "bflib_basics.h"
#include "thing_data.h"
#include "thing_list.h"
#include "map_data.h"
#include "game_legacy.h"
#include "zz_mapwho_check.h"
#include "post_inc.h"

static unsigned char mwc_seen[THINGS_COUNT];
static int mwc_inited;
static int mwc_on;
static long mwc_thing_a = -1, mwc_thing_b = -1;
static long mwc_watch = -1;
static int mwc_ff = -1;
static long mwc_fail_reports;

static void mwc_init(void)
{
    if (mwc_inited)
        return;
    mwc_inited = 1;
    const char *s = getenv("KFX_MWC");
    mwc_on = (s != NULL) && (atoi(s) != 0);
    s = getenv("KFX_MWC_THING");
    if (s != NULL)
        sscanf(s, "%ld-%ld", &mwc_thing_a, &mwc_thing_b);
    s = getenv("KFX_MWC_WATCH");
    if (s != NULL)
        mwc_watch = atol(s);
    s = getenv("KFX_FF");
    if (s != NULL)
        mwc_ff = atoi(s);
}

int mwc_fast_forward(void)
{
    mwc_init();
    return mwc_ff;
}

int mwc_per_thing_active(void)
{
    mwc_init();
    GameTurn t = game.play_gameturn;
    return (mwc_thing_a >= 0) && ((long)t >= mwc_thing_a) && ((long)t <= mwc_thing_b);
}

static void mwc_describe(const char *pfx, const struct Thing *t)
{
    JUSTLOG("MWC %s: %s %d stl(%d,%d) pos(%d,%d,%d) prev=%d next=%d alloc=0x%x state=%d/%d",
        pfx, thing_class_and_model_name(t->class_id, t->model), (int)t->index,
        (int)t->mappos.x.stl.num, (int)t->mappos.y.stl.num,
        (int)t->mappos.x.val, (int)t->mappos.y.val, (int)t->mappos.z.val,
        (int)t->prev_on_mapblk, (int)t->next_on_mapblk, (unsigned)t->alloc_flags,
        (int)t->active_state, (int)t->continue_state);
}

void mwc_watch_log(const char *where, const struct Thing *updated)
{
    mwc_init();
    if (mwc_watch <= 0)
        return;
    const struct Thing *t = thing_get(mwc_watch);
    char buf[160];
    snprintf(buf, sizeof(buf), "watch %s (updated %d)", where, updated ? (int)updated->index : -1);
    mwc_describe(buf, t);
}

/* Returns number of problems found; logs up to a few of them. */
long mwc_check(const char *where, const struct Thing *after)
{
    mwc_init();
    if (!mwc_on)
        return 0;
    long problems = 0;
    long reported = 0;
#define MWC_REPORT(...) do { problems++; if (reported++ < 8) JUSTLOG(__VA_ARGS__); } while (0)
    memset(mwc_seen, 0, sizeof(mwc_seen));
    for (MapSubtlCoord y = 0; y <= game.map_subtiles_y; y++)
    {
        for (MapSubtlCoord x = 0; x <= game.map_subtiles_x; x++)
        {
            const struct Map *mapblk = get_map_block_at(x, y);
            long i = get_mapwho_thing_index(mapblk);
            long prev = 0;
            long k = 0;
            while (i != 0)
            {
                if ((i <= 0) || (i >= THINGS_COUNT)) {
                    MWC_REPORT("MWC [%s] block (%d,%d): bad index %ld after %ld", where, (int)x, (int)y, i, prev);
                    break;
                }
                const struct Thing *t = thing_get(i);
                if ((t->alloc_flags & TAlF_Exists) == 0)
                    MWC_REPORT("MWC [%s] block (%d,%d): thing %ld does not exist (after %ld)", where, (int)x, (int)y, i, prev);
                if ((t->alloc_flags & TAlF_IsInMapWho) == 0)
                    MWC_REPORT("MWC [%s] block (%d,%d): thing %ld lacks IsInMapWho", where, (int)x, (int)y, i);
                if ((t->mappos.x.stl.num != x) || (t->mappos.y.stl.num != y)) {
                    MWC_REPORT("MWC [%s] block (%d,%d): thing %ld is at stl (%d,%d)", where, (int)x, (int)y, i,
                        (int)t->mappos.x.stl.num, (int)t->mappos.y.stl.num);
                    if (reported <= 8) mwc_describe("  misplaced", t);
                }
                if (t->prev_on_mapblk != prev)
                    MWC_REPORT("MWC [%s] block (%d,%d): thing %ld prev=%d, expected %ld", where, (int)x, (int)y, i, (int)t->prev_on_mapblk, prev);
                if (mwc_seen[i]) {
                    MWC_REPORT("MWC [%s] block (%d,%d): thing %ld seen twice (cycle or shared)", where, (int)x, (int)y, i);
                    break;
                }
                mwc_seen[i] = 1;
                prev = i;
                i = t->next_on_mapblk;
                if (++k > THINGS_COUNT)
                    break;
            }
        }
    }
    for (long i = 1; i < THINGS_COUNT; i++)
    {
        const struct Thing *t = thing_get(i);
        if (((t->alloc_flags & TAlF_Exists) != 0) && ((t->alloc_flags & (TAlF_IsInMapWho|TAlF_IsInLimbo)) == (TAlF_IsInMapWho|TAlF_IsInLimbo)))
        {
            MWC_REPORT("MWC [%s] thing %ld is in limbo (held) but linked in mapwho", where, i);
            if (reported <= 8) mwc_describe("  limbo+mapwho", t);
        }
        if (((t->alloc_flags & TAlF_Exists) != 0) && ((t->alloc_flags & TAlF_IsInMapWho) != 0) && !mwc_seen[i])
        {
            MWC_REPORT("MWC [%s] thing %ld in mapwho but not reachable from its block", where, i);
            if (reported <= 8) mwc_describe("  unreachable", t);
        }
    }
    if (problems > 0)
    {
        if (mwc_fail_reports++ < 200)
        {
            JUSTLOG("MWC [%s] turn %lu: %ld problems%s", where, (unsigned long)game.play_gameturn, problems,
                after ? "" : "");
            if (after != NULL)
                mwc_describe("  after update of", after);
        }
    }
    return problems;
#undef MWC_REPORT
}

/* Targeted test of the held-familiar path. KFX_MWC_SELFTEST=turn (solo game, player 0 has a heart). */
#include "thing_creature.h"
#include "creature_control.h"
#include "power_hand.h"
#include "dungeon_data.h"
#include "thing_navigate.h"
short dump_first_held_thing_on_map(PlayerNumber plyr_idx, NetUserId user, MapSubtlCoord stl_x, MapSubtlCoord stl_y, TbBool update_hand);

static void mwc_force_check(const char *where)
{
    int was = mwc_on;
    mwc_on = 1;
    long n = mwc_check(where, NULL);
    JUSTLOG("SELFTEST %s: %ld mapwho problems", where, n);
    mwc_on = was;
}

void mwc_selftest_turn(void)
{
    const char *s = getenv("KFX_MWC_SELFTEST");
    if ((s == NULL) || ((long)game.play_gameturn != atol(s)))
        return;
    const struct Coord3d *hp = dungeon_get_essential_pos(0);
    struct Coord3d pos = *hp;
    pos.x.val += 3 * COORD_PER_STL;
    struct Thing *druid = create_creature(&pos, 33, 0);
    if (thing_is_invalid(druid)) { JUSTLOG("SELFTEST: no druid"); return; }
    move_creature_to_nearest_valid_position(druid);
    thing_summon_temporary_creature(druid, 34, 1, 1, 2000, 30);
    struct CreatureControl *cctrl = creature_control_get_from_thing(druid);
    struct Thing *fam = thing_get(cctrl->familiar_idx[0]);
    if (!thing_is_creature(fam)) { JUSTLOG("SELFTEST: no familiar"); return; }
    JUSTLOG("SELFTEST druid %d familiar %d (model %d) flags 0x%x", (int)druid->index, (int)fam->index, (int)fam->model, (unsigned)fam->alloc_flags);
    mwc_force_check("after summon");
    TbBool held = place_thing_in_power_hand(fam, 0, get_my_user());
    JUSTLOG("SELFTEST picked up=%d flags 0x%x", (int)held, (unsigned)fam->alloc_flags);
    mwc_force_check("after pickup");
    creature_control_get_from_thing(fam)->follow_leader_fails = 1;
    { struct Coord3d dpos = druid->mappos; dpos.y.val += 4 * COORD_PER_STL; move_thing_in_map(druid, &dpos);
      JUSTLOG("SELFTEST summoner moved to stl(%d,%d)", (int)druid->mappos.x.stl.num, (int)druid->mappos.y.stl.num); }
    thing_summon_temporary_creature(druid, 34, 1, 1, 2000, 30); /* the summoner casts the spell again */
    JUSTLOG("SELFTEST after recast: familiar flags 0x%x stl(%d,%d)", (unsigned)fam->alloc_flags,
        (int)fam->mappos.x.stl.num, (int)fam->mappos.y.stl.num);
    mwc_force_check("after recast while held");
    short dropped = dump_first_held_thing_on_map(0, get_my_user(), hp->x.stl.num - 3, hp->y.stl.num + 3, 1);
    JUSTLOG("SELFTEST dropped=%d familiar flags 0x%x stl(%d,%d)", (int)dropped, (unsigned)fam->alloc_flags,
        (int)fam->mappos.x.stl.num, (int)fam->mappos.y.stl.num);
    mwc_force_check("after drop");
}
