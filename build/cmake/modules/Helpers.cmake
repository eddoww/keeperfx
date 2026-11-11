# Helpers.cmake - shared functions for the desktop (Windows/MinGW + Linux) build.

function(kfx_status PREFIX MESSAGE)
    message(STATUS "[${PREFIX}] ${MESSAGE}")
endfunction()

# Flags that make the simulation compute the same results on every platform.
# Multiplayer is lockstep: all clients (32-bit Windows, 64-bit Linux,
# WebAssembly) must get bit-identical game state from the same input.
#  - No contraction of a*b+c into a fused multiply-add on targets that have one.
#  - 32-bit x86 computes float/double in SSE registers like x86-64 and wasm do,
#    not in 80-bit x87 registers whose extra precision changes results.
function(apply_keeperfx_determinism_flags TARGET)
    if(MSVC)
        return()
    endif()
    target_compile_options(${TARGET} PRIVATE -ffp-contract=off)
    if(CMAKE_SIZEOF_VOID_P EQUAL 4 AND NOT EMSCRIPTEN)
        target_compile_options(${TARGET} PRIVATE -msse2 -mfpmath=sse)
    endif()
endfunction()

# Warning + optimisation flags, per platform (mirrors the hand Makefiles).
function(apply_keeperfx_warnings TARGET)
    apply_keeperfx_determinism_flags(${TARGET})
    if(MSVC)
        # Real cl.exe (Debug-MSVC preset) - a local-convenience build, not the
        # fork's canonical toolchain (that's GCC/MinGW-w64). The GNU-style
        # flags below aren't understood by cl.exe's native driver - e.g. a
        # bare "-W" is parsed as cl's own /W switch, which requires a number
        # ("cl : Command line error D8004: '/W' requires an argument"), and
        # -march/-fno-omit-frame-pointer/-fmessage-length have no cl.exe
        # equivalent. Skip them; CMAKE_BUILD_TYPE already supplies sane
        # /O* + /Zi flags. (Note: MSVC here means real cl.exe only - clang-cl
        # reports CMAKE_<LANG>_COMPILER_ID "Clang", so MSVC is false for it
        # and it still takes the WIN32 branch below, which it understands.)
    elseif(EMSCRIPTEN)
        # No -Werror: clang (emcc) warns about things GCC accepts, and the
        # desktop builds already gate warnings.
        target_compile_options(${TARGET} PRIVATE
            -Wall -Wextra -Wno-unused-parameter -Wno-unknown-pragmas
            -Wno-sign-compare -Wno-missing-field-initializers
            -O2 $<$<COMPILE_LANGUAGE:C>:-Wno-absolute-value>
            # Emscripten disables C++ exceptions by default; the sound code
            # relies on them. JS-based exceptions, as Asyncify can't combine
            # with native wasm exceptions.
            $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)
    elseif(WIN32)
        target_compile_options(${TARGET} PRIVATE
            -Wall -W -Wshadow -Wno-sign-compare -Wno-unused-parameter
            -Wno-strict-aliasing -Wno-unknown-pragmas
            -Werror -Wno-format-truncation
            -march=x86-64 -fno-omit-frame-pointer -fmessage-length=0 -O3
            $<$<COMPILE_LANGUAGE:C>:-Wimplicit>)
    else()
        target_compile_options(${TARGET} PRIVATE
            -Wall -Wextra -Werror -Wno-unused-parameter -Wno-unknown-pragmas
            -Wno-format-truncation -Wno-sign-compare
            -g -O3 -march=x86-64
            $<$<COMPILE_LANGUAGE:C>:-Wno-absolute-value>)
    endif()
endfunction()

# Link flags, per platform.
function(apply_keeperfx_link_flags TARGET)
    if(MSVC)
        # See apply_keeperfx_warnings: -mwindows/-Wl,.../-static are GNU
        # linker syntax, meaningless to link.exe. Let CMake's own MSVC
        # defaults link normally rather than passing them through unchanged.
    elseif(WIN32)
        # -static-libgcc/-static-libstdc++ are driver flags (mirrors the
        # Makefile's LINKFLAGS): they make g++ statically link its own
        # automatically-appended runtime refs. Without them the exe depends on
        # shared libgcc_s_dw2-1.dll/libstdc++-6.dll at runtime even though the
        # "-static stdc++ ... -dynamic" below (a linker -Bstatic/-Bdynamic
        # toggle for explicitly-listed libs) looks like it should cover it -
        # that toggle is back to -dynamic by the time g++ appends its own
        # implicit libs, so it doesn't apply to them.
        target_link_options(${TARGET} PRIVATE
            -mwindows -static-libgcc -static-libstdc++
            -Wl,--enable-auto-import -Wl,-Map,${TARGET}.map)
        target_link_libraries(${TARGET} PUBLIC -static stdc++ winpthread -dynamic)
    elseif(EMSCRIPTEN)
        kfx_web_link_flags(${TARGET})
    else()
        target_link_options(${TARGET} PRIVATE -g -rdynamic)
    endif()
endfunction()

function(apply_keeperfx_debug_split TARGET)
    if(NOT WIN32 OR MSVC)
        return()
    endif()
    if(NOT CMAKE_OBJCOPY)
        get_filename_component(_kfx_toolchain_bin "${CMAKE_CXX_COMPILER}" DIRECTORY)
        get_filename_component(_kfx_cxx_name "${CMAKE_CXX_COMPILER}" NAME_WE)
        string(REGEX REPLACE "-?g\\+\\+$" "" _kfx_toolchain_prefix "${_kfx_cxx_name}")
        find_program(CMAKE_OBJCOPY NAMES "${_kfx_toolchain_prefix}objcopy" objcopy
            HINTS "${_kfx_toolchain_bin}")
    endif()
    if(NOT CMAKE_OBJCOPY)
        message(WARNING "objcopy not found - ${TARGET} will ship with embedded debug info (no size-split)")
        return()
    endif()
    add_custom_command(TARGET ${TARGET} POST_BUILD
        COMMAND ${CMAKE_OBJCOPY} --only-keep-debug "$<TARGET_FILE:${TARGET}>" "$<TARGET_FILE:${TARGET}>.debug"
        COMMAND ${CMAKE_OBJCOPY} --strip-debug --add-gnu-debuglink=$<TARGET_FILE:${TARGET}>.debug "$<TARGET_FILE:${TARGET}>"
        COMMENT "Splitting debug info for ${TARGET}"
        VERBATIM)
endfunction()

# Windows system libraries (matches the Makefile LINKLIB trailer). No-op elsewhere.
function(apply_windows_system_libs TARGET)
    if(WIN32)
        target_link_libraries(${TARGET} PRIVATE
            winmm imagehlp ws2_32 dbghelp bcrypt ole32 uuid dxgi)
        if(NOT MSVC)
            # mingw32 (CRT startup wrapper import lib) only exists for MinGW/clang-cl.
            target_link_libraries(${TARGET} PRIVATE mingw32)
        endif()
    endif()
endfunction()

# Link flags for the browser build (docs/web.md explains the choices).
function(kfx_web_link_flags TARGET)
    set_target_properties(${TARGET} PROPERTIES SUFFIX ".js")
    target_link_options(${TARGET} PRIVATE
        # The game loop blocks (frame pacing, loading screens, menus); Asyncify
        # lets it yield to the browser from inside SDL_Delay and at present.
        -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144 -fexceptions
        -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sSTACK_SIZE=8MB
        -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1
        -sGL_ENABLE_GET_PROC_ADDRESS=1
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
    set_property(TARGET ${TARGET} APPEND PROPERTY LINK_DEPENDS "${CMAKE_SOURCE_DIR}/web/kfx_web.js")
endfunction()
