/*
 * hello — ABI smoke test.
 * Expects a layout with a label "price" and (optionally) data source
 * "market.BTCUSDT.ticker". Updates the label every tick and on data.
 */
#include "ccp_app.h"

static int32_t w_price = -1;
static uint32_t ticks = 0;

int32_t ccp_on_init(uint32_t abi_version)
{
    if (abi_version != CCP_ABI_VERSION) {
        return CCP_ERR_INVAL;
    }
    ccp_logs(CCP_LOG_INFO, "hello.wasm up");
    w_price = ccp_ui_get_widget(CCP_STR("price"));
    ccp_data_subscribe(CCP_STR("market.BTCUSDT.ticker"));
    ccp_request_tick(1000);
    return CCP_OK;
}

void ccp_on_tick(uint64_t now_ms)
{
    (void)now_ms;
    ticks++;
    if (w_price >= 0) {
        char msg[32];
        int n = 0;
        const char *prefix = "tick ";
        while (prefix[n]) {
            msg[n] = prefix[n];
            n++;
        }
        /* tiny utoa */
        uint32_t v = ticks;
        char tmp[10];
        int t = 0;
        do {
            tmp[t++] = '0' + (v % 10);
            v /= 10;
        } while (v);
        while (t) {
            msg[n++] = tmp[--t];
        }
        ccp_ui_set_text(w_price, msg, (uint32_t)n);
    }
}

void ccp_on_event(int32_t widget, uint32_t event, int32_t p0, int32_t p1)
{
    (void)widget; (void)p0; (void)p1;
    if (event == CCP_EVT_CLICKED) {
        ccp_audio_tone(880, 120, 60);
    }
}

void ccp_on_data(int32_t stream_handle, uint32_t payload_ptr, uint32_t len)
{
    (void)stream_handle;
    /* payload is JSON text in our linear memory */
    const char *json = (const char *)(uintptr_t)payload_ptr;
    if (w_price >= 0 && len > 0 && len < 200) {
        ccp_ui_set_text(w_price, json, len > 24 ? 24 : len);
    }
}

void ccp_on_destroy(void)
{
    ccp_logs(CCP_LOG_INFO, "hello.wasm bye");
}
