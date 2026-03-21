//! Backend WASM-based FsProvider plugin manager.
//!
//! Each plugin is a `.wasm` file that implements the fsProvider ABI:
//!
//!   Plugin exports:
//!     get_input_ptr() -> i32   — pointer to the input buffer
//!     get_output_ptr() -> i32  — pointer to the output buffer
//!     plugin_init() -> i32     — optional; return 0 for success
//!     plugin_list() -> i32     — bytes written to output (JSON)
//!     plugin_read(offset: i64, len: i64) -> i32  — bytes written
//!
//!   Input buffer layout (written by host before each call):
//!     [container_path_len: 4 bytes LE][container_path UTF-8]
//!     [inner_path_len: 4 bytes LE][inner_path UTF-8]
//!
//!   Host imports (env namespace):
//!     host_read_range(offset: i64, len: i64, out_ptr: i32) -> i32
//!     host_log(ptr: i32, len: i32)

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};
use wasmtime::{Engine, Linker, Module, Store};

/// Data available to host-imported functions during a WASM call.
struct HostData {
    container_path: String,
    /// Accumulates bytes sent by the plugin via host_receive_bytes.
    output_data: Vec<u8>,
}

/// A compiled WASM plugin. `Engine` and `Module` are thread-safe.
pub struct FsProviderPlugin {
    engine: Arc<Engine>,
    module: Module,
}

/// Manages loaded WASM plugins, keyed by absolute wasm file path.
pub struct FsProviderManager {
    plugins: Mutex<HashMap<String, Arc<FsProviderPlugin>>>,
}

/// A single directory entry returned by a plugin.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FspEntry {
    pub name: String,
    /// "file" or "directory"
    pub kind: String,
    pub size: Option<f64>,
    pub mtime_ms: Option<f64>,
}

impl FsProviderManager {
    pub fn new() -> Self {
        Self { plugins: Mutex::new(HashMap::new()) }
    }

    /// Compile and cache a WASM plugin. Idempotent — safe to call multiple times.
    pub fn load(&self, wasm_path: &str) -> Result<(), String> {
        let mut guard = self.plugins.lock().unwrap();
        if guard.contains_key(wasm_path) {
            return Ok(());
        }
        let engine = Arc::new(Engine::default());
        let module = Module::from_file(&engine, wasm_path)
            .map_err(|e| format!("Failed to compile '{}': {}", wasm_path, e))?;
        guard.insert(wasm_path.to_string(), Arc::new(FsProviderPlugin { engine, module }));
        Ok(())
    }

    /// List entries at `inner_path` inside the container at `container_path`.
    pub fn list_entries(
        &self,
        wasm_path: &str,
        container_path: &str,
        inner_path: &str,
    ) -> Result<Vec<FspEntry>, String> {
        let plugin = self.get_or_load(wasm_path)?;
        call_plugin_list(&plugin, container_path, inner_path)
    }

    /// Read a byte range of a file at `inner_path` inside the container.
    pub fn read_file_range(
        &self,
        wasm_path: &str,
        container_path: &str,
        inner_path: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, String> {
        let plugin = self.get_or_load(wasm_path)?;
        call_plugin_read(&plugin, container_path, inner_path, offset, length)
    }

    fn get_or_load(&self, wasm_path: &str) -> Result<Arc<FsProviderPlugin>, String> {
        {
            let guard = self.plugins.lock().unwrap();
            if let Some(p) = guard.get(wasm_path) {
                return Ok(p.clone());
            }
        }
        self.load(wasm_path)?;
        Ok(self.plugins.lock().unwrap().get(wasm_path).unwrap().clone())
    }
}

fn make_linker(engine: &Engine) -> Result<Linker<HostData>, String> {
    let mut linker = Linker::new(engine);

    // host_read_range(offset: i64, len: i64, out_ptr: i32) -> i32
    // Reads from the container file; writes `len` bytes at `out_ptr` in WASM memory.
    linker
        .func_wrap(
            "env",
            "host_read_range",
            |mut caller: wasmtime::Caller<'_, HostData>, offset: i64, len: i64, out_ptr: i32| -> i32 {
                if offset < 0 || len <= 0 || len > 4 * 1024 * 1024 {
                    return -1;
                }
                let container_path = caller.data().container_path.clone();
                let mut file = match File::open(&container_path) {
                    Ok(f) => f,
                    Err(_) => return -1,
                };
                if file.seek(SeekFrom::Start(offset as u64)).is_err() {
                    return -1;
                }
                let mut buf = vec![0u8; len as usize];
                let n = match file.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => return -1,
                };
                let mem = match caller.get_export("memory") {
                    Some(wasmtime::Extern::Memory(m)) => m,
                    _ => return -1,
                };
                if mem.write(&mut caller, out_ptr as usize, &buf[..n]).is_err() {
                    return -1;
                }
                n as i32
            },
        )
        .map_err(|e| format!("Failed to link host_read_range: {}", e))?;

    // host_log(ptr: i32, len: i32)
    linker
        .func_wrap(
            "env",
            "host_log",
            |mut caller: wasmtime::Caller<'_, HostData>, ptr: i32, len: i32| {
                let mem = match caller.get_export("memory") {
                    Some(wasmtime::Extern::Memory(m)) => m,
                    _ => return,
                };
                let mut buf = vec![0u8; len as usize];
                if mem.read(&caller, ptr as usize, &mut buf).is_ok() {
                    if let Ok(s) = std::str::from_utf8(&buf) {
                        log::info!("[wasm] {}", s);
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to link host_log: {}", e))?;

    // host_receive_bytes(ptr: i32, len: i32) -> i32
    // Streams plugin_read output to the host without the OUTPUT_BUF size limit.
    linker
        .func_wrap(
            "env",
            "host_receive_bytes",
            |mut caller: wasmtime::Caller<'_, HostData>, ptr: i32, len: i32| -> i32 {
                if len <= 0 {
                    return 0;
                }
                let mem = match caller.get_export("memory") {
                    Some(wasmtime::Extern::Memory(m)) => m,
                    _ => return -1,
                };
                let mut buf = vec![0u8; len as usize];
                if mem.read(&caller, ptr as usize, &mut buf).is_err() {
                    return -1;
                }
                caller.data_mut().output_data.extend_from_slice(&buf);
                len
            },
        )
        .map_err(|e| format!("Failed to link host_receive_bytes: {}", e))?;

    Ok(linker)
}

fn write_inputs(
    mem: &wasmtime::Memory,
    store: &mut Store<HostData>,
    input_ptr: usize,
    container_path: &str,
    inner_path: &str,
) -> Result<(), String> {
    let cp = container_path.as_bytes();
    let ip = inner_path.as_bytes();
    let mut buf = Vec::with_capacity(8 + cp.len() + ip.len());
    buf.extend_from_slice(&(cp.len() as u32).to_le_bytes());
    buf.extend_from_slice(cp);
    buf.extend_from_slice(&(ip.len() as u32).to_le_bytes());
    buf.extend_from_slice(ip);
    mem.write(store, input_ptr, &buf)
        .map_err(|e| format!("Failed to write plugin input: {}", e))
}

fn call_plugin_list(
    plugin: &FsProviderPlugin,
    container_path: &str,
    inner_path: &str,
) -> Result<Vec<FspEntry>, String> {
    let mut store = Store::new(&plugin.engine, HostData { container_path: container_path.to_string(), output_data: Vec::new() });
    let linker = make_linker(&plugin.engine)?;
    let instance = linker
        .instantiate(&mut store, &plugin.module)
        .map_err(|e| format!("Failed to instantiate plugin: {}", e))?;

    let mem = instance
        .get_memory(&mut store, "memory")
        .ok_or("Plugin has no 'memory' export")?;

    // Optional init
    if let Ok(init) = instance.get_typed_func::<(), i32>(&mut store, "plugin_init") {
        let rc = init.call(&mut store, ()).map_err(|e| format!("plugin_init: {}", e))?;
        if rc != 0 {
            return Err(format!("plugin_init returned error code {}", rc));
        }
    }

    let get_input_ptr = instance
        .get_typed_func::<(), i32>(&mut store, "get_input_ptr")
        .map_err(|_| "Plugin missing 'get_input_ptr' export")?;
    let get_output_ptr = instance
        .get_typed_func::<(), i32>(&mut store, "get_output_ptr")
        .map_err(|_| "Plugin missing 'get_output_ptr' export")?;
    let plugin_list = instance
        .get_typed_func::<(), i32>(&mut store, "plugin_list")
        .map_err(|_| "Plugin missing 'plugin_list' export")?;

    let input_ptr = get_input_ptr.call(&mut store, ()).map_err(|e| format!("get_input_ptr: {}", e))? as usize;
    let output_ptr = get_output_ptr.call(&mut store, ()).map_err(|e| format!("get_output_ptr: {}", e))? as usize;

    write_inputs(&mem, &mut store, input_ptr, container_path, inner_path)?;

    let bytes_written = plugin_list.call(&mut store, ()).map_err(|e| format!("plugin_list: {}", e))?;
    if bytes_written < 0 {
        return Err(format!("plugin_list returned error code {}", bytes_written));
    }

    let mut out = vec![0u8; bytes_written as usize];
    mem.read(&store, output_ptr, &mut out)
        .map_err(|e| format!("Failed to read plugin output: {}", e))?;

    serde_json::from_slice(&out).map_err(|e| format!("Failed to parse plugin entries: {}", e))
}

fn call_plugin_read(
    plugin: &FsProviderPlugin,
    container_path: &str,
    inner_path: &str,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    let mut store = Store::new(&plugin.engine, HostData { container_path: container_path.to_string(), output_data: Vec::new() });
    let linker = make_linker(&plugin.engine)?;
    let instance = linker
        .instantiate(&mut store, &plugin.module)
        .map_err(|e| format!("Failed to instantiate plugin: {}", e))?;

    let mem = instance
        .get_memory(&mut store, "memory")
        .ok_or("Plugin has no 'memory' export")?;

    let get_input_ptr = instance
        .get_typed_func::<(), i32>(&mut store, "get_input_ptr")
        .map_err(|_| "Plugin missing 'get_input_ptr' export")?;
    let get_output_ptr = instance
        .get_typed_func::<(), i32>(&mut store, "get_output_ptr")
        .map_err(|_| "Plugin missing 'get_output_ptr' export")?;
    let plugin_read = instance
        .get_typed_func::<(i64, i64), i32>(&mut store, "plugin_read")
        .map_err(|_| "Plugin missing 'plugin_read' export")?;

    let input_ptr = get_input_ptr.call(&mut store, ()).map_err(|e| format!("get_input_ptr: {}", e))? as usize;
    let output_ptr = get_output_ptr.call(&mut store, ()).map_err(|e| format!("get_output_ptr: {}", e))? as usize;

    write_inputs(&mem, &mut store, input_ptr, container_path, inner_path)?;

    let bytes_written = plugin_read
        .call(&mut store, (offset as i64, length as i64))
        .map_err(|e| format!("plugin_read: {}", e))?;
    if bytes_written < 0 {
        return Err(format!("plugin_read returned error code {}", bytes_written));
    }

    // New plugins stream data via host_receive_bytes (no OUTPUT_BUF size limit).
    // Old plugins write to OUTPUT_BUF directly — fall back to reading from there.
    let streamed = std::mem::take(&mut store.data_mut().output_data);
    if !streamed.is_empty() {
        return Ok(streamed);
    }

    let mut out = vec![0u8; bytes_written as usize];
    mem.read(&store, output_ptr, &mut out)
        .map_err(|e| format!("Failed to read plugin output: {}", e))?;

    Ok(out)
}
