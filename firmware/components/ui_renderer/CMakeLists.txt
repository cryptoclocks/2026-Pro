idf_component_register(
    SRCS "ui_renderer.c"
    INCLUDE_DIRS "include"
    REQUIRES display_engine storage json lvgl
)

# asset path / QR text composition uses bounded buffers
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
