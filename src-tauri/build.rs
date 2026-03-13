fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../dist");

    // Ensure ../dist exists so rust-embed compiles in dev mode.
    // In release, Tauri's `beforeBuildCommand` runs `pnpm build` first,
    // populating dist/ with the real frontend build.
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest_dir.join("../dist");
    if !dist.exists() {
        std::fs::create_dir_all(&dist).ok();
        std::fs::write(dist.join("index.html"), "<!-- dev placeholder -->").ok();
    }

    tauri_build::build()
}
