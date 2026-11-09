#!/usr/bin/env bash
# Build KeeperFX's third-party dependencies as WebAssembly static libraries.
#
# Usage: web/build-deps.sh [prefix]     (default prefix: build-web/deps/prefix)
# Needs an activated emsdk (emcc/emcmake/emconfigure on PATH).
#
# Everything is built from pinned sources into one prefix, which
# build/cmake/modules/Dependencies.cmake imports when CMAKE_SYSTEM_NAME is
# Emscripten. Differences from the desktop deps:
#   - LuaJIT has no WebAssembly backend, so PUC Lua 5.1.5 is used, patched with
#     the LuaJIT/5.2 extensions KeeperFX needs (see web/lua51-luajit-compat.patch),
#     plus LuaBitOp for the `bit` module.
#   - ffmpeg is the same smacker-only build the desktop release uses.
#   - curl, miniupnpc and libnatpmp are not built: browsers have no raw sockets.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SRC_DIR/.." && pwd)"
PREFIX="$(realpath -m "${1:-$ROOT/build-web/deps/prefix}")"
WORK="$(dirname "$PREFIX")/work"
JOBS="${JOBS:-4}"
NICE="nice -n 19"

SDL3_VER=3.4.18
SDL3_IMG_VER=3.4.6
SDL3_MIX_VER=3.2.4
ZLIB_VER=1.3.1
SPNG_VER=0.7.4
CENTIJSON_SHA=8c7a5fb42d9f55044d60592809288164adb4ca95
ASTRONOMY_SHA=865d3da7d8112bbc7911238052c6af4aaf877181
ENET6_VER=v6.1.3
LUA_VER=5.1.5
BITOP_VER=1.0.3
FFMPEG_VER=7.1.1

command -v emcc >/dev/null || { echo "emcc not found: source emsdk_env.sh first" >&2; exit 1; }
mkdir -p "$PREFIX/include" "$PREFIX/lib" "$WORK"
cd "$WORK"

fetch() { # fetch <dir> <url>: download and unpack once into $WORK/<dir>
    local dir=$1 url=$2 file
    [ -d "$dir" ] && return 0
    file="$(basename "$url")"
    [ -f "$file" ] || curl -fsSL -o "$file" "$url"
    mkdir -p "$dir.tmp"
    tar xf "$file" -C "$dir.tmp" --strip-components=1
    mv "$dir.tmp" "$dir"
}

stamp() { [ -f "$WORK/.done-$1" ]; }
done_() { touch "$WORK/.done-$1"; }

cmake_dep() { # cmake_dep <name> <srcdir> [cmake args...]
    local name=$1 src=$2; shift 2
    $NICE emcmake cmake -S "$src" -B "build-$name" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX" \
        -DCMAKE_FIND_ROOT_PATH="$PREFIX" -DBUILD_SHARED_LIBS=OFF "$@" >/dev/null
    $NICE cmake --build "build-$name" -j "$JOBS" >/dev/null
    cmake --install "build-$name" >/dev/null
}

# --- SDL3 + SDL3_image + SDL3_mixer
if ! stamp sdl3; then
    fetch SDL3 "https://github.com/libsdl-org/SDL/releases/download/release-$SDL3_VER/SDL3-$SDL3_VER.tar.gz"
    cmake_dep sdl3 SDL3 -DSDL_TEST_LIBRARY=OFF -DSDL_EXAMPLES=OFF -DSDL_TESTS=OFF
    done_ sdl3
fi
if ! stamp sdl3_image; then
    fetch SDL3_image "https://github.com/libsdl-org/SDL_image/releases/download/release-$SDL3_IMG_VER/SDL3_image-$SDL3_IMG_VER.tar.gz"
    # stb_image handles PNG/JPG with no external libraries.
    cmake_dep sdl3_image SDL3_image -DSDLIMAGE_SAMPLES=OFF -DSDLIMAGE_TESTS=OFF \
        -DSDLIMAGE_VENDORED=OFF -DSDLIMAGE_BACKEND_STB=ON -DSDLIMAGE_DEPS_SHARED=OFF \
        -DSDLIMAGE_AVIF=OFF -DSDLIMAGE_JXL=OFF -DSDLIMAGE_TIF=OFF -DSDLIMAGE_WEBP=OFF
    done_ sdl3_image
fi
if ! stamp sdl3_mixer; then
    fetch SDL3_mixer "https://github.com/libsdl-org/SDL_mixer/releases/download/release-$SDL3_MIX_VER/SDL3_mixer-$SDL3_MIX_VER.tar.gz"
    # Built-in decoders only (stb_vorbis, dr_wav/dr_flac/dr_mp3); no external codec libs.
    cmake_dep sdl3_mixer SDL3_mixer -DSDLMIXER_SAMPLES=OFF -DSDLMIXER_TESTS=OFF \
        -DSDLMIXER_VENDORED=OFF -DSDLMIXER_DEPS_SHARED=OFF \
        -DSDLMIXER_OPUS=OFF -DSDLMIXER_WAVPACK=OFF -DSDLMIXER_GME=OFF -DSDLMIXER_MOD=OFF \
        -DSDLMIXER_MIDI_FLUIDSYNTH=OFF -DSDLMIXER_FLAC_LIBFLAC=OFF -DSDLMIXER_MP3_MPG123=OFF \
        -DSDLMIXER_VORBIS_VORBISFILE=OFF -DSDLMIXER_VORBIS_TREMOR=OFF -DSDLMIXER_AIFF=ON
    done_ sdl3_mixer
fi

# --- zlib + minizip
if ! stamp zlib; then
    fetch zlib "https://github.com/madler/zlib/releases/download/v$ZLIB_VER/zlib-$ZLIB_VER.tar.gz"
    cmake_dep zlib zlib -DZLIB_BUILD_EXAMPLES=OFF
    rm -f "$PREFIX"/lib/libz.so*  # keep the static one only
    mz=zlib/contrib/minizip
    mkdir -p build-minizip "$PREFIX/include/minizip"
    for f in ioapi unzip zip; do
        $NICE emcc -O2 -c -I"$PREFIX/include" -DNOCRYPT=0 -o "build-minizip/$f.o" "$mz/$f.c"
    done
    emar crs "$PREFIX/lib/libminizip.a" build-minizip/*.o
    cp "$mz"/{ioapi,unzip,zip}.h "$PREFIX/include/minizip/"
    done_ zlib
fi

# --- libspng
if ! stamp spng; then
    fetch libspng "https://github.com/randy408/libspng/archive/refs/tags/v$SPNG_VER.tar.gz"
    cmake_dep spng libspng -DSPNG_SHARED=OFF -DSPNG_STATIC=ON -DBUILD_EXAMPLES=OFF \
        -DZLIB_ROOT="$PREFIX" -DZLIB_LIBRARY="$PREFIX/lib/libz.a" -DZLIB_INCLUDE_DIR="$PREFIX/include"
    done_ spng
fi

# --- centijson
if ! stamp centijson; then
    fetch centijson "https://github.com/mity/centijson/archive/$CENTIJSON_SHA.tar.gz"
    mkdir -p build-centijson
    for f in centijson/src/*.c; do
        $NICE emcc -O2 -c -o "build-centijson/$(basename "$f" .c).o" "$f"
    done
    emar crs "$PREFIX/lib/libjson.a" build-centijson/*.o
    cp centijson/src/*.h "$PREFIX/include/"
    done_ centijson
fi

# --- astronomy (with the same patches as kfx-deps)
if ! stamp astronomy; then
    fetch astronomy "https://github.com/cosinekitty/astronomy/archive/$ASTRONOMY_SHA.tar.gz"
    for p in 356 357; do
        [ -f "astronomy-$p.patch" ] || curl -fsSL -o "astronomy-$p.patch" \
            "https://raw.githubusercontent.com/dkfans/kfx-deps/master/astronomy-$p.patch"
        (cd astronomy && patch -p1 -N -s < "../astronomy-$p.patch") || true
    done
    $NICE emcc -O2 -c -Iastronomy/source/c -o astronomy.o astronomy/source/c/astronomy.c
    emar crs "$PREFIX/lib/libastronomy.a" astronomy.o
    cp astronomy/source/c/*.h "$PREFIX/include/"
    done_ astronomy
fi

# --- enet6 (compiles against Emscripten's socket emulation; LAN play is not
# available in a browser, but the code links unchanged)
if ! stamp enet6; then
    fetch enet6 "https://github.com/SirLynix/enet6/archive/refs/tags/$ENET6_VER.tar.gz"
    cmake_dep enet6 enet6 -DENET_STATIC=ON -DENET_SHARED=OFF -DENET_TEST=OFF
    [ -d "$PREFIX/include/enet6" ] || cp -r enet6/include/enet6 "$PREFIX/include/"
    [ -f "$PREFIX/lib/libenet6.a" ] || cp "$(find build-enet6 -name 'libenet6*.a' | head -1)" "$PREFIX/lib/libenet6.a"
    done_ enet6
fi

# --- Lua 5.1.5 (+ LuaJIT-compatible extensions) and LuaBitOp
if ! stamp lua; then
    fetch lua "https://www.lua.org/ftp/lua-$LUA_VER.tar.gz"
    fetch luabitop "http://bitop.luajit.org/download/LuaBitOp-$BITOP_VER.tar.gz"
    (cd lua && patch -p1 -N -s < "$SRC_DIR/lua51-luajit-compat.patch")
    mkdir -p build-lua
    objs=()
    for f in lua/src/*.c luabitop/bit.c; do
        b="$(basename "$f" .c)"
        case "$b" in lua|luac|print) continue;; esac
        $NICE emcc -O2 -c -DLUA_USE_POSIX -Ilua/src -o "build-lua/$b.o" "$f"
        objs+=("build-lua/$b.o")
    done
    emar crs "$PREFIX/lib/liblua.a" "${objs[@]}"
    cp lua/src/{lua.h,luaconf.h,lualib.h,lauxlib.h} lua/etc/lua.hpp "$PREFIX/include/"
    # luajit.h stand-in: KeeperFX includes it for LUAJIT_VERSION only.
    printf '#pragma once\n#define LUAJIT_VERSION "Lua 5.1.5 (WebAssembly)"\n' > "$PREFIX/include/luajit.h"
    done_ lua
fi

# --- ffmpeg, smacker only (intro and cutscene movies)
if ! stamp ffmpeg; then
    fetch ffmpeg "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz"
    (cd ffmpeg && $NICE emconfigure ./configure --prefix="$PREFIX" \
        --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
        --target-os=none --arch=x86_32 --enable-cross-compile \
        --disable-asm --disable-x86asm --disable-inline-asm --disable-stripping \
        --disable-programs --disable-doc --disable-devices --disable-everything \
        --disable-filters --disable-avdevice --disable-swscale --disable-avfilter \
        --disable-network --disable-dwt --disable-lsp --disable-faan --disable-iamf \
        --disable-pixelutils --disable-debug --disable-pthreads --disable-w32threads \
        --disable-os2threads --enable-static --disable-shared --enable-small \
        --enable-decoder=smacker --enable-decoder=smackaud --enable-demuxer=smacker \
        --enable-protocol=file >/dev/null)
    $NICE make -C ffmpeg -j "$JOBS" >/dev/null
    make -C ffmpeg install >/dev/null
    done_ ffmpeg
fi

echo "WebAssembly deps installed in $PREFIX"
