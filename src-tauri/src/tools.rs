//! 对偶 src/main/toolsScanner.ts。scan 工具目录 + fetch 远程 md（含敏感路径守卫）。

use crate::pure::parse_tool_meta;
use crate::types::*;
use regex::Regex;
use std::path::Path;

pub const DEFAULT_AUTO_UPDATE_MINUTES: i64 = 0;

// ── 敏感路径守卫（对偶 toolsScanner.ts）──────────────────────────────────────
const SENSITIVE_DIR_SEGMENTS: &[&str] = &[
    ".ssh",
    ".aws",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".gnupg",
    "Library/Keychains",
    "Library/Cookies",
    ".password-store",
];

fn sensitive_file_patterns() -> Vec<Regex> {
    vec![
        Regex::new(r"(?i)^\.env(\..*)?$").unwrap(),
        Regex::new(r"(?i)^\.netrc$").unwrap(),
        Regex::new(r"(?i)^\.npmrc$").unwrap(),
        Regex::new(r"(?i)^\.pypirc$").unwrap(),
        Regex::new(r"(?i)^\.my\.cnf$").unwrap(),
        Regex::new(r"(?i)^id_[a-z0-9]+$").unwrap(),
        Regex::new(r"(?i)^_netrc$").unwrap(),
        Regex::new(r"(?i)^credentials(\..*)?$").unwrap(),
        Regex::new(r"(?i)^.*\.key$").unwrap(),
        Regex::new(r"(?i)^.*\.pem$").unwrap(),
        Regex::new(r"(?i)^.*\.pfx$").unwrap(),
        Regex::new(r"(?i)^.*\.keystore$").unwrap(),
    ]
}

/// 路径敏感则返回人类可读理由，否则 None。
pub fn sensitive_path_reason(p: &str) -> Option<String> {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut abs = p.replace('\\', "/");
    if abs.starts_with("~/") {
        abs = format!("{}/{}", home, &abs[2..]);
    }
    let lower = abs.to_lowercase();
    for seg in SENSITIVE_DIR_SEGMENTS {
        let s = seg.to_lowercase();
        if lower.contains(&format!("/{}/", s)) || lower.ends_with(&format!("/{}", s)) {
            return Some(format!("路径位于敏感目录 (/{}/)", seg));
        }
    }
    let base = lower.rsplit('/').next().unwrap_or("").to_string();
    for re in sensitive_file_patterns() {
        if re.is_match(&base) {
            return Some(format!("文件名疑似凭据文件 ({})", base));
        }
    }
    None
}

// ── fetchRemoteMarkdown（对偶 toolsScanner.ts）───────────────────────────────
/// is_local_path: file:// 或非 http/https/data 的 URL scheme 视为本地路径。
fn is_local_path(url: &str) -> bool {
    if url.starts_with("file://") {
        return true;
    }
    // 找 scheme: 若以 <letter>...: 开头且 scheme 是 http/https/data → 远程；否则本地
    let bytes = url.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() && bytes[idx] != b':' {
        idx += 1;
    }
    if idx == 0 || idx >= bytes.len() {
        // 无 scheme → 本地路径
        return true;
    }
    let scheme = &url[..idx];
    let valid_scheme = scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    if !valid_scheme {
        return true; // 非合法 scheme → 当本地路径
    }
    !matches!(scheme.to_lowercase().as_str(), "http" | "https" | "data")
}

pub struct FetchedMd {
    pub markdown: String,
    pub error: Option<String>,
}

pub async fn fetch_remote_markdown(url: &str) -> FetchedMd {
    if is_local_path(url) {
        let p = if let Some(stripped) = url.strip_prefix("file://") {
            stripped.to_string()
        } else {
            url.to_string()
        };
        if let Some(reason) = sensitive_path_reason(&p) {
            return FetchedMd {
                markdown: String::new(),
                error: Some(format!("拒绝读取敏感文件: {}", reason)),
            };
        }
        match tokio::fs::read_to_string(&p).await {
            Ok(text) => FetchedMd { markdown: text, error: None },
            Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
        }
    } else {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(8000))
            .build()
            .unwrap();
        match client.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return FetchedMd {
                        markdown: String::new(),
                        error: Some(format!("HTTP {}", resp.status())),
                    };
                }
                match resp.text().await {
                    Ok(t) => FetchedMd { markdown: t, error: None },
                    Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
                }
            }
            Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
        }
    }
}

// ── scanTools（对偶 toolsScanner.ts）──────────────────────────────────────────
pub async fn scan_tools(tools_dir: &Path) -> ScanResult {
    let mut result = ScanResult::default();
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(e) => e,
        Err(_) => return result, // 目录缺失 → 空
    };
    for entry in entries.flatten() {
        let filetype = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !filetype.is_dir() {
            continue;
        }
        let child = entry.path();
        let id = child
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let tool_json_path = child.join("tool.json");
        let meta_raw: serde_json::Value = if tool_json_path.exists() {
            match std::fs::read_to_string(&tool_json_path) {
                Ok(s) => match serde_json::from_str(&s) {
                    Ok(v) => v,
                    Err(e) => {
                        // present-but-unparseable → skip + report
                        result.errors.push(ScanError {
                            id: id.clone(),
                            message: format!("tool.json 解析失败: {}", e),
                        });
                        continue;
                    }
                },
                Err(e) => {
                    result.errors.push(ScanError {
                        id: id.clone(),
                        message: format!("tool.json 解析失败: {}", e),
                    });
                    continue;
                }
            }
        } else {
            serde_json::Value::Object(Default::default())
        };
        let mut meta = parse_tool_meta(&meta_raw, &id);

        // help.md 总是读（本地可编辑源）
        let help_markdown = std::fs::read_to_string(child.join("help.md")).unwrap_or_default();

        // 可选远程 md（与 helpMarkdown 分开，不清除本地）
        let mut remote_markdown = None;
        if let Some(md_url) = meta.md_url.clone() {
            if meta.auto_update_minutes.is_none() {
                meta.auto_update_minutes = Some(DEFAULT_AUTO_UPDATE_MINUTES);
            }
            let fetched = fetch_remote_markdown(&md_url).await;
            if fetched.markdown.is_empty() && fetched.error.is_some() {
                result.errors.push(ScanError {
                    id: id.clone(),
                    message: format!("远程帮助加载失败 ({}): {}", md_url, fetched.error.unwrap()),
                });
            } else {
                remote_markdown = Some(fetched.markdown);
            }
        }
        result.tools.push(Tool {
            meta,
            help_markdown,
            remote_markdown,
        });
    }
    result.tools.sort_by(|a, b| {
        a.meta
            .order
            .cmp(&b.meta.order)
            .then_with(|| a.meta.id.cmp(&b.meta.id))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn write_tool(dir: &Path, id: &str, json: Option<&str>, md: &str) -> PathBuf {
        let t = dir.join(id);
        tokio::fs::create_dir_all(&t).await.unwrap();
        if let Some(j) = json {
            tokio::fs::write(t.join("tool.json"), j).await.unwrap();
        }
        tokio::fs::write(t.join("help.md"), md).await.unwrap();
        t
    }

    // tempfile::TempDir 给每个测试一个唯一目录，并在 drop 时自动清理，
    // 避免 nanos 时间戳并行冲突。
    fn tmp() -> TempDir {
        TempDir::new().unwrap()
    }

    #[tokio::test]
    async fn scan_empty_when_dir_missing() {
        let r = scan_tools(&Path::new("/nonexistent-xyz-123")).await;
        assert!(r.tools.is_empty());
        assert!(r.errors.is_empty());
    }

    #[tokio::test]
    async fn scan_defaults_when_tool_json_missing() {
        let _dir = tmp();
        let dir = _dir.path();
        write_tool(&dir, "git", None, "# Git").await;
        let r = scan_tools(&dir).await;
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].meta.name, "git");
        assert_eq!(r.tools[0].help_markdown, "# Git");
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn scan_parses_and_sorts_by_order() {
        let _dir = tmp();
        let dir = _dir.path();
        write_tool(&dir, "b", Some(r#"{"name":"B","order":2}"#), "").await;
        write_tool(&dir, "a", Some(r#"{"name":"A","order":1}"#), "").await;
        let r = scan_tools(&dir).await;
        let ids: Vec<_> = r.tools.iter().map(|t| t.meta.id.clone()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn scan_skips_invalid_json_and_reports() {
        let _dir = tmp();
        let dir = _dir.path();
        write_tool(&dir, "bad", Some("{ not json"), "").await;
        write_tool(&dir, "good", Some(r#"{"name":"Good"}"#), "").await;
        let r = scan_tools(&dir).await;
        let ids: Vec<_> = r.tools.iter().map(|t| t.meta.id.clone()).collect();
        assert_eq!(ids, vec!["good"]);
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0].id, "bad");
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn scan_ignores_non_dir_entries() {
        let _dir = tmp();
        let dir = _dir.path();
        tokio::fs::write(dir.join("stray.txt"), "x").await.unwrap();
        let r = scan_tools(&dir).await;
        assert!(r.tools.is_empty());
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn scan_reads_local_path_mdurl() {
        let _dir = tmp();
        let dir = _dir.path();
        let ext = write_md(&dir, "remote.md", "# From File").await;
        let json = format!(r#"{{"name":"A","mdUrl":{:?}}}"#, ext.to_string_lossy());
        write_tool(&dir, "a", Some(&json), "# Local").await;
        let r = scan_tools(&dir).await;
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].remote_markdown, Some("# From File".into()));
        assert_eq!(r.tools[0].help_markdown, "# Local");
        assert!(r.errors.is_empty());
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    async fn write_md(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        tokio::fs::write(&p, content).await.unwrap();
        p
    }

    // ── fetchRemoteMarkdown 本地路径 + 敏感守卫（对齐 toolsScanner.test.ts）────
    #[tokio::test]
    async fn fetch_reads_absolute_path() {
        let _dir = tmp();
        let dir = _dir.path();
        let p = write_md(&dir, "note.md", "hello").await;
        let r = fetch_remote_markdown(&p.to_string_lossy()).await;
        assert_eq!(r.markdown, "hello");
        assert!(r.error.is_none());
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_reports_error_for_missing_file() {
        let r = fetch_remote_markdown("/nonexistent-xyz-123/note.md").await;
        assert_eq!(r.markdown, "");
        assert!(r.error.is_some());
    }

    async fn expect_blocked(dir: &Path, rel: &str) {
        let full = dir.join(rel);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await.unwrap();
        }
        tokio::fs::write(&full, "SECRET").await.unwrap();
        let r = fetch_remote_markdown(&full.to_string_lossy()).await;
        assert_eq!(r.markdown, "", "expected blocked for {}", rel);
        let err = r.error.expect("expected error for blocked path");
        assert!(
            err.contains("敏感") || err.contains("拒绝"),
            "error should mention sensitive: got {}",
            err
        );
    }

    // 把 TempDir 转成 &Path 的便捷包装：调用 `let dir = tmp(); let p = dir.path();`
    // 后续用 p。TempDir 在 dir 析构时自动清理，无需手动 remove。

    #[tokio::test]
    async fn fetch_blocks_ssh_dir() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, ".ssh/id_rsa").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_aws_dir() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, ".aws/credentials").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_kube_dir() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, ".kube/config").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_id_key_by_name_anywhere() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, "notes/id_ed25519").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_env_anywhere() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, "project/.env.local").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_key_and_pem() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, "certs/server.key").await;
        expect_blocked(&dir, "certs/server.pem").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_blocks_keychains_dir() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, "Library/Keychains/login.keychain-db").await;
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    #[tokio::test]
    async fn fetch_allows_normal_md() {
        let _dir = tmp();
        let dir = _dir.path();
        let p = dir.join("docs/guide.md");
        tokio::fs::create_dir_all(p.parent().unwrap()).await.unwrap();
        tokio::fs::write(&p, "# ok").await.unwrap();
        let r = fetch_remote_markdown(&p.to_string_lossy()).await;
        assert_eq!(r.markdown, "# ok");
        assert!(r.error.is_none());
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    // ── is_local_path 单元 ─────────────────────────────────────────────────────
    #[test]
    fn local_path_detects_file_url() {
        assert!(is_local_path("file:///etc/hosts"));
    }
    #[test]
    fn local_path_detects_bare_path() {
        assert!(is_local_path("/Users/x/note.md"));
    }
    #[test]
    fn local_path_rejects_http() {
        assert!(!is_local_path("https://example.com/a.md"));
    }
    #[test]
    fn local_path_rejects_data() {
        assert!(!is_local_path("data:text/plain,hi"));
    }
}
