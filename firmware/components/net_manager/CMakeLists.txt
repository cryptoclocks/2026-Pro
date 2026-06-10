idf_component_register(
    SRCS "net_manager.c"
    INCLUDE_DIRS "include"
    REQUIRES storage esp_wifi esp_netif esp_event esp_http_server lwip
)
