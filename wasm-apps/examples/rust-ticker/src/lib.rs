#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const CCP_LOG_INFO: i32 = 2;
const CCP_EVT_CLICKED: u32 = 4;

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_data_subscribe(stream: *const u8, len: u32) -> i32;
    fn ccp_audio_tone(freq_hz: u32, dur_ms: u32, vol_0_100: u32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_log(level: i32, msg: *const u8, len: u32);
}

static mut PRICE_WIDGET: i32 = -1;
static mut TICKS: u32 = 0;
static mut ARENA: [u8; 16 * 1024] = [0; 16 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        let msg = b"rust-ticker.wasm up";
        ccp_log(CCP_LOG_INFO, msg.as_ptr(), msg.len() as u32);
        PRICE_WIDGET = ccp_ui_get_widget(b"price".as_ptr(), 5);
        ccp_data_subscribe(b"market.BTCUSDT.ticker".as_ptr(), 21);
        ccp_request_tick(1000);
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {
    unsafe {
        TICKS = TICKS.wrapping_add(1);
        if PRICE_WIDGET >= 0 {
            let mut buf = [0u8; 24];
            let prefix = b"rust tick ";
            buf[..prefix.len()].copy_from_slice(prefix);
            let n = write_u32(&mut buf[prefix.len()..], TICKS) + prefix.len();
            ccp_ui_set_text(PRICE_WIDGET, buf.as_ptr(), n as u32);
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, event: u32, _p0: i32, _p1: i32) {
    if event == CCP_EVT_CLICKED {
        unsafe {
            ccp_audio_tone(880, 120, 60);
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_data(_stream_handle: i32, payload_ptr: u32, len: u32) {
    unsafe {
        if PRICE_WIDGET >= 0 && len > 0 {
            ccp_ui_set_text(PRICE_WIDGET, payload_ptr as *const u8, len.min(32));
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {
    unsafe {
        let msg = b"rust-ticker.wasm bye";
        ccp_log(CCP_LOG_INFO, msg.as_ptr(), msg.len() as u32);
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

fn write_u32(out: &mut [u8], mut value: u32) -> usize {
    let mut tmp = [0u8; 10];
    let mut n = 0;
    loop {
        tmp[n] = b'0' + (value % 10) as u8;
        n += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for i in 0..n {
        out[i] = tmp[n - 1 - i];
    }
    n
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
