//! 对偶 src/main/ipc.ts 中 tool CRUD / bundle / quick 部分。纯 fs 操作。

use crate::pure::{build_md_append, merge_tool_json, parse_tool_meta};
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

/// tool_append_md：把 body 原样作为 markdown 块追加到 help.md 末尾（不再包裹 ```buttons 围栏）。
/// 返回是否实际写入。对偶 TOOL_APPEND_MD。
pub async fn tool_append_md(dir: &Path, body: &str) -> std::io::Result<bool> {
    let file = dir.join("help.md");
    let cur = tokio::fs::read_to_string(&file).await.unwrap_or_default();
    let next = build_md_append(&cur, body);
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
    // 不写 order：排序由 tools/order.json 索引统一管理。新工具不在索引里 →
    // scanner 兜底排末尾（usize::MAX），首次 reorder 后进索引。
    let tool_json = serde_json::json!({"name": meta.name, "icon": meta.icon});
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

/// 排序索引文件名（相对 tools_dir）：`tools/order.json`。
/// 内容是 `{"order":["uuid1","uuid2",...]}`，整个应用唯一的排序来源。
/// 单文件存储让 reorder 只重写一处（而非每个 tool.json），从根上避免分散写入。
const ORDER_INDEX_FILE: &str = "order.json";

/// 读排序索引。缺失/损坏返回空 vec（scanner 对不在数组里的 id 兜底排末尾）。
/// 同步（std::fs）：scanner 是同步路径，对偶它。
pub fn read_order_index(tools_dir: &Path) -> Vec<String> {
    let file = tools_dir.join(ORDER_INDEX_FILE);
    let raw = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    v.get("order")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 原子写排序索引：写临时文件再 rename，避免 watcher 读到半截 JSON。
pub async fn write_order_index(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    let obj = serde_json::json!({ "order": ordered_ids });
    let pretty = serde_json::to_string_pretty(&obj)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let final_path = tools_dir.join(ORDER_INDEX_FILE);
    // 写到同目录下的临时文件再 rename（同目录 rename 是原子的）。
    let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
    tokio::fs::write(&tmp, format!("{}\n", pretty)).await?;
    tokio::fs::rename(&tmp, &final_path).await?;
    Ok(())
}

/// 把旧「每个 tool.json 各存一个 order 字段」迁移到单一的 order.json 索引，
/// 并清理 tool.json 里的 order 字段。幂等：order.json 已存在则跳过。
///
/// 时序：必须在 `migrate_to_uuid_ids_blocking` **之后**调用（索引里存的是迁移后
/// 的 UUID 目录名）。返回是否写了索引。
pub fn migrate_order_to_index_blocking(tools_dir: &Path) -> bool {
    // 已有索引 → 不动（幂等）。
    if tools_dir.join(ORDER_INDEX_FILE).exists() {
        return false;
    }
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    // 收集 (order, id)，order 缺失按 0 兜底（与 parse_tool_meta 一致）。
    let mut ordered: Vec<(i64, String)> = vec![];
    let mut to_clean: Vec<String> = vec![];
    for entry in entries.flatten() {
        let filetype = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !filetype.is_dir() {
            continue;
        }
        let id = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let json_path = tools_dir.join(&id).join("tool.json");
        let raw = match std::fs::read_to_string(&json_path) {
            Ok(s) => s,
            Err(_) => {
                // 无 tool.json：order 视为 0，不进清理列表
                ordered.push((0, id));
                continue;
            }
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                ordered.push((0, id));
                continue;
            }
        };
        let order = v.get("order").and_then(|o| o.as_i64()).unwrap_or(0);
        ordered.push((order, id.clone()));
        if v.get("order").is_some() {
            to_clean.push(id);
        }
    }
    // 按 (order, id) 排序 → id 数组
    ordered.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let ids: Vec<String> = ordered.into_iter().map(|(_, id)| id).collect();

    // 写索引（同步写 + rename 模拟原子）
    if let Ok(obj) = serde_json::to_string_pretty(&serde_json::json!({ "order": ids })) {
        let final_path = tools_dir.join(ORDER_INDEX_FILE);
        let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
        if std::fs::write(&tmp, format!("{}\n", obj)).is_ok() && std::fs::rename(&tmp, &final_path).is_ok() {
            // 清理 tool.json 里的 order 字段（单个失败容错跳过）
            for id in to_clean {
                let json_path = tools_dir.join(&id).join("tool.json");
                if let Ok(raw) = std::fs::read_to_string(&json_path) {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if let Some(obj) = v.as_object_mut() {
                            obj.remove("order");
                            if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                                let _ = std::fs::write(&json_path, format!("{}\n", pretty));
                            }
                        }
                    }
                }
            }
            return true;
        }
    }
    false
}

/// tool_reorder：写排序索引 order.json（不再遍历各 tool.json）。对偶 TOOL_REORDER。
pub async fn tool_reorder(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    write_order_index(tools_dir, ordered_ids).await
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

    // ── order index: read_order_index ──────────────────────────────────────────
    #[test]
    fn read_order_index_returns_empty_when_missing() {
        let _dir = tmp();
        assert!(read_order_index(_dir.path()).is_empty());
    }

    #[test]
    fn read_order_index_parses_array() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a","b","c"]}"#).unwrap();
        assert_eq!(read_order_index(dir), vec!["a".to_string(), "b".into(), "c".into()]);
    }

    #[test]
    fn read_order_index_returns_empty_on_corrupt_json() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), "{ not json").unwrap();
        assert!(read_order_index(dir).is_empty());
    }

    #[test]
    fn read_order_index_returns_empty_when_order_not_array() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":"notarray"}"#).unwrap();
        assert!(read_order_index(dir).is_empty());
    }

    // ── order index: write_order_index ─────────────────────────────────────────
    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let _dir = tmp();
        let dir = _dir.path();
        let ids = vec!["x".to_string(), "y".into(), "z".into()];
        write_order_index(dir, &ids).await.unwrap();
        assert_eq!(read_order_index(dir), ids);
    }

    #[tokio::test]
    async fn write_order_index_is_atomic_no_tmp_left() {
        let _dir = tmp();
        let dir = _dir.path();
        write_order_index(dir, &["a".into()]).await.unwrap();
        // 写完后不应残留临时文件
        assert!(!dir.join(".order.json.tmp").exists());
        assert!(dir.join("order.json").exists());
    }

    #[tokio::test]
    async fn tool_reorder_writes_index_file() {
        let _dir = tmp();
        let dir = _dir.path();
        let ids = vec!["b".to_string(), "a".into()];
        tool_reorder(dir, &ids).await.unwrap();
        assert_eq!(read_order_index(dir), ids);
    }

    // ── migrate_order_to_index_blocking ────────────────────────────────────────
    #[test]
    fn migrate_order_to_index_from_tool_json() {
        let _dir = tmp();
        let dir = _dir.path();
        // 两个工具，docker 的 order 更小 → 排前面
        std::fs::create_dir_all(dir.join("git")).unwrap();
        std::fs::write(dir.join("git").join("tool.json"), r#"{"name":"Git","order":2}"#).unwrap();
        std::fs::create_dir_all(dir.join("docker")).unwrap();
        std::fs::write(dir.join("docker").join("tool.json"), r#"{"name":"Docker","order":1}"#)
            .unwrap();

        let changed = migrate_order_to_index_blocking(dir);
        assert!(changed);

        // 索引按 order 升序：docker 在前
        assert_eq!(read_order_index(dir), vec!["docker".to_string(), "git".into()]);
        // tool.json 里的 order 字段被清理
        let git = std::fs::read_to_string(dir.join("git").join("tool.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&git).unwrap();
        assert!(v.get("order").is_none(), "order must be removed from tool.json");
        assert_eq!(v["name"], "Git");
    }

    #[test]
    fn migrate_order_to_index_is_idempotent() {
        let _dir = tmp();
        let dir = _dir.path();
        // 预置一个工具 + 一个已有的 order.json
        std::fs::create_dir_all(dir.join("git")).unwrap();
        std::fs::write(dir.join("git").join("tool.json"), r#"{"name":"Git","order":5}"#).unwrap();
        std::fs::write(dir.join("order.json"), r#"{"order":["git"]}"#).unwrap();

        let changed = migrate_order_to_index_blocking(dir);
        assert!(!changed, "order.json already exists → skip");
        // 索引不变（未被覆盖）
        assert_eq!(read_order_index(dir), vec!["git".to_string()]);
        // tool.json 的 order 未被清理（迁移跳过了）
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("git").join("tool.json")).unwrap())
                .unwrap();
        assert_eq!(v["order"], 5);
    }

    #[test]
    fn migrate_order_to_index_defaults_missing_order_to_zero() {
        let _dir = tmp();
        let dir = _dir.path();
        // 无 order 字段 → 视为 0；按 id 二级排序
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("b").join("tool.json"), r#"{"name":"B"}"#).unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a").join("tool.json"), r#"{"name":"A"}"#).unwrap();

        migrate_order_to_index_blocking(dir);
        // 两个都 order=0 → 按 id 升序：a, b
        assert_eq!(read_order_index(dir), vec!["a".to_string(), "b".into()]);
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
