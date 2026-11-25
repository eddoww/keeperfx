/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file creature_settings.c
 *     Orders a keeper gives to one creature: its name, combat style, whether
 *     it flees or takes prisoners, and how it uses each of its abilities.
 * @par Purpose:
 *     The creature query panel lets the keeper set these for one creature. The
 *     interface only queues requests; they are sent as packet actions when the
 *     local packet has no other action, so every machine (and a replay) applies
 *     them on the same turn. A name does not fit one packet and goes in chunks.
 * @author   KeeperFX Team
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include "pre_inc.h"
#include "creature_settings.h"

#include "config_creature.h"
#include "config_effects.h"
#include "config_magic.h"
#include "creature_control.h"
#include "creature_instances.h"
#include "creature_states.h"
#include "engine_camera.h"
#include "game_legacy.h"
#include "local_camera.h"
#include "net_game.h"
#include "net_spectator.h"
#include "packets.h"
#include "player_data.h"
#include "player_utils.h"
#include "power_hand.h"
#include "thing_creature.h"
#include "thing_data.h"
#include "thing_effects.h"
#include "thing_list.h"
#include "thing_stats.h"
#include "post_inc.h"

#ifdef __cplusplus
extern "C" {
#endif
/******************************************************************************/
#define NAME_CHUNK_BYTES 8
#define NAME_BUFFER_LEN 32 // CREATURE_NAME_MAX rounded up to whole chunks
#define PENDING_REQUESTS_COUNT 16
// Name chunk packet, actn_par1: thing index, chunk number, last chunk flag, low bits of creation turn.
// The name bytes go in actn_par2 (4), actn_par3 (2) and actn_par4 (2).
#define NAME_PAR1_CHUNK_SHIFT 16
#define NAME_PAR1_CHUNK_MASK 0x3
#define NAME_PAR1_FINAL 0x40000
#define NAME_PAR1_CRTURN_SHIFT 19
#define NAME_PAR1_CRTURN_MASK 0x1FFF
// Order packet: actn_par1 thing index, actn_par2 order kind, value and low bits of creation turn.
#define ORDER_PAR2_KIND_MASK 0xFF
#define ORDER_PAR2_VALUE_SHIFT 8
#define ORDER_PAR2_VALUE_MASK 0xFF
#define ORDER_PAR2_CRTURN_SHIFT 16
#define ORDER_PAR2_CRTURN_MASK 0xFFFF
long instf_creature_fire_shot(struct Thing *creatng, int32_t *param);
long instf_creature_cast_spell(struct Thing *creatng, int32_t *param);
long instf_first_person_do_imp_task(struct Thing *creatng, int32_t *param);
/** Range of poison gas clouds, see update_effect(). */
#define GAS_CLOUD_RANGE (5 * COORD_PER_STL)

enum CreatureSettingsRequestKind {
    CrSetReq_None = 0,
    CrSetReq_Order,
    CrSetReq_Name,
};

struct CreatureSettingsRequest {
    unsigned char kind;
    unsigned char order_kind;
    unsigned char order_value;
    ThingIndex thing_idx;
    GameTurn creation_turn;
    unsigned char name_sent; // bytes of the name already sent
    char name[NAME_BUFFER_LEN];
};

/** Requests made on this machine which were not sent yet, oldest first. */
static struct CreatureSettingsRequest pending_requests[PENDING_REQUESTS_COUNT];
static int pending_requests_count = 0;

/******************************************************************************/

/**
 * Gives the attack type a creature prefers: the one its keeper chose for it, or else the
 * one from the creature's config.
 */
CrAttackType creature_attack_preference(const struct Thing *creatng)
{
    const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (!creature_control_invalid(cctrl))
    {
        switch (cctrl->combat_style)
        {
        case CrCmbtStl_Melee:
            return AttckT_Melee;
        case CrCmbtStl_Ranged:
            return AttckT_Ranged;
        default:
            break;
        }
    }
    const struct CreatureModelConfig *crconf = creature_stats_get_from_thing(creatng);
    return crconf->attack_preference;
}

/** Tells whether a creature runs away when badly hurt: its own order, or else its keeper's tendency. */
TbBool creature_tends_to_flee(const struct Thing *creatng)
{
    const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (!creature_control_invalid(cctrl))
    {
        if (cctrl->flee_order == CrFlee_Flee)
            return true;
        if (cctrl->flee_order == CrFlee_Fight)
            return false;
    }
    return player_creature_tends_to(creatng->owner, CrTend_Flee);
}

/**
 * Tells whether the enemies a thing defeats are knocked out for the prison: the order of a
 * creature, or else its keeper's tendency.
 */
TbBool creature_tends_to_imprison(const struct Thing *killertng)
{
    if (thing_is_creature(killertng))
    {
        const struct CreatureControl *cctrl = creature_control_get_from_thing(killertng);
        if (!creature_control_invalid(cctrl))
        {
            if (cctrl->imprison_order == CrImpr_Imprison)
                return true;
            if (cctrl->imprison_order == CrImpr_Kill)
                return false;
        }
    }
    return player_creature_tends_to(killertng->owner, CrTend_Imprison);
}

/**
 * Remembers that a creature was knocked out by one with a "take prisoners" order, so its
 * keeper's imps carry it to the prison even if the keeper doesn't take prisoners in general.
 */
void creature_note_knocked_out_by(struct Thing *victng, const struct Thing *killertng)
{
    struct CreatureControl *vicctrl = creature_control_get_from_thing(victng);
    if (creature_control_invalid(vicctrl))
        return;
    vicctrl->knocked_out_for_plyr = 0;
    if (!thing_is_creature(killertng))
        return;
    const struct CreatureControl *cctrl = creature_control_get_from_thing(killertng);
    if (!creature_control_invalid(cctrl) && (cctrl->imprison_order == CrImpr_Imprison))
        vicctrl->knocked_out_for_plyr = killertng->owner + 1;
}

/** Tells whether a player's imps should carry an unconscious creature to the prison. */
TbBool player_wants_creature_as_prisoner(PlayerNumber plyr_idx, const struct Thing *victng)
{
    if (player_creature_tends_to(plyr_idx, CrTend_Imprison))
        return true;
    const struct CreatureControl *vicctrl = creature_control_get_from_thing(victng);
    if (creature_control_invalid(vicctrl))
        return false;
    return (vicctrl->knocked_out_for_plyr == plyr_idx + 1);
}
/******************************************************************************/

/** Gives the slot of an instance in the list of instances the creature's kind learns, or -1. */
int creature_learned_instance_slot(const struct Thing *creatng, CrInstance inst_id)
{
    if (inst_id <= CrInst_NULL)
        return -1;
    const struct CreatureModelConfig *crconf = creature_stats_get_from_thing(creatng);
    for (int i = 0; i < LEARNED_INSTANCES_COUNT; i++)
    {
        if (crconf->learned_instance_id[i] == inst_id)
            return i;
    }
    return -1;
}

unsigned char creature_instance_order(const struct Thing *creatng, CrInstance inst_id)
{
    const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (creature_control_invalid(cctrl))
        return CrInstOrd_Allowed;
    int slot = creature_learned_instance_slot(creatng, inst_id);
    if ((slot < 0) || (cctrl->instance_orders[slot] >= CrInstOrd_Count))
        return CrInstOrd_Allowed;
    return cctrl->instance_orders[slot];
}

static TbBool instance_is_attack(CrInstance inst_id)
{
    return instance_is_melee_attack(inst_id) || instance_is_ranged_weapon(inst_id);
}

/** Tells whether a creature has an attack, other than the given instance, which it may use on its own. */
static TbBool creature_has_other_attack_not_off(const struct Thing *creatng, CrInstance inst_id)
{
    const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    const struct CreatureModelConfig *crconf = creature_stats_get_from_thing(creatng);
    for (int i = 0; i < LEARNED_INSTANCES_COUNT; i++)
    {
        CrInstance other_id = crconf->learned_instance_id[i];
        if ((other_id <= CrInst_NULL) || (other_id == inst_id) || !cctrl->instance_available[other_id])
            continue;
        if (instance_is_attack(other_id) && (cctrl->instance_orders[i] != CrInstOrd_Off))
            return true;
    }
    return false;
}

/**
 * Tells whether a creature may use an instance on its own. Instances the keeper turned off
 * are not used against creatures, except that a creature never ends up with no attack at all.
 */
TbBool creature_instance_allowed_for_ai(const struct Thing *creatng, CrInstance inst_id)
{
    if ((creatng->alloc_flags & TAlF_IsControlled) != 0)
        return true;
    // Orders are about fighting creatures; against doors and objects anything goes, so the
    // creature never ends up with nothing to break a door with
    const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (!creature_control_invalid(cctrl) && ((cctrl->combat_flags & (CmbtF_DoorFight|CmbtF_ObjctFight)) != 0))
        return true;
    if (creature_instance_order(creatng, inst_id) != CrInstOrd_Off)
        return true;
    return instance_is_attack(inst_id) && !creature_has_other_attack_not_off(creatng, inst_id);
}

/** Tells whether an effect is a gas cloud, which affects every creature in it, friend or foe. */
static TbBool effect_is_gas_cloud(EffectOrEffElModel effect_model)
{
    switch (get_effect_model_stats(effect_model)->area_affect_type)
    {
    case AAffT_GasDamage:
    case AAffT_GasDamageEffect:
    case AAffT_GasEffect:
        return true;
    default:
        return false;
    }
}

static MapCoordDelta shot_own_creatures_hit_range(ThingModel shot_model, const struct Thing *creatng)
{
    if (shot_model <= 0)
        return 0;
    const struct ShotConfigStats *shotst = get_shot_model_stats(shot_model);
    MapCoordDelta range = 0;
    if ((shotst->area_range > 0) && (shotst->area_damage > 0)
        && ((hit_type_to_hit_targets(shotst->area_hit_type) & (HitTF_OwnedCreatures|HitTF_AlliedCreatures)) != 0))
    {
        const struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
        range = compute_creature_attack_range(shotst->area_range * COORD_PER_STL, 0, cctrl->exp_level);
    }
    // Effects left where the shot lands, like a poison gas cloud
    const EffectOrEffElModel effects[] = {shotst->explode.effect1_model, shotst->explode.effect2_model,
        shotst->explode.around_effect1_model, shotst->explode.around_effect2_model,
        shotst->hit_creature.effect_model, shotst->hit_generic.effect_model};
    for (int i = 0; i < (int)(sizeof(effects) / sizeof(effects[0])); i++)
    {
        if ((effects[i] > 0) && effect_is_gas_cloud(effects[i]))
            range = max(range, GAS_CLOUD_RANGE);
    }
    return range;
}

/**
 * Gives the range around its centre within which an instance can hurt the caster's own and
 * allied creatures, or 0 if it hits only what it is aimed at.
 */
MapCoordDelta instance_own_creatures_hit_range(CrInstance inst_id, const struct Thing *creatng)
{
    const struct InstanceInfo *inst_inf = creature_instance_info_get(inst_id);
    const Creature_Instf_Func func = creature_instances_func_list[inst_inf->func_idx];
    if (func == instf_creature_fire_shot)
        return shot_own_creatures_hit_range(inst_inf->func_params[0], creatng);
    if (func == instf_creature_cast_spell)
    {
        const struct SpellConfig *spconf = get_spell_config(inst_inf->func_params[0]);
        MapCoordDelta range = shot_own_creatures_hit_range(spconf->shot_model, creatng);
        if ((spconf->cast_effect_model > 0) && effect_is_gas_cloud(spconf->cast_effect_model))
            range = max(range, GAS_CLOUD_RANGE);
        return range;
    }
    return 0;
}

/** Tells whether an instance is centred on the caster rather than on its target. */
static TbBool instance_hits_around_caster(CrInstance inst_id)
{
    const struct InstanceInfo *inst_inf = creature_instance_info_get(inst_id);
    const Creature_Instf_Func func = creature_instances_func_list[inst_inf->func_idx];
    if (func == instf_creature_cast_spell)
        return !get_spell_config(inst_inf->func_params[0])->cast_at_thing;
    return (inst_inf->range_max >= 0) && (inst_inf->range_max <= 284);
}

/**
 * Tells whether a creature may use an instance on the given target now. With the "careful"
 * order, an area attack is not used when the keeper's or allied creatures would be in it.
 */
TbBool creature_instance_safe_for_ai(const struct Thing *creatng, CrInstance inst_id, const struct Thing *target)
{
    if ((creatng->alloc_flags & TAlF_IsControlled) != 0)
        return true;
    if (creature_instance_order(creatng, inst_id) != CrInstOrd_Careful)
        return true;
    MapCoordDelta range = instance_own_creatures_hit_range(inst_id, creatng);
    if (range <= 0)
        return true;
    // Shots may land a little off target
    range += COORD_PER_STL;
    const struct Coord3d *centre = &creatng->mappos;
    if (!instance_hits_around_caster(inst_id) && thing_exists(target))
        centre = &target->mappos;
    const struct StructureList *slist = get_list_for_thing_class(TCls_Creature);
    long k = 0;
    for (ThingIndex i = slist->index; i != 0; )
    {
        struct Thing *thing = thing_get(i);
        if (thing_is_invalid(thing))
            break;
        i = thing->next_of_class;
        if ((thing != creatng) && (thing != target) && !thing_is_picked_up(thing)
            && players_creatures_tolerate_each_other(creatng->owner, thing->owner)
            && (get_2d_distance(centre, &thing->mappos) < range))
        {
            return false;
        }
        if (++k > slist->count)
            break;
    }
    return true;
}
/******************************************************************************/

TbBool creature_settings_can_change(const struct Thing *creatng, PlayerNumber plyr_idx)
{
    if (!thing_exists(creatng) || !thing_is_creature(creatng) || (creatng->ccontrol_idx <= 0))
        return false;
    if (creatng->owner != plyr_idx)
        return false;
    return !creature_is_dying(creatng);
}

TbBool creature_can_be_renamed(const struct Thing *creatng, PlayerNumber plyr_idx)
{
    if (!creature_settings_can_change(creatng, plyr_idx))
        return false;
    // Unique creatures are named after their kind, see creature_own_name()
    return ((get_creature_model_flags(creatng) & CMF_OneOfKind) == 0);
}

/**
 * Tells whether a creature kind has both a melee and a ranged attack among the instances it
 * learns, at any level, so choosing a combat style makes a difference for it.
 */
TbBool creature_has_combat_style_choice(const struct Thing *creatng)
{
    const struct CreatureModelConfig *crconf = creature_stats_get_from_thing(creatng);
    TbBool has_melee = false;
    TbBool has_ranged = false;
    for (int i = 0; i < LEARNED_INSTANCES_COUNT; i++)
    {
        CrInstance inst_id = crconf->learned_instance_id[i];
        if (inst_id <= CrInst_NULL)
            continue;
        has_melee |= instance_is_melee_attack(inst_id);
        has_ranged |= instance_is_ranged_weapon(inst_id);
    }
    return has_melee && has_ranged;
}

/** Tells whether an order makes sense for a creature; anything else is ignored. */
TbBool creature_order_value_valid(const struct Thing *creatng, unsigned char kind, unsigned char value)
{
    switch (kind)
    {
    case CrOrd_CombatStyle:
        return (value == CrCmbtStl_Default) || ((value < CrCmbtStl_Count) && creature_has_combat_style_choice(creatng));
    case CrOrd_Flee:
        return (value < CrFlee_Count);
    case CrOrd_Imprison:
        return (value < CrImpr_Count);
    default:
        break;
    }
    if ((kind < CrOrd_InstanceFirst) || (kind >= CrOrd_Count) || (value >= CrInstOrd_Count))
        return false;
    const struct CreatureModelConfig *crconf = creature_stats_get_from_thing(creatng);
    CrInstance inst_id = crconf->learned_instance_id[kind - CrOrd_InstanceFirst];
    if (inst_id <= CrInst_NULL)
        return false;
    // Possession-only instances are never used by the creature on its own
    const struct InstanceInfo *inst_inf = creature_instance_info_get(inst_id);
    if ((value != CrInstOrd_Allowed) && (creature_instances_func_list[inst_inf->func_idx] == instf_first_person_do_imp_task))
        return false;
    if (value == CrInstOrd_Careful)
        return (instance_own_creatures_hit_range(inst_id, creatng) > 0);
    if (value == CrInstOrd_Off)
    {
        // Never take away the last attack a creature has
        return !instance_is_attack(inst_id) || creature_has_other_attack_not_off(creatng, inst_id);
    }
    return true;
}

static unsigned char *creature_order_field(struct CreatureControl *cctrl, unsigned char kind)
{
    switch (kind)
    {
    case CrOrd_CombatStyle:
        return &cctrl->combat_style;
    case CrOrd_Flee:
        return &cctrl->flee_order;
    case CrOrd_Imprison:
        return &cctrl->imprison_order;
    default:
        break;
    }
    if ((kind >= CrOrd_InstanceFirst) && (kind < CrOrd_Count))
        return &cctrl->instance_orders[kind - CrOrd_InstanceFirst];
    return NULL;
}

static unsigned char creature_order_values_count(unsigned char kind)
{
    switch (kind)
    {
    case CrOrd_CombatStyle:
        return CrCmbtStl_Count;
    case CrOrd_Flee:
        return CrFlee_Count;
    case CrOrd_Imprison:
        return CrImpr_Count;
    default:
        return CrInstOrd_Count;
    }
}

/** Gives the order which follows the displayed one, skipping those which make no sense for the creature. */
unsigned char creature_order_next_value(const struct Thing *creatng, unsigned char kind, int direction)
{
    const int count = creature_order_values_count(kind);
    int value = creature_displayed_order(creatng, kind);
    for (int i = 0; i < count; i++)
    {
        value = (value + direction + count) % count;
        if (creature_order_value_valid(creatng, kind, value))
            return value;
    }
    return creature_displayed_order(creatng, kind);
}

/** Drops all orders of a creature, for a new keeper. */
void creature_reset_orders(struct Thing *creatng)
{
    struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (creature_control_invalid(cctrl))
        return;
    cctrl->combat_style = CrCmbtStl_Default;
    cctrl->flee_order = CrFlee_Default;
    cctrl->imprison_order = CrImpr_Default;
    memset(cctrl->instance_orders, 0, sizeof(cctrl->instance_orders));
    memset(cctrl->incoming_name, 0, sizeof(cctrl->incoming_name));
}
/******************************************************************************/

static struct CreatureSettingsRequest *find_pending_request(const struct Thing *creatng, unsigned char kind, unsigned char order_kind)
{
    for (int i = 0; i < pending_requests_count; i++)
    {
        struct CreatureSettingsRequest *req = &pending_requests[i];
        if ((req->kind == kind) && ((kind != CrSetReq_Order) || (req->order_kind == order_kind))
            && (req->thing_idx == creatng->index) && (req->creation_turn == creatng->creation_turn))
            return req;
    }
    return NULL;
}

static void remove_first_pending_request(void)
{
    if (pending_requests_count <= 0)
        return;
    pending_requests_count--;
    memmove(&pending_requests[0], &pending_requests[1], pending_requests_count * sizeof(pending_requests[0]));
    memset(&pending_requests[pending_requests_count], 0, sizeof(pending_requests[0]));
}

static struct CreatureSettingsRequest *add_pending_request(const struct Thing *creatng, unsigned char kind, unsigned char order_kind)
{
    struct CreatureSettingsRequest *req = find_pending_request(creatng, kind, order_kind);
    if (req != NULL)
    {
        // A name half sent goes again from the start, with the new text
        req->name_sent = 0;
        return req;
    }
    if (pending_requests_count >= PENDING_REQUESTS_COUNT)
    {
        WARNLOG("Too many creature settings waiting to be sent; dropping the oldest");
        remove_first_pending_request();
    }
    req = &pending_requests[pending_requests_count++];
    memset(req, 0, sizeof(*req));
    req->kind = kind;
    req->order_kind = order_kind;
    req->thing_idx = creatng->index;
    req->creation_turn = creatng->creation_turn;
    return req;
}

void request_creature_order(const struct Thing *creatng, unsigned char kind, unsigned char value)
{
    if (!creature_settings_can_change(creatng, my_player_number) || !creature_order_value_valid(creatng, kind, value))
        return;
    struct CreatureSettingsRequest *req = add_pending_request(creatng, CrSetReq_Order, kind);
    req->order_value = value;
}

/** The order to show in the interface: one waiting to be sent, or else the current one. */
unsigned char creature_displayed_order(const struct Thing *creatng, unsigned char kind)
{
    const struct CreatureSettingsRequest *req = find_pending_request(creatng, CrSetReq_Order, kind);
    if (req != NULL)
        return req->order_value;
    struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    if (creature_control_invalid(cctrl))
        return 0;
    const unsigned char *field = creature_order_field(cctrl, kind);
    if ((field == NULL) || (*field >= creature_order_values_count(kind)))
        return 0;
    return *field;
}

/** Copies a name, dropping control characters and never cutting a UTF-8 character in two. */
static void sanitize_creature_name(char *dst, size_t dst_size, const char *src)
{
    size_t len = 0;
    for (const unsigned char *s = (const unsigned char *)src; (*s != '\0') && (len + 1 < dst_size); s++)
    {
        if ((*s < 0x20) || (*s == 0x7F))
            continue;
        dst[len++] = *s;
    }
    // Drop an incomplete UTF-8 sequence at the end
    size_t lead = len;
    while ((lead > 0) && (((unsigned char)dst[lead - 1] & 0xC0) == 0x80))
        lead--;
    if (lead < len)
    {
        // dst[lead - 1] should start a sequence of exactly (len - lead + 1) bytes
        size_t seq_len = 0;
        if (lead > 0)
        {
            unsigned char c = (unsigned char)dst[lead - 1];
            if ((c & 0xE0) == 0xC0) seq_len = 2;
            else if ((c & 0xF0) == 0xE0) seq_len = 3;
            else if ((c & 0xF8) == 0xF0) seq_len = 4;
        }
        if (seq_len != len - lead + 1)
            len = (lead > 0) ? lead - 1 : 0;
    } else
    if ((len > 0) && (((unsigned char)dst[len - 1] & 0xC0) == 0xC0))
    {
        // A lead byte with nothing after it
        len--;
    }
    dst[len] = '\0';
}

void request_creature_name(const struct Thing *creatng, const char *name)
{
    if (!creature_can_be_renamed(creatng, my_player_number))
        return;
    char clean[CREATURE_NAME_MAX];
    sanitize_creature_name(clean, sizeof(clean), name);
    // Leading and trailing spaces would only make the name look off-centre
    char *text = clean;
    while (*text == ' ')
        text++;
    size_t len = strlen(text);
    while ((len > 0) && (text[len - 1] == ' '))
        text[--len] = '\0';
    if (len == 0)
        return;
    if (strcmp(text, creature_displayed_name(creatng)) == 0)
        return;
    struct CreatureSettingsRequest *req = add_pending_request(creatng, CrSetReq_Name, 0);
    memset(req->name, 0, sizeof(req->name));
    memcpy(req->name, text, len);
}

/** The name to show in the interface: one waiting to be sent, or else the current one. */
const char *creature_displayed_name(const struct Thing *creatng)
{
    const struct CreatureSettingsRequest *req = find_pending_request(creatng, CrSetReq_Name, 0);
    if (req != NULL)
        return req->name;
    return creature_own_name(creatng);
}

void clear_creature_settings_requests(void)
{
    memset(pending_requests, 0, sizeof(pending_requests));
    pending_requests_count = 0;
}

/**
 * Puts the oldest waiting request into the local packet, if the packet has no other action.
 * A name takes several turns; one chunk goes per turn.
 */
void set_pending_creature_settings_packet_action(struct Packet *pckt)
{
    // Actions taken while paused are not kept in replays, so wait for the game to run
    if ((pckt->action != PckA_None) || flag_is_set(game.operation_flags, GOF_Paused))
        return;
    while (pending_requests_count > 0)
    {
        struct CreatureSettingsRequest *req = &pending_requests[0];
        struct Thing *creatng = thing_get(req->thing_idx);
        if (!thing_is_creature(creatng) || (creatng->creation_turn != req->creation_turn)
            || !creature_settings_can_change(creatng, my_player_number))
        {
            remove_first_pending_request();
            continue;
        }
        if (req->kind == CrSetReq_Order)
        {
            uint32_t par2 = req->order_kind | ((uint32_t)req->order_value << ORDER_PAR2_VALUE_SHIFT)
                | ((req->creation_turn & ORDER_PAR2_CRTURN_MASK) << ORDER_PAR2_CRTURN_SHIFT);
            set_packet_action(pckt, PckA_CreatureSetOrder, req->thing_idx, par2, 0, 0);
            remove_first_pending_request();
            return;
        }
        if (req->kind == CrSetReq_Name)
        {
            // In first person the packet's camera fields hold the attack target, which name chunks
            // would replace; wait with a new name, but finish one already started
            unsigned char view_type = get_local_view_type();
            if ((req->name_sent == 0) && ((view_type == PVT_CreatureContrl) || (view_type == PVT_CreaturePasngr)))
                return;
            const unsigned char *chunk = (const unsigned char *)&req->name[req->name_sent];
            const size_t remaining = strnlen(&req->name[req->name_sent], NAME_BUFFER_LEN - req->name_sent);
            // The last chunk holds the terminating zero
            const TbBool final = (remaining < NAME_CHUNK_BYTES);
            uint32_t par1 = (uint32_t)req->thing_idx
                | ((uint32_t)(req->name_sent / NAME_CHUNK_BYTES) << NAME_PAR1_CHUNK_SHIFT)
                | ((req->creation_turn & NAME_PAR1_CRTURN_MASK) << NAME_PAR1_CRTURN_SHIFT);
            if (final)
                par1 |= NAME_PAR1_FINAL;
            uint32_t par2 = chunk[0] | (chunk[1] << 8) | (chunk[2] << 16) | ((uint32_t)chunk[3] << 24);
            unsigned short par3 = chunk[4] | (chunk[5] << 8);
            unsigned short par4 = chunk[6] | (chunk[7] << 8);
            set_packet_action(pckt, PckA_CreatureSetName, par1, par2, par3, par4);
            if (final) {
                remove_first_pending_request();
            } else {
                req->name_sent += NAME_CHUNK_BYTES;
            }
            return;
        }
        remove_first_pending_request();
    }
}
/******************************************************************************/

/**
 * Applies one chunk of a new name. Chunks are put together in the creature's incoming_name,
 * which is game state like the rest (saved, resynced); the name the creature shows changes
 * only when the last chunk arrives, so a rename cut short leaves the old name.
 */
static void process_creature_name_chunk(NetUserId user, PlayerNumber plyr_idx, const struct Packet *pckt)
{
    const uint32_t par1 = (uint32_t)pckt->actn_par1;
    struct Thing *creatng = thing_get(par1 & 0xFFFF);
    if (!creature_can_be_renamed(creatng, plyr_idx))
        return;
    if ((creatng->creation_turn & NAME_PAR1_CRTURN_MASK) != ((par1 >> NAME_PAR1_CRTURN_SHIFT) & NAME_PAR1_CRTURN_MASK))
        return;
    struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
    const size_t offset = ((par1 >> NAME_PAR1_CHUNK_SHIFT) & NAME_PAR1_CHUNK_MASK) * NAME_CHUNK_BYTES;
    if (offset == 0)
    {
        memset(cctrl->incoming_name, 0, sizeof(cctrl->incoming_name));
        cctrl->incoming_name_user = user;
    } else
    if ((cctrl->incoming_name_user != user) || (strnlen(cctrl->incoming_name, sizeof(cctrl->incoming_name)) != offset))
    {
        // Not the next chunk of the name being received
        return;
    }
    char name[NAME_BUFFER_LEN];
    memset(name, 0, sizeof(name));
    memcpy(name, cctrl->incoming_name, offset);
    const uint32_t par2 = (uint32_t)pckt->actn_par2;
    const uint16_t par3 = (uint16_t)pckt->actn_par3;
    const uint16_t par4 = (uint16_t)pckt->actn_par4;
    char *bytes = &name[offset];
    bytes[0] = par2 & 0xFF;
    bytes[1] = (par2 >> 8) & 0xFF;
    bytes[2] = (par2 >> 16) & 0xFF;
    bytes[3] = (par2 >> 24) & 0xFF;
    bytes[4] = par3 & 0xFF;
    bytes[5] = (par3 >> 8) & 0xFF;
    bytes[6] = par4 & 0xFF;
    bytes[7] = (par4 >> 8) & 0xFF;
    name[sizeof(cctrl->incoming_name) - 1] = '\0';
    memset(cctrl->incoming_name, 0, sizeof(cctrl->incoming_name));
    if ((par1 & NAME_PAR1_FINAL) == 0)
    {
        // The next chunk checks the length of what is here
        memcpy(cctrl->incoming_name, name, min(offset + NAME_CHUNK_BYTES, sizeof(cctrl->incoming_name) - 1));
        return;
    }
    char clean[CREATURE_NAME_MAX];
    sanitize_creature_name(clean, sizeof(clean), name);
    if (clean[0] == '\0')
        return;
    memset(cctrl->creature_name, 0, sizeof(cctrl->creature_name));
    memcpy(cctrl->creature_name, clean, strlen(clean));
    SYNCDBG(7, "Player %d renamed %s index %d to \"%s\"", (int)plyr_idx, thing_model_name(creatng),
        (int)creatng->index, cctrl->creature_name);
}

/**
 * Applies a creature settings packet action. Called on every machine.
 * @return True if the action was a creature settings one.
 */
TbBool process_creature_settings_packet(NetUserId user, const struct Packet *pckt)
{
    if ((user < 0) || (user >= MAX_NET_USERS) || network_user_is_spectator(user))
        return false;
    const PlayerNumber plyr_idx = get_net_user_player_number(user);
    switch (pckt->action)
    {
    case PckA_CreatureSetOrder:
    {
        struct Thing *creatng = thing_get(pckt->actn_par1);
        const uint32_t par2 = (uint32_t)pckt->actn_par2;
        const unsigned char kind = par2 & ORDER_PAR2_KIND_MASK;
        const unsigned char value = (par2 >> ORDER_PAR2_VALUE_SHIFT) & ORDER_PAR2_VALUE_MASK;
        if (!creature_settings_can_change(creatng, plyr_idx) || !creature_order_value_valid(creatng, kind, value))
            return true;
        if ((creatng->creation_turn & ORDER_PAR2_CRTURN_MASK) != ((par2 >> ORDER_PAR2_CRTURN_SHIFT) & ORDER_PAR2_CRTURN_MASK))
            return true;
        struct CreatureControl *cctrl = creature_control_get_from_thing(creatng);
        unsigned char *field = creature_order_field(cctrl, kind);
        if (field == NULL)
            return true;
        *field = value;
        SYNCDBG(7, "Player %d set order %d of %s index %d to %d", (int)plyr_idx, (int)kind, thing_model_name(creatng),
            (int)creatng->index, (int)value);
        return true;
    }
    case PckA_CreatureSetName:
        process_creature_name_chunk(user, plyr_idx, pckt);
        return true;
    default:
        return false;
    }
}
/******************************************************************************/
#ifdef __cplusplus
}
#endif
