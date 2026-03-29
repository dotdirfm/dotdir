use dotdir_core::copy::CancelToken;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

pub const MARKETPLACE_URL: &str = "https://dotdir.dev";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "source")]
pub enum ExtensionInstallRequest {
    #[serde(rename = "dotdir-marketplace", alias = "dotdirMarketplace")]
    DotdirMarketplace {
        publisher: String,
        name: String,
        version: String,
    },
    #[serde(rename = "vscode-marketplace", alias = "vscodeMarketplace")]
    VscodeMarketplace {
        publisher: String,
        name: String,
        #[serde(rename = "downloadUrl", alias = "download_url")]
        download_url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensionRef {
    pub publisher: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExtensionInstallEvent {
    Progress {
        phase: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_file: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        files_done: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        files_total: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes_done: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes_total: Option<u64>,
    },
    Done {
        r#ref: InstalledExtensionRef,
    },
    Error {
        message: String,
    },
}

fn normalized_home_extensions_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not available".to_string())?;
    Ok(home.join(".dotdir").join("extensions"))
}

fn extension_dir_name(installed: &InstalledExtensionRef) -> String {
    format!("{}-{}-{}", installed.publisher, installed.name, installed.version)
}

fn refs_json_path(base_dir: &Path) -> PathBuf {
    base_dir.join("extensions.json")
}

fn read_refs(base_dir: &Path) -> Vec<InstalledExtensionRef> {
    let path = refs_json_path(base_dir);
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_refs(base_dir: &Path, refs: &[InstalledExtensionRef]) -> Result<(), String> {
    fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(refs).map_err(|e| e.to_string())?;
    fs::write(refs_json_path(base_dir), data).map_err(|e| e.to_string())
}

fn strip_common_top_level(entries: &[String]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let Some(first) = entries.first() else {
        return String::new();
    };
    let Some(slash) = first.find('/') else {
        return String::new();
    };
    let prefix = &first[..=slash];
    if entries.iter().all(|name| name.starts_with(prefix)) {
        prefix.to_string()
    } else {
        String::new()
    }
}

fn check_cancel(cancel: &CancelToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("cancelled".to_string())
    } else {
        Ok(())
    }
}

fn download_bytes(
    url: &str,
    cancel: &CancelToken,
    emit: &impl Fn(ExtensionInstallEvent),
) -> Result<Vec<u8>, String> {
    let mut response = reqwest::blocking::get(url)
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = response.content_length();
    let mut bytes = Vec::new();
    let mut buf = [0_u8; 64 * 1024];
    let mut done = 0_u64;
    loop {
        check_cancel(cancel)?;
        let read = response.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..read]);
        done += read as u64;
        emit(ExtensionInstallEvent::Progress {
            phase: "download",
            current_file: None,
            files_done: None,
            files_total: None,
            bytes_done: Some(done),
            bytes_total: total,
        });
    }
    Ok(bytes)
}

fn extract_archive(
    archive_bytes: &[u8],
    request: &ExtensionInstallRequest,
    cancel: &CancelToken,
    emit: &impl Fn(ExtensionInstallEvent),
) -> Result<(InstalledExtensionRef, Vec<(String, Vec<u8>)>), String> {
    let cursor = Cursor::new(archive_bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let mut names = Vec::new();
    let mut version_from_package: Option<String> = None;
    let mut kept_names = Vec::new();

    for i in 0..archive.len() {
        check_cancel(cancel)?;
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        match request {
            ExtensionInstallRequest::DotdirMarketplace { .. } => {
                names.push(name.clone());
            }
            ExtensionInstallRequest::VscodeMarketplace { .. } => {
                if name.starts_with("extension/") {
                    kept_names.push(name.clone());
                }
            }
        }
    }

    let strip_prefix = match request {
        ExtensionInstallRequest::DotdirMarketplace { .. } => strip_common_top_level(&names),
        ExtensionInstallRequest::VscodeMarketplace { .. } => "extension/".to_string(),
    };

    let files_total = match request {
        ExtensionInstallRequest::DotdirMarketplace { .. } => names.len() as u32,
        ExtensionInstallRequest::VscodeMarketplace { .. } => kept_names.len() as u32,
    };

    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut files_done = 0_u32;

    for i in 0..archive.len() {
        check_cancel(cancel)?;
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let original_name = file.name().to_string();
        let normalized_name = match request {
            ExtensionInstallRequest::DotdirMarketplace { .. } => {
                if !strip_prefix.is_empty() && !original_name.starts_with(&strip_prefix) {
                    continue;
                }
                if strip_prefix.is_empty() {
                    original_name.clone()
                } else {
                    original_name[strip_prefix.len()..].to_string()
                }
            }
            ExtensionInstallRequest::VscodeMarketplace { .. } => {
                if !original_name.starts_with(&strip_prefix) {
                    continue;
                }
                original_name[strip_prefix.len()..].to_string()
            }
        };
        if normalized_name.is_empty() || !seen.insert(normalized_name.clone()) {
            continue;
        }

        let mut content = Vec::new();
        file.read_to_end(&mut content).map_err(|e| e.to_string())?;

        if matches!(request, ExtensionInstallRequest::VscodeMarketplace { .. }) && normalized_name == "package.json" {
            let package_json: serde_json::Value =
                serde_json::from_slice(&content).map_err(|e| e.to_string())?;
            version_from_package = package_json
                .get("version")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
        }

        files_done += 1;
        emit(ExtensionInstallEvent::Progress {
            phase: "extract",
            current_file: Some(normalized_name.clone()),
            files_done: Some(files_done),
            files_total: Some(files_total),
            bytes_done: None,
            bytes_total: None,
        });
        files.push((normalized_name, content));
    }

    let installed = match request {
        ExtensionInstallRequest::DotdirMarketplace {
            publisher,
            name,
            version,
        } => InstalledExtensionRef {
            publisher: publisher.clone(),
            name: name.clone(),
            version: version.clone(),
        },
        ExtensionInstallRequest::VscodeMarketplace { publisher, name, .. } => InstalledExtensionRef {
            publisher: publisher.clone(),
            name: name.clone(),
            version: version_from_package.unwrap_or_else(|| "0.0.0".to_string()),
        },
    };

    Ok((installed, files))
}

pub fn install_extension(
    request: ExtensionInstallRequest,
    cancel: CancelToken,
    emit: impl Fn(ExtensionInstallEvent),
) -> Result<InstalledExtensionRef, String> {
    let download_url = match &request {
        ExtensionInstallRequest::DotdirMarketplace {
            publisher,
            name,
            version,
        } => format!(
            "{}/api/extensions/{}/{}/{}/download",
            MARKETPLACE_URL, publisher, name, version
        ),
        ExtensionInstallRequest::VscodeMarketplace { download_url, .. } => download_url.clone(),
    };

    let archive_bytes = download_bytes(&download_url, &cancel, &emit)?;
    let (installed, files) = extract_archive(&archive_bytes, &request, &cancel, &emit)?;

    let extensions_dir = normalized_home_extensions_dir()?;
    let ext_dir = extensions_dir.join(extension_dir_name(&installed));
    fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;

    let files_total = files.len() as u32;
    for (idx, (name, content)) in files.iter().enumerate() {
        check_cancel(&cancel)?;
        let target = ext_dir.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, content).map_err(|e| e.to_string())?;
        emit(ExtensionInstallEvent::Progress {
            phase: "write",
            current_file: Some(name.clone()),
            files_done: Some((idx + 1) as u32),
            files_total: Some(files_total),
            bytes_done: None,
            bytes_total: None,
        });
    }

    check_cancel(&cancel)?;
    let mut refs = read_refs(&extensions_dir);
    refs.retain(|r| !(r.publisher == installed.publisher && r.name == installed.name));
    refs.push(installed.clone());
    write_refs(&extensions_dir, &refs)?;

    emit(ExtensionInstallEvent::Progress {
        phase: "finalize",
        current_file: None,
        files_done: Some(files_total),
        files_total: Some(files_total),
        bytes_done: None,
        bytes_total: None,
    });
    emit(ExtensionInstallEvent::Done {
        r#ref: installed.clone(),
    });
    Ok(installed)
}
