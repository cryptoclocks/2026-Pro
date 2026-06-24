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
| 1 | crypto_poll stack overflow | Bug #1 | 🔄 PENDING | — |
| 4 | brightness range validation | Bug #4 | 🔄 PENDING | — |
| 2 | LVGL task watchdog hang | Bug #2 | 🔄 PENDING | — |
| 3 | POST /config schema validation | Bug #3 | 🔄 PENDING | — |
| 5 | slideshow transient lock timeout | Bug #5 | 🔄 PENDING | — |
| 6 | FAT atomic write race | Bug #6 | 🔄 PENDING | — |
| 7 | Bonus: serial debug commands | Bonus | 🔄 PENDING | — |

**หมายเหตุ**: Section 1 (crypto) ทำก่อนเพราะเป็น P0 + กระทบแค่ 1 ไฟล์
Section 4 (brightness) ทำก่อน Section 2 เพราะเร็วมาก (1 บรรทัด) — quick win

---

## Checkpoint log

### Checkpoint 0: baseline (HEAD = 271a6d5)
- Firmware: `271a6d5-dirty`
- All known bugs present (verified from QA report)

(จะอัพเดทหลังแต่ละ section เสร็จ)
