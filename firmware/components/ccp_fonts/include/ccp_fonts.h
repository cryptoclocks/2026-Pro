#pragma once
#include "lvgl.h"

/* Large clock font (Montserrat Medium 80px, glyphs 0-9 and ':') for pages that
 * need a time bigger than the built-in montserrat_48 — generated with
 * lv_font_conv from the LVGL built-in Montserrat-Medium.ttf. Digits + colon only
 * to keep flash small (~35KB). Used via ui_renderer style font "montserrat_80". */
LV_FONT_DECLARE(lv_font_montserrat_80);
