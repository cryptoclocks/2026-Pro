idf_component_register(
    SRCS "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES board_bsp display_engine storage net_manager connectivity
             sync_manager ui_renderer wasm_engine audio_engine ota_manager
             device_security sys_monitor json
)
