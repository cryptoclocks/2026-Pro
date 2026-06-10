idf_component_register(
    SRCS "display_engine.c" "esp_lcd_axs15231b.c"
    INCLUDE_DIRS "include" "."
    REQUIRES board_bsp esp_lcd driver esp_timer lvgl
)
