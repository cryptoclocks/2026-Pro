# Serial Debug Console

A REPL over the CryptoClock's USB-Serial-JTAG port for inspecting the running
device — list/switch pages, dump the rendered widget tree, browse the SD card,
check heap and the active package. Lives in `firmware/components/dbg_console`,
started at the end of `app_main` once the UI is up.

## Connect

Any serial terminal at 115200 on the device's USB port, e.g.:

    idf.py -p /dev/cu.usbmodem21301 monitor      # interactive
    # or drive it from a script (write "<cmd>\r\n", read the reply)

Type `help` for the command list. The prompt is `ccp>`.

## Commands

| command            | what it shows / does                                             |
|--------------------|------------------------------------------------------------------|
| `ver`              | firmware version, active package `id@version`, SD mount + free   |
| `pages`            | pages in the swipe rotation + which one is current (`*`)         |
| `goto <id>`        | switch to a page (`clock` / `crypto` / `slideshow` / a pkg id)   |
| `widgets`          | dump the loaded package's widgets: id, type, x/y/w/h, and for    |
|                    | labels the text + font line-height (so you can confirm fonts)    |
| `ls [dir]`         | list an SD directory (default `/sd`)                             |
| `cat <file>`       | print the first 4KB of an SD file (e.g. a layout.json)           |
| `heap`             | internal + PSRAM free / largest-block (spot fragmentation)       |

## Why it's useful

Reading device state directly beats blind reflash cycles. Examples from real
debugging:
- `widgets` showed `time … lh=58 "06:31"` — proof the custom montserrat_80 clock
  font actually resolved on-device (vs. the admin-web sim).
- `heap` showed internal `largest=2304 B` — explained why bundle extraction was
  crashing (no room for miniz's inflate buffer) → fixed with a bigger sync stack
  + PSRAM allocator.
- `ls /sd/packages/com.ccp.weather` revealed which versions are actually on the
  SD card vs. what the server thinks is active.

## Adding a command

Register in `dbg_console.c` with `reg("name", "help", fn, argtable)`. Read live
state through the existing accessors: `home_ui_debug_pages` / `home_ui_goto_id`
(home_ui.h), `ui_renderer_debug_widgets` (ui_renderer.h), `sync_manager_active_*`,
`storage_*`, or POSIX `opendir`/`fopen` for the SD card.
