/******************************************************************************/
/** @file WebFileSystem.c
 *     Browser build: download game data files the first time they are opened.
 * @par Purpose:
 *     The browser page (web/shell.html + web/kfx_web.js) creates every file of
 *     the KeeperFX data set as an empty placeholder from a manifest, without
 *     downloading anything. The link step wraps the open and stat syscalls
 *     (-Wl,--wrap=...) so that, for any placeholder:
 *       - opening it downloads it first (Asyncify suspends the game meanwhile);
 *       - stat reports its real size, without downloading it.
 *     Because this sits at the syscall layer, stdio, iostreams, SDL, Lua and
 *     ffmpeg all get it with no change to the game's own file code.
 * @par Copying and copyrights:
 *     This program is free software; you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation; either version 2 of the License, or
 *     (at your option) any later version.
 */
/******************************************************************************/
#include <stdarg.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <emscripten/syscalls.h>

// Implemented in web/kfx_web.js.
// Size of a not-yet-downloaded placeholder (>= 0), or -1 for any other path.
extern double kfx_web_lazy_size(int dirfd, const char *path);
// Download a placeholder's contents into the in-memory filesystem (async).
extern int kfx_web_lazy_fetch(int dirfd, const char *path);

int __real___syscall_openat(int dirfd, const char *path, int flags, ...);
int __real___syscall_stat64(const char *path, struct stat *buf);
int __real___syscall_lstat64(const char *path, struct stat *buf);
int __real___syscall_newfstatat(int dirfd, const char *path, struct stat *buf, int flags);

int __wrap___syscall_openat(int dirfd, const char *path, int flags, ...)
{
    int mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, int);
        va_end(ap);
    }
    if (kfx_web_lazy_size(dirfd, path) >= 0) {
        int err = kfx_web_lazy_fetch(dirfd, path);
        if (err != 0)
            return err; // negative errno, as syscalls return
    }
    return __real___syscall_openat(dirfd, path, flags, mode);
}

static int fix_size(int ret, int dirfd, const char *path, struct stat *buf)
{
    if (ret == 0) {
        double size = kfx_web_lazy_size(dirfd, path);
        if (size >= 0)
            buf->st_size = (off_t)size;
    }
    return ret;
}

int __wrap___syscall_stat64(const char *path, struct stat *buf)
{
    return fix_size(__real___syscall_stat64(path, buf), AT_FDCWD, path, buf);
}

int __wrap___syscall_lstat64(const char *path, struct stat *buf)
{
    return fix_size(__real___syscall_lstat64(path, buf), AT_FDCWD, path, buf);
}

int __wrap___syscall_newfstatat(int dirfd, const char *path, struct stat *buf, int flags)
{
    return fix_size(__real___syscall_newfstatat(dirfd, path, buf, flags), dirfd, path, buf);
}
