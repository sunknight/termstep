//! 对偶 src/main/cwd.ts。macOS 走 lsof（无 /proc），Linux 走 readlink /proc。

use std::path::PathBuf;

/// 解析进程的实时 cwd。None = 读不到（pid 无效或进程已退）。
pub fn live_cwd(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(p) = std::fs::read_link(format!("/proc/{}/cwd", pid)) {
            return Some(p);
        }
    }
    lsof_cwd(pid)
}

// macOS 无 /proc；问 lsof 该进程的 cwd。lsof 缺失或 pid 已退 → None。
fn lsof_cwd(pid: u32) -> Option<PathBuf> {
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // 'n' 开头的行携带 cwd 路径
    stdout
        .lines()
        .find(|l| l.starts_with('n'))
        .and_then(|l| l.strip_prefix('n'))
        .map(PathBuf::from)
}
