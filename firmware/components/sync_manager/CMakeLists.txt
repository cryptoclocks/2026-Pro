idf_component_register(
    SRCS "sync_manager.c" "miniz/miniz.c"
    INCLUDE_DIRS "include" "miniz"
    REQUIRES storage connectivity json
)

# miniz: stdio-based zip reading is exactly what we want; trim the rest
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    MINIZ_NO_ARCHIVE_WRITING_APIS
    MINIZ_NO_TIME
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-type-limits -Wno-format-truncation)
