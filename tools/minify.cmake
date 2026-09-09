set(minified FALSE)

get_filename_component(where "${OUT}" DIRECTORY)
file(MAKE_DIRECTORY "${where}")

if(TERSER)
    execute_process(
        COMMAND "${TERSER}" "${IN}" --compress --mangle --output "${OUT}"
        RESULT_VARIABLE status
        ERROR_VARIABLE stderr
    )
    if(status EQUAL 0)
        set(minified TRUE)
    else()
        string(STRIP "${stderr}" stderr)
        message(STATUS "${NAME}: terser failed, copying unminified: ${stderr}")
    endif()
else()
    message(STATUS "${NAME}: no terser on PATH, copying unminified")
endif()

if(minified)
    file(SIZE "${IN}" before)
    file(SIZE "${OUT}" after)
    math(EXPR saved "100 - (100 * ${after} / ${before})")
    message(STATUS "${NAME}: ${before} -> ${after} bytes, ${saved}% smaller")
else()
    configure_file("${IN}" "${OUT}" COPYONLY)
    file(TOUCH "${OUT}")
endif()
