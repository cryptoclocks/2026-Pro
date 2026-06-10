/*
 * CryptoClock Pro — board definition for JC3248W535C (ESP32-S3-WROOM-1 N16R8)
 * Pin map confirmed against vendor demo (JC3248W535EN/1-Demo/Demo_Arduino).
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- display: AXS15231B over QSPI ---------- */
#define CCP_LCD_QSPI_HOST       SPI2_HOST
#define CCP_PIN_LCD_CS          45
#define CCP_PIN_LCD_PCLK        47
#define CCP_PIN_LCD_D0          21
#define CCP_PIN_LCD_D1          48
#define CCP_PIN_LCD_D2          40
#define CCP_PIN_LCD_D3          39
#define CCP_PIN_LCD_TE          38
#define CCP_PIN_LCD_RST         (-1)   /* not wired */
#define CCP_PIN_LCD_BL          1      /* LEDC PWM, active high */

#define CCP_LCD_H_RES           320    /* panel-native portrait */
#define CCP_LCD_V_RES           480
#define CCP_LCD_PIXEL_BYTES     2      /* RGB565 */

/* Logical UI rotation: 0, 90, 180, 270 (90 = landscape 480x320, vendor default) */
#ifndef CCP_DISPLAY_ROTATION
#define CCP_DISPLAY_ROTATION    90
#endif

/* ---------- touch: AXS15231B built-in, I2C ---------- */
#define CCP_TOUCH_I2C_NUM       0
#define CCP_PIN_TOUCH_SCL       8
#define CCP_PIN_TOUCH_SDA       4
#define CCP_PIN_TOUCH_INT       3
#define CCP_PIN_TOUCH_RST       (-1)
#define CCP_TOUCH_I2C_HZ        400000

/* ---------- SD card: SDMMC 1-bit ---------- */
#define CCP_PIN_SD_CLK          12
#define CCP_PIN_SD_CMD          11
#define CCP_PIN_SD_D0           13

/* ---------- audio: NS4168 I2S amplifier ---------- */
#define CCP_PIN_I2S_BCLK        42
#define CCP_PIN_I2S_LRCK        2
#define CCP_PIN_I2S_DOUT        41

/* ---------- battery ---------- */
#define CCP_PIN_BAT_ADC         5

/**
 * Init backlight PWM (off) and battery ADC.
 */
esp_err_t ccp_board_init(void);

/** 0..100, persisted setting is the caller's job */
esp_err_t ccp_board_set_brightness(int percent);
int ccp_board_get_brightness(void);

/** Battery voltage in mV (raw divider-corrected estimate) */
int ccp_board_read_battery_mv(void);

#ifdef __cplusplus
}
#endif
