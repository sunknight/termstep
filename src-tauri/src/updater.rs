//! 对偶 src/main/updater.ts。reqwest 拉清单，对比版本，状态机 + emit。
//! 不自动下载安装（沿用现状：浏览器打开 DMG）。

use crate::types::UpdateState;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const MANIFEST_URL_DEFAULT: &str = "https://plainraw.com/raw/87c5a6f119b5";
const FETCH_TIMEOUT_MS: u64 = 10_000;

pub struct UpdaterState {
    pub state: UpdateState,
    pub checking: bool,
    pub notified_version: Option<String>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        UpdaterState {
            state: UpdateState::Idle,
            checking: false,
            notified_version: None,
        }
    }
}

// ── 纯函数（对偶 updater.ts，tests/updater.test.ts 覆盖）─────────────────────

/// 解析 "X.Y.Z" 为 (major,minor,patch)，非法返回 None。
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut nums = vec![];
    for p in parts {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        nums.push(p.parse::<u64>().ok()?);
    }
    Some((nums[0], nums[1], nums[2]))
}

/// 对比版本：>0 remote 更新，0 相等，<0 remote 更旧，None remote 非法。
pub fn compare_versions(remote: &str, current: &str) -> Option<i64> {
    let r = parse_semver(remote)?;
    let c = parse_semver(current)?;
    let cmp = |a: u64, b: u64| -> i64 {
        if a > b {
            1
        } else if a < b {
            -1
        } else {
            0
        }
    };
    let major = cmp(r.0, c.0);
    if major != 0 {
        return Some(major);
    }
    let minor = cmp(r.1, c.1);
    if minor != 0 {
        return Some(minor);
    }
    Some(cmp(r.2, c.2))
}

#[derive(Debug, PartialEq)]
pub struct ParsedManifest {
    pub version: String,
    pub url: String,
    pub notes: String,
}

/// 解析清单 JSON，非法返回 None。notes 缺省 ""。
pub fn parse_manifest(raw: &str) -> Option<ParsedManifest> {
    let obj: serde_json::Value = serde_json::from_str(raw).ok()?;
    let o = obj.as_object()?;
    let version = o.get("version")?.as_str()?.to_string();
    let url = o.get("url")?.as_str()?.to_string();
    if version.is_empty() || url.is_empty() {
        return None;
    }
    let notes = o.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some(ParsedManifest { version, url, notes })
}

// ── 状态机 + 网络（运行时）───────────────────────────────────────────────────

fn set_state(handle: &AppHandle, st: &Arc<Mutex<UpdaterState>>, next: UpdateState) {
    let to_emit = {
        let mut s = st.lock().unwrap();
        s.state = next.clone();
        s.state.clone()
    };
    let _ = handle.emit("update:state", &to_emit);
}

pub fn get_state(st: &Arc<Mutex<UpdaterState>>) -> UpdateState {
    st.lock().unwrap().state.clone()
}

/// 读取已通知版本（去重）。读 <userData>/update-state.json。
fn read_notified_version(state_file: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(state_file).ok()?;
    let obj: serde_json::Value = serde_json::from_str(&raw).ok()?;
    obj.get("version")?.as_str().map(|s| s.to_string())
}

fn write_notified_version(state_file: &std::path::Path, version: &str) {
    let _ = std::fs::write(
        state_file,
        serde_json::json!({ "version": version }).to_string(),
    );
}

/// 拉清单并更新状态。manual=true 把错误/idle 暴露给 UI；auto 静默。防重入。
pub async fn check_for_updates(
    handle: AppHandle,
    st: Arc<Mutex<UpdaterState>>,
    app_version: String,
    state_file: std::path::PathBuf,
    manual: bool,
) -> UpdateState {
    {
        let mut s = st.lock().unwrap();
        if s.checking {
            return s.state.clone();
        }
        s.checking = true;
    }
    let result = check_inner(&handle, &st, &app_version, &state_file, manual).await;
    st.lock().unwrap().checking = false;
    result
}

async fn check_inner(
    handle: &AppHandle,
    st: &Arc<Mutex<UpdaterState>>,
    app_version: &str,
    state_file: &std::path::Path,
    manual: bool,
) -> UpdateState {
    let url =
        std::env::var("TERMSTEP_UPDATE_URL").unwrap_or_else(|_| MANIFEST_URL_DEFAULT.to_string());
    let raw = match fetch_manifest(&url).await {
        Ok(r) => r,
        Err(_) => {
            if manual {
                set_state(
                    handle,
                    st,
                    UpdateState::Error {
                        error: "检查更新失败，请检查网络后重试".into(),
                    },
                );
            }
            return get_state(st);
        }
    };
    let manifest = match parse_manifest(&raw) {
        Some(m) => m,
        None => {
            if manual {
                set_state(
                    handle,
                    st,
                    UpdateState::Error {
                        error: "更新信息格式无效".into(),
                    },
                );
            }
            return get_state(st);
        }
    };
    match compare_versions(&manifest.version, app_version) {
        None => {
            if manual {
                set_state(
                    handle,
                    st,
                    UpdateState::Error {
                        error: "更新版本号格式无效".into(),
                    },
                );
            }
        }
        Some(cmp) => {
            if cmp > 0 {
                // 去重：auto 检查对已通知版本保持 idle
                let already = st
                    .lock()
                    .unwrap()
                    .notified_version
                    .as_deref()
                    .map(|v| v == manifest.version)
                    .unwrap_or(false)
                    || read_notified_version(state_file).as_deref() == Some(&manifest.version);
                if !(manual == false && already) {
                    set_state(
                        handle,
                        st,
                        UpdateState::Available {
                            version: manifest.version.clone(),
                            url: manifest.url.clone(),
                            notes: manifest.notes.clone(),
                        },
                    );
                    st.lock().unwrap().notified_version = Some(manifest.version.clone());
                    write_notified_version(state_file, &manifest.version);
                }
            } else if manual {
                set_state(handle, st, UpdateState::UpToDate);
            }
        }
    }
    get_state(st)
}

async fn fetch_manifest(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()).into());
    }
    Ok(resp.text().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_patch_newer() {
        assert!(compare_versions("0.4.0", "0.3.0").unwrap() > 0);
    }
    #[test]
    fn compare_equal() {
        assert_eq!(compare_versions("0.3.0", "0.3.0").unwrap(), 0);
    }
    #[test]
    fn compare_older() {
        assert!(compare_versions("0.2.0", "0.3.0").unwrap() < 0);
    }
    #[test]
    fn compare_numeric_not_lexic() {
        assert!(compare_versions("1.0.0", "0.9.9").unwrap() > 0);
    }
    #[test]
    fn compare_two_digit_segments() {
        assert!(compare_versions("0.10.0", "0.9.0").unwrap() > 0);
    }
    #[test]
    fn compare_invalid_abc() {
        assert!(compare_versions("abc", "0.3.0").is_none());
    }
    #[test]
    fn compare_invalid_two_parts() {
        assert!(compare_versions("1.2", "0.3.0").is_none());
    }
    #[test]
    fn compare_invalid_four_parts() {
        assert!(compare_versions("1.2.3.4", "0.3.0").is_none());
    }

    #[test]
    fn manifest_valid() {
        let r = parse_manifest(r#"{"version":"0.4.0","url":"https://x/d.dmg","notes":"fix"}"#).unwrap();
        assert_eq!(r.version, "0.4.0");
        assert_eq!(r.url, "https://x/d.dmg");
        assert_eq!(r.notes, "fix");
    }
    #[test]
    fn manifest_notes_defaults_empty() {
        let r = parse_manifest(r#"{"version":"0.4.0","url":"https://x/d.dmg"}"#).unwrap();
        assert_eq!(r.notes, "");
    }
    #[test]
    fn manifest_invalid_json() {
        assert!(parse_manifest("not json").is_none());
    }
    #[test]
    fn manifest_missing_version() {
        assert!(parse_manifest(r#"{"url":"x"}"#).is_none());
    }
    #[test]
    fn manifest_missing_url() {
        assert!(parse_manifest(r#"{"version":"0.4.0"}"#).is_none());
    }
    #[test]
    fn manifest_version_not_string() {
        assert!(parse_manifest(r#"{"version":4,"url":"x"}"#).is_none());
    }
    #[test]
    fn manifest_url_not_string() {
        assert!(parse_manifest(r#"{"version":"0.4.0","url":5}""#).is_none());
    }
}
