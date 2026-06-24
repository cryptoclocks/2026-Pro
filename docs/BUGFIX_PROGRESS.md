# Bug Fix Progress Log (2026-06-24)

> Live log ของการแก้บั๊กตามแผน `docs/BUGFIX_PLAN_2026-06-24.md`
> ทำทีละ section, verify บนเครื่องจริง, commit + push หลังผ่าน
> ถ้าแก้แล้วไม่เวิร์ค → revert กลับมาที่ commit checkpoint ก่อนหน้า แล้วค่อยลองวิธีใหม่

---

## Setup (2026-06-24 ~13:00 ICT)

### Environment verified
- ✅ Device `/dev/cu.usbmodem1301` @115200 — firmware `fw=271a6d5-dirty` (ตรงกับ main HEAD `271a6d5`)
- ✅ LAN API `http://192.168.1.46` reachable
- ✅ idf.py ที่ `/Users/natthapongsuwanjit/esp/esp-idf/tools/idf.py`
- ✅ Python env ที่ `~/.espressif/python_env/idf5.5_py3.9_env`
- ✅ esptool.py available

### Git state
- ✅ WIP uncommitted changes → snapshot ที่ branch `wip-snapshot-pre-bugfix` (commit `ad37877`)
- ✅ Clean main (`271a6d5`) → new branch `bugfix/2026-06-24-p0-fixes`
- ✅ Docs (`QA_REPORT_2026-06-24.md`, `BUGFIX_PLAN_2026-06-24.md`, etc.) checked out from wip branch

### Baseline commit (จุดปลอดภัยแรก)
- **Commit**: `271a6d5` (main HEAD)
- **ถ้าทุกอย่างพัง**: `git reset --hard 271a6d5 && git checkout main`

### Branch
- `bugfix/2026-06-24-p0-fixes` — local branch for fixes
- WIP snapshot: `wip-snapshot-pre-bugfix` (commit `ad37877`)

---

## Sections — เรียงตามลำดับที่จะทำ

| # | Section | Bug | Status | Commit |
|---|---|---|---|---|
| 1 | crypto_poll stack overflow | Bug #1 | ✅ **DONE** | `c088f48` |
| 4 | brightness range validation | Bug #4 | ✅ **DONE** | `7879caf` |
| 2 | LVGL task watchdog hang | Bug #2 | ✅ **DONE** | `5e219f0` |
| 3 | POST /config schema validation | Bug #3 | ✅ **DONE** | `ecf01b9` |
| 5 | slideshow transient lock timeout | Bug #5 | ✅ **DONE** | `9e7837c` |
| 6 | FAT atomic write race | Bug #6 | 🔄 PENDING | — |
| 7 | Bonus: serial debug commands | Bonus | 🔄 PENDING | — |

**หมายเหตุ**: Section 1 (crypto) ทำก่อนเพราะเป็น P0 + กระทบแค่ 1 ไฟล์
Section 4 (brightness) ทำก่อน Section 2 เพราะเร็วมาก (1 บรรทัด) — quick win

---

## Checkpoint log

### Checkpoint 0: baseline (HEAD = 271a6d5)
- Firmware: `271a6d5-dirty`
- All known bugs present (verified from QA report)

### Checkpoint 1: after wip-snapshot merge (HEAD = 180f318)
- เรียนรู้: main branch build ไม่ได้ (cc_aes.h missing) — ต้อง merge wip-snapshot ก่อน
- หลัง merge: `cc_aes.h`, `cc_aes.c`, panel_frame changes, fonts, etc. ครบ
- Build: SUCCESS (1979/1979 steps)
- ถ้าทุกอย่างพังหลังจากนี้: `git reset --hard 180f318`

---

## Section 1 — crypto_poll stack overflow ✅ DONE (2026-06-24 ~13:30)

### ปัญหาที่เจอ
1. **Pre-existing build breakage**: `main/app_main.c:33` includes `cc_aes.h` แต่ main branch ไม่มีไฟล์นี้
   - Fix: merge `wip-snapshot-pre-bugfix` (commit `ad37877`) ที่มี cc_aes.h + cc_aes.c + CMakeLists.txt update
2. **idf.py ไม่ทำงาน**: export.sh hardcodes `idf5.5_py3.14_env` แต่ installed คือ `idf5.5_py3.9_env`
   - Fix: เขียน wrapper script `/tmp/ccp_idf.sh` ใช้ venv python ตรง ๆ + toolchain PATH manual
3. **Managed component hash mismatch**: lvgl__lvgl hash mismatch (อัตโนมัติ fix ด้วย `fullclean`)

### แก้
- `firmware/components/home_ui/home_ui.c`:
  - Line 46: `CRYPTO_POLL_STACK 4096 → 8192`
  - เพิ่ม `ccp_cjson_malloc/free` PSRAM hooks (lines 49-53)
  - ใน `crypto_poll_task`: เพิ่ม `cJSON_InitHooks` call (line 945-948)

### Verify บนเครื่องจริง
- ✅ Flash สำเร็จ (2.8 MB binary, 19.4s)
- ✅ Boot OK — firmware เปลี่ยนเป็น `fw=180f318-dirty`
- ✅ `ver`, `pages`, `heap` ตอบปกติ — 5 pages loaded
- ✅ **goto crypto 5 ครั้งติด ไม่ crash** (ก่อนแก้ crash 100%)
- ✅ แต่ละ iteration: klines fetched (60 candles), quote parsed, page rendered
- ✅ LAN API /info ยังตอบปกติ
- Side observations (ไม่ใช่ blocker):
  - "LCD transfer timeout" errors — display DMA ตอน render candle chart หนัก
  - "internal heap fragmented" — heap แตกหลัง 5 crypto cycles

### Commit + Push
- Commit: `c088f48 fix(crypto): double crypto_poll stack + PSRAM cJSON hooks (Bug #1)`
- Push: ✅ สำเร็จ → `origin/bugfix/2026-06-24-p0-fixes`
- GitHub แนะนำให้เปิด PR: https://github.com/cryptoclocks/2026-Pro/pull/new/bugfix/2026-06-24-p0-fixes

### ถ้าต้อง revert
```bash
git reset --hard 180f318  # กลับไป wip-snapshot merged state
# หรือ
git revert c088f48        # revert commit นี้
```

---

## Section 4 — brightness range validation ✅ DONE (2026-06-24 ~13:45)

### แก้
- `firmware/components/local_api/local_api.c:158-161`: เพิ่ม range check หลัง type check
  - `if (v->valueint < 0 || v->valueint > 100) return 400 "value must be 0-100"`

### Verify บนเครื่องจริง
- ✅ Build + flash สำเร็จ
- ✅ `{"value":999}` → 400 "value must be 0-100"
- ✅ `{"value":-5}` → 400 "value must be 0-100"
- ✅ `{"value":"abc"}` → 400 "need {\"value\":0-100}" (type error message preserved)
- ✅ `{"value":50}` → 200, /info shows brightness:50

### Commit + Push
- Commit: `7879caf fix(local_api): reject out-of-range brightness values (Bug #4)`
- Push: ✅ สำเร็จ

---

## Section 2 — LVGL task watchdog hang ✅ DONE (2026-06-24 ~14:10)

### แก้
- `firmware/components/display_engine/display_engine.c`:
  - `#include "esp_task_wdt.h"` (line 19)
  - `lvgl_task`: subscribe to task watchdog (line 263)
  - `lvgl_task`: reset watchdog ทุก loop iteration (line 280)
  - `lvgl_task`: heartbeat log ทุก 5s (lvgl tick count, fps, heap_free)
- `firmware/components/home_ui/home_ui.c`:
  - `#include "esp_task_wdt.h"` (line 27)
  - `crypto_poll_task`: subscribe + reset + delete ก่อน vTaskDelete
  - 9 จุดที่เรียก `display_engine_lock(0)` ใน non-render callers → 200ms
- `firmware/components/ui_renderer/ui_renderer.c`:
  - 3 จุด → 200ms
- **คงไว้**: `display_engine.c:273` `display_engine_lock(0)` ใน lvgl_task (render loop ต้อง hold lock)

### Verify บนเครื่องจริง
- ✅ Build + flash สำเร็จ
- ✅ Heartbeat log ปรากฏทุก 5s: "lvgl heartbeat: 322 ticks in 5s, fps=1.0, heap_free=34679"
- ✅ 35s drain + 10x goto stress + 10s follow-up → **0 task_wdt events** (ไม่มี false positive)
- ✅ ภายใต้ stress (LCD transfer timeouts ตลอด) — lvgl tick count ลด 18/5s แต่ไม่ crash
- ✅ LAN API ยังตอบหลัง stress

### Side observation (ไม่ใช่ blocker)
- "LCD transfer timeout" storm ตอน crypto page — เป็น SPI/QSPI starvation แยกต่างหาก
- ตอนนี้ watchdog ระบุได้ชัดเจนว่าใครค้าง (lvgl เอง vs IDLE)

### Commit + Push
- Commit: `5e219f0 fix(lvgl): subscribe to task watchdog + bounded lock timeout (Bug #2)`
- Push: ✅ สำเร็จ
- **หมายเหตุ**: fw version บนเครื่องแสดง `7879caf-dirty` (build ตอน HEAD=7879caf, dirty) — bug จริงคือ code ใหม่ (มี heartbeat) — non-issue สำหรับ build หน้า

---

## Section 3 — POST /config schema validation ✅ DONE (2026-06-24 ~14:25)

### แก้
- `firmware/components/local_api/local_api.c`:
  - เพิ่ม `validate_config_json()` (lines 107-166) — require pages[], brightness 0-100, page_delay_s≥3, profile obj, owner obj, display_mode
  - rewrite `h_config_post()` (lines 168-250):
    - Layer 1: validate ก่อนเขียน (return 400 ถ้าไม่ครบ)
    - Layer 2: backup current → device.json.bak ก่อนเขียน
    - ถ้า home_ui_reload fail → restore backup + retry reload + return 500
    - cleanup .bak on success

### Verify บนเครื่องจริง — ผ่าน 8/8
- ✅ `{foo:"bar"}` → 400 missing or empty 'pages' array
- ✅ `{pages:[]}` → 400
- ✅ brightness:150 → 400 'brightness' must be 0-100
- ✅ missing profile → 400 missing 'profile' object
- ✅ valid full config (brightness=60) → 200 ok:true
- ✅ /info after reject storm → 200 brightness:60
- ✅ serial pages → 5 pages listed
- ✅ restore brightness:80 → 200 + brightness:80

### Build issue encountered + fixed
- Variable name conflict (`err` ใช้ 2 ที่) → renamed เป็น `werr` — build succeeded

### Commit + Push
- Commit: `ecf01b9 fix(local_api): validate config schema + backup/rollback (Bug #3)`
- Push: ✅ สำเร็จ

---

## Section 5 — slideshow transient lock timeout ✅ DONE (2026-06-24)

**Approach**: Option B — เพิ่ม UI_LOCK_MS 50 → 200 (ไม่ใช่ targeted fix)
**File**: `firmware/components/wasm_engine/ccp_host_api.c:17`
**Commit**: `9e7837c`

### Root cause ที่ audit เจอ
- สาเหตุที่แท้จริง: LVGL task ถือ lock นาน (slideshow PNG decode 100-200ms + 240ms screen-load anim)
- ระหว่างนั้น wasm tick handler (esp_timer periodic) ยิงเข้ามาเรียก ccp_host_api เช่น `n_ui_set_text`
- 50ms lock wait หมดเวลาก่อนที่ LVGL จะปล่อย lock → log `display lock timeout (50 ms), holder=lvgl`
- home_ui.c ใช้ 200/500ms หมดแล้ว (จาก Section 2 fix) — ตัวที่เหลือ 50ms มีแค่ ccp_host_api.c (10 call sites)

### Audit: ทำไม 200ms ปลอดภัย
- 10 ccp_host_api callers ทั้งหมดเป็น native LVGL ops (text/value/color/visible/page + canvas blit/fill/line/text/flush)
- ไม่มีตัวไหนอยู่ใน tight loop — ถูกเรียกจาก WAMR `guarded_call` ที่มี deadline (16-300ms)
- Lock เป็น recursive — nested calls จาก LVGL task เองไม่ติด dead-lock
- 200ms = "don't block long" สำหรับ ABI ยังคง valid (human-perceptible UI 5 FPS worst-case ต่อ 1 tick)

### Verify (real device, /dev/cu.usbmodem1301)
- 5x `goto slideshow`: **0** "display lock timeout" messages (เดิม 1+ ครั้ง)
- slideshow scan สำเร็จ: "slideshow: 4 images"
- HTTP `/api/v1/info`: 200 OK + valid JSON
- pages(5) ยังครบทั้ง 5 หน้า
- LVGL heartbeat FPS: 4-6 (ปกติ)
