idf_component_register(
    SRCS "audio_engine.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp storage esp_driver_i2s
)
