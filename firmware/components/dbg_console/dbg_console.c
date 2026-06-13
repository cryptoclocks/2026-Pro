#include "dbg_console.h"

#include <stdio.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>

#include "esp_console.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_app_desc.h"
#include "argtable3/argtable3.h"

#include "home_ui.h"
#include "ui_renderer.h"
#include "sync_manager.h"
#include "storage.h"

static const char *TAG = "dbg";
static char s_buf[3072]; /* shared scratch for listings */

/* ----------------------------------------------------------- commands */

static int cmd_pages(int argc, char **argv)
{
    home_ui_debug_pages(s_buf, sizeof(s_buf));
    fputs(s_buf, stdout);
    return 0;
}

static struct { struct arg_str *id; struct arg_end *end; } goto_args;
static int cmd_goto(int argc, char **argv)
{
    if (arg_parse(argc, argv, (void **)&goto_args) != 0) {
        arg_print_errors(stdout, goto_args.end, "goto");
        return 1;
    }
    const char *id = goto_args.id->sval[0];
    printf(home_ui_goto_id(id) ? "-> %s\n" : "no such page: %s\n", id);
    return 0;
}

static int cmd_widgets(int argc, char **argv)
{
    /* dumps whatever package layout ui_renderer currently holds (0 if none);
     * the built-in clock/crypto/slideshow are native and have no entries */
    if (ui_renderer_debug_widgets(s_buf, sizeof(s_buf)) == 0) {
        printf("no package layout loaded (built-in page or none).\n");
        return 0;
    }
    fputs(s_buf, stdout);
    return 0;
}

static struct { struct arg_str *path; struct arg_end *end; } ls_args;
static int cmd_ls(int argc, char **argv)
{
    const char *dir = "/sd";
    if (arg_parse(argc, argv, (void **)&ls_args) == 0 && ls_args.path->count) {
        dir = ls_args.path->sval[0];
    }
    DIR *d = opendir(dir);
    if (!d) { printf("opendir failed: %s\n", dir); return 1; }
    struct dirent *e;
    char p[300];
    struct stat st;
    while ((e = readdir(d)) != NULL) {
        snprintf(p, sizeof(p), "%s/%s", dir, e->d_name);
        long sz = (stat(p, &st) == 0) ? (long)st.st_size : -1;
        printf("  %c %8ld  %s\n", (e->d_type == DT_DIR) ? 'd' : '-', sz, e->d_name);
    }
    closedir(d);
    return 0;
}

static struct { struct arg_str *file; struct arg_end *end; } cat_args;
static int cmd_cat(int argc, char **argv)
{
    if (arg_parse(argc, argv, (void **)&cat_args) != 0) {
        arg_print_errors(stdout, cat_args.end, "cat");
        return 1;
    }
    FILE *f = fopen(cat_args.file->sval[0], "rb");
    if (!f) { printf("open failed: %s\n", cat_args.file->sval[0]); return 1; }
    char chunk[256];
    size_t total = 0, r;
    while ((r = fread(chunk, 1, sizeof(chunk), f)) > 0 && total < 4096) {
        fwrite(chunk, 1, r, stdout);
        total += r;
    }
    if (total >= 4096) printf("\n...[truncated at 4KB]\n");
    fputc('\n', stdout);
    fclose(f);
    return 0;
}

static int cmd_heap(int argc, char **argv)
{
    printf("internal: free=%u largest=%u | psram: free=%u largest=%u\n",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
    return 0;
}

static int cmd_ver(int argc, char **argv)
{
    char id[64] = "", ver[32] = "", dir[200] = "";
    sync_manager_active_id(id, sizeof(id));
    sync_manager_active_version(ver, sizeof(ver));
    sync_manager_active_dir(dir, sizeof(dir));
    const esp_app_desc_t *app = esp_app_get_description();
    printf("fw=%s  package=%s@%s  dir=%s  sd=%s free=%lldKB\n",
           app->version, id[0] ? id : "(none)", ver[0] ? ver : "-", dir,
           storage_sd_mounted() ? "yes" : "no", (long long)storage_sd_free_kb());
    return 0;
}

/* -------------------------------------------------------------- setup */

static void reg(const char *cmd, const char *help, esp_console_cmd_func_t fn, void *args)
{
    const esp_console_cmd_t c = { .command = cmd, .help = help, .func = fn, .argtable = args };
    ESP_ERROR_CHECK(esp_console_cmd_register(&c));
}

void dbg_console_start(void)
{
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t cfg = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    cfg.prompt = "ccp>";
    cfg.max_cmdline_length = 256;

    esp_console_dev_usb_serial_jtag_config_t dev = ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    if (esp_console_new_repl_usb_serial_jtag(&dev, &cfg, &repl) != ESP_OK) {
        ESP_LOGW(TAG, "repl init failed");
        return;
    }

    esp_console_register_help_command();
    reg("pages", "list pages + current", cmd_pages, NULL);
    reg("widgets", "dump the loaded package's widget tree", cmd_widgets, NULL);
    reg("heap", "internal/PSRAM heap stats", cmd_heap, NULL);
    reg("ver", "firmware + active package version", cmd_ver, NULL);

    goto_args.id = arg_str1(NULL, NULL, "<id>", "page id (clock/crypto/slideshow/<pkg>)");
    goto_args.end = arg_end(1);
    reg("goto", "switch to a page by id", cmd_goto, &goto_args);

    ls_args.path = arg_str0(NULL, NULL, "[dir]", "dir (default /sd)");
    ls_args.end = arg_end(1);
    reg("ls", "list an SD directory", cmd_ls, &ls_args);

    cat_args.file = arg_str1(NULL, NULL, "<file>", "file to dump (first 4KB)");
    cat_args.end = arg_end(1);
    reg("cat", "print an SD file", cmd_cat, &cat_args);

    /* non-fatal: a console that can't start (e.g. low memory) must never abort
     * the device into a boot loop */
    if (esp_console_start_repl(repl) != ESP_OK) {
        ESP_LOGW(TAG, "repl start failed (continuing without console)");
        return;
    }
    ESP_LOGI(TAG, "serial debug console up — try 'help'");
}
