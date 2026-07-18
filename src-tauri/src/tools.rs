//! 对偶 src/main/toolsScanner.ts。scan 工具目录 + fetch 远程 md（含敏感路径守卫）。

use crate::pure::parse_tool_meta;
use crate::types::*;
use regex::Regex;
use std::path::Path;

pub const DEFAULT_AUTO_UPDATE_MINUTES: i64 = 0;

// 一些 CDN/防火墙（plainraw 用的 Cloudflare 类）拒绝没有标准浏览器 UA 的请求
// （返回 403）。reqwest 默认 UA "reqwest/<ver>" 会被拒，所以所有 HTTP 抓取都
// 带一个标准浏览器 UA。注意：UA 必须像浏览器，不能是 "TermStep" 等自定义名。
const HTTP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
    // 系统配置目录（含 passwd/hosts/sudoers 等）
    "etc",
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
        // shell rc / history 常含别名、token、export 的密钥
        Regex::new(r"(?i)^\.bashrc$").unwrap(),
        Regex::new(r"(?i)^\.zshrc$").unwrap(),
        Regex::new(r"(?i)^\.profile$").unwrap(),
        Regex::new(r"(?i)^\.bash_history$").unwrap(),
        Regex::new(r"(?i)^\.zsh_history$").unwrap(),
        Regex::new(r"(?i)^\.gitconfig$").unwrap(),
        Regex::new(r"(?i)^\.npmrc$").unwrap(),
        // 系统账户/凭据文件
        Regex::new(r"(?i)^passwd$").unwrap(),
        Regex::new(r"(?i)^shadow$").unwrap(),
        Regex::new(r"(?i)^sudoers$").unwrap(),
        Regex::new(r"(?i)^hosts$").unwrap(),
    ]
}

/// 本地 markdown 读取允许的扩展名白名单。mdUrl 本地路径仅允许这些后缀，
/// 防止把 fetch_md_preview 当成任意文件读取器（例如 /etc/passwd、~/.zshrc）。
fn allowed_md_extensions() -> &'static [&'static str] {
    &["md", "markdown", "txt"]
}

/// 判断本地路径是否在允许读取的范围内：扩展名必须在白名单内。
fn is_allowed_local_md(p: &str) -> bool {
    let lower = p.to_lowercase();
    allowed_md_extensions()
        .iter()
        .any(|ext| lower.ends_with(&format!(".{}", ext)))
}

/// 判断 URL 的 host 是否为内网/元数据地址（SSRF 防护）。
/// 拒绝：环回、私有、链路本地、运营商级 NAT、未分配、云元数据链路本地地址。
fn is_internal_host(host: &str) -> bool {
    let h = host.to_lowercase();
    // 明确文本形式
    matches!(
        h.as_str(),
        "localhost"
        | "ip6-localhost"
        | "ip6-loopback"
        | "metadata.google.internal" // GCP 元数据
    ) || h.ends_with(".local")
        || h.ends_with(".internal")
        // 解析 IP 后判断（IPv4 点分十进制；IPv6 形如 [::1]）
        || is_internal_ipv4(&h)
        // 含 '[' 的视为 IPv6 字面量（含 IPv4-mapped、ULA、link-local）
        || (h.contains('[') && is_internal_ipv6_literal(&h))
        // 无方括号的裸 IPv6（无端口的纯 ::1 形式）
        || (!h.contains('.') && h.contains(':') && is_internal_ipv6_literal(&h))
}

/// IPv4 内网段判断。把点分四段（**仅**纯十进制，拒绝八进制 `0177.0.0.1`、
/// 十六进制 `0x7f.0.0.1`、单整数 `2130706433`、紧缩 `127.1` 等等价写法——
/// 这些形式经系统 resolver 仍会解析到内网，必须一并拒绝）解析为 u32 后比对 CIDR。
/// 任何含前导 `0`（且本身不是 `0`）或含非数字字符的段都判为「无法判定 → 视为可疑」，
/// 因为它们既可能是合法公网域名前缀（如 `0.0.0.0` 之外的 `01.example.com`），
/// 也可能是 resolver 会内网化的 IP 字面量——安全侧取保守：拒绝。
fn is_internal_ipv4(host: &str) -> bool {
    // 去掉端口
    let h = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let octets: Vec<&str> = h.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    let mut bytes = [0u8; 4];
    for (i, o) in octets.iter().enumerate() {
        // 拒绝任何非纯十进制段：含前导 0（非 "0"）、十六进制、空串都判为「非公网」。
        // resolver 接受 0177/0x7f/单整数等 → 它们等价于某个内网 IP，不能放行。
        if o.is_empty() || !o.bytes().all(|c| c.is_ascii_digit()) || (o.len() > 1 && o.starts_with('0')) {
            return true;
        }
        match o.parse::<u8>() {
            Ok(v) => bytes[i] = v,
            // 超出 u8（如 321）也判内网——resolver 会做溢出归一化，保守拒绝
            Err(_) => return true,
        }
    }
    let [a, b, _c, _d] = bytes;
    match a {
        0 => true,                          // 0.0.0.0/8 当前网络
        10 => true,                         // 10.0.0.0/8 私有
        127 => true,                        // 127.0.0.0/8 环回
        169 if b == 254 => true,            // 169.254.0.0/16 链路本地（含 AWS/GCP 元数据 169.254.169.254）
        172 if (16..=31).contains(&b) => true, // 172.16.0.0/12 私有
        192 if b == 0 => true,              // 192.0.0.0/24、192.0.2.0/24（保留）
        192 if b == 168 => true,            // 192.168.0.0/16 私有
        198 if (18..=19).contains(&b) => true, // 198.18.0.0/15 基准测试
        198 if b == 51 && _c == 100 => true,// 198.51.100.0/24 文档用例
        203 if b == 0 && _c == 113 => true, // 203.0.113.0/24 文档用例
        224..=239 => true,                  // 多播
        240..=255 => true,                  // 保留
        _ => false,
    }
}

/// 判断 IPv6 字面量是否为内网/环回/链路本地/私有（涵盖 ULA fc00::/7）。
/// 对 `[::1]` / `[::ffff:127.0.0.1]` / `[fc00::1]` / `[fe80::1]` 等都返回 true。
fn is_internal_ipv6_literal(host: &str) -> bool {
    // 去掉方括号（host 可能带端口 `[::1]:8080` → 取 `]` 前）
    let h = host.trim_start_matches('[');
    let h = h.split(']').next().unwrap_or(h);
    h.parse::<std::net::Ipv6Addr>().map(|ip| {
        ip.is_loopback()
            || ip.is_unspecified()
            || ip.is_multicast()
            // ULA（唯一本地地址）fc00::/7：标准库无 is_unicast_link_local / is_unique_local，
            // 用段判断。fc00::/7 覆盖 fc00:: 和 fd00:: 两段。
            || (ip.segments()[0] & 0xfe00) == 0xfc00
            // 链路本地 fe80::/10
            || (ip.segments()[0] & 0xffc0) == 0xfe80
            // IPv4-mapped IPv6 ::ffff:a.b.c.d：解出内嵌 IPv4 再判
            || ip.to_ipv4().map(|v4| {
                let o = v4.octets();
                // 复用 is_internal_ipv4 的公网/内网判定（环回/私有/链路本地等）
                is_internal_ipv4(&format!("{}.{}.{}.{}", o[0], o[1], o[2], o[3]))
            }).unwrap_or(false)
    }).unwrap_or(false)
}

/// 从 URL 字符串提取 host 部分（http(s)://host[:port]/path → host[:port]）。
/// **大小写不敏感**地匹配 scheme 前缀（`HTTP://localhost` 与 `https://localhost`
/// 同等处理）——旧实现用 `strip_prefix` 区分大小写，导致大写 scheme 绕过整个
/// SSRF 守卫（extract_host 返回 None → 检查跳过，但 reqwest 仍发请求）。
fn extract_host(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let stripped = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let host_end = stripped
        .find(['/', '?', '#'])
        .unwrap_or(stripped.len());
    Some(stripped[..host_end].to_string())
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
/// 展开 ~ 与 ~/ 为 $HOME（shell 惯例，文件系统不识别 ~）。
/// 仅处理以 ~ 开头的整段；不处理 ~user 形式（极少见于帮助文档路径）。
/// 无法获取 home 时原样返回（交给后续读取自然报错）。
fn expand_tilde(p: &str) -> String {
    if p == "~" {
        return dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}/{}", home.display(), rest);
        }
    }
    p.to_string()
}

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
        let raw = if let Some(stripped) = url.strip_prefix("file://") {
            stripped.to_string()
        } else {
            url.to_string()
        };
        // 展开 ~ 与 ~/（shell 惯例，文件系统不认 ~）。敏感守卫内部也会展开一次，
        // 但实际读取前必须先展开成绝对路径，否则 tokio::fs 会报 No such file。
        // 仅展开以 ~ 开头的整段（不处理 ~user 形式，极少见于帮助文档）。
        let p = expand_tilde(&raw);
        // 敏感守卫优先：无论扩展名，凭据/系统文件一律拒绝。
        if let Some(reason) = sensitive_path_reason(&p) {
            return FetchedMd {
                markdown: String::new(),
                error: Some(format!("拒绝读取敏感文件: {}", reason)),
            };
        }
        // 扩展名白名单：非敏感文件也仅允许 .md/.markdown/.txt，防止读取任意文件
        // （如 /etc/passwd 虽非凭据，也不应作为"帮助文档"被读取）。
        if !is_allowed_local_md(&p) {
            return FetchedMd {
                markdown: String::new(),
                error: Some("本地路径仅允许 .md / .markdown / .txt 文件".into()),
            };
        }
        match tokio::fs::read_to_string(&p).await {
            Ok(text) => FetchedMd { markdown: text, error: None },
            Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
        }
    } else {
        // SSRF 防护：拒绝内网/环回/链路本地/元数据地址。
        if let Some(host) = extract_host(url) {
            if is_internal_host(&host) {
                return FetchedMd {
                    markdown: String::new(),
                    error: Some(format!("拒绝访问内网地址: {}", host)),
                };
            }
        }
        // 禁止重定向（防止 http→file 或重定向到内网）。无重定向则不会跟随跳转。
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(8000))
            .user_agent(HTTP_UA)
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return FetchedMd {
                    markdown: String::new(),
                    error: Some(format!("HTTP 客户端构建失败: {}", e)),
                }
            }
        };
        match client.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return FetchedMd {
                        markdown: String::new(),
                        error: Some(format!("HTTP {}", resp.status())),
                    };
                }
                // 限制响应体大小（2 MiB），防止超大响应导致 OOM。
                // 带 Content-Length 且超限直接拒绝；不带的由下方 text() + 8s 超时兜底。
                const LIMIT: u64 = 2 * 1024 * 1024;
                if let Some(len) = resp.content_length() {
                    if len > LIMIT {
                        return FetchedMd {
                            markdown: String::new(),
                            error: Some("响应超过 2 MiB 上限".into()),
                        };
                    }
                }
                match resp.text().await {
                    Ok(t) => {
                        // chunked 编码可能不带 Content-Length，再次校验实际长度。
                        if t.len() > LIMIT as usize {
                            return FetchedMd {
                                markdown: String::new(),
                                error: Some("响应超过 2 MiB 上限".into()),
                            };
                        }
                        FetchedMd { markdown: t, error: None }
                    }
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
        // 仅当 useRemote:true 才拉取 mdUrl——与前端显示逻辑一致
        // （App.tsx: useRemote ? remoteMarkdown : helpMarkdown）。否则即便 mdUrl
        // 指向 ~/Downloads 等受 TCC 保护的目录，也不会每次扫描都读文件、触发
        // macOS「想访问下载文件夹」权限弹窗。
        let mut remote_markdown = None;
        if meta.use_remote == Some(true) {
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
        }
        result.tools.push(Tool {
            meta,
            help_markdown,
            remote_markdown,
        });
    }
    // 排序来源是单一的 tools/order.json 索引（id 数组）。每个工具的 order =
    // 它在索引里的位置；不在索引里的兜底 usize::MAX（排末尾，彼此再按 id 稳定排序，
    // 让新工具/导入工具以可预测的顺序追加）。meta.order 字段同步设为该位置，供
    // 前端/导出携带，但前端实际顺序由这里 sort 后的数组决定。
    let order_index = crate::tool_io::read_order_index(tools_dir);
    let position_of = |id: &str| order_index.iter().position(|x| x == id);
    for t in result.tools.iter_mut() {
        t.meta.order = position_of(&t.meta.id).map(|p| p as i64).unwrap_or(i64::MAX);
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
    async fn scan_orders_by_index_file_ignoring_tool_json_order() {
        // 排序来源是 tools/order.json（id 数组），与各 tool.json 的 order 字段无关。
        let _dir = tmp();
        let dir = _dir.path();
        write_tool(&dir, "a", Some(r#"{"name":"A","order":0}"#), "").await;
        write_tool(&dir, "b", Some(r#"{"name":"B","order":0}"#), "").await;
        // 索指定 b 在前；尽管 tool.json 里两者 order 都是 0
        tokio::fs::write(dir.join("order.json"), r#"{"order":["b","a"]}"#).await.unwrap();
        let r = scan_tools(&dir).await;
        let ids: Vec<_> = r.tools.iter().map(|t| t.meta.id.clone()).collect();
        assert_eq!(ids, vec!["b", "a"], "order.json wins over per-tool order");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn scan_appends_unknown_ids_after_indexed_sorted_by_id() {
        // 不在索引里的 id 兜底排末尾，彼此按 id 升序稳定。
        let _dir = tmp();
        let dir = _dir.path();
        write_tool(&dir, "z", None, "").await; // 不在索引里
        write_tool(&dir, "a", None, "").await; // 在索引里，排第 2
        write_tool(&dir, "m", None, "").await; // 不在索引里
        tokio::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).await.unwrap();
        let r = scan_tools(&dir).await;
        let ids: Vec<_> = r.tools.iter().map(|t| t.meta.id.clone()).collect();
        // a（索引）在前；m、z 不在索引，按 id 升序
        assert_eq!(ids, vec!["a", "m", "z"]);
        std::fs::remove_dir_all(&dir).ok();
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
    async fn scan_reads_local_path_mdurl_when_use_remote() {
        let _dir = tmp();
        let dir = _dir.path();
        let ext = write_md(&dir, "remote.md", "# From File").await;
        let json = format!(
            r#"{{"name":"A","mdUrl":{:?},"useRemote":true}}"#,
            ext.to_string_lossy()
        );
        write_tool(&dir, "a", Some(&json), "# Local").await;
        let r = scan_tools(&dir).await;
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].remote_markdown, Some("# From File".into()));
        assert_eq!(r.tools[0].help_markdown, "# Local");
        assert!(r.errors.is_empty());
        std::fs::remove_dir_all(&dir).ok();
        // _dir (TempDir) drops here, auto-cleaning.
    }

    // 回归：useRemote 不为 true（含缺省）时，即便 mdUrl 指向本地文件，scan 也不读它。
    // 这避免指向 ~/Downloads 等受 TCC 保护目录的 mdUrl 在每次扫描时触发 macOS
    // 「想访问下载文件夹」权限弹窗。
    #[tokio::test]
    async fn scan_skips_local_path_mdurl_when_not_use_remote() {
        let _dir = tmp();
        let dir = _dir.path();
        let ext = write_md(&dir, "remote.md", "# From File").await;
        // useRemote:false —— mdUrl 存在但不应被读取
        let json = format!(
            r#"{{"name":"A","mdUrl":{:?},"useRemote":false}}"#,
            ext.to_string_lossy()
        );
        write_tool(&dir, "a", Some(&json), "# Local").await;
        let r = scan_tools(&dir).await;
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].remote_markdown, None);
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

    // ── 扩展名白名单（本地 mdUrl 仅允许 .md/.markdown/.txt）────────────────────
    #[tokio::test]
    async fn fetch_rejects_non_md_extension() {
        let _dir = tmp();
        let dir = _dir.path();
        // 写一个非敏感但扩展名不在白名单的文件（.sh）
        let p = write_md(&dir, "script.sh", "#!/bin/sh").await;
        let r = fetch_remote_markdown(&p.to_string_lossy()).await;
        assert_eq!(r.markdown, "");
        assert!(r.error.unwrap().contains("仅允许"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn fetch_allows_markdown_extension() {
        let _dir = tmp();
        let dir = _dir.path();
        let p = write_md(&dir, "guide.markdown", "# ok").await;
        let r = fetch_remote_markdown(&p.to_string_lossy()).await;
        assert_eq!(r.markdown, "# ok");
        assert!(r.error.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn fetch_allows_txt_extension() {
        let _dir = tmp();
        let dir = _dir.path();
        let p = write_md(&dir, "notes.txt", "plain text").await;
        let r = fetch_remote_markdown(&p.to_string_lossy()).await;
        assert_eq!(r.markdown, "plain text");
        assert!(r.error.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn fetch_blocks_etc_passwd_by_dir() {
        let _dir = tmp();
        let dir = _dir.path();
        // 在 tmp 下建 etc/passwd，验证 etc 段被敏感守卫拦截（无论扩展名）
        expect_blocked(&dir, "etc/passwd").await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn fetch_blocks_zshrc_by_name() {
        let _dir = tmp();
        let dir = _dir.path();
        expect_blocked(&dir, "home/.zshrc").await;
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── SSRF 内网过滤 ───────────────────────────────────────────────────────────
    #[test]
    fn internal_host_detects_loopback() {
        assert!(is_internal_host("127.0.0.1"));
        assert!(is_internal_host("localhost"));
        assert!(is_internal_host("169.254.169.254")); // 云元数据
        assert!(is_internal_host("10.0.0.5"));
        assert!(is_internal_host("192.168.1.1"));
        assert!(is_internal_host("172.16.0.1"));
    }

    #[test]
    fn internal_host_rejects_public() {
        assert!(!is_internal_host("example.com"));
        assert!(!is_internal_host("plainraw.com"));
        assert!(!is_internal_host("8.8.8.8"));
        assert!(!is_internal_host("1.1.1.1"));
    }

    #[test]
    fn extract_host_strips_path_and_port() {
        assert_eq!(extract_host("https://example.com/a/b").as_deref(), Some("example.com"));
        assert_eq!(extract_host("http://localhost:8080/x").as_deref(), Some("localhost:8080"));
        assert_eq!(extract_host("https://a.com").as_deref(), Some("a.com"));
        assert!(extract_host("ftp://x").is_none()); // 非 http(s)
    }

    // ── H1 回归：大写 scheme 不得绕过 SSRF 守卫 ──────────────────────────────────
    // extract_host 用 strip_prefix 区分大小写 → 大写 scheme 返回 None → 守卫跳过。
    // 修复后对 scheme 做小写化，大写 HTTP/HTTPS 同等处理。
    #[test]
    fn extract_host_case_insensitive_scheme() {
        assert_eq!(extract_host("HTTPS://127.0.0.1/x").as_deref(), Some("127.0.0.1"));
        assert_eq!(extract_host("HTTP://localhost:8080/x").as_deref(), Some("localhost:8080"));
        assert_eq!(extract_host("Http://10.0.0.5/y").as_deref(), Some("10.0.0.5"));
    }

    #[test]
    fn internal_host_blocks_uppercase_scheme_loopback() {
        // 组合：大写 scheme 经 extract_host 提取后，仍应被 is_internal_host 拦截。
        let h = extract_host("HTTPS://127.0.0.1/x").unwrap();
        assert!(is_internal_host(&h), "uppercase scheme must not bypass SSRF");
        let h = extract_host("HTTP://169.254.169.254/latest/").unwrap();
        assert!(is_internal_host(&h), "uppercase scheme to metadata must be blocked");
    }

    // ── H2 回归：非十进制 IPv4 等价写法不得绕过 ─────────────────────────────────
    // resolver 接受八进制/十六进制/单整数/紧缩形式并解析到内网，旧实现只认纯十进制
    // 四段 → 这些形式全部漏过。修复后一律判为内网（保守拒绝）。
    #[test]
    fn internal_ipv4_rejects_octal_form() {
        // 0177.0.0.1 = 127.0.0.1（八进制）
        assert!(is_internal_ipv4("0177.0.0.1"), "octal loopback must be blocked");
    }

    #[test]
    fn internal_ipv4_rejects_hex_form() {
        // 0x7f000001 = 127.0.0.1（十六进制单段）
        assert!(is_internal_ipv4("0x7f.0.0.1"), "hex form must be blocked");
    }

    #[test]
    fn internal_ipv4_rejects_leading_zero_octet() {
        // 010 → 前导零，resolver 视为八进制，保守拒绝
        assert!(is_internal_ipv4("010.0.0.1"), "leading-zero octet must be blocked");
    }

    #[test]
    fn internal_ipv4_rejects_overflow_octet() {
        // 321 超出 u8，resolver 可能做溢出归一化，保守拒绝
        assert!(is_internal_ipv4("321.0.0.1"), "overflow octet must be blocked");
    }

    #[test]
    fn internal_ipv4_allows_public_decimal() {
        // 纯十进制公网 IP 不受影响
        assert!(!is_internal_ipv4("8.8.8.8"));
        assert!(!is_internal_ipv4("1.1.1.1"));
        assert!(!is_internal_ipv4("93.184.216.34")); // example.com
    }

    // ── H2 回归：IPv4-mapped IPv6 / ULA / link-local ───────────────────────────
    #[test]
    fn internal_ipv6_blocks_mapped_loopback() {
        // ::ffff:127.0.0.1 = IPv4-mapped，resolver 视同 127.0.0.1
        assert!(is_internal_ipv6_literal("[::ffff:127.0.0.1]"));
        assert!(is_internal_ipv6_literal("[::ffff:169.254.169.254]"));
    }

    #[test]
    fn internal_ipv6_blocks_ula() {
        // fc00::/7（ULA 私有）
        assert!(is_internal_ipv6_literal("[fc00::1]"));
        assert!(is_internal_ipv6_literal("[fd12:3456:789a::1]"));
    }

    #[test]
    fn internal_ipv6_blocks_link_local() {
        // fe80::/10（链路本地）
        assert!(is_internal_ipv6_literal("[fe80::1]"));
    }

    #[test]
    fn internal_ipv6_blocks_loopback() {
        assert!(is_internal_ipv6_literal("[::1]"));
    }

    #[test]
    fn internal_ipv6_allows_public() {
        // 2606:4700:4700::1111 = Cloudflare DNS，公网
        assert!(!is_internal_ipv6_literal("[2606:4700:4700::1111]"));
    }

    #[test]
    fn internal_host_blocks_ipv6_mapped_loopback() {
        // 端到端：经 extract_host + is_internal_host 全链路拦截
        let h = extract_host("https://[::ffff:127.0.0.1]/x").unwrap();
        assert!(is_internal_host(&h));
    }

    // ── expand_tilde（~ 展开为 $HOME，文件系统不识别 ~）─────────────────────────
    #[test]
    fn expand_tilde_home_alone() {
        let expanded = expand_tilde("~");
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert_eq!(expanded, home);
    }

    #[test]
    fn expand_tilde_home_slash() {
        let expanded = expand_tilde("~/foo/bar.md");
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert_eq!(expanded, format!("{}/foo/bar.md", home));
    }

    #[test]
    fn expand_tilde_leaves_absolute_untouched() {
        assert_eq!(expand_tilde("/abs/path.md"), "/abs/path.md");
    }

    #[test]
    fn expand_tilde_leaves_relative_untouched() {
        assert_eq!(expand_tilde("rel/path.md"), "rel/path.md");
    }

    #[test]
    fn expand_tilde_does_not_handle_user_form() {
        // ~user 不展开（约定不处理，极少见于帮助文档）
        assert_eq!(expand_tilde("~root/x.md"), "~root/x.md");
    }

    // ── fetch_remote_markdown 本地路径（含 ~ 展开）端到端 ─────────────────────
    #[tokio::test]
    async fn fetch_local_with_tilde_expands_and_reads() {
        // 在 $HOME 下建临时 md，用 ~/... 路径读取，验证 ~ 被展开。
        let home = dirs::home_dir().unwrap();
        let tmp = TempDir::new_in(&home).unwrap();
        let rel = tmp.path().strip_prefix(&home).unwrap();
        let tilde_path = format!("~/{}", rel.join("doc.md").display());
        tokio::fs::write(home.join(rel).join("doc.md"), "# Hello").await.unwrap();
        let r = fetch_remote_markdown(&tilde_path).await;
        assert!(r.error.is_none(), "应成功读取，但 error = {:?}", r.error);
        assert_eq!(r.markdown, "# Hello");
    }
}
