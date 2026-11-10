# WebBuild.cmake - KeeperFX 1.4 for the browser (Emscripten / WebAssembly).
# Included by CMakeLists.txt when configured with emcmake (see docs/web.md):
#
#   source ~/emsdk/emsdk_env.sh
#   web/build-deps.sh <prefix>                     # once: zlib, spng, Lua, ffmpeg...
#   emcmake cmake -S . -B build-web -G Ninja -DCMAKE_BUILD_TYPE=Release \
#       -DKFX_WEB_DEPS=<prefix> -DBUILD_NUMBER=5136 -DPACKAGE_SUFFIX=
#   nice -n 19 cmake --build build-web -j 4        # -> build-web/site/keeperfx.js/.wasm
#
# 1.4 is an SDL2 game: SDL2, SDL2_mixer, SDL2_image and SDL2_net come from
# Emscripten's own ports (the versions 1.4 shipped with, or close: SDL 2.32,
# SDL_mixer 2.8.0), OpenAL from Emscripten's Web Audio implementation. The other
# libraries are the same pinned sources the alpha builds use (web/build-deps.sh;
# kfx-deps had the same versions for 1.4 and for master).

set(KFX_WEB_DEPS "${CMAKE_BINARY_DIR}/deps/prefix" CACHE PATH "Prefix built by web/build-deps.sh")
if(NOT EXISTS "${KFX_WEB_DEPS}/lib/liblua.a")
    message(FATAL_ERROR "WebAssembly deps missing in ${KFX_WEB_DEPS}; run: web/build-deps.sh ${KFX_WEB_DEPS}")
endif()

# Version: version.mk, with the build number upstream's own build has
# (git rev-list --count at the release tag: 5136 for 1.4.0).
file(STRINGS "${CMAKE_SOURCE_DIR}/version.mk" _ver REGEX "^VER_(MAJOR|MINOR|RELEASE)=")
foreach(_l IN LISTS _ver)
    string(REGEX MATCH "^(VER_[A-Z]+)=([0-9]+)" _m "${_l}")
    set(${CMAKE_MATCH_1} ${CMAKE_MATCH_2})
endforeach()
set(BUILD_NUMBER "0" CACHE STRING "Build number (git rev-list --count of the upstream commit)")
set(PACKAGE_SUFFIX "" CACHE STRING "Package suffix (empty for a release, Alpha for an alpha)")
set(VER_BUILD ${BUILD_NUMBER})
set(VER_STRING "${VER_MAJOR}.${VER_MINOR}.${VER_RELEASE}.${VER_BUILD} ${PACKAGE_SUFFIX}")
find_package(Git QUIET)
set(GIT_REVISION "unknown")
if(GIT_FOUND)
    execute_process(COMMAND "${GIT_EXECUTABLE}" describe --always WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
        OUTPUT_VARIABLE GIT_REVISION OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
endif()
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/gen")
configure_file("${CMAKE_SOURCE_DIR}/ver_defs.h.in" "${CMAKE_BINARY_DIR}/gen/ver_defs.h")

file(GLOB_RECURSE KEEPERFX_SOURCES CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/src/*.c" "${CMAKE_SOURCE_DIR}/src/*.cpp")
# As linux.mk, less the Windows-only files; no curl/UPnP in a browser
# (src/kfx/platform/web/NetMatchmakingWeb.c stands in for them).
list(FILTER KEEPERFX_SOURCES EXCLUDE REGEX "/src/(ftests/|windows\\.cpp$|cdrom\\.cpp$|steam_api\\.cpp$|net_matchmaking\\.c$|net_portforward\\.cpp$)")
list(APPEND KEEPERFX_SOURCES "${CMAKE_SOURCE_DIR}/deps/centitoml/toml_api.c")

add_executable(keeperfx ${KEEPERFX_SOURCES})
set_target_properties(keeperfx PROPERTIES SUFFIX ".js")
target_include_directories(keeperfx PRIVATE
    "${CMAKE_BINARY_DIR}/gen" "${CMAKE_SOURCE_DIR}/src" "${CMAKE_SOURCE_DIR}/deps/centitoml"
    "${KFX_WEB_DEPS}/include")
target_compile_definitions(keeperfx PRIVATE BFDEBUG_LEVEL=0 DEBUG=0 SPNG_STATIC=1 AL_LIBTYPE_STATIC)

set(_ports -sUSE_SDL=2 -sUSE_SDL_MIXER=2 "-sSDL2_MIXER_FORMATS=[\"ogg\",\"wav\"]"
    -sUSE_SDL_IMAGE=2 "-sSDL2_IMAGE_FORMATS=[\"png\"]" -sUSE_SDL_NET=2)
# No -Werror: clang (emcc) warns about things GCC accepts.
target_compile_options(keeperfx PRIVATE ${_ports}
    -O2 -Wall -Wno-unused-parameter -Wno-unknown-pragmas -Wno-sign-compare
    -Wno-missing-field-initializers -Wno-unused-variable -Wno-unused-but-set-variable
    $<$<COMPILE_LANGUAGE:C>:-Wno-absolute-value>
    # Emscripten disables C++ exceptions by default; the sound code uses
    # them. JS-based exceptions, as Asyncify does not combine with wasm ones.
    $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)

set(_wl "${KFX_WEB_DEPS}/lib")
target_link_libraries(keeperfx PRIVATE
    "${_wl}/libavformat.a" "${_wl}/libavcodec.a" "${_wl}/libswresample.a" "${_wl}/libavutil.a"
    "${_wl}/liblua.a" "${_wl}/libspng_static.a" "${_wl}/libminizip.a" "${_wl}/libz.a"
    "${_wl}/libastronomy.a" "${_wl}/libjson.a" "${_wl}/libenet6.a")
target_link_options(keeperfx PRIVATE ${_ports}
    # The game loop blocks (frame pacing, loading screens, menus); Asyncify
    # lets it yield to the browser from inside SDL_Delay and after each frame.
    -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144 -fexceptions
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sSTACK_SIZE=8MB
    -sFORCE_FILESYSTEM=1 -lidbfs.js -lopenal
    -sEXIT_RUNTIME=1 -sINVOKE_RUN=0
    -sEXPORTED_RUNTIME_METHODS=FS,IDBFS,callMain,ENV
    -sEXPORTED_FUNCTIONS=_main
    -sENVIRONMENT=web
    # Keep function names: crash reports from players stay readable.
    --profiling-funcs
    # Lazy data download on first open (src/kfx/platform/web/WebFileSystem.c).
    -Wl,--wrap=__syscall_openat -Wl,--wrap=__syscall_stat64
    -Wl,--wrap=__syscall_lstat64 -Wl,--wrap=__syscall_newfstatat
    # No sockets in a browser (src/kfx/platform/web/NetMatchmakingWeb.c).
    -Wl,--wrap=__syscall_socket
    "--js-library=${CMAKE_SOURCE_DIR}/web/kfx_web.js")
set_property(TARGET keeperfx APPEND PROPERTY LINK_DEPENDS "${CMAKE_SOURCE_DIR}/web/kfx_web.js")

# The engine is all a build publishes (web/publish-build.py takes keeperfx.js
# and keeperfx.wasm from site/); the page around it is the site's own.
set(KFX_WEB_SITE "${CMAKE_BINARY_DIR}/site")
add_custom_target(web-site ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory "${KFX_WEB_SITE}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE_DIR:keeperfx>/keeperfx.js" "$<TARGET_FILE_DIR:keeperfx>/keeperfx.wasm" "${KFX_WEB_SITE}/"
    DEPENDS keeperfx
    COMMENT "Engine -> ${KFX_WEB_SITE}"
    VERBATIM)
message(STATUS "KeeperFX ${VER_STRING} for the browser; engine -> ${KFX_WEB_SITE}")
