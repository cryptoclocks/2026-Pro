idf_component_register(
    SRCS "connectivity.c"
    INCLUDE_DIRS "include"
    REQUIRES mqtt esp_http_client mbedtls esp_event
)

# topic/path composition uses bounded buffers; GCC's worst-case math disagrees
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
