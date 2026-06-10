#include "ccp_board.h"

#include "driver/ledc.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "board_bsp";

#define BL_LEDC_TIMER   LEDC_TIMER_1
#define BL_LEDC_CHANNEL LEDC_CHANNEL_1

static int s_brightness = 0;
static adc_oneshot_unit_handle_t s_adc;
static adc_channel_t s_bat_channel;

esp_err_t ccp_board_init(void)
{
    const ledc_timer_config_t bl_timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = BL_LEDC_TIMER,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_RETURN_ON_ERROR(ledc_timer_config(&bl_timer), TAG, "bl timer");

    const ledc_channel_config_t bl_channel = {
        .gpio_num = CCP_PIN_LCD_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = BL_LEDC_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = BL_LEDC_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_RETURN_ON_ERROR(ledc_channel_config(&bl_channel), TAG, "bl channel");

    adc_oneshot_unit_init_cfg_t adc_cfg = { .unit_id = ADC_UNIT_1 };
    adc_unit_t unit;
    if (adc_oneshot_io_to_channel(CCP_PIN_BAT_ADC, &unit, &s_bat_channel) == ESP_OK &&
        adc_oneshot_new_unit(&adc_cfg, &s_adc) == ESP_OK) {
        adc_oneshot_chan_cfg_t ch_cfg = {
            .bitwidth = ADC_BITWIDTH_12,
            .atten = ADC_ATTEN_DB_12,
        };
        adc_oneshot_config_channel(s_adc, s_bat_channel, &ch_cfg);
    } else {
        ESP_LOGW(TAG, "battery ADC unavailable on GPIO%d", CCP_PIN_BAT_ADC);
        s_adc = NULL;
    }

    ESP_LOGI(TAG, "board init OK (JC3248W535C)");
    return ESP_OK;
}

esp_err_t ccp_board_set_brightness(int percent)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s_brightness = percent;
    uint32_t duty = (1023 * percent) / 100;
    ESP_RETURN_ON_ERROR(ledc_set_duty(LEDC_LOW_SPEED_MODE, BL_LEDC_CHANNEL, duty), TAG, "duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, BL_LEDC_CHANNEL);
}

int ccp_board_get_brightness(void)
{
    return s_brightness;
}

int ccp_board_read_battery_mv(void)
{
    if (!s_adc) {
        return -1;
    }
    int raw = 0;
    if (adc_oneshot_read(s_adc, s_bat_channel, &raw) != ESP_OK) {
        return -1;
    }
    /* 12-bit @ 12dB atten ~= 0..3100mV at pin; board divides VBAT by 2 */
    return (raw * 3100 / 4095) * 2;
}
