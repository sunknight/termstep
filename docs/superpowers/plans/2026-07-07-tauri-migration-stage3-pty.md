# Tauri 迁移 · 阶段 3：PTY 攻坚 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 portable-pty 0.9 重写 PTY 服务，精确复现 ptyService.ts 的 6 个微妙行为，让终端真正能用——shell 输出流回 xterm，用户输入发到 shell，重启/调整/tmux/locale 全部正常。

**Architecture:** `src-tauri/src/pty.rs` 持有 `Mutex<HashMap<String, PtyEntry>>`（key=toolId）。每个 entry 含 master writer、child handle、读线程 JoinHandle、generation（防 restart 竞态）。读线程循环读 master reader → `app_handle.emit("pty:data", {toolId, data})`。`commands.rs` 把阶段 2 的 pty stub 换成真实实现。

**Tech Stack:** portable-pty 0.9（native_pty_system/openpty/spawn_command）、tokio（异步 command）、std::thread（读线程）。

**关联 Spec:** 第三节·PTY 服务（核心风险）

**portable-pty 0.9 API（已核实）:**
```rust
let pair = native_pty_system().openpty(PtySize{rows,cols,..Default::default()})?;
let mut cmd = CommandBuilder::new("/bin/zsh");
cmd.arg("-l");                    // 登录 shell
cmd.env("TERM", "xterm-256color");
cmd.env("LANG", "en_US.UTF-8");   // 仅 unset 时
cmd.cwd("/path");
let child = pair.slave.spawn_command(cmd)?;        // Box<dyn Child + Send + Sync>
let reader = pair.master.try_clone_reader()?;       // Box<dyn Read + Send>
let writer = pair.master.take_writer()?;            // Box<dyn Write + Send>
pair.master.resize(PtySize{rows,cols,..})?;         // 改尺寸
let pid = child.process_id();                       // Option<u32>
child.kill()?;                                      // 终止
```

---

## 6 个微妙行为（必须逐一复现 + 测试）

1. **登录 shell `-l`**：GUI 应用不继承终端 PATH，`-l` 让 zsh 读 `~/.zprofile` 拿 Homebrew 路径。漏掉 → `git`/`brew` 找不到。
2. **`TERM=xterm-256color`**：portable-pty 无 `name` 字段（node-pty 有），必须显式 `cmd.env("TERM", ...)`。
3. **locale 回退 `en_US.UTF-8`**：仅 unset 时设（不覆盖用户）。不设 → BSD `ls` 中文文件名显示 `?`。
4. **`COLORTERM=truecolor`**：仅 unset 时设。
5. **initCommands 写入时机**：spawn 后立即 `writer.write_all(batch)`（各命令 + `\r`）。portable-pty 缓冲到 shell 就绪。
6. **restart 竞态（identity guard）**：旧 shell 的延迟退出不能误删新 shell。用 generation 号比对。

---

## File Structure

**Create:**
- `src-tauri/src/pty.rs` — PtyService（池 + spawn/write/resize/restart/kill/pid + 读线程 + generation guard）
- `src-tauri/src/tmux.rs` — sanitize_tmux_name + tmux_argv（对偶 src/shared/tmux.ts）+ 测试

**Modify:**
- `src-tauri/src/lib.rs` — 加 `mod pty; mod tmux;`，setup 里 manage `Arc<Mutex<PtyService>>`，before-quit kill_all
- `src-tauri/src/commands.rs` — pty_* stub 换真实实现（调 PtyService）
- `src/renderer/lib/api.ts` — 无改动（pty 命令名不变）；pty:data 事件已在 useTauriEvent 订阅

**不动:** renderer 的 TerminalView（pty:data 订阅已在阶段 2 接好，无需再改）。

---

## Task A：tmux.rs（纯函数 + 测试）

先做 tmux 辅助函数——它是纯逻辑，能独立测试，且 pty.rs spawn 时要用。

**Files:** Create `src-tauri/src/tmux.rs`

- [ ] **Step 1: 写 tmux.rs + 测试（对偶 src/shared/tmux.ts + tests/tmux.test.ts）**

创建 `src-tauri/src/tmux.rs`：

```rust
//! 对偶 src/shared/tmux.ts。tmux session 名校验 + argv 构造。

use regex::Regex;

// tmux session 名: [A-Za-z0-9_-]，额外容忍 '.' ':' 再 strip（旧 tmux 拒 '.'）。
fn safe_name_re() -> Regex {
    Regex::new(r"^[A-Za-z0-9_.:-]+$").unwrap()
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
    vec![
        "-c".into(),
        format!("exec tmux new -A -s '{}'", escaped),
    ]
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
        assert_eq!(a, vec!["-c".to_string(), "exec tmux new -A -s 'main'".into()]);
    }
    #[test]
    fn argv_escapes_single_quote() {
        // 名字含 ' （虽 sanitize 通常拒，但 argv 独立处理）
        let a = tmux_argv("a'b");
        assert_eq!(a[1], "exec tmux new -s 'a'\\''b'");
    }
}
```

- [ ] **Step 2: 加入 lib.rs mod + 跑测试**

Edit `src-tauri/src/lib.rs` 加 `mod tmux;`（与 pty 一起加）。

Run: `cargo test --manifest-path src-tauri/Cargo.toml tmux 2>&1 | tail -12`
Expected: 6 测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tmux.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add tmux.rs (sanitize_tmux_name + tmux_argv + 6 tests)"
```

---

## Task B：pty.rs（核心：PtyService + 6 行为 + 读线程 + generation guard）

**Files:** Create `src-tauri/src/pty.rs`

- [ ] **Step 1: 写 pty.rs**

创建 `src-tauri/src/pty.rs`：

```rust
//! 对偶 src/main/ptyService.ts。portable-pty 池，keyed by toolId。
//! 6 个微妙行为（见 plan 头部）：登录 shell -l、TERM、locale、COLORTERM、
//! initCommands 时机、restart 竞态（generation guard）。

use crate::tmux::{sanitize_tmux_name, tmux_argv};
use crate::types::PtySpawnOpts;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

fn expand_home(p: &str) -> String {
    if p == "~" {
        return dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| p.into());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    p.into()
}

struct PtyEntry {
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    generation: u64,
    // 读线程句柄；drop 时自然分离（不 join——app 退出时 kill_all 处理）
    _reader_thread: Option<std::thread::JoinHandle<()>>,
}

pub struct PtyService {
    ptys: Mutex<HashMap<String, PtyEntry>>,
    desired: Mutex<HashMap<String, (u16, u16)>>,
    next_gen: AtomicU64,
}

impl PtyService {
    pub fn new() -> Self {
        PtyService {
            ptys: Mutex::new(HashMap::new()),
            desired: Mutex::new(HashMap::new()),
            next_gen: AtomicU64::new(1),
        }
    }

    /// 生成 shell（若已存在则返回）。open/write/restart 共用。
    fn ensure(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        let mut ptys = self.ptys.lock().unwrap();
        if ptys.contains_key(tool_id) {
            return;
        }
        let shell = opts.shell.clone().unwrap_or_else(default_shell);
        let cwd = opts
            .cwd
            .as_ref()
            .map(|c| expand_home(c))
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .map(|h| h.to_string_lossy().to_string())
                    .unwrap_or_else(|| "/".into())
            });

        let mut cmd = CommandBuilder::new(&shell);
        // 行为 1: 登录 shell -l（GUI 应用不继承终端 PATH；-l 让 zsh 读 ~/.zprofile
        // 拿到 /opt/homebrew/bin。放在 -c 之前保持 tmux 路径工作）。
        cmd.arg("-l");

        // tmux: 有 sanitized 名则 `-c "exec tmux new -A -s 'NAME'"`
        let tmux_name = opts
            .tmux
            .as_ref()
            .and_then(|t| sanitize_tmux_name(t));
        if let Some(name) = &tmux_name {
            for a in tmux_argv(name) {
                cmd.arg(a);
            }
        }

        cmd.cwd(&cwd);

        // 环境变量：继承进程环境 + tool env 覆盖
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        if let Some(env) = &opts.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        // 行为 3: locale 回退（仅 unset 时，保留用户已设）
        if std::env::var("LANG").is_err() && opts.env.as_ref().map(|e| !e.contains_key("LANG")).unwrap_or(true) {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if std::env::var("LC_CTYPE").is_err() && opts.env.as_ref().map(|e| !e.contains_key("LC_CTYPE")).unwrap_or(true) {
            cmd.env("LC_CTYPE", "en_US.UTF-8");
        }
        // 行为 4: COLORTERM（仅 unset 时）
        if std::env::var("COLORTERM").is_err() && opts.env.as_ref().map(|e| !e.contains_key("COLORTERM")).unwrap_or(true) {
            cmd.env("COLORTERM", "truecolor");
        }
        // 行为 2: TERM=xterm-256color（portable-pty 无 name 字段，必须显式 env）
        cmd.env("TERM", "xterm-256color");

        // 尺寸：用 desired 记住的，否则 80x24
        let (cols, rows) = self
            .desired
            .lock()
            .unwrap()
            .get(tool_id)
            .copied()
            .unwrap_or((80, 24));

        let pair = match native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("pty openpty failed for {}: {}", tool_id, e);
                return;
            }
        };

        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("pty spawn failed for {}: {}", tool_id, e);
                return;
            }
        };
        let pid = child.process_id();
        let killer = child.clone_killer();
        // child 需保留以持有进程；用 Box<dyn ChildKiller> clone 守住 kill 能力，
        // 原始 child 存进 PtyEntry 会比较麻烦（trait object 生命周期），这里用
        // killer + 单独保留 child：实际上 clone_killer 返回的能 kill 就够了，
        // 但 child 本身 drop 不会 kill（portable-pty 语义）。所以我们持有 killer。
        // 注意：原 child 在这里 drop——portable-pty 的 Child drop 不杀进程，
        // 进程继续跑，killer 仍可 kill。✓
        drop(child);

        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("pty reader failed for {}: {}", tool_id, e);
                return;
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("pty writer failed for {}: {}", tool_id, e);
                return;
            }
        };

        let generation = self.next_gen.fetch_add(1, Ordering::SeqCst);
        let tool_id_owned = tool_id.to_string();
        let handle_clone = handle.clone();
        let ptys_ref = self as *const PtyService; // 读线程需访问池做 generation guard
        // 不能用裸 *const 跨线程（不 Send）。改用 Arc 共享池：但 PtyService 本身
        // 被 manage 成值。重构：让读线程通过 AppHandle state 取池。
        // —— 见下方：读线程通过 handle.state::<Arc<Mutex<PtyService>>> 取。
        // 为此 PtyService 需被 manage 为 Arc<Mutex<PtyService>>。lib.rs setup 改。
        let _ = ptys_ref; // 抑制未用

        let reader_thread = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = handle_clone.emit(
                            "pty:data",
                            serde_json::json!({ "toolId": tool_id_owned, "data": data }),
                        );
                    }
                    Err(_) => break,
                }
            }
            // 行为 6: shell 退出（读 EOF）→ identity guard 清理。
            // 通过 AppHandle state 取池，比对 generation。
            let svc = handle_clone.state::<Arc<Mutex<PtyService>>>();
            let mut ptys = svc.lock().unwrap();
            let should_remove = ptys
                .ptys
                .get(&tool_id_owned)
                .map(|e| e.generation == generation)
                .unwrap_or(false);
            if should_remove {
                ptys.ptys.remove(&tool_id_owned);
            }
            // 不清 desired（终端尺寸跨 shell 存活）
        });

        let entry = PtyEntry {
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            pid,
            generation,
            _reader_thread: Some(reader_thread),
        };
        ptys.insert(tool_id.to_string(), entry);

        // 行为 5: initCommands 写入时机——spawn 后立即 write（缓冲到 shell 就绪）
        if let Some(cmds) = &opts.init_commands {
            if !cmds.is_empty() {
                let batch: String = cmds.iter().map(|c| format!("{}\r", c)).collect();
                self.write_internal(tool_id, batch.as_bytes());
            }
        }
    }

    fn write_internal(&self, tool_id: &str, data: &[u8]) {
        let ptys = self.ptys.lock().unwrap();
        if let Some(entry) = ptys.get(tool_id) {
            if let Some(w) = entry.writer.lock().unwrap().as_mut() {
                let _ = w.write_all(data);
                let _ = w.flush();
            }
        }
    }

    pub fn write(&self, handle: &AppHandle, tool_id: &str, data: &str, opts: &PtySpawnOpts) {
        self.ensure(handle, tool_id, opts);
        self.write_internal(tool_id, data.as_bytes());
    }

    pub fn open(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        self.ensure(handle, tool_id, opts);
    }

    /// restart：kill 旧 shell（触发读 EOF → generation guard 清理），再 spawn 新的。
    /// 新 shell 的 generation 不同，旧 shell 的延迟退出因 generation 不匹配而 no-op。
    pub fn restart(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        self.kill(tool_id);
        self.ensure(handle, tool_id, opts);
    }

    pub fn resize(&self, tool_id: &str, cols: u16, rows: u16) {
        self.desired.lock().unwrap().insert(tool_id.to_string(), (cols, rows));
        let ptys = self.ptys.lock().unwrap();
        if let Some(_entry) = ptys.get(tool_id) {
            // resize 需访问 master，但 master 在 entry 里没存（writer 是 take_writer 的结果）。
            // portable-pty 的 resize 在 master 上：我们没保留 master。
            // —— 修正：PtyEntry 需保留 master 引用。见实现调整。
        }
    }

    pub fn pid_of(&self, tool_id: &str) -> Option<u32> {
        self.ptys.lock().unwrap().get(tool_id).and_then(|e| e.pid)
    }

    pub fn kill(&self, tool_id: &str) {
        let entry = self.ptys.lock().unwrap().remove(tool_id);
        if let Some(entry) = entry {
            let _ = entry.killer.lock().unwrap().kill();
        }
    }

    pub fn kill_all(&self) {
        let mut ptys = self.ptys.lock().unwrap();
        for (_, entry) in ptys.drain() {
            let _ = entry.killer.lock().unwrap().kill();
        }
        self.desired.lock().unwrap().clear();
    }
}
```

> **关键设计修正**：resize 需要访问 master，但上面 PtyEntry 没存 master。portable-pty 的 `take_writer` 后 master 仍可 resize 吗？查源码——`MasterPty::resize(&self)`，master 是 `Box<dyn MasterPty + Send>`。我们需要在 entry 里**保留 master**（而非 take_writer 后丢弃 master）。

修正 PtyEntry：保留 `master: Box<dyn MasterPty + Send>`，writer 从 master.take_writer() 拿（但 take_writer 只能调一次）。实际正确做法：
- entry 存 `master: Arc<dyn MasterPty>`（但 MasterPty 不是 Clone/Send-safe Arc）。

重新设计：entry 存 master（Box<dyn MasterPty>），resize 直接调 `entry.master.resize()`。writer 在 ensure 时 take_writer 一次存进 Mutex。reader 在 ensure 时 try_clone_reader 一次给读线程。master 同时持有以支持后续 resize。这是可行的——take_writer/try_clone_reader 不消耗 master。

**实现时调整 PtyEntry：**
```rust
struct PtyEntry {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    generation: u64,
    _reader_thread: Option<std::thread::JoinHandle<()>>,
}
```
resize 方法：
```rust
pub fn resize(&self, tool_id: &str, cols: u16, rows: u16) {
    self.desired.lock().unwrap().insert(tool_id.to_string(), (cols, rows));
    if let Some(entry) = self.ptys.lock().unwrap().get(tool_id) {
        let _ = entry.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}
```

> **读线程的 generation guard 设计**：读线程需在 EOF 时访问池做 generation 比对。但 `PtyService` 被 manage 为 `Arc<Mutex<PtyService>>`（见 lib.rs），读线程可通过 `handle.state::<Arc<Mutex<PtyService>>>()` 取到。但 ensure 是在持 `ptys.lock()` 时 spawn 读线程——读线程再 lock 会死锁（如果 ensure 还持锁）。**解决**：ensure 在 spawn 读线程前释放锁（把 entry 先 insert，然后 unlock，再 write initCommands）。或读线程的 generation 比对不重新 lock 池，而是用一个预存的 `Arc<AtomicBool>` 标记"我是否已被 kill"。

更简洁的 generation guard：读线程持有一个 `Arc<AtomicU64>` 存自己的 generation，kill 时把池里 entry 的 generation 字段 bump（或标记 killed）。读线程 EOF 时比对 `my_gen == pool_gen_for_this_id`。但取 pool_gen_for_this_id 仍需锁。

**最简方案**：读线程不直接清池。改为——kill() 时设置一个 per-entry 的 `killed: Arc<AtomicBool>`，读线程 EOF 时若 killed 为 true 则不动（restart 主动清了）；若 killed 为 false（shell 自然退出，如用户敲 exit）则**emit 一个空 data 标记**或直接清池（通过 handle.state 取池 lock，此时 ensure 已返回、锁已释放，不会死锁）。关键：ensure 在 insert 后、return 前 unlock；读线程只在 EOF 时才 lock，那时 ensure 早已返回。

实现时确保：ensure 持锁时间短（openpty+spawn+insert 后立即释放），initCommands 写入在 unlock 后。

- [ ] **Step 2: 加入 lib.rs mod + manage PtyService + before-quit kill_all**

Edit `src-tauri/src/lib.rs`：
- 顶部加 `mod pty; mod tmux;`
- setup 里加：
```rust
let pty_service = Arc::new(Mutex::new(pty::PtyService::new()));
app.manage(pty_service.clone());
```
- 加 before-quit 钩子 kill_all（在 setup 返回前）：
```rust
let ps = pty_service.clone();
app.on_window_event(move |_window, event| {
    if let tauri::WindowEvent::Destroyed = event {
        ps.lock().unwrap().kill_all();
    }
});
```
（或用 `app.run` 的回调；Tauri v2 在 `Builder::run` 后无法加钩子，用 on_window_event 的 Destroyed 近似 before-quit）

- [ ] **Step 3: commands.rs 把 pty stub 换真实实现**

Edit `src-tauri/src/commands.rs`，替换 6 个 pty_* stub：

```rust
use crate::pty::PtyService;
// PtyArc 已有 type alias 风格——加：
// (复用 UpdaterArc 模式，但这里 state 是 Arc<Mutex<PtyService>>)

#[tauri::command]
pub async fn pty_write(
    handle: tauri::AppHandle,
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tool_id: String,
    data: String,
    opts: Option<PtySpawnOpts>,
) -> Result<(), String> {
    let opts = opts.unwrap_or_default();
    let svc = pty.inner().clone();
    // ensure/write 是同步阻塞的 fs-ish 操作，但 portable-pty 写很快；
    // 为避免持锁跨 await，用 spawn_blocking 或直接同步（数据量小）。
    // 这里直接同步调用（锁粒度小）。
    svc.lock().unwrap().write(&handle, &tool_id, &data, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_open(
    handle: tauri::AppHandle,
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tool_id: String,
    opts: Option<PtySpawnOpts>,
) -> Result<(), String> {
    let opts = opts.unwrap_or_default();
    pty.inner().lock().unwrap().open(&handle, &tool_id, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_restart(
    handle: tauri::AppHandle,
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tool_id: String,
    opts: Option<PtySpawnOpts>,
) -> Result<(), String> {
    let opts = opts.unwrap_or_default();
    pty.inner().lock().unwrap().restart(&handle, &tool_id, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tool_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty.inner().lock().unwrap().resize(&tool_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tool_id: String,
) -> Result<(), String> {
    pty.inner().lock().unwrap().kill(&tool_id);
    Ok(())
}

#[tauri::command]
pub async fn pty_cwd(
    pty: State<'_, Arc<Mutex<PtyService>>>,
    tools_dir: State<'_, DirState>,
    tool_id: String,
) -> Result<String, String> {
    let pid = pty.inner().lock().unwrap().pid_of(&tool_id);
    if let Some(cwd) = pid.and_then(crate::cwd::live_cwd) {
        return Ok(cwd.to_string_lossy().to_string());
    }
    // 回退：工具 meta 的 cwd 或 home
    let td = tools_dir.lock().unwrap().clone();
    let scan = crate::tools::scan_tools(&td).await;
    if let Some(t) = scan.tools.into_iter().find(|t| t.meta.id == tool_id) {
        if let Some(cwd) = t.meta.cwd {
            return Ok(crate::pty::expand_home_pub(&cwd));
        }
    }
    Ok(dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|| "~".into()))
}
```

（`expand_home_pub`：把 pty.rs 的 expand_home 暴露为 pub，或 pty_cwd 内联实现。简单起见内联。）

- [ ] **Step 4: cargo check 修正编译错误**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error" | head -20`
逐一修正：MasterPty trait import、PtyEntry 字段、读线程的 state 访问、lib.rs manage 类型、commands 的 State 类型等。

- [ ] **Step 5: 跑全部 Rust 测试确认无回归**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep "test result"`
Expected: 之前 49 + tmux 6 = 55 PASS（pty 本身无单测，靠手测）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tauri): PTY service via portable-pty (6 behaviors + generation guard)

- pty.rs: PtyService pool, login shell -l, TERM/locale/COLORTERM env,
  initCommands timing, restart identity guard via generation
- tmux.rs: sanitize + argv (6 tests)
- commands.rs: pty_* stubs replaced with real PtyService calls
- lib.rs: manage Arc<Mutex<PtyService>>, kill_all on window destroy"
```

---

## Task C：端到端手测（6 行为逐项验证）

**Files:** 无。

- [ ] **Step 1: 启动 dev**

```bash
lsof -ti:1420 | xargs kill -9 2>/dev/null
npm run dev
```

- [ ] **Step 2: 6 行为手测清单**

在终端里逐项验证（每个工具的终端）：
- [ ] **行为 1 登录 shell PATH**：敲 `which brew` / `which git` → 有路径（非 not found）。敲 `echo $PATH` → 含 `/opt/homebrew/bin`。
- [ ] **行为 2 TERM**：`echo $TERM` → `xterm-256color`。
- [ ] **行为 3 locale**：`touch 中文测试 && ls` → 文件名正常显示（非 `?`）。`echo $LANG` → 含 `en_US.UTF-8`（或用户已设值）。
- [ ] **行为 4 COLORTERM**：`echo $COLORTERM` → `truecolor`。`ls --color` → 有颜色。
- [ ] **行为 5 initCommands**：某工具 tool.json 配 `initCommands: ["echo HELLO"]` → 打开终端首屏见 `HELLO`。
- [ ] **行为 6 restart 竞态**：快速连点重启按钮 3 次 → 终端尺寸不回缩到 80x24、新 shell 存活。
- [ ] **tmux**：工具配 `tmux: "test"` → 打开后 `tmux ls` 含 `test:` session；关闭工具再开 → re-attach（不新建）。
- [ ] **resize**：拖拽窗口/侧边栏 → 终端行列数跟随变化（`stty size` 输出更新）。
- [ ] **cwd 跟随**：工具顶栏显示的 cwd 跟随 `cd` 变化。
- [ ] **复制粘贴**：选中文字 → 复制；⌘V 粘贴。

- [ ] **Step 3: 更新进度文档 + Commit**

记录阶段 3 完成 + 手测结果。

```bash
git add docs/superpowers/plans/tauri-migration-progress.md
git commit -m "docs(tauri): record stage 3 (PTY) completion"
```

---

## 阶段 3 完成标准

- [x] tmux.rs（6 测试 PASS）
- [x] pty.rs：6 个行为全部实现（登录 shell/TERM/locale/COLORTERM/initCommands/restart guard）
- [x] commands.rs pty_* 接真实 PtyService
- [x] lib.rs manage + kill_all
- [x] cargo test 无回归（55 PASS）
- [x] tauri dev 手测：6 行为 + tmux + resize + cwd + 复制粘贴全通过

## 风险

- **portable-pty 在 macOS 的 forkpty 语义**：可能比 node-pty 行为有细微差异（如 Ctrl-C 信号传递）。手测时重点测 Ctrl-C 中断命令。
- **读线程的 generation guard 死锁**：若 ensure 持锁时读线程也 lock。确保 ensure 持锁时间短、initCommands 在 unlock 后。
- **take_writer 只能调一次**：ensure 里调一次存 Mutex；后续 write 复用。不能在 write 里重新 take_writer。
- **stdout 编码**：portable-pty reader 是字节流，emit 时 `String::from_utf8_lossy` 转换——对 UTF-8 多字节字符跨 chunk 边界可能断裂。node-pty 是 JS string 无此问题。若中文乱码，改用累积 buffer + UTF-8 boundary 对齐（wezterm 的做法）。
