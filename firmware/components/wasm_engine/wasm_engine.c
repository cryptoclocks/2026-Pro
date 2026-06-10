#include "wasm_engine.h"
#include "ccp_host_api.h"
#include "ui_renderer.h"
#include "storage.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_check.h"
#include "esp_log.h"

#include "wasm_export.h"

static const char *TAG = "wasm";

#define WASM_POOL_BYTES      (2 * 1024 * 1024)
#define WASM_TASK_STACK      (24 * 1024)
#define WASM_TASK_PRIO       5
#define WASM_TASK_CORE       1
#define WASM_EXEC_STACK      (32 * 1024)   /* guest exec stack inside WAMR */
#define MAX_STRIKES          3
#define SUPERVISOR_PERIOD_US (50 * 1000)

/* deadlines (ms) per ABI doc */
#define DEADLINE_INIT_MS     3000
#define DEADLINE_EVENT_MS    250
#define DEADLINE_TICK_MIN_MS 100

typedef enum { JOB_INIT, JOB_TICK, JOB_EVENT, JOB_DATA, JOB_RELOAD } job_type_t;

typedef struct {
    job_type_t type;
    int module_idx;
    int widget_idx;
    uint32_t event;
    int32_t p0, p1;
    int stream_handle;
    char *payload;       /* owned by the job (JOB_DATA) */
    uint32_t payload_len;
} wasm_job_t;

typedef struct {
    ui_wasm_desc_t desc;
    wasm_module_t module;
    wasm_module_inst_t inst;
    wasm_exec_env_t exec_env;
    uint8_t *file_buf;

    wasm_function_inst_t fn_init, fn_tick, fn_event, fn_data, fn_destroy;
    wasm_function_inst_t fn_malloc, fn_free;

    esp_timer_handle_t tick_timer;
    uint32_t tick_ms;
    uint8_t strikes;
    bool dead;
    bool loaded;

    /* supervisor state */
    volatile bool in_call;
    volatile int64_t call_enter_us;
    volatile uint32_t call_deadline_ms;
} wasm_mod_t;

static struct {
    wasm_engine_hooks_t hooks;
    uint8_t *pool;
    QueueHandle_t queue;
    TaskHandle_t task;
    esp_timer_handle_t supervisor;
    wasm_mod_t mods[UI_MAX_WASM];
    int mod_count;
    uint32_t crash_count;
    char streams[CCP_MAX_STREAMS][96];
    int stream_count;
    bool subscribed[UI_MAX_WASM][CCP_MAX_STREAMS];
} s_eng;

const wasm_engine_hooks_t *wasm_engine_get_hooks(void) { return &s_eng.hooks; }

/* ---------------------------------------------------------- stream reg */

int wasm_engine_stream_handle(const char *stream, bool create)
{
    for (int i = 0; i < s_eng.stream_count; i++) {
        if (!strcmp(s_eng.streams[i], stream)) {
            return i;
        }
    }
    if (!create || s_eng.stream_count >= CCP_MAX_STREAMS) {
        return -1;
    }
    strlcpy(s_eng.streams[s_eng.stream_count], stream, 96);
    return s_eng.stream_count++;
}

int wasm_engine_subscribe_current(wasm_exec_env_t env, const char *stream)
{
    wasm_mod_t *m = wasm_runtime_get_user_data(env);
    if (!m) {
        return -1;
    }
    int h = wasm_engine_stream_handle(stream, true);
    if (h < 0) {
        return -1;
    }
    int mi = (int)(m - s_eng.mods);
    if (!s_eng.subscribed[mi][h]) {
        s_eng.subscribed[mi][h] = true;
        if (s_eng.hooks.stream_subscribe) {
            s_eng.hooks.stream_subscribe(stream);
        }
    }
    return h;
}

int wasm_engine_unsubscribe_current(wasm_exec_env_t env, int handle)
{
    wasm_mod_t *m = wasm_runtime_get_user_data(env);
    if (!m || handle < 0 || handle >= s_eng.stream_count) {
        return -1;
    }
    s_eng.subscribed[m - s_eng.mods][handle] = false;
    return 0;
}

int wasm_engine_request_tick_current(wasm_exec_env_t env, uint32_t interval_ms)
{
    wasm_mod_t *m = wasm_runtime_get_user_data(env);
    if (!m) {
        return -1;
    }
    if (interval_ms > 0 && interval_ms < 16) {
        interval_ms = 16;
    }
    m->tick_ms = interval_ms;
    if (m->tick_timer) {
        esp_timer_stop(m->tick_timer);
        if (interval_ms > 0) {
            esp_timer_start_periodic(m->tick_timer, (uint64_t)interval_ms * 1000);
        }
    }
    return 0;
}

/* ------------------------------------------------------------- calling */

static void guarded_call(wasm_mod_t *m, wasm_function_inst_t fn,
                         uint32_t argc, uint32_t argv[], uint32_t deadline_ms)
{
    if (!fn || m->dead) {
        return;
    }
    m->call_enter_us = esp_timer_get_time();
    m->call_deadline_ms = deadline_ms;
    m->in_call = true;
    bool ok = wasm_runtime_call_wasm(m->exec_env, fn, argc, argv);
    m->in_call = false;

    if (!ok) {
        const char *ex = wasm_runtime_get_exception(m->inst);
        ESP_LOGE(TAG, "module %s trapped: %s", m->desc.id, ex ? ex : "?");
        wasm_runtime_clear_exception(m->inst);
        s_eng.crash_count++;
        m->strikes++;
        if (m->strikes >= MAX_STRIKES) {
            ESP_LOGE(TAG, "module %s exceeded %d strikes — disabled", m->desc.id, MAX_STRIKES);
            m->dead = true;
        } else {
            wasm_job_t job = { .type = JOB_RELOAD, .module_idx = (int)(m - s_eng.mods) };
            xQueueSend(s_eng.queue, &job, 0);
        }
    }
}

static void unload_module(wasm_mod_t *m)
{
    if (m->tick_timer) {
        esp_timer_stop(m->tick_timer);
        esp_timer_delete(m->tick_timer);
        m->tick_timer = NULL;
    }
    if (m->exec_env) {
        wasm_runtime_destroy_exec_env(m->exec_env);
        m->exec_env = NULL;
    }
    if (m->inst) {
        wasm_runtime_deinstantiate(m->inst);
        m->inst = NULL;
    }
    if (m->module) {
        wasm_runtime_unload(m->module);
        m->module = NULL;
    }
    free(m->file_buf);
    m->file_buf = NULL;
    m->loaded = false;
}

static void tick_timer_cb(void *arg)
{
    wasm_mod_t *m = arg;
    wasm_job_t job = { .type = JOB_TICK, .module_idx = (int)(m - s_eng.mods) };
    xQueueSend(s_eng.queue, &job, 0); /* drop ticks when busy */
}

static esp_err_t instantiate_module(wasm_mod_t *m)
{
    char err_buf[128];

    size_t len = 0;
    if (!storage_sd_lock(2000)) {
        return ESP_ERR_TIMEOUT;
    }
    m->file_buf = (uint8_t *)storage_read_file(m->desc.path, &len);
    storage_sd_unlock();
    ESP_RETURN_ON_FALSE(m->file_buf, ESP_ERR_NOT_FOUND, TAG, "read %s", m->desc.path);

    m->module = wasm_runtime_load(m->file_buf, (uint32_t)len, err_buf, sizeof(err_buf));
    if (!m->module) {
        ESP_LOGE(TAG, "load %s: %s", m->desc.id, err_buf);
        free(m->file_buf);
        m->file_buf = NULL;
        return ESP_FAIL;
    }
    m->inst = wasm_runtime_instantiate(m->module, WASM_EXEC_STACK,
                                       m->desc.memory_kb * 1024, err_buf, sizeof(err_buf));
    if (!m->inst) {
        ESP_LOGE(TAG, "instantiate %s: %s", m->desc.id, err_buf);
        unload_module(m);
        return ESP_FAIL;
    }
    m->exec_env = wasm_runtime_create_exec_env(m->inst, WASM_EXEC_STACK);
    if (!m->exec_env) {
        unload_module(m);
        return ESP_ERR_NO_MEM;
    }
    wasm_runtime_set_user_data(m->exec_env, m);

    m->fn_init    = wasm_runtime_lookup_function(m->inst, "ccp_on_init");
    m->fn_tick    = wasm_runtime_lookup_function(m->inst, "ccp_on_tick");
    m->fn_event   = wasm_runtime_lookup_function(m->inst, "ccp_on_event");
    m->fn_data    = wasm_runtime_lookup_function(m->inst, "ccp_on_data");
    m->fn_destroy = wasm_runtime_lookup_function(m->inst, "ccp_on_destroy");
    m->fn_malloc  = wasm_runtime_lookup_function(m->inst, "ccp_malloc");
    m->fn_free    = wasm_runtime_lookup_function(m->inst, "ccp_free");

    if (!m->fn_init) {
        ESP_LOGE(TAG, "%s exports no ccp_on_init", m->desc.id);
        unload_module(m);
        return ESP_ERR_INVALID_ARG;
    }
    m->loaded = true;
    return ESP_OK;
}

/* ------------------------------------------------------------ executor */

static void run_job(const wasm_job_t *job)
{
    if (job->module_idx < 0 || job->module_idx >= s_eng.mod_count) {
        return;
    }
    wasm_mod_t *m = &s_eng.mods[job->module_idx];
    if (m->dead) {
        return;
    }

    switch (job->type) {
    case JOB_INIT: {
        if (instantiate_module(m) != ESP_OK) {
            m->dead = true;
            return;
        }
        uint32_t argv[1] = { CCP_ABI_VERSION };
        guarded_call(m, m->fn_init, 1, argv, DEADLINE_INIT_MS);
        if (!m->dead && m->desc.tick_ms > 0) {
            const esp_timer_create_args_t targs = {
                .callback = tick_timer_cb, .arg = m, .name = "wasm_tick",
            };
            if (esp_timer_create(&targs, &m->tick_timer) == ESP_OK) {
                m->tick_ms = m->desc.tick_ms < 16 ? 16 : m->desc.tick_ms;
                esp_timer_start_periodic(m->tick_timer, (uint64_t)m->tick_ms * 1000);
            }
        }
        break;
    }
    case JOB_TICK: {
        uint64_t now = (uint64_t)(esp_timer_get_time() / 1000);
        uint32_t argv[2] = { (uint32_t)(now & 0xFFFFFFFF), (uint32_t)(now >> 32) };
        uint32_t deadline = m->tick_ms * 3;
        if (deadline < DEADLINE_TICK_MIN_MS) {
            deadline = DEADLINE_TICK_MIN_MS;
        }
        guarded_call(m, m->fn_tick, 2, argv, deadline);
        break;
    }
    case JOB_EVENT: {
        uint32_t argv[4] = { (uint32_t)job->widget_idx, job->event,
                             (uint32_t)job->p0, (uint32_t)job->p1 };
        guarded_call(m, m->fn_event, 4, argv, DEADLINE_EVENT_MS);
        break;
    }
    case JOB_DATA: {
        if (!m->fn_data || !m->fn_malloc || !job->payload) {
            break;
        }
        /* place payload into guest memory via its exported allocator */
        uint32_t argv[1] = { job->payload_len };
        guarded_call(m, m->fn_malloc, 1, argv, DEADLINE_EVENT_MS);
        uint32_t guest_ptr = argv[0];
        if (m->dead || guest_ptr == 0) {
            break;
        }
        void *native = wasm_runtime_addr_app_to_native(m->inst, guest_ptr);
        if (!native ||
            !wasm_runtime_validate_app_addr(m->inst, guest_ptr, job->payload_len)) {
            break;
        }
        memcpy(native, job->payload, job->payload_len);
        uint32_t argv2[3] = { (uint32_t)job->stream_handle, guest_ptr, job->payload_len };
        guarded_call(m, m->fn_data, 3, argv2, DEADLINE_EVENT_MS);
        if (m->fn_free && !m->dead) {
            uint32_t argv3[1] = { guest_ptr };
            guarded_call(m, m->fn_free, 1, argv3, DEADLINE_EVENT_MS);
        }
        break;
    }
    case JOB_RELOAD: {
        ESP_LOGW(TAG, "reloading module %s (strike %d)", m->desc.id, m->strikes);
        unload_module(m);
        wasm_job_t init = { .type = JOB_INIT, .module_idx = job->module_idx };
        xQueueSend(s_eng.queue, &init, 0);
        break;
    }
    }
}

static void wasm_task(void *arg)
{
    wasm_job_t job;
    while (true) {
        if (xQueueReceive(s_eng.queue, &job, portMAX_DELAY) == pdTRUE) {
            run_job(&job);
            free(job.payload);
        }
    }
}

/* deadline watchdog: terminate the active call when it overruns */
static void supervisor_cb(void *arg)
{
    for (int i = 0; i < s_eng.mod_count; i++) {
        wasm_mod_t *m = &s_eng.mods[i];
        if (m->loaded && m->in_call) {
            int64_t elapsed_ms = (esp_timer_get_time() - m->call_enter_us) / 1000;
            if (elapsed_ms > (int64_t)m->call_deadline_ms) {
                ESP_LOGE(TAG, "module %s overran deadline (%lld ms) — terminating",
                         m->desc.id, elapsed_ms);
                wasm_runtime_terminate(m->inst);
            }
        }
    }
}

/* -------------------------------------------------------------- public */

esp_err_t wasm_engine_init(const wasm_engine_hooks_t *hooks)
{
    if (hooks) {
        s_eng.hooks = *hooks;
    }
    s_eng.pool = heap_caps_malloc(WASM_POOL_BYTES, MALLOC_CAP_SPIRAM);
    ESP_RETURN_ON_FALSE(s_eng.pool, ESP_ERR_NO_MEM, TAG, "pool alloc");

    RuntimeInitArgs args;
    memset(&args, 0, sizeof(args));
    args.mem_alloc_type = Alloc_With_Pool;
    args.mem_alloc_option.pool.heap_buf = s_eng.pool;
    args.mem_alloc_option.pool.heap_size = WASM_POOL_BYTES;
    ESP_RETURN_ON_FALSE(wasm_runtime_full_init(&args), ESP_FAIL, TAG, "wamr init");

    ESP_RETURN_ON_ERROR(ccp_host_api_register(), TAG, "host api");

    s_eng.queue = xQueueCreate(16, sizeof(wasm_job_t));
    ESP_RETURN_ON_FALSE(s_eng.queue, ESP_ERR_NO_MEM, TAG, "queue");

    BaseType_t ok = xTaskCreatePinnedToCore(wasm_task, "wasm_exec", WASM_TASK_STACK,
                                            NULL, WASM_TASK_PRIO, &s_eng.task, WASM_TASK_CORE);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "task");

    const esp_timer_create_args_t sup_args = {
        .callback = supervisor_cb, .name = "wasm_sup",
    };
    ESP_RETURN_ON_ERROR(esp_timer_create(&sup_args, &s_eng.supervisor), TAG, "supervisor");
    ESP_RETURN_ON_ERROR(esp_timer_start_periodic(s_eng.supervisor, SUPERVISOR_PERIOD_US),
                        TAG, "supervisor start");

    ESP_LOGI(TAG, "WAMR up, %d KB pool in PSRAM", WASM_POOL_BYTES / 1024);
    return ESP_OK;
}

esp_err_t wasm_engine_load_modules(void)
{
    wasm_engine_unload_all();

    const ui_wasm_desc_t *descs = NULL;
    int n = ui_renderer_get_wasm_modules(&descs);
    for (int i = 0; i < n && i < UI_MAX_WASM; i++) {
        wasm_mod_t *m = &s_eng.mods[s_eng.mod_count];
        memset(m, 0, sizeof(*m));
        m->desc = descs[i];
        s_eng.mod_count++;
        wasm_job_t job = { .type = JOB_INIT, .module_idx = i };
        xQueueSend(s_eng.queue, &job, portMAX_DELAY);
    }
    return ESP_OK;
}

void wasm_engine_unload_all(void)
{
    /* drain queue then teardown inline (no jobs are running for old mods
     * because we stop their tick timers first) */
    for (int i = 0; i < s_eng.mod_count; i++) {
        wasm_mod_t *m = &s_eng.mods[i];
        if (m->tick_timer) {
            esp_timer_stop(m->tick_timer);
        }
        m->dead = true;
    }
    wasm_job_t job;
    while (xQueueReceive(s_eng.queue, &job, 0) == pdTRUE) {
        free(job.payload);
    }
    for (int i = 0; i < s_eng.mod_count; i++) {
        unload_module(&s_eng.mods[i]);
    }
    memset(s_eng.subscribed, 0, sizeof(s_eng.subscribed));
    s_eng.mod_count = 0;
    s_eng.stream_count = 0;
}

void wasm_engine_send_event(const char *module_id, int widget_idx,
                            uint32_t event, int32_t p0, int32_t p1)
{
    for (int i = 0; i < s_eng.mod_count; i++) {
        if (!strcmp(s_eng.mods[i].desc.id, module_id)) {
            wasm_job_t job = {
                .type = JOB_EVENT, .module_idx = i, .widget_idx = widget_idx,
                .event = event, .p0 = p0, .p1 = p1,
            };
            xQueueSend(s_eng.queue, &job, 0);
            return;
        }
    }
}

void wasm_engine_on_data(const char *stream, const char *payload, size_t len)
{
    int h = wasm_engine_stream_handle(stream, false);
    if (h < 0) {
        return;
    }
    for (int i = 0; i < s_eng.mod_count; i++) {
        if (!s_eng.subscribed[i][h] || s_eng.mods[i].dead) {
            continue;
        }
        char *copy = malloc(len);
        if (!copy) {
            return;
        }
        memcpy(copy, payload, len);
        wasm_job_t job = {
            .type = JOB_DATA, .module_idx = i, .stream_handle = h,
            .payload = copy, .payload_len = (uint32_t)len,
        };
        if (xQueueSend(s_eng.queue, &job, 0) != pdTRUE) {
            free(copy); /* backpressure: drop data frames, never block MQTT */
        }
    }
}

uint32_t wasm_engine_crash_count(void) { return s_eng.crash_count; }

int wasm_engine_loaded_count(void)
{
    int n = 0;
    for (int i = 0; i < s_eng.mod_count; i++) {
        if (s_eng.mods[i].loaded && !s_eng.mods[i].dead) {
            n++;
        }
    }
    return n;
}
