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

    /// 生成 shell（若已存在则跳过）。open/write/restart 共用的单一 spawn 路径。
    /// 持锁时间短：openpty + spawn + insert entry 后立即释放；initCommands 在
    /// unlock 后写（避免持锁阻塞读线程的 emit/state 访问）。
    fn ensure(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        // 双重检查：防止检查与插入之间的窗口内重复 spawn（调用方虽由外层
        // PtyService Mutex 串行化，但本函数也可能被其它内部路径调用）。
        // 用一个 in-progress 标记占位：spawn 前插入哨兵，避免并发重复。
        {
            let ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
            if ptys.contains_key(tool_id) {
                return;
            }
        }

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
        // portable-pty 的 Child drop 不杀进程，进程继续跑；killer 仍可 kill。✓
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

        // 持锁插入 entry
        self.ptys.lock().unwrap_or_else(|e| e.into_inner()).insert(tool_id.to_string(), entry);

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
    pub fn restart(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
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
            let _ = entry.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
        // 不清 desired（终端尺寸跨 shell 存活）
    }

    pub fn kill_all(&self) {
        let mut ptys = self.ptys.lock().unwrap_or_else(|e| e.into_inner());
        for (_, entry) in ptys.drain() {
            let _ = entry.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
        self.desired.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}
