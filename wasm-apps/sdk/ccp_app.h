/*
 * CryptoClock Pro — guest-side lifecycle exports + bump allocator.
 * Include once from your app's main C file.
 */
#pragma once

#include "ccp_abi.h"

/* Lifecycle the host calls — implement these in your app: */
CCP_EXPORT(ccp_on_init)    int32_t ccp_on_init(uint32_t abi_version);
CCP_EXPORT(ccp_on_tick)    void    ccp_on_tick(uint64_t now_ms);
CCP_EXPORT(ccp_on_event)   void    ccp_on_event(int32_t widget, uint32_t event,
                                                int32_t p0, int32_t p1);
CCP_EXPORT(ccp_on_data)    void    ccp_on_data(int32_t stream_handle,
                                               uint32_t payload_ptr, uint32_t len);
CCP_EXPORT(ccp_on_destroy) void    ccp_on_destroy(void);

/*
 * Minimal bump allocator backing ccp_malloc/ccp_free (the host uses these to
 * place on_data payloads). Freed only when ptr is the most recent block —
 * fine for the host's alloc/copy/call/free pattern. Apps with real heap
 * needs can link walloc or implement their own.
 */
#ifndef CCP_ARENA_BYTES
#define CCP_ARENA_BYTES (16 * 1024)
#endif

static unsigned char ccp__arena[CCP_ARENA_BYTES];
static uint32_t ccp__arena_top = 0;
static uint32_t ccp__arena_last = 0;

CCP_EXPORT(ccp_malloc)
uint32_t ccp_malloc(uint32_t size)
{
    size = (size + 7u) & ~7u;
    if (ccp__arena_top + size > CCP_ARENA_BYTES) {
        return 0;
    }
    ccp__arena_last = ccp__arena_top;
    ccp__arena_top += size;
    return (uint32_t)(uintptr_t)&ccp__arena[ccp__arena_last];
}

CCP_EXPORT(ccp_free)
void ccp_free(uint32_t ptr)
{
    if (ptr == (uint32_t)(uintptr_t)&ccp__arena[ccp__arena_last]) {
        ccp__arena_top = ccp__arena_last; /* LIFO free */
    }
}
