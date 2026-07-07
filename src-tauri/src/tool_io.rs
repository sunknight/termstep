//! 对偶 src/main/ipc.ts 中 tool CRUD / bundle / quick 部分。纯 fs 操作。

use crate::pure::{build_buttons_append, merge_tool_json, parse_tool_meta};
use std::path::Path;
use uuid::Uuid;

const DEFAULT_QUICK_MD: &str = "# 快捷命令\n\n这些按钮出现在终端标题栏的全局下拉中，可在任意工具的终端执行。点「编辑」修改：\n\n```buttons\npwd # 当前目录\nls -la # 列出文件\nclear # 清屏\n```\n";

/// 读 tool.json（不 merge），缺失/解析失败返回空对象。对偶 ipc.ts readJson。
pub async fn read_tool_json(dir: &Path) -> serde_json::Value {
    match tokio::fs::read_to_string(dir.join("tool.json")).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(Default::default())),
        Err(_) => serde_json::Value::Object(Default::default()),
    }
}

/// tool_save：merge tool.json + 写 help.md。对偶 ipc.ts TOOL_SAVE。
pub async fn tool_save(
    dir: &Path,
    markdown: &str,
    meta_patch: serde_json::Value,
) -> std::io::Result<()> {
    let existing = read_tool_json(dir).await;
    let merged = merge_tool_json(&existing, &meta_patch);
    let pretty = serde_json::to_string_pretty(&merged)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    tokio::fs::write(dir.join("tool.json"), format!("{}\n", pretty)).await?;
    tokio::fs::write(dir.join("help.md"), markdown).await?;
    Ok(())
}

/// tool_append_buttons：追加 ```buttons 围栏。返回是否实际写入。对偶 TOOL_APPEND_BUTTONS。
pub async fn tool_append_buttons(dir: &Path, body: &str) -> std::io::Result<bool> {
    let file = dir.join("help.md");
    let cur = tokio::fs::read_to_string(&file).await.unwrap_or_default();
    let next = build_buttons_append(&cur, body);
    if next == cur {
        return Ok(false); // 空体 no-op，跳过写入
    }
    tokio::fs::write(file, next).await?;
    Ok(true)
}

/// 生成新工具 id：UUID v4。不再用 slug 做目录名——UUID 天然唯一，从根本上
/// 消除导入时「同名 → -2/-3」冲突。name 不再决定目录名（只写进 tool.json）。
pub fn new_tool_id() -> String {
    Uuid::new_v4().to_string()
}

/// 把 tools_dir 下所有"非 UUID"目录就地重命名为 UUID。
/// 幂等：已是合法 UUID（含版本位校验）的跳过；单个 rename 失败只跳过并告警，
/// 不阻断其它迁移或启动。返回是否至少改了一个目录。
///
/// 同步（std::fs）：在 lib.rs setup 中、watcher/seed 之前调用，确保任何 scan
/// 看到的都是迁移后的状态。PTY 是懒创建的，迁移完成时无终端 keyed 到旧 id。
pub fn migrate_to_uuid_ids_blocking(tools_dir: &Path) -> bool {
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut changed = false;
    for entry in entries.flatten() {
        let filetype = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !filetype.is_dir() {
            continue;
        }
        let from = entry.path();
        let name = match from.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // 已是合法 UUID（含版本/变体位校验）则跳过
        if Uuid::parse_str(&name).is_ok() {
            continue;
        }
        // 重抽直至目标不存在（防极罕见的 UUID 碰撞 / 同名竞态）
        let mut to = None;
        for _ in 0..8 {
            let candidate = tools_dir.join(new_tool_id());
            if !candidate.exists() {
                to = Some(candidate);
                break;
            }
        }
        let to = match to {
            Some(p) => p,
            None => {
                eprintln!("migrate: could not find free uuid for {}", name);
                continue;
            }
        };
        match std::fs::rename(&from, &to) {
            Ok(()) => changed = true,
            Err(e) => eprintln!("migrate: rename {} failed: {}", name, e),
        }
    }
    changed
}

/// tool_create：建目录 + 写 tool.json + starter help.md。返回新 id。对偶 TOOL_CREATE。
pub async fn tool_create(tools_dir: &Path, name: &str) -> std::io::Result<String> {
    let id = new_tool_id();
    let dir = tools_dir.join(&id);
    tokio::fs::create_dir_all(&dir).await?;
    let meta = parse_tool_meta(
        &serde_json::json!({"name": name, "icon": "★"}),
        &id,
    );
    let tool_json = serde_json::json!({"name": meta.name, "icon": meta.icon, "order": 999});
    let pretty = serde_json::to_string_pretty(&tool_json)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    tokio::fs::write(dir.join("tool.json"), format!("{}\n", pretty)).await?;
    tokio::fs::write(dir.join("help.md"), starter_help_md(&meta.name)).await?;
    Ok(id)
}

// Starter help.md：单个 ls 按钮加 buttons/buttons-json 语法注释（注释不渲染）。
// 对偶 ipc.ts TOOL_CREATE 里写的那段。{{ 在 Rust raw string 里直接写。
fn starter_help_md(name: &str) -> String {
    format!(
        r#"# {name}

点击按钮运行命令。buttons / buttons-json 的完整语法写在下面这个 buttons 块的注释里（点「编辑」即可看到）。

```buttons
# ── buttons 语法（每行一条命令）──
# 命令                 → 生成一个按钮，按钮文字 = 命令本身
ls
# 命令 # 标签          → 按钮显示「标签」，运行时执行「命令」
# 命令 // edit         → 只粘贴到终端、不自动回车（编辑模式）
# 命令 # 标签 // edit  → 带标签的编辑模式
# // 文字              → 行首以 // 开头：渲染为一段可见纯文本
# # 文字               → 行首以 # 开头：注释，只留在源码、不渲染（这些行就是）
# 空行                 → 跳过

# ── buttons-json 语法（带参数的按钮）──
# 把围栏名 buttons 改成 buttons-json，内容是 JSON 对象或数组，每项可用字段：
#   command（必填）   label   edit   params
# params 每项：name（必填）   required   default   hint   options
# command 里写 {{{{参数名}}}} 占位；点按钮时弹表单收集，值做 POSIX shell 转义后代入
# 示例（去掉下面这行开头的 #，放进 buttons-json 围栏即可用）：
# {{"command":"git commit -m {{{{msg}}}}","label":"提交","params":[{{"name":"msg","required":true}}]}}
```
"#
    )
}

/// tool_delete：rm -r（pty kill 由 command 层做）。对偶 TOOL_DELETE。
pub async fn tool_delete(tools_dir: &Path, tool_id: &str) -> std::io::Result<()> {
    tokio::fs::remove_dir_all(tools_dir.join(tool_id)).await
}

/// tool_reorder：写各 tool.json 的 order。对偶 TOOL_REORDER。
pub async fn tool_reorder(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    for (i, id) in ordered_ids.iter().enumerate() {
        let file = tools_dir.join(id).join("tool.json");
        let raw = tokio::fs::read_to_string(&file).await.unwrap_or_else(|_| "{}".into());
        let mut o: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()));
        if let Some(obj) = o.as_object_mut() {
            obj.insert("order".into(), serde_json::json!(i));
        }
        let pretty = serde_json::to_string_pretty(&o)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        tokio::fs::write(file, format!("{}\n", pretty)).await?;
    }
    Ok(())
}

/// quick_get：读 quick-commands.md，缺失返回 DEFAULT_QUICK_MD。对偶 QUICK_GET。
pub async fn quick_get(user_data_dir: &Path) -> String {
    let file = user_data_dir.join("quick-commands.md");
    tokio::fs::read_to_string(file)
        .await
        .unwrap_or_else(|_| DEFAULT_QUICK_MD.to_string())
}

/// quick_save。对偶 QUICK_SAVE。
pub async fn quick_save(user_data_dir: &Path, md: &str) -> std::io::Result<()> {
    tokio::fs::write(user_data_dir.join("quick-commands.md"), md).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;
    use uuid::Uuid;

    // tempfile::TempDir 给每个测试一个唯一目录并在 drop 时自动清理（对齐 tools.rs 测试）。
    fn tmp() -> TempDir {
        TempDir::new().unwrap()
    }

    /// 列出 dir 下所有子目录名（排序，便于断言）。
    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .collect();
        names.sort();
        names
    }

    fn is_uuid(s: &str) -> bool {
        Uuid::parse_str(s).is_ok()
    }

    /// 给 Iterator<Item=&String>::all 用的适配（.all(is_uuid_str)）。
    fn is_uuid_str(s: &String) -> bool {
        is_uuid(s)
    }

    // ── new_tool_id ────────────────────────────────────────────────────────────
    #[test]
    fn new_tool_id_is_uuid() {
        assert!(is_uuid(&new_tool_id()));
    }

    #[test]
    fn new_tool_id_is_unique() {
        let a = new_tool_id();
        let b = new_tool_id();
        assert_ne!(a, b, "two consecutive ids must differ");
    }

    // ── migrate_to_uuid_ids_blocking ───────────────────────────────────────────
    #[test]
    fn migrate_renames_slug_dirs_to_uuid() {
        let _dir = tmp();
        let dir = _dir.path();
        // 预置两个旧 slug 目录，带 tool.json + help.md
        for name in ["git", "tool-2"] {
            let t = dir.join(name);
            std::fs::create_dir_all(&t).unwrap();
            std::fs::write(t.join("tool.json"), r#"{"name":"X"}"#).unwrap();
            std::fs::write(t.join("help.md"), "# body").unwrap();
        }

        let changed = migrate_to_uuid_ids_blocking(dir);
        assert!(changed, "should report it renamed something");

        // 旧目录消失，两个新目录都是合法 UUID
        let names = dir_names(dir);
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(is_uuid_str), "all dirs must be UUIDs: {:?}", names);
        // 旧 slug 名不再存在
        assert!(!names.iter().any(|n| n == "git" || n == "tool-2"));

        // 内容原样保留（每个目录都有 tool.json + help.md）
        for n in &names {
            let t = dir.join(n);
            assert_eq!(
                std::fs::read_to_string(t.join("tool.json")).unwrap(),
                r#"{"name":"X"}"#
            );
            assert_eq!(std::fs::read_to_string(t.join("help.md")).unwrap(), "# body");
        }
    }

    #[test]
    fn migrate_is_idempotent_on_uuid_dirs() {
        let _dir = tmp();
        let dir = _dir.path();
        // 预置一个已是 UUID 的目录
        let id = Uuid::new_v4().to_string();
        let t = dir.join(&id);
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("help.md"), "x").unwrap();

        // 第一次：已全是 UUID → 不改名
        let changed = migrate_to_uuid_ids_blocking(dir);
        assert!(!changed, "nothing to migrate, should report false");
        let names = dir_names(dir);
        assert_eq!(names, vec![id.clone()], "uuid dir must keep its name");

        // 第二次：仍幂等
        let changed2 = migrate_to_uuid_ids_blocking(dir);
        assert!(!changed2);
        assert_eq!(dir_names(dir), vec![id]);
    }

    #[test]
    fn migrate_keeps_running_after_a_failed_rename_target_clash() {
        // 模拟「目标已存在」时不停重抽：预置一个 UUID 目录 + 一个 slug 目录，
        // 迁移后 slug 被改名（非撞到既有 UUID），最终两个合法 UUID。
        let _dir = tmp();
        let dir = _dir.path();
        let existing_uuid = Uuid::new_v4().to_string();
        std::fs::create_dir_all(dir.join(&existing_uuid)).unwrap();
        let slug = dir.join("docker");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(slug.join("help.md"), "hi").unwrap();

        let changed = migrate_to_uuid_ids_blocking(dir);
        assert!(changed);

        let names = dir_names(dir);
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(is_uuid_str));
        // 既有 UUID 保留，docker 被改成另一个 UUID
        assert!(names.contains(&existing_uuid));
        assert!(!names.contains(&"docker".to_string()));
    }

    #[test]
    fn migrate_ignores_non_dir_entries() {
        let _dir = tmp();
        let dir = _dir.path();
        // 一个散落文件（非目录）+ 一个 slug 目录
        std::fs::write(dir.join("stray.txt"), "x").unwrap();
        std::fs::create_dir_all(dir.join("git")).unwrap();

        migrate_to_uuid_ids_blocking(dir);

        let entries: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .collect();
        // 文件原样保留，目录改名成 UUID
        assert!(entries.contains(&"stray.txt".to_string()));
        assert_eq!(
            entries
                .iter()
                .filter(|n| *n != "stray.txt")
                .filter(|n| is_uuid(n))
                .count(),
            1
        );
    }
}
