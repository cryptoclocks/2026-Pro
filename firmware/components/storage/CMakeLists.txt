idf_component_register(
    SRCS "storage.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp nvs_flash fatfs sdmmc esp_driver_sdmmc littlefs
)
