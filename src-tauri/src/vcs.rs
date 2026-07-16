//! 配置版本控制：在 configs/ 目录上用系统 git 做本地快照与历史对比。
//!
//! 设计要点：
//! - 零外部依赖：统一用 std::process::Command 调系统 git（macOS 标配）。
//! - 严格范围：每个 Command 都设 .current_dir(configs_dir)，git 操作绝不触及上级
//!   的 Chromium 运行时目录（Cache/Cookies 等）。
//! - 降级安全：git 不可用时 git_available()=false，上层隐藏 UI，其余功能不受影响。
//! - 幂等：ensure_repo 多次调用安全；snapshot 无变更时不产生空提交。

use std::path::Path;
use std::process::Command;

/// Vcs 命令返回的错误字符串（可直接展示给用户）。
pub type VcsResult<T> = Result<T, String>;

/// 快照（commit）结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotResult {
    /// 是否真的产生了新提交（无变更时为 false）。
    pub committed: bool,
    /// 新提交的完整 hash（committed=false 时为 None）。
    pub hash: Option<String>,
    /// 提交消息（committed=false 时为 None）。
    pub message: Option<String>,
}

/// 一条提交历史记录。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommitEntry {
    /// 完整 hash。
    pub hash: String,
    /// 短 hash（如 a1b2c3d）。
    #[serde(rename = "shortHash")]
    pub short_hash: String,
    /// 提交时间戳（Unix 秒）。
    pub time: i64,
    /// 提交消息首行。
    pub message: String,
}

/// 探测系统是否安装了可执行的 git。启动时调一次，结果缓存进 VcsState。
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 运行一个 git 子进程，cwd 锁定在 configs_dir。返回 stdout（已 trim）。
/// git 写到 stderr 的内容作为错误返回。
fn git(configs_dir: &Path, args: &[&str]) -> VcsResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(configs_dir)
        .output()
        .map_err(|e| format!("无法启动 git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} 失败: {}", args.join(" "), stdout)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 幂等初始化 configs/ 为 git 仓库：
/// 1. 若无 .git → git init
/// 2. 写 .gitignore（排除 .DS_Store）
/// 3. 设 local user.name/email（仅当未设置；--local 不污染全局 ~/.gitconfig）
/// 4. 若无任何 commit → add -A + 首次提交
pub fn ensure_repo(configs_dir: &Path) -> VcsResult<()> {
    if !configs_dir.exists() {
        std::fs::create_dir_all(configs_dir).map_err(|e| e.to_string())?;
    }
    // 1. init（.git 不存在时）
    if !configs_dir.join(".git").exists() {
        git(configs_dir, &["init"])?;
        // 关闭安全目录告警（configs 在用户数据区，git 2.35.2+ 会因 owner 检查报错）
        let _ = git(
            configs_dir,
            &["config", "--local", "safe.directory", "*"],
        );
    }
    // 2. .gitignore（幂等写：内容固定，重复写无害）。排除 macOS 元数据与迁移标志文件。
    std::fs::write(
        configs_dir.join(".gitignore"),
        ".DS_Store\n.migrated\n",
    )
    .map_err(|e| e.to_string())?;
    // 3. 本地身份（仅在未设置时；避免无身份导致首次 commit 失败）
    if git(configs_dir, &["config", "user.name"]).is_err() {
        git(configs_dir, &["config", "--local", "user.name", "TermStep"])?;
    }
    if git(configs_dir, &["config", "user.email"]).is_err() {
        git(
            configs_dir,
            &["config", "--local", "user.email", "termstep@local"],
        )?;
    }
    // 4. 若无任何 commit → 首次提交
    if has_commits(configs_dir)? {
        return Ok(());
    }
    git(configs_dir, &["add", "-A"])?;
    // 即便 add 后工作区为空（理论上 configs 至少有 .gitignore），也兜底尝试 commit
    let _ = git(configs_dir, &["commit", "-m", "初始快照"])?;
    Ok(())
}

/// 仓库是否已有至少一个提交。
fn has_commits(configs_dir: &Path) -> VcsResult<bool> {
    // rev-parse --verify HEAD 成功（退出 0）= 有提交；失败 = 空仓库。
    match git(configs_dir, &["rev-parse", "--verify", "HEAD"]) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}


/// 提交历史（最新在前）。limit 默认 100。
pub fn log_list(configs_dir: &Path, limit: Option<usize>) -> VcsResult<Vec<CommitEntry>> {
    let n = limit.unwrap_or(100);
    let fmt = "%H|%h|%ct|%s";
    let raw = git(
        configs_dir,
        &[
            "log",
            &format!("-{}", n.min(1000)),
            &format!("--pretty={}", fmt),
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '|');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let time: i64 = parts.next()?.parse().ok()?;
            let message = parts.next()?.to_string();
            Some(CommitEntry {
                hash,
                short_hash,
                time,
                message,
            })
        })
        .collect())
}

/// 工作区相对 HEAD 的未提交 diff。
pub fn diff_working(configs_dir: &Path) -> VcsResult<String> {
    if !has_commits(configs_dir)? {
        // 空仓库：没有 HEAD 可比，返回空。
        return Ok(String::new());
    }
    git(configs_dir, &["diff", "HEAD"])
}

/// 某次提交相对其父提交的 diff（该提交改了什么）。
/// 对首个提交（无父）返回该提交引入的全部内容。
pub fn diff_rev(configs_dir: &Path, hash: &str) -> VcsResult<String> {
    // hash~1 失败（首个提交无父）时，退化为显示该提交自身。
    match git(configs_dir, &["diff", &format!("{}~1", hash), hash]) {
        Ok(d) => Ok(d),
        Err(_) => {
            // 首个提交：用 --root 显示其引入的全部内容
            git(configs_dir, &["diff", "--root", hash])
        }
    }
}

// ── path-scoped 变体（per-tool 配置记录 / 自动提交用）─────────────────────────
// pathspec 是相对 configs_dir 的路径（如 "tools/<uuid>/" 或 "tools/order.json"），
// 因 git 操作的 cwd 始终是 configs_dir，故直接作相对路径传给 git。

/// 仅暂存并提交指定路径。无变更时 committed=false。
/// message 必须非空（调用方保证，通常是「保存工具 Git」这类描述）。
pub fn snapshot_path(
    configs_dir: &Path,
    pathspec: &str,
    message: &str,
) -> VcsResult<SnapshotResult> {
    git(configs_dir, &["add", "--", pathspec])?;
    // diff --cached --quiet -- <pathspec>：该路径暂存区无差异 = 无需提交。
    let has_staged = match Command::new("git")
        .args(["diff", "--cached", "--quiet", "--", pathspec])
        .current_dir(configs_dir)
        .status()
    {
        Ok(s) => !s.success(), // 退出码 1 = 有差异
        Err(e) => return Err(format!("git diff 失败: {}", e)),
    };
    if !has_staged {
        return Ok(SnapshotResult {
            committed: false,
            hash: None,
            message: None,
        });
    }
    git(configs_dir, &["commit", "-m", message, "--", pathspec])?;
    let hash = git(configs_dir, &["rev-parse", "HEAD"]).ok();
    Ok(SnapshotResult {
        committed: true,
        hash,
        message: Some(message.to_string()),
    })
}

/// 仅列出触碰过指定路径的提交历史。limit 默认 100。
pub fn log_list_path(
    configs_dir: &Path,
    pathspec: &str,
    limit: Option<usize>,
) -> VcsResult<Vec<CommitEntry>> {
    let n = limit.unwrap_or(100);
    let fmt = "%H|%h|%ct|%s";
    let raw = git(
        configs_dir,
        &[
            "log",
            &format!("-{}", n.min(1000)),
            &format!("--pretty={}", fmt),
            "--",
            pathspec,
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '|');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let time: i64 = parts.next()?.parse().ok()?;
            let message = parts.next()?.to_string();
            Some(CommitEntry {
                hash,
                short_hash,
                time,
                message,
            })
        })
        .collect())
}

/// 工作区相对 HEAD 的未提交 diff，仅限指定路径。
pub fn diff_working_path(configs_dir: &Path, pathspec: &str) -> VcsResult<String> {
    if !has_commits(configs_dir)? {
        return Ok(String::new());
    }
    git(configs_dir, &["diff", "HEAD", "--", pathspec])
}

/// 某次提交相对其父的 diff，仅限指定路径。
pub fn diff_rev_path(
    configs_dir: &Path,
    hash: &str,
    pathspec: &str,
) -> VcsResult<String> {
    match git(
        configs_dir,
        &["diff", &format!("{}~1", hash), hash, "--", pathspec],
    ) {
        Ok(d) => Ok(d),
        Err(_) => git(configs_dir, &["diff", "--root", hash, "--", pathspec]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp() -> TempDir {
        TempDir::new().unwrap()
    }

    // 所有 vcs 测试前提：系统装了 git。CI/开发机标配；没装时这些测试会被跳过。
    fn git_ok() -> bool {
        git_available()
    }

    #[test]
    fn ensure_repo_creates_git_and_initial_commit() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        // 放一个配置文件，确保首次提交有内容
        std::fs::write(dir.join("tool.json"), "{}").unwrap();
        ensure_repo(dir).unwrap();
        assert!(dir.join(".git").exists(), ".git should exist after init");
        assert!(dir.join(".gitignore").exists());
        assert!(has_commits(dir).unwrap(), "should have initial commit");
    }

    #[test]
    fn ensure_repo_is_idempotent() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        ensure_repo(dir).unwrap();
        let commits1 = log_list(dir, None).unwrap().len();
        // 再跑一次：不应新增提交
        ensure_repo(dir).unwrap();
        let commits2 = log_list(dir, None).unwrap().len();
        assert_eq!(commits1, commits2, "ensure_repo must not add commits if HEAD exists");
    }

    #[test]
    fn log_list_parses_entries() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::write(dir.join("a.txt"), "1").unwrap();
        ensure_repo(dir).unwrap();
        std::fs::write(dir.join("a.txt"), "2").unwrap();
        snapshot_path(dir, ".", "second").unwrap();
        let log = log_list(dir, None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].message, "second"); // 最新在前
        assert!(!log[0].short_hash.is_empty());
        assert!(log[0].time > 0);
    }

    #[test]
    fn diff_working_shows_uncommitted() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::write(dir.join("a.txt"), "1").unwrap();
        ensure_repo(dir).unwrap();
        std::fs::write(dir.join("a.txt"), "2").unwrap();
        let d = diff_working(dir).unwrap();
        assert!(d.contains("-1") || d.contains("+2"), "diff should show change: {}", d);
    }

    #[test]
    fn diff_rev_shows_commit_change() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::write(dir.join("a.txt"), "1").unwrap();
        ensure_repo(dir).unwrap();
        std::fs::write(dir.join("a.txt"), "2").unwrap();
        snapshot_path(dir, ".", "second").unwrap();
        let full = git(dir, &["rev-parse", "HEAD"]).unwrap();
        let d = diff_rev(dir, &full).unwrap();
        assert!(d.contains("+2"), "diff_rev should show the commit's addition: {}", d);
    }

    #[test]
    fn git_ops_are_scoped_to_configs_dir() {
        if !git_ok() {
            return;
        }
        // 确保不在上级目录建仓库：configs 外的文件不被 git 跟踪。
        let _d = tmp();
        let dir = _d.path();
        let configs = dir.join("configs");
        std::fs::create_dir_all(&configs).unwrap();
        std::fs::write(dir.join("outside.txt"), "x").unwrap(); // 仓库外
        std::fs::write(configs.join("inside.txt"), "y").unwrap();
        ensure_repo(&configs).unwrap();
        // outside.txt 不在仓库里——git status 在 configs 下看不到它
        let status = git(&configs, &["status", "--porcelain"]).unwrap();
        assert!(
            !status.contains("outside.txt"),
            "outside file must not appear in repo status: {}",
            status
        );
    }

    // ── path-scoped 函数 ─────────────────────────────────────────────────────
    #[test]
    fn snapshot_path_only_commits_that_path() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        // 两个工具目录
        std::fs::create_dir_all(dir.join("tools/A")).unwrap();
        std::fs::create_dir_all(dir.join("tools/B")).unwrap();
        std::fs::write(dir.join("tools/A/help.md"), "a1").unwrap();
        std::fs::write(dir.join("tools/B/help.md"), "b1").unwrap();
        ensure_repo(dir).unwrap();

        // 改工具 A 和 B，但只 snapshot_path("tools/A/")
        std::fs::write(dir.join("tools/A/help.md"), "a2").unwrap();
        std::fs::write(dir.join("tools/B/help.md"), "b2").unwrap();
        let r = snapshot_path(dir, "tools/A/", "保存工具 A").unwrap();
        assert!(r.committed);

        // 工具 B 的变更应仍在工作区（未被该提交带走）
        let dirty_b = git(dir, &["status", "--porcelain", "--", "tools/B/"]).unwrap();
        assert!(
            dirty_b.contains("help.md"),
            "tools/B change must remain uncommitted: [{}]",
            dirty_b
        );
    }

    #[test]
    fn log_list_path_is_scoped() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::create_dir_all(dir.join("tools/A")).unwrap();
        std::fs::create_dir_all(dir.join("tools/B")).unwrap();
        std::fs::write(dir.join("tools/A/help.md"), "a1").unwrap();
        std::fs::write(dir.join("tools/B/help.md"), "b1").unwrap();
        ensure_repo(dir).unwrap();

        // 只改工具 A 并提交
        std::fs::write(dir.join("tools/A/help.md"), "a2").unwrap();
        snapshot_path(dir, "tools/A/", "保存工具 A").unwrap();

        // A 的历史里有这条提交；B 的历史里没有
        let log_a = log_list_path(dir, "tools/A/", None).unwrap();
        let log_b = log_list_path(dir, "tools/B/", None).unwrap();
        assert!(
            log_a.iter().any(|c| c.message == "保存工具 A"),
            "A's log should include the commit"
        );
        assert!(
            !log_b.iter().any(|c| c.message == "保存工具 A"),
            "B's log must NOT include A's commit"
        );
    }

    #[test]
    fn snapshot_path_no_change_returns_committed_false() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::create_dir_all(dir.join("tools/A")).unwrap();
        std::fs::write(dir.join("tools/A/help.md"), "a1").unwrap();
        ensure_repo(dir).unwrap();
        // 无变更 → committed=false
        let r = snapshot_path(dir, "tools/A/", "无变更").unwrap();
        assert!(!r.committed);
    }

    #[test]
    fn diff_rev_path_is_scoped() {
        if !git_ok() {
            return;
        }
        let _d = tmp();
        let dir = _d.path();
        std::fs::create_dir_all(dir.join("tools/A")).unwrap();
        std::fs::write(dir.join("tools/A/help.md"), "a1").unwrap();
        ensure_repo(dir).unwrap();
        std::fs::write(dir.join("tools/A/help.md"), "a2").unwrap();
        snapshot_path(dir, "tools/A/", "保存工具 A").unwrap();

        let full = git(dir, &["rev-parse", "HEAD"]).unwrap();
        let d = diff_rev_path(dir, &full, "tools/A/").unwrap();
        assert!(d.contains("+a2"), "scoped diff should show A's change: {}", d);
    }
}
