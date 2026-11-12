#ifndef ZZ_MAPWHO_CHECK_H
#define ZZ_MAPWHO_CHECK_H
#ifdef __cplusplus
extern "C" {
#endif
struct Thing;
long mwc_check(const char *where, const struct Thing *after);
int mwc_per_thing_active(void);
int mwc_fast_forward(void);
void mwc_watch_log(const char *where, const struct Thing *updated);
void mwc_selftest_turn(void);
#ifdef __cplusplus
}
#endif
#endif
