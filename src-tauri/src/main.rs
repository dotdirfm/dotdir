// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    std::panic::set_hook(Box::new(|info| {
        faraday_tauri_lib::write_debug_log(&format!("panic: {info}"));
    }));

    let args: Vec<String> = std::env::args().collect();
    faraday_tauri_lib::write_debug_log(&format!("main entered with args: {:?}", args));

    match args.get(1).map(|s| s.as_str()) {
        Some("serve") => faraday_tauri_lib::serve::run(&args[2..]),
        Some("rpc") => faraday_tauri_lib::rpc::run(&args[2..]),
        _ => faraday_tauri_lib::run(),
    }
}
