# WebBundle.cmake - assembles the browser build into <build>/site/, ready to
# serve as static files (see docs/web.md).
#
#   web-site target (all) -> site/index.html, site.css, kfx_*.js, fonts/, keeperfx.js/.wasm
#   web-gamedata target   -> site/gamedata/ (+ manifest.json) from the dirs in
#                            -DKFX_WEB_GAMEDATA_SRC="<complete release>;<pkg>",
#                            later dirs laid over earlier ones

set(KFX_WEB_SITE "${CMAKE_BINARY_DIR}/site")
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(KFX_WEB_GAMEDATA_SRC "" CACHE STRING
    "KeeperFX install dir(s) the web-gamedata target packages, base first (a ;-list)")

# Its own target rather than a post-build step of keeperfx, so a change to the
# page alone (web/*.html, .css, .js) is picked up without relinking the game.
add_custom_target(web-site ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory "${KFX_WEB_SITE}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE_DIR:keeperfx>/keeperfx.js"
        "$<TARGET_FILE_DIR:keeperfx>/keeperfx.wasm"
        "${CMAKE_SOURCE_DIR}/web/index.html"
        "${CMAKE_SOURCE_DIR}/web/kfx_loader.js"
        "${CMAKE_SOURCE_DIR}/web/kfx_touch.js"
        "${CMAKE_SOURCE_DIR}/web/kfx_account.js"
        "${CMAKE_SOURCE_DIR}/web/kfx_site.js"
        "${CMAKE_SOURCE_DIR}/web/site.css"
        "${CMAKE_SOURCE_DIR}/web/_headers"
        "${CMAKE_SOURCE_DIR}/web/404.html"
        "${KFX_WEB_SITE}/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/res/keeperfx_icon256-24bpp.png" "${KFX_WEB_SITE}/icon.png"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/web/fonts" "${KFX_WEB_SITE}/fonts"
    # Make the page request this exact keeperfx.js/.wasm pair (cache safety).
    COMMAND Python3::Interpreter "${CMAKE_SOURCE_DIR}/web/stamp-version.py" "${KFX_WEB_SITE}"
    DEPENDS keeperfx
    COMMENT "Assembling the site in ${KFX_WEB_SITE}"
    VERBATIM)

if(Python3_FOUND)
    add_custom_target(web-gamedata
        COMMAND Python3::Interpreter "${CMAKE_SOURCE_DIR}/web/package-data.py"
                "${KFX_WEB_SITE}" ${KFX_WEB_GAMEDATA_SRC}
        COMMENT "Packaging game data for the browser from ${KFX_WEB_GAMEDATA_SRC}"
        VERBATIM)
endif()

kfx_status("WEB" "site -> ${KFX_WEB_SITE} (game data: ninja web-gamedata)")
