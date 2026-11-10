/******************************************************************************/
// Free implementation of Bullfrog's Dungeon Keeper strategy game.
/******************************************************************************/
/** @file ariadne_tringls.h
 *     Header file for ariadne_tringls.c.
 * @par Purpose:
 *     Triangles array for Ariadne system support.
 * @par Comment:
 *     Just a header file - #defines, typedefs, function prototypes etc.
 * @author   Tomasz Lis
 * @date     11 Mar 2010 - 22 Jul 2010
 * @par  Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#ifndef DK_ARIADNE_TRINGLS_H
#define DK_ARIADNE_TRINGLS_H

#include "bflib_basics.h"
#include "globals.h"
#include "bflib_math.h"
#include "ariadne_points.h"

#define TRIANLGLES_COUNT 100000
#define EDGELEN_BITS 6

#ifdef __cplusplus
extern "C" {
#endif

/******************************************************************************/
#pragma pack(1)

struct Point;

struct Triangle {
  short points[3];
  int tags[3]; // Id of each triangle neighbour of this one
  NavColour tree_alt; // NAV_COL_UNSET is a special value here
  unsigned char navigation_flags;
  unsigned short region_and_edgelen;
};

#define NAV_COL_UNSET USHRT_MAX

/******************************************************************************/
extern struct Triangle Triangles[TRIANLGLES_COUNT];
extern int32_t count_Triangles;
extern int32_t ix_Triangles;
extern int32_t free_Triangles;

#pragma pack()
/******************************************************************************/
extern struct Triangle bad_triangle;
#define INVALID_TRIANGLE &bad_triangle
extern const long MOD3[];
/******************************************************************************/
long tri_new(void);
void tri_dispose(long tri_idx);

long triangle_find_first_used(void);

TbBool set_triangle_region_id(long tri_id, long reg_id);
TbBool set_triangle_edgelen(long tri_id, long edgelen);
TbBool triangle_tip_equals(long tri_id, long pt_cor, long pt_x, long pt_y);
TbBool outer_locked(long ntri, long ncor);

long point_loop(long pt_tri, long pt_cor);
long reduce_point(int32_t *pt_tri, int32_t *pt_cor);
void edgelen_set(long tri_id);
long edge_rotateAC(long tri1_id, long cor1_id);

void triangulation_init_triangles(long pt_id1, long pt_id2, long pt_id3, long pt_id4);
/******************************************************************************/
// Small accessors used in the pathfinding inner loops, inline to avoid call overhead

static inline TbBool triangle_is_invalid(const struct Triangle *tri)
{
    return (tri < &Triangles[0]) || (tri > &Triangles[TRIANLGLES_COUNT-1]) || (tri == INVALID_TRIANGLE) || (tri == NULL);
}

static inline struct Triangle *get_triangle(long tri_id)
{
    if ((tri_id < 0) || (tri_id >= TRIANLGLES_COUNT))
        return INVALID_TRIANGLE;
    return &Triangles[tri_id];
}

static inline long get_triangle_region_id(long tri_id)
{
    if ((tri_id < 0) || (tri_id >= TRIANLGLES_COUNT))
        return -1;
    return (Triangles[tri_id].region_and_edgelen >> EDGELEN_BITS);
}

static inline long get_triangle_edgelen(long tri_id)
{
    if ((tri_id < 0) || (tri_id >= TRIANLGLES_COUNT))
        return 0;
    return (Triangles[tri_id].region_and_edgelen & ((1 << EDGELEN_BITS) - 1));
}

static inline NavColour get_triangle_tree_alt(long tri_id)
{
    if ((tri_id < 0) || (tri_id >= TRIANLGLES_COUNT))
        return -1;
    return Triangles[tri_id].tree_alt;
}

static inline struct Point *get_triangle_point(long tri_id, long pt_cor)
{
    if ((tri_id < 0) || (tri_id >= TRIANLGLES_COUNT))
        return INVALID_POINT;
    if ((pt_cor < 0) || (pt_cor >= 3))
        return INVALID_POINT;
    return point_get(Triangles[tri_id].points[pt_cor]);
}

static inline long link_find(long ntri, long val)
{
    if ((ntri < 0) || (ntri >= TRIANLGLES_COUNT))
    {
        return -1;
    }
    for (long i = 0; i < 3; i++)
    {
        if (Triangles[ntri].tags[i] == val)
        {
            return i;
        }
    }
    return -1;
}

static inline char triangle_divide_areas_s8differ(long ntri, long ncorA, long ncorB, long pt_x, long pt_y)
{
    struct Point* pt = get_triangle_point(ntri, ncorA);
    long tipA_x = (pt->x << 8);
    long tipA_y = (pt->y << 8);
    pt = get_triangle_point(ntri,ncorB);
    long tipB_x = (pt->x << 8);
    long tipB_y = (pt->y << 8);
    return LbCompareMultiplications(tipA_x-pt_x, tipB_y-pt_y, tipA_y-pt_y, tipB_x-pt_x);
}
/******************************************************************************/
#ifdef __cplusplus
}
#endif
#endif
