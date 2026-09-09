cmake_minimum_required(VERSION 4.1.2 FATAL_ERROR)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(VillagePlanner LANGUAGES CXX)

# Without this a bare `cmake -S . -B build` compiles unoptimised, which makes
# any timing taken from the solver meaningless.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
    message(STATUS "No build type given, using Release")
endif()

find_package(Threads REQUIRED)
find_package(httplib REQUIRED)

set(SITE ${CMAKE_BINARY_DIR}/site)
file(MAKE_DIRECTORY ${SITE})

find_program(TERSER terser)
find_program(EMXX em++)
set(MINIFY ${CMAKE_CURRENT_SOURCE_DIR}/tools/minify.cmake)

# Every game's rules, generated from data/games/ rather than parsed at runtime:
# the engine has no json parser and the data is small enough to compile in.
set(GAMES_CPP ${CMAKE_BINARY_DIR}/games.gen.cpp)
# Written beside it: the array bounds effects.hpp reads, counted from the data.
set(GAMES_HPP ${CMAKE_BINARY_DIR}/games.gen.hpp)
# CONFIGURE_DEPENDS because data/ is written by tools/fetch-games.py rather
# than committed: a round that appears, or one whose file is removed, must
# reach the build without an explicit reconfigure.
file(GLOB GAME_DATA CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/data/games/*.json)

# The rules are never fetched by the build itself: fetch-games.py needs a token
# and the network, and the api's cost multipliers move every season, so a build
# that fetched would be neither offline-capable nor reproducible. Fail here
# instead, before anything is compiled, and say what to run.
if(NOT GAME_DATA)
    message(FATAL_ERROR
        "No game rules in data/games. They are fetched rather than committed:\n"
        "    FACTIONS_TOKEN=... tools/fetch-games.py\n"
        "See the top of tools/fetch-games.py for what it reads and what it keeps.")
endif()

add_custom_command(
    OUTPUT ${GAMES_CPP} ${GAMES_HPP}
    COMMAND ${CMAKE_COMMAND} -E env python3
            ${CMAKE_CURRENT_SOURCE_DIR}/tools/games-to-cpp.py ${GAMES_CPP}
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tools/games-to-cpp.py ${GAME_DATA}
    COMMENT "Writing games.gen.cpp from data/games"
    VERBATIM
)

# The engine: compiled to WebAssembly for the page, and natively for the tools
# and tests below. The server does not link it.
set(ENGINE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/parse.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/json.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cost.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/game.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/solver.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/effects.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/village.cpp
    ${GAMES_CPP}
)

set(ENGINE_HEADERS
    ${CMAKE_CURRENT_SOURCE_DIR}/src/parse.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/json.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cost.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/effects.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/game.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/solver.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/text.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/village.hpp
)

add_executable(Server src/server.cpp)
target_link_libraries(Server PRIVATE httplib::httplib Threads::Threads)

# The api under test. See tests/run.sh.
add_executable(Harness tests/harness.cpp ${ENGINE})
target_include_directories(Harness PRIVATE src ${CMAKE_BINARY_DIR})

# What the page needs to know about the game, generated from the engine's own
# tables so nothing is declared twice.
add_executable(Schema tools/schema.cpp ${ENGINE})
target_include_directories(Schema PRIVATE src ${CMAKE_BINARY_DIR})

set(SCHEMA_JS ${CMAKE_BINARY_DIR}/schema.gen.js)

add_custom_command(
    OUTPUT ${SCHEMA_JS}
    COMMAND Schema ${SCHEMA_JS}
    DEPENDS Schema
    COMMENT "Writing schema.js"
    VERBATIM
)

# Every script goes through terser on its way into the site.
foreach(script IN ITEMS app schema)
    if(script STREQUAL app)
        set(from ${CMAKE_CURRENT_SOURCE_DIR}/web/app.js)
    else()
        set(from ${SCHEMA_JS})
    endif()

    add_custom_command(
        OUTPUT ${SITE}/${script}.js
        COMMAND ${CMAKE_COMMAND} -DIN=${from} -DOUT=${SITE}/${script}.js
                -DNAME=${script}.js -DTERSER=${TERSER} -P ${MINIFY}
        DEPENDS ${from} ${MINIFY}
        COMMENT "Minifying ${script}.js"
        VERBATIM
    )
    list(APPEND SITE_OUTPUTS ${SITE}/${script}.js)
endforeach()

# The villages players built, fetched by the page only when one is requested.
# There may be none: data/ is written by tools/fetch-games.py rather than
# committed, and a run of it can be told to skip these.
file(GLOB PLAYER_DATA CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/data/players/*.json)
if(PLAYER_DATA)
    set(COPY_PLAYERS COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PLAYER_DATA} ${SITE}/players/)
endif()

add_custom_command(
    OUTPUT ${SITE}/players.stamp
    # Emptied first, or a round no longer offered (one still being played has
    # no villages recorded, see tools/fetch-games.py) would go on being served
    # from an earlier build.
    COMMAND ${CMAKE_COMMAND} -E rm -rf ${SITE}/players
    COMMAND ${CMAKE_COMMAND} -E make_directory ${SITE}/players
    ${COPY_PLAYERS}
    COMMAND ${CMAKE_COMMAND} -E touch ${SITE}/players.stamp
    DEPENDS ${PLAYER_DATA}
    COMMENT "Copying player villages"
    VERBATIM
)
list(APPEND SITE_OUTPUTS ${SITE}/players.stamp)

# The page itself, with comments removed and whitespace collapsed as the
# browser would render it anyway.
add_custom_command(
    OUTPUT ${SITE}/index.html
    COMMAND ${CMAKE_COMMAND} -E env python3
            ${CMAKE_CURRENT_SOURCE_DIR}/tools/minify-html.py
            ${CMAKE_CURRENT_SOURCE_DIR}/web/index.html ${SITE}/index.html
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/web/index.html
            ${CMAKE_CURRENT_SOURCE_DIR}/tools/minify-html.py
    COMMENT "Minifying index.html"
    VERBATIM
)
list(APPEND SITE_OUTPUTS ${SITE}/index.html)

foreach(file IN ITEMS style.css engine-worker.js)
    add_custom_command(
        OUTPUT ${SITE}/${file}
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${CMAKE_CURRENT_SOURCE_DIR}/web/${file} ${SITE}/${file}
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/web/${file}
        COMMENT "Copying ${file}"
        VERBATIM
    )
    list(APPEND SITE_OUTPUTS ${SITE}/${file})
endforeach()

if(EMXX)
    add_custom_command(
        OUTPUT ${SITE}/engine.js ${SITE}/engine.wasm
        COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/tools/build-wasm.sh ${SITE}
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/wasm.cpp ${ENGINE} ${ENGINE_HEADERS}
                ${CMAKE_CURRENT_SOURCE_DIR}/tools/build-wasm.sh ${GAMES_HPP}
        COMMENT "Building site/engine.wasm"
        VERBATIM
    )
    list(APPEND SITE_OUTPUTS ${SITE}/engine.js ${SITE}/engine.wasm)
else()
    message(FATAL_ERROR "em++ not on PATH: the page cannot compute anything without the wasm engine")
endif()

add_custom_target(Site ALL DEPENDS ${SITE_OUTPUTS})
add_dependencies(Server Site)

if (MSVC)
    set(WARNINGS /W4 /WX)
else()
    set(WARNINGS -Wall -Wextra -pedantic -Werror)
endif()

target_compile_options(Server PRIVATE ${WARNINGS})
target_compile_options(Harness PRIVATE ${WARNINGS})
target_compile_options(Schema PRIVATE ${WARNINGS})
