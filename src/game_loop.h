/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file game_loop.h
 *     Header file for game_loop.c.
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/

#ifndef DK_GAMELOOP_H
#define DK_GAMELOOP_H

#include "bflib_basics.h"
#include "globals.h"


#ifdef __cplusplus
extern "C" {
#endif
/******************************************************************************/
void process_dungeon_destroy(struct Thing* heartng);
void initialise_devastate_dungeon_from_heart(PlayerNumber plyr_idx);
/** True while a level is being played and the game is between two turns: not reading input, not running a
 *  turn's logic. The state of the game is whole then, so it can be saved, also from code that runs while the
 *  game waits (the browser build calls in while it waits for the next frame). */
TbBool gameplay_between_turns(void);
/******************************************************************************/
#ifdef __cplusplus
}
#endif
#endif
