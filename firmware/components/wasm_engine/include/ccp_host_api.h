/*
 * CryptoClock Pro — ccp_* host ABI implementation (WAMR natives).
 * Contract: schema/abi/ccp_abi_v1.md
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "wasm_export.h"
#include "wasm_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CCP_MAX_STREAMS 16

/* error codes shared with guests */
#define CCP_OK            0
#define CCP_ERR_INVAL    (-1)
#define CCP_ERR_NOT_FOUND (-2)
#define CCP_ERR_NO_MEM   (-3)
#define CCP_ERR_BUSY     (-4)
#define CCP_ERR_DENIED   (-5)
#define CCP_ERR_IO       (-6)

/** Register all ccp_* natives under import module "env". Call before loading. */
esp_err_t ccp_host_api_register(void);

/* engine-private helpers used by the natives (defined in wasm_engine.c) */
const wasm_engine_hooks_t *wasm_engine_get_hooks(void);
int wasm_engine_stream_handle(const char *stream, bool create);
int wasm_engine_subscribe_current(wasm_exec_env_t env, const char *stream);
int wasm_engine_unsubscribe_current(wasm_exec_env_t env, int handle);
int wasm_engine_request_tick_current(wasm_exec_env_t env, uint32_t interval_ms);

#ifdef __cplusplus
}
#endif
