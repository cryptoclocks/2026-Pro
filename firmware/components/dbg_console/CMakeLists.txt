idf_component_register(
    SRCS "dbg_console.c"
    INCLUDE_DIRS "include"
    REQUIRES console esp_driver_usb_serial_jtag home_ui ui_renderer
             sync_manager storage esp_app_format vfs
             board_bsp display_engine audio_engine esp_system
)
