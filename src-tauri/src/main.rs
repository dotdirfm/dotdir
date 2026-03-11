// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(|s| s.as_str()) {
        Some("serve") => faraday_tauri_lib::serve::run(&args[2..]),
        Some("rpc") => faraday_tauri_lib::rpc::run(&args[2..]),
        _ => faraday_tauri_lib::run(),
    }
}
