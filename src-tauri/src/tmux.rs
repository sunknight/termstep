//! 对偶 src/shared/tmux.ts。tmux session 名校验 + argv 构造。

use regex::Regex;
use std::sync::OnceLock;

// tmux session 名: [A-Za-z0-9_-]，额外容忍 '.' ':' 再 strip（旧 tmux 拒 '.'）。
fn safe_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.:-]+$").unwrap())
}

/// 校验并清洗 tmux session 名。非法/空 → None；合法则把 '.' ':' 换成 '-'。
pub fn sanitize_tmux_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || !safe_name_re().is_match(name) {
        return None;
    }
    Some(name.replace(['.', ':'], "-"))
}

/// argv 让 spawned shell exec 进 tmux：`-c "exec tmux new -A -s 'NAME'"`。
/// 单引号转义 '\''。返回的 vec 应 append 到 `["-l"]` 之后。
pub fn tmux_argv(name: &str) -> Vec<String> {
    let escaped = name.replace('\'', "'\\''");
    vec!["-c".into(), format!("exec tmux new -A -s '{}'", escaped)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_valid() {
        assert_eq!(sanitize_tmux_name("main"), Some("main".into()));
    }
    #[test]
    fn sanitize_strips_dot_colon() {
        assert_eq!(sanitize_tmux_name("a.b:c"), Some("a-b-c".into()));
    }
    #[test]
    fn sanitize_rejects_empty() {
        assert_eq!(sanitize_tmux_name(""), None);
        assert_eq!(sanitize_tmux_name("   "), None);
    }
    #[test]
    fn sanitize_rejects_shell_meta() {
        assert_eq!(sanitize_tmux_name("a;rm -rf"), None);
        assert_eq!(sanitize_tmux_name("a$b"), None);
        assert_eq!(sanitize_tmux_name("a|b"), None);
    }
    #[test]
    fn argv_basic() {
        let a = tmux_argv("main");
        assert_eq!(a, vec!["-c".to_string(), "exec tmux new -A -s 'main'".to_string()]);
    }
    #[test]
    fn argv_escapes_single_quote() {
        // 名字含 '（argv 独立处理转义）
        let a = tmux_argv("a'b");
        assert_eq!(a[1], "exec tmux new -A -s 'a'\\''b'");
    }
}
