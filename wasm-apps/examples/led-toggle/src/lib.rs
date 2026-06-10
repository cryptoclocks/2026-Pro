#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const CCP_LOG_INFO: i32 = 2;
const EVT_LED_1: u32 = 101;
const EVT_LED_2: u32 = 102;
const PART_INDICATOR: u32 = 2;

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_color(widget: i32, argb8888: u32, part: u32) -> i32;
    fn ccp_log(level: i32, msg: *const u8, len: u32);
}

static mut LED_1: i32 = -1;
static mut LED_2: i32 = -1;
static mut LED_1_ON: bool = false;
static mut LED_2_ON: bool = false;
static mut ARENA: [u8; 4 * 1024] = [0; 4 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        LED_1 = ccp_ui_get_widget(b"led_1".as_ptr(), 5);
        LED_2 = ccp_ui_get_widget(b"led_2".as_ptr(), 5);
        set_led(LED_1, false, 0xFF0ECB81);
        set_led(LED_2, false, 0xFFF0B90B);
        let msg = b"led-toggle.wasm up";
        ccp_log(CCP_LOG_INFO, msg.as_ptr(), msg.len() as u32);
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, event: u32, _p0: i32, _p1: i32) {
    unsafe {
        match event {
            EVT_LED_1 => {
                LED_1_ON = !LED_1_ON;
                set_led(LED_1, LED_1_ON, 0xFF0ECB81);
            }
            EVT_LED_2 => {
                LED_2_ON = !LED_2_ON;
                set_led(LED_2, LED_2_ON, 0xFFF0B90B);
            }
            _ => {}
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_data(_stream_handle: i32, _payload_ptr: u32, _len: u32) {}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {
    unsafe {
        let msg = b"led-toggle.wasm bye";
        ccp_log(CCP_LOG_INFO, msg.as_ptr(), msg.len() as u32);
    }
}

unsafe fn set_led(widget: i32, on: bool, color: u32) {
    if widget >= 0 {
        let off = 0xFF20262D;
        ccp_ui_set_color(widget, if on { color } else { off }, PART_INDICATOR);
    }
}

#[no_mangle]
pub extern "C" fn ccp_malloc(size: u32) -> u32 {
    let size = ((size as usize) + 7) & !7;
    unsafe {
        if ARENA_TOP + size > ARENA.len() {
            return 0;
        }
        ARENA_LAST = ARENA_TOP;
        let ptr = ARENA.as_mut_ptr().add(ARENA_TOP) as u32;
        ARENA_TOP += size;
        ptr
    }
}

#[no_mangle]
pub extern "C" fn ccp_free(ptr: u32) {
    unsafe {
        let last_ptr = ARENA.as_mut_ptr().add(ARENA_LAST) as u32;
        if ptr == last_ptr {
            ARENA_TOP = ARENA_LAST;
        }
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
