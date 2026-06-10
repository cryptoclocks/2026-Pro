idf_component_register(
    SRCS "local_api.c"
    INCLUDE_DIRS "include"
    REQUIRES storage board_bsp device_security net_manager ota_manager
             home_ui audio_engine esp_http_server json
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
