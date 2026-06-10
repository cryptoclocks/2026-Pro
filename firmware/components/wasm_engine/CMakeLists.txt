idf_component_register(
    SRCS "wasm_engine.c" "ccp_host_api.c"
    INCLUDE_DIRS "include"
    REQUIRES wamr ui_renderer display_engine storage esp_timer lvgl
)
