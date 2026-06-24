idf_component_register(
    SRCS "device_security.c" "cc_aes.c"
    INCLUDE_DIRS "include"
    REQUIRES storage nvs_flash esp_hw_support littlefs mbedtls
)
