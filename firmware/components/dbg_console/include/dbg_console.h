#pragma once
/* Serial debug console (USB-Serial-JTAG REPL) for inspecting the running
 * CryptoClock: list/switch pages, dump the rendered widget tree, browse the SD
 * card, check heap and the active package. Call once after the UI is up. */
void dbg_console_start(void);
