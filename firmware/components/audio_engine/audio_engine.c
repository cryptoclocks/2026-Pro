#include "audio_engine.h"
#include "ccp_board.h"
#include "storage.h"

#include <stdio.h>
#include <string.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "audio";

#define AUDIO_TASK_STACK (8 * 1024)
#define AUDIO_TASK_PRIO  18
#define AUDIO_TASK_CORE  0
#define CHUNK_FRAMES     512

typedef enum { CMD_PLAY_FILE, CMD_TONE, CMD_STOP } audio_cmd_type_t;

typedef struct {
    audio_cmd_type_t type;
    char path[160];
    bool loop;
    uint32_t freq, dur_ms, vol;
} audio_cmd_t;

static QueueHandle_t s_cmds;
static i2s_chan_handle_t s_tx;
static volatile bool s_playing;
static volatile bool s_abort;
static int s_volume = 80;

/* ----------------------------------------------------------- wav parse */

typedef struct {
    uint32_t sample_rate;
    uint16_t channels;
    uint16_t bits;
    uint32_t data_offset;
    uint32_t data_len;
} wav_info_t;

static bool wav_parse(FILE *f, wav_info_t *out)
{
    uint8_t hdr[12];
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "RIFF", 4) || memcmp(hdr + 8, "WAVE", 4)) {
        return false;
    }
    uint8_t chunk[8];
    while (fread(chunk, 1, 8, f) == 8) {
        uint32_t size = chunk[4] | (chunk[5] << 8) | (chunk[6] << 16) | ((uint32_t)chunk[7] << 24);
        if (!memcmp(chunk, "fmt ", 4)) {
            uint8_t fmt[16];
            if (size < 16 || fread(fmt, 1, 16, f) != 16) {
                return false;
            }
            out->channels = fmt[2] | (fmt[3] << 8);
            out->sample_rate = fmt[4] | (fmt[5] << 8) | (fmt[6] << 16) | ((uint32_t)fmt[7] << 24);
            out->bits = fmt[14] | (fmt[15] << 8);
            if (size > 16) {
                fseek(f, size - 16, SEEK_CUR);
            }
        } else if (!memcmp(chunk, "data", 4)) {
            out->data_offset = (uint32_t)ftell(f);
            out->data_len = size;
            return out->bits == 16 && out->channels >= 1 && out->channels <= 2;
        } else {
            fseek(f, size, SEEK_CUR);
        }
    }
    return false;
}

/* -------------------------------------------------------------- output */

static esp_err_t i2s_reconfig(uint32_t sample_rate)
{
    i2s_channel_disable(s_tx);
    i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG(sample_rate);
    ESP_RETURN_ON_ERROR(i2s_channel_reconfig_std_clock(s_tx, &clk), TAG, "clk");
    return i2s_channel_enable(s_tx);
}

static void play_wav(const char *path, bool loop)
{
    FILE *f = NULL;
    int16_t *buf = malloc(CHUNK_FRAMES * 2 * sizeof(int16_t));
    if (!buf) {
        return;
    }

    do {
        if (!storage_sd_lock(2000)) {
            break;
        }
        f = fopen(path, "rb");
        storage_sd_unlock();
        if (!f) {
            ESP_LOGW(TAG, "open failed: %s", path);
            break;
        }
        wav_info_t wav = {0};
        if (!wav_parse(f, &wav)) {
            ESP_LOGW(TAG, "unsupported wav: %s", path);
            break;
        }
        i2s_reconfig(wav.sample_rate);
        s_playing = true;

        do {
            fseek(f, wav.data_offset, SEEK_SET);
            uint32_t remaining = wav.data_len;
            while (remaining > 0 && !s_abort) {
                size_t want = CHUNK_FRAMES * wav.channels * 2;
                if (want > remaining) {
                    want = remaining;
                }
                storage_sd_lock(0);
                size_t rd = fread(buf, 1, want, f);
                storage_sd_unlock();
                if (rd == 0) {
                    break;
                }
                remaining -= rd;

                size_t samples = rd / 2;
                /* volume + mono->stereo expansion happens in-place per chunk */
                int16_t *out = buf;
                size_t out_samples = samples;
                for (size_t i = 0; i < samples; i++) {
                    buf[i] = (int16_t)((int32_t)buf[i] * s_volume / 100);
                }
                if (wav.channels == 1) {
                    /* duplicate from the back so we can expand in place */
                    out_samples = samples * 2;
                    if (out_samples * 2 > CHUNK_FRAMES * 2 * sizeof(int16_t)) {
                        out_samples = samples; /* shouldn't happen with CHUNK sizing */
                    } else {
                        for (int i = (int)samples - 1; i >= 0; i--) {
                            buf[i * 2] = buf[i];
                            buf[i * 2 + 1] = buf[i];
                        }
                    }
                }
                size_t written = 0;
                i2s_channel_write(s_tx, out, out_samples * 2, &written, portMAX_DELAY);
            }
        } while (loop && !s_abort);
    } while (false);

    if (f) {
        fclose(f);
    }
    free(buf);
    s_playing = false;
}

static void play_tone(uint32_t freq, uint32_t dur_ms, uint32_t vol)
{
    if (freq < 20 || freq > 20000) {
        return;
    }
    const uint32_t rate = 22050;
    i2s_reconfig(rate);
    s_playing = true;

    int16_t buf[256 * 2];
    const int16_t amp = (int16_t)(8000 * (vol > 100 ? 100 : vol) / 100);
    uint32_t total = rate * dur_ms / 1000;
    uint32_t phase = 0, half = rate / (2 * freq);
    if (half == 0) {
        half = 1;
    }
    while (total > 0 && !s_abort) {
        uint32_t n = total > 256 ? 256 : total;
        for (uint32_t i = 0; i < n; i++) {
            int16_t s = ((phase / half) & 1) ? amp : -amp;
            buf[i * 2] = s;
            buf[i * 2 + 1] = s;
            phase++;
        }
        size_t written = 0;
        i2s_channel_write(s_tx, buf, n * 4, &written, portMAX_DELAY);
        total -= n;
    }
    s_playing = false;
}

static void audio_task(void *arg)
{
    audio_cmd_t cmd;
    while (true) {
        if (xQueueReceive(s_cmds, &cmd, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        s_abort = false;
        switch (cmd.type) {
        case CMD_PLAY_FILE: play_wav(cmd.path, cmd.loop); break;
        case CMD_TONE:      play_tone(cmd.freq, cmd.dur_ms, cmd.vol); break;
        case CMD_STOP:      break;
        }
    }
}

/* -------------------------------------------------------------- public */

esp_err_t audio_engine_init(void)
{
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan_cfg, &s_tx, NULL), TAG, "chan");

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(22050),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = CCP_PIN_I2S_BCLK,
            .ws = CCP_PIN_I2S_LRCK,
            .dout = CCP_PIN_I2S_DOUT,
            .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_tx, &std_cfg), TAG, "std");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(s_tx), TAG, "enable");

    s_cmds = xQueueCreate(4, sizeof(audio_cmd_t));
    ESP_RETURN_ON_FALSE(s_cmds, ESP_ERR_NO_MEM, TAG, "queue");

    BaseType_t ok = xTaskCreatePinnedToCore(audio_task, "audio", AUDIO_TASK_STACK,
                                            NULL, AUDIO_TASK_PRIO, NULL, AUDIO_TASK_CORE);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "task");
    ESP_LOGI(TAG, "audio up (NS4168, i2s_std)");
    return ESP_OK;
}

int audio_engine_play_file(const char *abs_path, bool loop)
{
    audio_cmd_t cmd = { .type = CMD_PLAY_FILE, .loop = loop };
    strlcpy(cmd.path, abs_path, sizeof(cmd.path));
    s_abort = true; /* preempt current playback */
    return xQueueSend(s_cmds, &cmd, 0) == pdTRUE ? 0 : -1;
}

int audio_engine_tone(uint32_t freq_hz, uint32_t dur_ms, uint32_t vol)
{
    audio_cmd_t cmd = { .type = CMD_TONE, .freq = freq_hz, .dur_ms = dur_ms, .vol = vol };
    return xQueueSend(s_cmds, &cmd, 0) == pdTRUE ? 0 : -1;
}

int audio_engine_stop(void)
{
    s_abort = true;
    return 0;
}

void audio_engine_set_volume(int vol)
{
    if (vol < 0) vol = 0;
    if (vol > 100) vol = 100;
    s_volume = vol;
}

bool audio_engine_playing(void) { return s_playing; }
