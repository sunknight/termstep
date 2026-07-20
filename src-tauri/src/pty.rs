//! 对偶 src/main/ptyService.ts。portable-pty 池，keyed by toolId。
//! 6 个微妙行为（见 plan 头部）：登录 shell -l、TERM、locale、COLORTERM、
//! initCommands 时机、restart 竞态（generation guard）。

use crate::tmux::{sanitize_tmux_name, tmux_argv};
use crate::types::PtySpawnOpts;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// 彻底杀掉一个 pty 会话的全部进程（shell 及其子孙进程），并等待 controlling
/// terminal 释放，保证紧接着的新 spawn 能成为新 session 的前台 leader。
///
/// 背景（修复「重启终端无效」的核心）：portable-pty spawn 时 `setsid()`，所以
/// child.pid == sid == pgid leader。但 `clone_killer().kill()` 只发一次 SIGHUP
/// 给 child 的正数 pid——**碰不到** shell 里跑着的前台程序（vim/node/ssh...），
/// 它们有独立进程组、持有 pty slave fd、且是 controlling terminal 的前台组。
/// 新 spawn 的 shell 因此抢不到 controlling terminal，提示符出现但键盘输入被
/// 旧前台程序截走，表现成「卡死」且再次重启也无效（旧程序仍占着 ctty）。
///
/// 本函数用 `kill(-pid, SIGKILL)` 覆盖整个进程组（负数 pid = 进程组），SIGKILL
/// 不可阻塞/忽略，能带走组内所有进程。之后短暂 sleep 让内核清理 ctty 投递。
fn reap_process_group(pid: Option<u32>) {
    let Some(pid) = pid else { return; };
    if pid == 0 {
        return;
    }
    // kill 整个进程组：负数 pid 表示「pid 这个进程组」。组已不存在返回 ESRCH，忽略。
    // unsafe 仅因 libc::kill 是 C FFI；pid 来自 child.process_id()，受控非用户输入。
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGKILL);
    }
    // 不等 reap：child 在 ensure 里被 drop，被 init 收养，我们无法 waitpid。
    // 50ms 足够内核释放 controlling terminal 并把前台权交还，避免新 spawn 撞车。
    // restart 是用户主动操作，这点延迟无感知。
    std::thread::sleep(std::time::Duration::from_millis(50));
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// 把 `~` / `~/foo` 展开为绝对路径。对偶 ptyService.ts expandHome。
pub fn expand_home(p: &str) -> String {
    if p == "~" {
        return dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    p.to_string()
}

struct PtyEntry {
    /// 保留 master 以支持后续 resize（take_writer/try_clone_reader 不消耗 master）。
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    generation: u64,
    /// 读线程句柄；存这里只为保持线程存活（JoinHandle drop 不 join 不杀线程）。
    _reader_thread: Option<std::thread::JoinHandle<()>>,
}

/// RAII 哨兵守卫：spawn 前插入 in_progress 标记，spawn 结束（成功 defuse 或
/// 失败/panic drop）后移除。保证「检查无哨兵 → 插入哨兵 → spawn → 移除哨兵」
/// 全过程内，其他并发调用看到哨兵即跳过，不会重复 spawn。
struct SentinelGuard<'a> {
    svc: &'a PtyService,
    tool_id: String,
    defused: bool,
}

impl<'a> SentinelGuard<'a> {
    /// 成功插入 entry 后调用：标记已处理，阻止 drop 再次移除（避免冗余加锁）。
    fn defuse(&mut self) {
        self.defused = true;
    }
}

impl<'a> Drop for SentinelGuard<'a> {
    fn drop(&mut self) {
        if !self.defused {
            self.svc
                .in_progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.tool_id);
        }
    }
}

pub struct PtyService {
    ptys: Mutex<HashMap<String, PtyEntry>>,
    /// spawn 进行中的 tool_id 哨兵集合：防止「检查无 entry → 释放锁 → spawn」
    /// 窗口内的并发重复 spawn（两个调用者同时通过 contains_key 检查 → 各自 spawn
    /// → 后插入者覆盖前者 entry → 前者 child 因 portable-pty Child drop 不杀进程
    /// 而成为孤儿）。哨兵在 spawn 开始前插入、完成（含失败）后移除。
    in_progress: Mutex<std::collections::HashSet<String>>,
    desired: Mutex<HashMap<String, (u16, u16)>>,
    next_gen: AtomicU64,
}

impl PtyService {
    pub fn new() -> Self {
        PtyService {
            ptys: Mutex::new(HashMap::new()),
            in_progress: Mutex::new(std::collections::HashSet::new()),
            desired: Mutex::new(HashMap::new()),
            next_gen: AtomicU64::new(1),
        }
    }

    /// 生成 shell（若已存在则跳过）。open/write/restart 共用的单一 spawn 路径。
    /// 用 in_progress 哨兵消除「检查 → 释放锁 → spawn」窗口内的并发重复 spawn：
    /// 进入时在锁保护下检查「已有 entry」或「已有哨兵」，任一为真则直接返回；
    /// 否则插入哨兵，释放锁后 spawn，完成（含失败）后移除哨兵。
    fn ensure(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        // 双重检查 + 哨兵：在 ptys 锁与 in_progress 锁同时持有时判定，避免 TOCTOU。
        {
            let ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
            if ptys.contains_key(tool_id) {
                return;
            }
            let mut ip = self.in_progress.lock().unwrap_or_else(|e| e.into_inner());
            if !ip.insert(tool_id.to_string()) {
                // insert 返回 false = 已存在哨兵 = 另一个调用正在 spawn，跳过。
                return;
            }
        }
        // 哨兵已插入。用 guard 保证 spawn 无论成败都移除它（RAII，panic 也安全）。
        let mut _guard = SentinelGuard {
            svc: self,
            tool_id: tool_id.to_string(),
            defused: false,
        };

        let shell = opts.shell.clone().unwrap_or_else(default_shell);
        let cwd = opts
            .cwd
            .as_ref()
            .map(|c| expand_home(c))
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .map(|h| h.to_string_lossy().to_string())
                    .unwrap_or_else(|| "/".to_string())
            });

        let mut cmd = CommandBuilder::new(&shell);
        // 行为 1: 登录 shell -l（GUI 应用不继承终端 PATH；-l 让 zsh 读 ~/.zprofile
        // 拿到 /opt/homebrew/bin。放在 -c 之前保持 tmux 路径工作）。
        cmd.arg("-l");

        // tmux: 有 sanitized 名则 `-c "exec tmux new -A -s 'NAME'"`
        let tmux_name = opts.tmux.as_ref().and_then(|t| sanitize_tmux_name(t));
        if let Some(ref name) = tmux_name {
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
        // 行为 3: locale 回退（仅 unset 时设，保留用户已设）
        let env_has = |k: &str| {
            std::env::var(k).is_ok() || opts.env.as_ref().map(|e| e.contains_key(k)).unwrap_or(false)
        };
        if !env_has("LANG") {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if !env_has("LC_CTYPE") {
            cmd.env("LC_CTYPE", "en_US.UTF-8");
        }
        // 行为 4: COLORTERM（仅 unset 时）
        if !env_has("COLORTERM") {
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
                return; // _guard drop 移除哨兵
            }
        };

        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("pty spawn failed for {}: {}", tool_id, e);
                return; // _guard drop 移除哨兵
            }
        };
        let pid = child.process_id();
        let mut killer = child.clone_killer();
        // portable-pty 的 Child drop 不杀进程，进程继续跑；killer 仍可 kill。✓
        // 但若后续 try_clone_reader/take_writer 失败，必须用 killer 主动 kill
        // 已 spawn 的 child，否则它会成为孤儿（旧代码在这些 early return 路径泄漏）。
        drop(child);

        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("pty reader failed for {}: {}", tool_id, e);
                let _ = killer.kill();
                reap_process_group(pid); // 弱版 SIGHUP 杀不掉整组，SIGKILL 兜底防孤儿
                return; // _guard drop 移除哨兵
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("pty writer failed for {}: {}", tool_id, e);
                let _ = killer.kill();
                reap_process_group(pid); // 同上
                return; // _guard drop 移除哨兵
            }
        };

        let generation = self.next_gen.fetch_add(1, Ordering::SeqCst);
        let tool_id_owned = tool_id.to_string();
        let handle_clone = handle.clone();

        // 读线程：循环读 master reader，emit pty:data。EOF 时 generation guard 清理。
        // 此时 ensure 早已返回（读线程只在 EOF 才 state.lock），不会死锁。
        let reader_thread = std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: shell 退出
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
            // 行为 6: shell 退出（读 EOF）→ identity guard。
            // 通过 AppHandle state 取池，比对 generation：只有 generation 匹配
            // （即这不是被 restart 替换的旧 shell）才移除。不清 desired（尺寸跨 shell 存活）。
            if let Some(svc) = handle_clone.try_state::<Arc<Mutex<PtyService>>>() {
                let svc = svc.lock().unwrap_or_else(|e| e.into_inner());
                let mut pool = svc.ptys.lock().unwrap_or_else(|e| e.into_inner());
                let should_remove = pool
                    .get(&tool_id_owned)
                    .map(|e| e.generation == generation)
                    .unwrap_or(false);
                if should_remove {
                    pool.remove(&tool_id_owned);
                }
            }
        });

        let entry = PtyEntry {
            master: pair.master,
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            pid,
            generation,
            _reader_thread: Some(reader_thread),
        };

        // 持锁插入 entry，并在同一逻辑步骤 defuse 哨兵（移除 in_progress 标记）。
        // 先插入 entry 再 defuse：若先 defuse，另一个调用方可能在此 entry 插入前
        // 通过检查并重复 spawn。entry 已在池中即可被复用，哨兵可安全移除。
        self.ptys.lock().unwrap_or_else(|e| e.into_inner()).insert(tool_id.to_string(), entry);
        _guard.defuse();

        // 行为 5: initCommands 写入时机——spawn 后立即 write（缓冲到 shell 就绪）。
        // 在 unlock 后写（ensure 持锁段已结束）。
        if let Some(cmds) = &opts.init_commands {
            if !cmds.is_empty() {
                let batch: String = cmds.iter().map(|c| format!("{}\r", c)).collect();
                self.write_internal(tool_id, batch.as_bytes());
            }
        }
    }

    fn write_internal(&self, tool_id: &str, data: &[u8]) {
        let ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = ptys.get(tool_id) {
            if let Some(w) = entry.writer.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
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
    ///
    /// 先清 in_progress 哨兵：正常路径下 SentinelGuard 的 drop 会移除哨兵，但偶发
    /// 竞态（spawn 线程被卡住、Tauri 运行时时序等）可能让哨兵残留在集合里，导致
    /// ensure 命中 `哨兵已存在` 分支跳过 spawn——表现为"重启终端无效"。restart
    /// 的语义是用户明确要求"杀旧的起新的"，此时清哨兵是安全的：即使有并发 spawn
    /// 在进行，kill 会处理掉它，ensure 会重新 spawn 一个干净的。
    pub fn restart(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        self.in_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_id);
        self.kill(tool_id);
        self.ensure(handle, tool_id, opts);
    }

    pub fn resize(&self, tool_id: &str, cols: u16, rows: u16) {
        self.desired.lock().unwrap_or_else(|e| e.into_inner()).insert(tool_id.to_string(), (cols, rows));
        let ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = ptys.get(tool_id) {
            let _ = entry.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn pid_of(&self, tool_id: &str) -> Option<u32> {
        self.ptys.lock().unwrap_or_else(|e| e.into_inner()).get(tool_id).and_then(|e| e.pid)
    }

    pub fn kill(&self, tool_id: &str) {
        let entry = self.ptys.lock().unwrap_or_else(|e| e.into_inner()).remove(tool_id);
        if let Some(entry) = entry {
            // 先取 pid（drop 前可用），再 drop entry 关闭 master/writer（让 slave 端
            // 最终 EIO），最后 reap 整个进程组带走残留的前台程序。详见 reap_process_group。
            let pid = entry.pid;
            let _ = entry
                .killer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .kill();
            drop(entry);
            reap_process_group(pid);
        }
        // 不清 desired（终端尺寸跨 shell 存活）
    }

    pub fn kill_all(&self) {
        let mut ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
        let drained: Vec<PtyEntry> = ptys.drain().map(|(_, e)| e).collect();
        // 锁只护 drain；drop entry + reap 放锁外，避免 kill_all 期间长持 ptys 锁。
        drop(ptys);
        for entry in drained {
            let pid = entry.pid;
            let _ = entry
                .killer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .kill();
            drop(entry);
            reap_process_group(pid);
        }
        self.desired.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}
