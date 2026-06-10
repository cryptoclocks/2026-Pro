idf_component_register(
    SRCS "sys_monitor.c"
    INCLUDE_DIRS "include"
    REQUIRES display_engine storage board_bsp wasm_engine esp_timer
)
