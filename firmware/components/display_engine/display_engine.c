#include "display_engine.h"
#include "ccp_board.h"
#include "esp_lcd_axs15231b.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_touch.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_task_wdt.h"

static const char *TAG = "display";

#define LVGL_TASK_STACK   (12 * 1024)
#define LVGL_TASK_PRIO    10
#define LVGL_TASK_CORE    1
#define LVGL_TICK_MS      5

/* One bounce chunk = N panel rows = 320*N*2 bytes of DMA-capable RAM (x2).
 * Internal DIRAM is the scarcest resource (it was exhausting under the full page
 * set), so use small 12-row chunks (~7.5 KB x2) — more SPI transactions, but it
 * frees ~15 KB of internal RAM for LVGL to render pages. */
#define TRANS_ROWS        12
#define TRANS_PIXELS      (CCP_LCD_H_RES * TRANS_ROWS)

#if CCP_DISPLAY_ROTATION == 90 || CCP_DISPLAY_ROTATION == 270
#define LOGICAL_W CCP_LCD_V_RES
#define LOGICAL_H CCP_LCD_H_RES
#else
#define LOGICAL_W CCP_LCD_H_RES
#define LOGICAL_H CCP_LCD_V_RES
#endif

/*
 * Board-specific init sequence from the vendor BSP (esp_bsp.c) — differs from
 * the driver's generic default table; keep byte-identical.
 */
static const axs15231b_lcd_init_cmd_t s_lcd_init_cmds[] = {
    {0xBB, (uint8_t []){0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5A, 0xA5}, 8, 0},
    {0xA0, (uint8_t []){0xC0, 0x10, 0x00, 0x02, 0x00, 0x00, 0x04, 0x3F, 0x20, 0x05, 0x3F, 0x3F, 0x00, 0x00, 0x00, 0x00, 0x00}, 17, 0},
    {0xA2, (uint8_t []){0x30, 0x3C, 0x24, 0x14, 0xD0, 0x20, 0xFF, 0xE0, 0x40, 0x19, 0x80, 0x80, 0x80, 0x20, 0xf9, 0x10, 0x02, 0xff, 0xff, 0xF0, 0x90, 0x01, 0x32, 0xA0, 0x91, 0xE0, 0x20, 0x7F, 0xFF, 0x00, 0x5A}, 31, 0},
    {0xD0, (uint8_t []){0xE0, 0x40, 0x51, 0x24, 0x08, 0x05, 0x10, 0x01, 0x20, 0x15, 0x42, 0xC2, 0x22, 0x22, 0xAA, 0x03, 0x10, 0x12, 0x60, 0x14, 0x1E, 0x51, 0x15, 0x00, 0x8A, 0x20, 0x00, 0x03, 0x3A, 0x12}, 30, 0},
    {0xA3, (uint8_t []){0xA0, 0x06, 0xAa, 0x00, 0x08, 0x02, 0x0A, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x55, 0x55}, 22, 0},
    {0xC1, (uint8_t []){0x31, 0x04, 0x02, 0x02, 0x71, 0x05, 0x24, 0x55, 0x02, 0x00, 0x41, 0x00, 0x53, 0xFF, 0xFF, 0xFF, 0x4F, 0x52, 0x00, 0x4F, 0x52, 0x00, 0x45, 0x3B, 0x0B, 0x02, 0x0d, 0x00, 0xFF, 0x40}, 30, 0},
    {0xC3, (uint8_t []){0x00, 0x00, 0x00, 0x50, 0x03, 0x00, 0x00, 0x00, 0x01, 0x80, 0x01}, 11, 0},
    {0xC4, (uint8_t []){0x00, 0x24, 0x33, 0x80, 0x00, 0xea, 0x64, 0x32, 0xC8, 0x64, 0xC8, 0x32, 0x90, 0x90, 0x11, 0x06, 0xDC, 0xFA, 0x00, 0x00, 0x80, 0xFE, 0x10, 0x10, 0x00, 0x0A, 0x0A, 0x44, 0x50}, 29, 0},
    {0xC5, (uint8_t []){0x18, 0x00, 0x00, 0x03, 0xFE, 0x3A, 0x4A, 0x20, 0x30, 0x10, 0x88, 0xDE, 0x0D, 0x08, 0x0F, 0x0F, 0x01, 0x3A, 0x4A, 0x20, 0x10, 0x10, 0x00}, 23, 0},
    {0xC6, (uint8_t []){0x05, 0x0A, 0x05, 0x0A, 0x00, 0xE0, 0x2E, 0x0B, 0x12, 0x22, 0x12, 0x22, 0x01, 0x03, 0x00, 0x3F, 0x6A, 0x18, 0xC8, 0x22}, 20, 0},
    {0xC7, (uint8_t []){0x50, 0x32, 0x28, 0x00, 0xa2, 0x80, 0x8f, 0x00, 0x80, 0xff, 0x07, 0x11, 0x9c, 0x67, 0xff, 0x24, 0x0c, 0x0d, 0x0e, 0x0f}, 20, 0},
    {0xC9, (uint8_t []){0x33, 0x44, 0x44, 0x01}, 4, 0},
    {0xCF, (uint8_t []){0x2C, 0x1E, 0x88, 0x58, 0x13, 0x18, 0x56, 0x18, 0x1E, 0x68, 0x88, 0x00, 0x65, 0x09, 0x22, 0xC4, 0x0C, 0x77, 0x22, 0x44, 0xAA, 0x55, 0x08, 0x08, 0x12, 0xA0, 0x08}, 27, 0},
    {0xD5, (uint8_t []){0x40, 0x8E, 0x8D, 0x01, 0x35, 0x04, 0x92, 0x74, 0x04, 0x92, 0x74, 0x04, 0x08, 0x6A, 0x04, 0x46, 0x03, 0x03, 0x03, 0x03, 0x82, 0x01, 0x03, 0x00, 0xE0, 0x51, 0xA1, 0x00, 0x00, 0x00}, 30, 0},
    {0xD6, (uint8_t []){0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC, 0xFE, 0x93, 0x00, 0x01, 0x83, 0x07, 0x07, 0x00, 0x07, 0x07, 0x00, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x00, 0x84, 0x00, 0x20, 0x01, 0x00}, 30, 0},
    {0xD7, (uint8_t []){0x03, 0x01, 0x0b, 0x09, 0x0f, 0x0d, 0x1E, 0x1F, 0x18, 0x1d, 0x1f, 0x19, 0x40, 0x8E, 0x04, 0x00, 0x20, 0xA0, 0x1F}, 19, 0},
    {0xD8, (uint8_t []){0x02, 0x00, 0x0a, 0x08, 0x0e, 0x0c, 0x1E, 0x1F, 0x18, 0x1d, 0x1f, 0x19}, 12, 0},
    {0xD9, (uint8_t []){0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F}, 12, 0},
    {0xDD, (uint8_t []){0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F}, 12, 0},
    {0xDF, (uint8_t []){0x44, 0x73, 0x4B, 0x69, 0x00, 0x0A, 0x02, 0x90}, 8,  0},
    {0xE0, (uint8_t []){0x3B, 0x28, 0x10, 0x16, 0x0c, 0x06, 0x11, 0x28, 0x5c, 0x21, 0x0D, 0x35, 0x13, 0x2C, 0x33, 0x28, 0x0D}, 17, 0},
    {0xE1, (uint8_t []){0x37, 0x28, 0x10, 0x16, 0x0b, 0x06, 0x11, 0x28, 0x5C, 0x21, 0x0D, 0x35, 0x14, 0x2C, 0x33, 0x28, 0x0F}, 17, 0},
    {0xE2, (uint8_t []){0x3B, 0x07, 0x12, 0x18, 0x0E, 0x0D, 0x17, 0x35, 0x44, 0x32, 0x0C, 0x14, 0x14, 0x36, 0x3A, 0x2F, 0x0D}, 17, 0},
    {0xE3, (uint8_t []){0x37, 0x07, 0x12, 0x18, 0x0E, 0x0D, 0x17, 0x35, 0x44, 0x32, 0x0C, 0x14, 0x14, 0x36, 0x32, 0x2F, 0x0F}, 17, 0},
    {0xE4, (uint8_t []){0x3B, 0x07, 0x12, 0x18, 0x0E, 0x0D, 0x17, 0x39, 0x44, 0x2E, 0x0C, 0x14, 0x14, 0x36, 0x3A, 0x2F, 0x0D}, 17, 0},
    {0xE5, (uint8_t []){0x37, 0x07, 0x12, 0x18, 0x0E, 0x0D, 0x17, 0x39, 0x44, 0x2E, 0x0C, 0x14, 0x14, 0x36, 0x3A, 0x2F, 0x0F}, 17, 0},
    {0xA4, (uint8_t []){0x85, 0x85, 0x95, 0x82, 0xAF, 0xAA, 0xAA, 0x80, 0x10, 0x30, 0x40, 0x40, 0x20, 0xFF, 0x60, 0x30}, 16, 0},
    {0xA4, (uint8_t []){0x85, 0x85, 0x95, 0x85}, 4, 0},
    {0xBB, (uint8_t []){0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 8, 0},
    {0x13, (uint8_t []){0x00}, 0, 0},
    {0x11, (uint8_t []){0x00}, 0, 120},
    {0x2C, (uint8_t []){0x00, 0x00, 0x00, 0x00}, 4, 0},
};

typedef struct {
    esp_lcd_panel_handle_t panel;
    esp_lcd_panel_io_handle_t io;
    esp_lcd_touch_handle_t touch;
    i2c_master_bus_handle_t i2c_bus;

    lv_display_t *disp;
    lv_indev_t *indev;
    uint16_t *frame;                 /* full logical frame, PSRAM */
    uint16_t *panel_frame;           /* rotated panel-native frame, PSRAM */
    SemaphoreHandle_t trans_done;    /* 1 credit = bus idle */
    SemaphoreHandle_t te_sem;        /* given by TE ISR */
    SemaphoreHandle_t lvgl_mutex;    /* recursive */
    SemaphoreHandle_t touch_irq;

    esp_timer_handle_t tick_timer;
    volatile uint32_t flush_count;
    uint32_t fps_window_start_ms;
    uint32_t fps_window_frames;
    float fps;
} display_ctx_t;

static display_ctx_t s_ctx;

/* ---------------------------------------------------------------- helpers */

static void IRAM_ATTR te_isr(void *arg)
{
    BaseType_t hp = pdFALSE;
    xSemaphoreGiveFromISR(s_ctx.te_sem, &hp);
    if (hp) {
        portYIELD_FROM_ISR();
    }
}

static bool on_color_trans_done(esp_lcd_panel_io_handle_t io,
                                esp_lcd_panel_io_event_data_t *edata, void *user_ctx)
{
    BaseType_t hp = pdFALSE;
    xSemaphoreGiveFromISR(s_ctx.trans_done, &hp);
    return hp == pdTRUE;
}

/*
 * Copy one band of panel rows [py0, py0+rows) from the logical frame into a
 * bounce buffer, applying rotation + RGB565 byte swap in the same pass.
 * Panel is 320 wide x 480 tall, portrait-native.
 */
static void fill_band(uint16_t *dst, const uint16_t *frame, int py0, int rows)
{
    for (int r = 0; r < rows; r++) {
        const int py = py0 + r;
        uint16_t *out = dst + (size_t)r * CCP_LCD_H_RES;
#if CCP_DISPLAY_ROTATION == 0
        const uint16_t *src = frame + (size_t)py * LOGICAL_W;
        for (int px = 0; px < CCP_LCD_H_RES; px++) {
            out[px] = __builtin_bswap16(src[px]);
        }
#elif CCP_DISPLAY_ROTATION == 180
        const uint16_t *src = frame + (size_t)(LOGICAL_H - 1 - py) * LOGICAL_W;
        for (int px = 0; px < CCP_LCD_H_RES; px++) {
            out[px] = __builtin_bswap16(src[LOGICAL_W - 1 - px]);
        }
#elif CCP_DISPLAY_ROTATION == 90
        /* logical (lx,ly) -> panel (LOGICAL_H-1-ly, lx)  =>  lx=py, ly=LOGICAL_H-1-px */
        const int lx = py;
        for (int px = 0; px < CCP_LCD_H_RES; px++) {
            out[px] = __builtin_bswap16(frame[(size_t)(LOGICAL_H - 1 - px) * LOGICAL_W + lx]);
        }
#else /* 270: logical (lx,ly) -> panel (ly, LOGICAL_W-1-lx) => lx=LOGICAL_W-1-py, ly=px */
        const int lx = LOGICAL_W - 1 - py;
        for (int px = 0; px < CCP_LCD_H_RES; px++) {
            out[px] = __builtin_bswap16(frame[(size_t)px * LOGICAL_W + lx]);
        }
#endif
    }
}

/*
 * Full-frame flush. AXS15231B in QSPI mode takes CASET only: the first band
 * (y=0) goes out with RAMWR, subsequent bands with RAMWRC continuation —
 * which is why we always stream the whole frame top to bottom.
 */
static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    (void)area;
    const uint16_t *frame = (const uint16_t *)px_map;

    /* Tear sync: drop a stale pulse, then gate on the next one (60Hz => <17ms). */
    xSemaphoreTake(s_ctx.te_sem, 0);
    xSemaphoreTake(s_ctx.te_sem, pdMS_TO_TICKS(20));

    if (xSemaphoreTake(s_ctx.trans_done, pdMS_TO_TICKS(250)) != pdTRUE) {
        ESP_LOGE(TAG, "LCD transfer timeout");
        lv_display_flush_ready(disp);
        return;
    }

    /* Build one panel-native frame in PSRAM, then submit it as one color
     * transaction chain. Re-opening the SPI bus for every band can deadlock
     * between the async color transfer and the next polling CASET command. */
    for (int py0 = 0; py0 < CCP_LCD_V_RES; py0 += TRANS_ROWS) {
        const int rows = (py0 + TRANS_ROWS <= CCP_LCD_V_RES) ? TRANS_ROWS : (CCP_LCD_V_RES - py0);
        uint16_t *dst = s_ctx.panel_frame + (size_t)py0 * CCP_LCD_H_RES;
        fill_band(dst, frame, py0, rows);
    }

    esp_err_t err = esp_lcd_panel_draw_bitmap(
        s_ctx.panel, 0, 0, CCP_LCD_H_RES, CCP_LCD_V_RES, s_ctx.panel_frame);
    if (err != ESP_OK) {
        /* No completion callback follows a rejected transfer, so restore
         * the bus credit before returning to LVGL. */
        xSemaphoreGive(s_ctx.trans_done);
        ESP_LOGE(TAG, "LCD transfer failed: %s", esp_err_to_name(err));
        lv_display_flush_ready(disp);
        return;
    }

    s_ctx.flush_count++;
    lv_display_flush_ready(disp);
}

/* ------------------------------------------------------------------ touch */

static void touch_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    uint16_t x[1], y[1];
    uint8_t cnt = 0;

    /* Poll only when INT fired (or on first run) to keep the I2C bus quiet. */
    if (xSemaphoreTake(s_ctx.touch_irq, 0) != pdTRUE) {
        data->state = LV_INDEV_STATE_RELEASED;
        return;
    }

    esp_lcd_touch_read_data(s_ctx.touch);
    if (esp_lcd_touch_get_coordinates(s_ctx.touch, x, y, NULL, &cnt, 1) && cnt > 0) {
        int px = x[0], py = y[0];
        int lx, ly;
#if CCP_DISPLAY_ROTATION == 0
        lx = px; ly = py;
#elif CCP_DISPLAY_ROTATION == 180
        lx = CCP_LCD_H_RES - 1 - px; ly = CCP_LCD_V_RES - 1 - py;
#elif CCP_DISPLAY_ROTATION == 90
        lx = py; ly = LOGICAL_H - 1 - px;
#else
        lx = LOGICAL_W - 1 - py; ly = px;
#endif
        data->point.x = lx;
        data->point.y = ly;
        data->state = LV_INDEV_STATE_PRESSED;
        /* keep polling while finger may still be down */
        xSemaphoreGive(s_ctx.touch_irq);
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

static void touch_isr_cb(esp_lcd_touch_handle_t tp)
{
    BaseType_t hp = pdFALSE;
    xSemaphoreGiveFromISR(s_ctx.touch_irq, &hp);
    if (hp) {
        portYIELD_FROM_ISR();
    }
}

/* ------------------------------------------------------------------- task */

static void lvgl_tick_cb(void *arg)
{
    lv_tick_inc(LVGL_TICK_MS);
}

static void lvgl_task(void *arg)
{
    ESP_LOGI(TAG, "LVGL task running on core %d", xPortGetCoreID());
    /* Subscribe this task to the task watchdog. Was previously missing, so when
     * lvgl itself hung the watchdog blamed IDLE1. After subscribing we must
     * call esp_task_wdt_reset() periodically or the watchdog will fire and
     * correctly identify THIS task as the hung one. */
    esp_err_t wdt_err = esp_task_wdt_add(NULL);
    if (wdt_err != ESP_OK) {
        ESP_LOGW(TAG, "lvgl: esp_task_wdt_add failed: %s", esp_err_to_name(wdt_err));
    }

    uint32_t last_hb_ms = 0;
    uint32_t hb_count = 0;

    while (true) {
        uint32_t delay_ms = 5;
        if (display_engine_lock(0)) {
            delay_ms = lv_timer_handler();
            display_engine_unlock();
        }
        /* Feed watchdog every iteration. If lv_timer_handler hangs above,
         * the watchdog will fire after 10s and identify THIS task (lvgl) as
         * the culprit — not IDLE1. */
        esp_task_wdt_reset();

        /* FPS bookkeeping (1s window) */
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        if (now - s_ctx.fps_window_start_ms >= 1000) {
            uint32_t frames = s_ctx.flush_count - s_ctx.fps_window_frames;
            s_ctx.fps = (float)frames * 1000.0f / (float)(now - s_ctx.fps_window_start_ms);
            s_ctx.fps_window_start_ms = now;
            s_ctx.fps_window_frames = s_ctx.flush_count;
        }

        /* Heartbeat log every 5s — debug aid: confirms lvgl is alive
         * and shows live tick rate / fps / free heap. */
        hb_count++;
        if (now - last_hb_ms > 5000) {
            ESP_LOGI(TAG, "lvgl heartbeat: %u ticks in 5s, fps=%.1f, heap_free=%u",
                     (unsigned)hb_count, s_ctx.fps,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
            hb_count = 0;
            last_hb_ms = now;
        }

        if (delay_ms > 500) delay_ms = 500;
        if (delay_ms < 1) delay_ms = 1;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}

/* ------------------------------------------------------------------- init */

static esp_err_t init_panel(void)
{
    const spi_bus_config_t buscfg = AXS15231B_PANEL_BUS_QSPI_CONFIG(
        CCP_PIN_LCD_PCLK, CCP_PIN_LCD_D0, CCP_PIN_LCD_D1, CCP_PIN_LCD_D2, CCP_PIN_LCD_D3,
        TRANS_PIXELS * CCP_LCD_PIXEL_BYTES);
    ESP_RETURN_ON_ERROR(spi_bus_initialize(CCP_LCD_QSPI_HOST, &buscfg, SPI_DMA_CH_AUTO), TAG, "spi bus");

    esp_lcd_panel_io_spi_config_t io_config =
        AXS15231B_PANEL_IO_QSPI_CONFIG(CCP_PIN_LCD_CS, NULL, NULL);
    io_config.trans_queue_depth = 2;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)CCP_LCD_QSPI_HOST,
                                                 &io_config, &s_ctx.io), TAG, "panel io");

    const esp_lcd_panel_io_callbacks_t cbs = { .on_color_trans_done = on_color_trans_done };
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_register_event_callbacks(s_ctx.io, &cbs, NULL), TAG, "io cbs");

    const axs15231b_vendor_config_t vendor_config = {
        .init_cmds = s_lcd_init_cmds,
        .init_cmds_size = sizeof(s_lcd_init_cmds) / sizeof(s_lcd_init_cmds[0]),
        .flags = { .use_qspi_interface = 1 },
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = CCP_PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = (void *)&vendor_config,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_axs15231b(s_ctx.io, &panel_config, &s_ctx.panel), TAG, "panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_ctx.panel), TAG, "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_ctx.panel), TAG, "init");

    /* TE pin -> v-sync semaphore */
    const gpio_config_t te_cfg = {
        .intr_type = GPIO_INTR_NEGEDGE,
        .mode = GPIO_MODE_INPUT,
        .pin_bit_mask = BIT64(CCP_PIN_LCD_TE),
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&te_cfg), TAG, "te gpio");
    gpio_install_isr_service(0);
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(CCP_PIN_LCD_TE, te_isr, NULL), TAG, "te isr");

    return ESP_OK;
}

static esp_err_t init_touch(void)
{
    const i2c_master_bus_config_t bus_cfg = {
        .i2c_port = CCP_TOUCH_I2C_NUM,
        .sda_io_num = CCP_PIN_TOUCH_SDA,
        .scl_io_num = CCP_PIN_TOUCH_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_ctx.i2c_bus), TAG, "i2c bus");

    esp_lcd_panel_io_i2c_config_t tp_io_cfg = ESP_LCD_TOUCH_IO_I2C_AXS15231B_CONFIG();
    tp_io_cfg.scl_speed_hz = CCP_TOUCH_I2C_HZ;
    esp_lcd_panel_io_handle_t tp_io = NULL;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(s_ctx.i2c_bus, &tp_io_cfg, &tp_io), TAG, "tp io");

    const esp_lcd_touch_config_t tp_cfg = {
        .x_max = CCP_LCD_H_RES,
        .y_max = CCP_LCD_V_RES,
        .rst_gpio_num = CCP_PIN_TOUCH_RST,
        .int_gpio_num = CCP_PIN_TOUCH_INT,
        .levels = { .reset = 0, .interrupt = 0 },
        .interrupt_callback = touch_isr_cb,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_touch_new_i2c_axs15231b(tp_io, &tp_cfg, &s_ctx.touch), TAG, "touch");
    return ESP_OK;
}

esp_err_t display_engine_start(void)
{
    s_ctx.lvgl_mutex = xSemaphoreCreateRecursiveMutex();
    s_ctx.trans_done = xSemaphoreCreateCounting(1, 1); /* bus starts idle */
    s_ctx.te_sem = xSemaphoreCreateBinary();
    s_ctx.touch_irq = xSemaphoreCreateBinary();
    ESP_RETURN_ON_FALSE(s_ctx.lvgl_mutex && s_ctx.trans_done && s_ctx.te_sem && s_ctx.touch_irq,
                        ESP_ERR_NO_MEM, TAG, "sem alloc");

    ESP_RETURN_ON_ERROR(init_panel(), TAG, "panel init");
    if (init_touch() != ESP_OK) {
        ESP_LOGW(TAG, "touch init failed — continuing without input");
        s_ctx.touch = NULL;
    }

    /* Logical and panel-native frames live in PSRAM. The SPI driver uses its
     * small queue as the DMA bounce, keeping internal allocation bounded. */
    s_ctx.frame = heap_caps_malloc((size_t)LOGICAL_W * LOGICAL_H * CCP_LCD_PIXEL_BYTES,
                                   MALLOC_CAP_SPIRAM);
    s_ctx.panel_frame = heap_caps_malloc(
        (size_t)CCP_LCD_H_RES * CCP_LCD_V_RES * CCP_LCD_PIXEL_BYTES,
        MALLOC_CAP_SPIRAM);
    ESP_RETURN_ON_FALSE(s_ctx.frame && s_ctx.panel_frame,
                        ESP_ERR_NO_MEM, TAG, "framebuffer alloc");

    lv_init();
    s_ctx.disp = lv_display_create(LOGICAL_W, LOGICAL_H);
    ESP_RETURN_ON_FALSE(s_ctx.disp, ESP_FAIL, TAG, "lv_display_create");
    lv_display_set_color_format(s_ctx.disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(s_ctx.disp, s_ctx.frame, NULL,
                           (uint32_t)LOGICAL_W * LOGICAL_H * CCP_LCD_PIXEL_BYTES,
                           LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(s_ctx.disp, flush_cb);

    if (s_ctx.touch) {
        s_ctx.indev = lv_indev_create();
        lv_indev_set_type(s_ctx.indev, LV_INDEV_TYPE_POINTER);
        lv_indev_set_read_cb(s_ctx.indev, touch_read_cb);
        lv_indev_set_display(s_ctx.indev, s_ctx.disp);
    }

    const esp_timer_create_args_t tick_args = {
        .callback = lvgl_tick_cb,
        .name = "lv_tick",
    };
    ESP_RETURN_ON_ERROR(esp_timer_create(&tick_args, &s_ctx.tick_timer), TAG, "tick");
    ESP_RETURN_ON_ERROR(esp_timer_start_periodic(s_ctx.tick_timer, LVGL_TICK_MS * 1000), TAG, "tick start");

    BaseType_t ok = xTaskCreatePinnedToCore(lvgl_task, "lvgl", LVGL_TASK_STACK, NULL,
                                            LVGL_TASK_PRIO, NULL, LVGL_TASK_CORE);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "lvgl task");

    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_ctx.panel, true), TAG, "disp on");
    ESP_LOGI(TAG, "display up: %dx%d (rotation %d)", LOGICAL_W, LOGICAL_H, CCP_DISPLAY_ROTATION);
    return ESP_OK;
}

bool display_engine_lock(uint32_t timeout_ms)
{
    const TickType_t ticks = (timeout_ms == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    if (xSemaphoreTakeRecursive(s_ctx.lvgl_mutex, ticks) == pdTRUE) {
        return true;
    }
    TaskHandle_t holder = xSemaphoreGetMutexHolder(s_ctx.lvgl_mutex);
    ESP_LOGE(TAG, "display lock timeout (%lu ms), holder=%s",
             (unsigned long)timeout_ms, holder ? pcTaskGetName(holder) : "none");
    return false;
}

void display_engine_unlock(void)
{
    xSemaphoreGiveRecursive(s_ctx.lvgl_mutex);
}

lv_display_t *display_engine_get_disp(void) { return s_ctx.disp; }
int display_engine_width(void)  { return LOGICAL_W; }
int display_engine_height(void) { return LOGICAL_H; }
float display_engine_get_fps(void) { return s_ctx.fps; }
