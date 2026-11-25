/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file creature_settings.h
 *     Header file for creature_settings.c.
 * @par Purpose:
 *     Orders a keeper gives to one creature: its name, combat style, whether
 *     it flees or takes prisoners, and how it uses each of its abilities.
 * @par Comment:
 *     Just a header file - #defines, typedefs, function prototypes etc.
 * @author   KeeperFX Team
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#ifndef DK_CREATURE_SETTINGS_H
#define DK_CREATURE_SETTINGS_H

#include "bflib_basics.h"
#include "globals.h"
#include "net_main.h"
#include "thing_stats.h"

#ifdef __cplusplus
extern "C" {
#endif

struct Thing;
struct Packet;

/** Kinds of orders; each instance slot the creature learns has its own order kind. */
enum CreatureOrderKind {
    CrOrd_CombatStyle = 0,
    CrOrd_Flee,
    CrOrd_Imprison,
    CrOrd_InstanceFirst,
    CrOrd_Count = CrOrd_InstanceFirst + LEARNED_INSTANCES_COUNT,
};

/** Combat style chosen for one creature, stored in CreatureControl::combat_style. */
enum CreatureCombatStyle {
    CrCmbtStl_Default = 0, /**< Use the attack preference from the creature's config. */
    CrCmbtStl_Melee,       /**< Close in and fight hand to hand; ranged attacks only when the enemy can't be reached. */
    CrCmbtStl_Ranged,      /**< Keep at a distance and use ranged attacks when the creature has them. */
    CrCmbtStl_Count,
};

/** Whether one creature flees when badly hurt, stored in CreatureControl::flee_order. */
enum CreatureFleeOrder {
    CrFlee_Default = 0, /**< Follow the keeper's Flee tendency. */
    CrFlee_Flee,        /**< Flee when badly hurt. */
    CrFlee_Fight,       /**< Fight to the death. */
    CrFlee_Count,
};

/** Whether one creature takes prisoners, stored in CreatureControl::imprison_order. */
enum CreatureImprisonOrder {
    CrImpr_Default = 0, /**< Follow the keeper's Imprison tendency. */
    CrImpr_Imprison,    /**< Knock out the enemies it defeats, for the prison. */
    CrImpr_Kill,        /**< Kill the enemies it defeats. */
    CrImpr_Count,
};

/** How one creature may use one of its abilities on its own, stored in CreatureControl::instance_orders. */
enum CreatureInstanceOrder {
    CrInstOrd_Allowed = 0, /**< Used as usual. */
    CrInstOrd_Careful,     /**< Area attacks only: not used when the keeper's or allied creatures would be caught in it. */
    CrInstOrd_Off,         /**< Never used on its own; the keeper can still use it when possessing the creature. */
    CrInstOrd_Count,
};

CrAttackType creature_attack_preference(const struct Thing *creatng);
TbBool creature_tends_to_flee(const struct Thing *creatng);
TbBool creature_tends_to_imprison(const struct Thing *killertng);
void creature_note_knocked_out_by(struct Thing *victng, const struct Thing *killertng);
TbBool player_wants_creature_as_prisoner(PlayerNumber plyr_idx, const struct Thing *victng);

int creature_learned_instance_slot(const struct Thing *creatng, CrInstance inst_id);
unsigned char creature_instance_order(const struct Thing *creatng, CrInstance inst_id);
TbBool creature_instance_allowed_for_ai(const struct Thing *creatng, CrInstance inst_id);
TbBool creature_instance_safe_for_ai(const struct Thing *creatng, CrInstance inst_id, const struct Thing *target);
MapCoordDelta instance_own_creatures_hit_range(CrInstance inst_id, const struct Thing *creatng);

TbBool creature_settings_can_change(const struct Thing *creatng, PlayerNumber plyr_idx);
TbBool creature_can_be_renamed(const struct Thing *creatng, PlayerNumber plyr_idx);
TbBool creature_has_combat_style_choice(const struct Thing *creatng);
TbBool creature_order_value_valid(const struct Thing *creatng, unsigned char kind, unsigned char value);
unsigned char creature_order_next_value(const struct Thing *creatng, unsigned char kind, int direction);
void creature_reset_orders(struct Thing *creatng);

// Local requests from the interface; they reach the game through packets.
void request_creature_order(const struct Thing *creatng, unsigned char kind, unsigned char value);
void request_creature_name(const struct Thing *creatng, const char *name);
unsigned char creature_displayed_order(const struct Thing *creatng, unsigned char kind);
const char *creature_displayed_name(const struct Thing *creatng);
void set_pending_creature_settings_packet_action(struct Packet *pckt);
void clear_creature_settings_requests(void);

// Applied on every machine when the packet is processed.
TbBool process_creature_settings_packet(NetUserId user, const struct Packet *pckt);

#ifdef __cplusplus
}
#endif
#endif
