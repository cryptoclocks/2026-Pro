idf_component_register(
    SRCS "home_ui.c"
    INCLUDE_DIRS "include"
    REQUIRES display_engine storage board_bsp net_manager device_security
             ota_manager audio_engine esp_http_client mbedtls json lvgl
    PRIV_INCLUDE_DIRS "../../main"
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
