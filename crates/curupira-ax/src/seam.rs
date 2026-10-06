use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::ptr::NonNull;
use std::sync::OnceLock;

type Ref = *const c_void;
type Handle = *mut c_void;
type TypeId = usize;
type Index = isize;

const RTLD_LAZY: i32 = 0x1;
const RTLD_DEFAULT: Handle = -2isize as Handle;
const UTF8: u32 = 0x0800_0100;
const NUMBER_DOUBLE: Index = 13;
const PATH_BUF: usize = 4096;
const MESSAGING_TIMEOUT_S: f32 = 3.0;

const AX_SUCCESS: i32 = 0;
const AX_ATTRIBUTE_UNSUPPORTED: i32 = -25205;
const AX_NO_VALUE: i32 = -25212;

const HISERVICES: &CStr =
    c"/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices";
const CORE_FOUNDATION: &CStr = c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: i32) -> Handle;
    fn dlsym(handle: Handle, symbol: *const c_char) -> Handle;
    fn proc_listallpids(buffer: Handle, buffersize: i32) -> i32;
    fn proc_pidpath(pid: i32, buffer: Handle, buffersize: u32) -> i32;
    fn getpid() -> i32;
}

struct Api {
    is_trusted: unsafe extern "C" fn() -> u8,
    create_application: unsafe extern "C" fn(i32) -> Ref,
    copy_attribute: unsafe extern "C" fn(Ref, Ref, *mut Ref) -> i32,
    set_attribute: unsafe extern "C" fn(Ref, Ref, Ref) -> i32,
    perform_action: unsafe extern "C" fn(Ref, Ref) -> i32,
    set_timeout: unsafe extern "C" fn(Ref, f32) -> i32,
    element_type: unsafe extern "C" fn() -> TypeId,
    release: unsafe extern "C" fn(Ref),
    retain: unsafe extern "C" fn(Ref) -> Ref,
    type_of: unsafe extern "C" fn(Ref) -> TypeId,
    string_type: unsafe extern "C" fn() -> TypeId,
    array_type: unsafe extern "C" fn() -> TypeId,
    boolean_type: unsafe extern "C" fn() -> TypeId,
    number_type: unsafe extern "C" fn() -> TypeId,
    string_create: unsafe extern "C" fn(Ref, *const u8, Index, u32, u8) -> Ref,
    string_length: unsafe extern "C" fn(Ref) -> Index,
    string_max_size: unsafe extern "C" fn(Index, u32) -> Index,
    string_cstring: unsafe extern "C" fn(Ref, *mut c_char, Index, u32) -> u8,
    array_count: unsafe extern "C" fn(Ref) -> Index,
    array_at: unsafe extern "C" fn(Ref, Index) -> Ref,
    boolean_value: unsafe extern "C" fn(Ref) -> u8,
    number_value: unsafe extern "C" fn(Ref, Index, Handle) -> u8,
    describe: unsafe extern "C" fn(Ref) -> Ref,
    url_from_path: unsafe extern "C" fn(Ref, *const u8, Index, u8) -> Ref,
    bundle_create: unsafe extern "C" fn(Ref, Ref) -> Ref,
    bundle_identifier: unsafe extern "C" fn(Ref) -> Ref,
    boolean_true: Ref,
    responsible_for: Option<unsafe extern "C" fn(i32) -> i32>,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn open(path: &CStr) -> Option<Handle> {
    let h = unsafe { dlopen(path.as_ptr(), RTLD_LAZY) };
    (!h.is_null()).then_some(h)
}

fn symbol(handle: Handle, name: &CStr) -> Option<Handle> {
    let p = unsafe { dlsym(handle, name.as_ptr()) };
    (!p.is_null()).then_some(p)
}

fn bind<F: Copy>(handle: Handle, name: &CStr) -> Option<F> {
    assert_eq!(std::mem::size_of::<F>(), std::mem::size_of::<Handle>());
    let p = symbol(handle, name)?;
    Some(unsafe { std::mem::transmute_copy::<Handle, F>(&p) })
}

fn load() -> Option<Api> {
    let ax = open(HISERVICES)?;
    let cf = open(CORE_FOUNDATION)?;
    let boolean_true = unsafe { *symbol(cf, c"kCFBooleanTrue")?.cast::<Ref>() };
    let responsible_for = bind(RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid");
    Some(Api {
        is_trusted: bind(ax, c"AXIsProcessTrusted")?,
        create_application: bind(ax, c"AXUIElementCreateApplication")?,
        copy_attribute: bind(ax, c"AXUIElementCopyAttributeValue")?,
        set_attribute: bind(ax, c"AXUIElementSetAttributeValue")?,
        perform_action: bind(ax, c"AXUIElementPerformAction")?,
        set_timeout: bind(ax, c"AXUIElementSetMessagingTimeout")?,
        element_type: bind(ax, c"AXUIElementGetTypeID")?,
        release: bind(cf, c"CFRelease")?,
        retain: bind(cf, c"CFRetain")?,
        type_of: bind(cf, c"CFGetTypeID")?,
        string_type: bind(cf, c"CFStringGetTypeID")?,
        array_type: bind(cf, c"CFArrayGetTypeID")?,
        boolean_type: bind(cf, c"CFBooleanGetTypeID")?,
        number_type: bind(cf, c"CFNumberGetTypeID")?,
        string_create: bind(cf, c"CFStringCreateWithBytes")?,
        string_length: bind(cf, c"CFStringGetLength")?,
        string_max_size: bind(cf, c"CFStringGetMaximumSizeForEncoding")?,
        string_cstring: bind(cf, c"CFStringGetCString")?,
        array_count: bind(cf, c"CFArrayGetCount")?,
        array_at: bind(cf, c"CFArrayGetValueAtIndex")?,
        boolean_value: bind(cf, c"CFBooleanGetValue")?,
        number_value: bind(cf, c"CFNumberGetValue")?,
        describe: bind(cf, c"CFCopyDescription")?,
        url_from_path: bind(cf, c"CFURLCreateFromFileSystemRepresentation")?,
        bundle_create: bind(cf, c"CFBundleCreate")?,
        bundle_identifier: bind(cf, c"CFBundleGetIdentifier")?,
        boolean_true,
        responsible_for,
    })
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(load).as_ref()
}

struct Owned(NonNull<c_void>);

impl Owned {
    fn new(r: Ref) -> Option<Self> {
        NonNull::new(r.cast_mut()).map(Self)
    }

    fn raw(&self) -> Ref {
        self.0.as_ptr().cast_const()
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(a) = api() {
            unsafe { (a.release)(self.raw()) };
        }
    }
}

pub struct Element(Owned);

impl Element {
    fn retained(a: &Api, r: Ref) -> Option<Self> {
        if r.is_null() {
            return None;
        }
        Owned::new(unsafe { (a.retain)(r) }).map(Element)
    }
}

impl Clone for Element {
    fn clone(&self) -> Self {
        let a = api().expect("an Element exists only once the API loaded");
        Element::retained(a, self.0.raw()).expect("retaining a live element returns it")
    }
}

pub enum Raw {
    Absent,
    Text(String),
    Number(f64),
    Bool(bool),
    Element(Element),
    Elements(Vec<Element>),
    Other(String),
    Unanswered,
}

fn cfstring(a: &Api, s: &str) -> Option<Owned> {
    let len = Index::try_from(s.len()).ok()?;
    Owned::new(unsafe { (a.string_create)(std::ptr::null(), s.as_ptr(), len, UTF8, 0) })
}

fn string_of(a: &Api, r: Ref) -> String {
    let len = unsafe { (a.string_length)(r) };
    let cap = unsafe { (a.string_max_size)(len, UTF8) } + 1;
    let Ok(size) = usize::try_from(cap) else { return String::new() };
    let mut buf = vec![0u8; size];
    let ok = unsafe { (a.string_cstring)(r, buf.as_mut_ptr().cast(), cap, UTF8) };
    if ok == 0 {
        return String::new();
    }
    CStr::from_bytes_until_nul(&buf).map(|c| c.to_string_lossy().into_owned()).unwrap_or_default()
}

fn classify(a: &Api, v: Ref) -> Raw {
    let t = unsafe { (a.type_of)(v) };
    if t == unsafe { (a.string_type)() } {
        Raw::Text(string_of(a, v))
    } else if t == unsafe { (a.boolean_type)() } {
        Raw::Bool(unsafe { (a.boolean_value)(v) } != 0)
    } else if t == unsafe { (a.number_type)() } {
        let mut out = 0f64;
        let ok = unsafe { (a.number_value)(v, NUMBER_DOUBLE, (&raw mut out).cast()) };
        if ok == 0 { Raw::Other(describe(a, v)) } else { Raw::Number(out) }
    } else if t == unsafe { (a.element_type)() } {
        Element::retained(a, v).map_or(Raw::Absent, Raw::Element)
    } else if t == unsafe { (a.array_type)() } {
        let n = unsafe { (a.array_count)(v) };
        let element = unsafe { (a.element_type)() };
        let mut out = Vec::new();
        for i in 0..n {
            let item = unsafe { (a.array_at)(v, i) };
            if unsafe { (a.type_of)(item) } != element {
                return Raw::Other(describe(a, v));
            }
            if let Some(e) = Element::retained(a, item) {
                out.push(e);
            }
        }
        Raw::Elements(out)
    } else {
        Raw::Other(describe(a, v))
    }
}

fn describe(a: &Api, v: Ref) -> String {
    Owned::new(unsafe { (a.describe)(v) }).map(|d| string_of(a, d.raw())).unwrap_or_default()
}

pub fn trusted() -> Option<bool> {
    api().map(|a| unsafe { (a.is_trusted)() } != 0)
}

pub fn application(pid: i32) -> Option<Element> {
    let a = api()?;
    let app = Owned::new(unsafe { (a.create_application)(pid) }).map(Element)?;
    unsafe { (a.set_timeout)(app.0.raw(), MESSAGING_TIMEOUT_S) };
    Some(app)
}

pub fn attribute(el: &Element, name: &str) -> Raw {
    let Some(a) = api() else { return Raw::Absent };
    let Some(key) = cfstring(a, name) else { return Raw::Absent };
    let mut out: Ref = std::ptr::null();
    let err = unsafe { (a.copy_attribute)(el.0.raw(), key.raw(), &raw mut out) };
    let value = Owned::new(out);
    match (err, value) {
        (AX_SUCCESS, Some(v)) => classify(a, v.raw()),
        (AX_SUCCESS | AX_NO_VALUE | AX_ATTRIBUTE_UNSUPPORTED, _) => Raw::Absent,
        _ => Raw::Unanswered,
    }
}

pub fn perform(el: &Element, action: &str) -> Result<(), i32> {
    let a = api().ok_or(-25200)?;
    let key = cfstring(a, action).ok_or(-25201)?;
    match unsafe { (a.perform_action)(el.0.raw(), key.raw()) } {
        AX_SUCCESS => Ok(()),
        code => Err(code),
    }
}

pub fn set_text(el: &Element, attr: &str, value: &str) -> Result<(), i32> {
    let a = api().ok_or(-25200)?;
    let key = cfstring(a, attr).ok_or(-25201)?;
    let v = cfstring(a, value).ok_or(-25201)?;
    match unsafe { (a.set_attribute)(el.0.raw(), key.raw(), v.raw()) } {
        AX_SUCCESS => Ok(()),
        code => Err(code),
    }
}

pub fn set_true(el: &Element, attr: &str) -> Result<(), i32> {
    let a = api().ok_or(-25200)?;
    let key = cfstring(a, attr).ok_or(-25201)?;
    match unsafe { (a.set_attribute)(el.0.raw(), key.raw(), a.boolean_true) } {
        AX_SUCCESS => Ok(()),
        code => Err(code),
    }
}

pub fn process_path(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; PATH_BUF];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr().cast(), u32::try_from(PATH_BUF).ok()?) };
    let n = usize::try_from(n).ok().filter(|n| *n > 0)?;
    buf.truncate(n);
    String::from_utf8(buf).ok()
}

pub fn responsible_process() -> Option<String> {
    let f = api()?.responsible_for?;
    let pid = unsafe { f(getpid()) };
    (pid > 0).then(|| process_path(pid)).flatten()
}

fn all_pids() -> Vec<i32> {
    let n = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    let Ok(n) = usize::try_from(n) else { return Vec::new() };
    let mut buf = vec![0i32; n + 64];
    let bytes = i32::try_from(buf.len() * std::mem::size_of::<i32>()).unwrap_or(i32::MAX);
    let got = unsafe { proc_listallpids(buf.as_mut_ptr().cast(), bytes) };
    buf.truncate(usize::try_from(got).unwrap_or(0).min(buf.len()));
    buf
}

fn bundle_identifier(a: &Api, bundle_path: &str) -> Option<String> {
    let len = Index::try_from(bundle_path.len()).ok()?;
    let url = Owned::new(unsafe { (a.url_from_path)(std::ptr::null(), bundle_path.as_ptr(), len, 1) })?;
    let bundle = Owned::new(unsafe { (a.bundle_create)(std::ptr::null(), url.raw()) })?;
    let id = unsafe { (a.bundle_identifier)(bundle.raw()) };
    (!id.is_null()).then(|| string_of(a, id))
}

pub fn pid_for_bundle(bundle_id: &str) -> Option<i32> {
    let a = api()?;
    let mut seen: HashMap<String, Option<String>> = HashMap::new();
    let mut hits: Vec<i32> = all_pids()
        .into_iter()
        .filter(|pid| *pid > 0)
        .filter(|pid| {
            let Some(path) = process_path(*pid) else { return false };
            let Some(i) = path.rfind(".app/Contents/MacOS/") else { return false };
            let bundle = path[..i + 4].to_string();
            let id = seen.entry(bundle.clone()).or_insert_with(|| bundle_identifier(a, &bundle));
            id.as_deref() == Some(bundle_id)
        })
        .collect();
    hits.sort_unstable();
    hits.first().copied()
}
