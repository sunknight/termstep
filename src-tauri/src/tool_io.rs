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
/// 仅当新旧内容不同时才写入（避免无谓的磁盘写，也防止内容未变时触发
/// 版本控制提交——序列化后的字节差异不该算作"变更"）。
pub async fn tool_save(
    dir: &Path,
    markdown: &str,
    meta_patch: serde_json::Value,
) -> std::io::Result<()> {
    let existing = read_tool_json(dir).await;
    let merged = merge_tool_json(&existing, &meta_patch);
    let pretty = serde_json::to_string_pretty(&merged)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tool_json_new = format!("{}\n", pretty);
    let tool_json_path = dir.join("tool.json");
    let tool_json_old = tokio::fs::read_to_string(&tool_json_path).await.unwrap_or_default();
    if tool_json_new != tool_json_old {
        tokio::fs::write(&tool_json_path, tool_json_new).await?;
    }
    let help_path = dir.join("help.md");
    let help_old = tokio::fs::read_to_string(&help_path).await.unwrap_or_default();
    if markdown != help_old {
        tokio::fs::write(&help_path, markdown).await?;
    }
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

/// 生成稳定来源标识（sourceId）：UUID v4。与 `id`（物理目录名）解耦——
/// 目录可因迁移/重命名/导入而换名，但 sourceId 跨导入不变，是「同一个工具」
/// 的匹配键。语义独立，便于将来 decouple（例如 sourceId 与目录名不同）。
pub fn new_source_id() -> String {
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

/// order.json 的内容：order（工具 id 的 flat 数组，纯展示顺序）+ groups
/// （分组展示顺序，分组功能新增的键）。旧版 order.json 没有 groups 键，读为空
/// （向后兼容：缺失即所有工具归未分组，零迁移）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderIndex {
    pub order: Vec<String>,
    pub groups: Vec<String>,
}

/// 读排序索引。缺失/损坏返回空 OrderIndex（scanner 对不在数组里的 id 兜底排末尾）。
/// 同步（std::fs）：scanner 是同步路径，对偶它。
pub fn read_order_index(tools_dir: &Path) -> OrderIndex {
    let file = tools_dir.join(ORDER_INDEX_FILE);
    let raw = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(_) => return OrderIndex::default(),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return OrderIndex::default(),
    };
    let order = v
        .get("order")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let groups = v
        .get("groups")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    OrderIndex { order, groups }
}

/// 原子写排序索引：只更新 order，**保留**已存在的 groups（read-modify-write）。
/// 写临时文件再 rename，避免 watcher 读到半截 JSON。
pub async fn write_order_index(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    let mut idx = read_order_index(tools_dir); // 保留 groups
    idx.order = ordered_ids.to_vec();
    let obj = serde_json::json!({ "order": idx.order, "groups": idx.groups });
    let pretty = serde_json::to_string_pretty(&obj)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let final_path = tools_dir.join(ORDER_INDEX_FILE);
    // 写到同目录下的临时文件再 rename（同目录 rename 是原子的）。
    let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
    tokio::fs::write(&tmp, format!("{}\n", pretty)).await?;
    tokio::fs::rename(&tmp, &final_path).await?;
    Ok(())
}

/// 同步读取所有工具目录的 group 字段（key = tool id，value = 分组名或 None）。
/// 用于 tool_move 在 order.json 中定位目标分组的插入位置。不走 scan_tools
/// 是因为后者会拉取远程 md，移动操作不需要。
pub fn read_tool_groups(tools_dir: &Path) -> std::collections::HashMap<String, Option<String>> {
    let mut map = std::collections::HashMap::new();
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.flatten() {
        let filetype = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !filetype.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.is_empty() || id.contains('/') || id.contains("\\") || id.contains("..") || id.contains('\0') {
            continue;
        }
        let json_path = entry.path().join("tool.json");
        let raw = match std::fs::read_to_string(&json_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let group = v
            .get("group")
            .and_then(|g| g.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        map.insert(id, group);
    }
    map
}

/// 移动工具到另一个分组并调整排序。
/// - `target_group`: Some(分组名) 或 None（未分组）。
/// - `before_id`: Some(工具 id) 时插到该工具之前；None 时追加到目标分组末尾。
/// 写 tool.json 的 group 字段 + 重写 order.json，失败返回 Err。
pub async fn tool_move(
    tools_dir: &Path,
    tool_id: &str,
    target_group: Option<&str>,
    before_id: Option<&str>,
) -> std::io::Result<()> {
    // 1. 更新 tool.json 的 group 字段。
    let tool_json_path = tools_dir.join(tool_id).join("tool.json");
    let raw = tokio::fs::read_to_string(&tool_json_path).await?;
    let mut v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    if let Some(obj) = v.as_object_mut() {
        if let Some(g) = target_group.map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("group".into(), serde_json::json!(g));
        } else {
            obj.remove("group");
        }
    }
    let pretty = serde_json::to_string_pretty(&v)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    tokio::fs::write(&tool_json_path, format!("{}\n", pretty)).await?;

    // 2. 调整 order.json：先移除，再按目标位置插入。
    let mut idx = read_order_index(tools_dir);
    idx.order.retain(|x| x != tool_id);

    let insert_pos = if let Some(bid) = before_id {
        idx.order
            .iter()
            .position(|x| x == bid)
            .unwrap_or(idx.order.len())
    } else {
        // 追加到目标分组末尾：找目标分组在现有顺序中的最后一个工具，插到其后。
        let groups = read_tool_groups(tools_dir);
        let mut last_pos: Option<usize> = None;
        for (i, id) in idx.order.iter().enumerate() {
            let g = if id == tool_id {
                target_group.map(|s| s.to_string())
            } else {
                groups.get(id).cloned().unwrap_or(None)
            };
            if g.as_deref() == target_group {
                last_pos = Some(i);
            }
        }
        last_pos.map(|p| p + 1).unwrap_or(idx.order.len())
    };

    idx.order.insert(insert_pos, tool_id.to_string());
    write_order_index(tools_dir, &idx.order).await
}

/// 若 group 非空且不在 order.json 的 groups 数组中，追加。已存在则 no-op。
/// 由 tool_save 在写完 tool.json 后调用：编辑器保存工具时若指定了新分组名，
/// 把它登记到 groups 索引里（展示顺序）。失败只返回 Err，由调用方决定降级。
pub async fn append_group_if_new(tools_dir: &Path, group: Option<&str>) -> std::io::Result<()> {
    let name = match group.map(str::trim).filter(|s| !s.is_empty()) {
        Some(g) => g,
        None => return Ok(()), // 未分组：不动 groups
    };
    let mut idx = read_order_index(tools_dir);
    if idx.groups.iter().any(|g| g == name) {
        return Ok(()); // 已登记 → no-op
    }
    idx.groups.push(name.to_string());
    let obj = serde_json::json!({ "order": idx.order, "groups": idx.groups });
    let pretty = serde_json::to_string_pretty(&obj)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let final_path = tools_dir.join(ORDER_INDEX_FILE);
    let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
    tokio::fs::write(&tmp, format!("{}\n", pretty)).await?;
    tokio::fs::rename(&tmp, &final_path).await?;
    Ok(())
}

/// 读 order.json 的 groups 数组（展示顺序）。供不走全量 scan 的 emit 路径
/// （tool_delete / tool_reorder）带上 groups，避免前端在后台 scan 到达前
/// 丢失分组索引（侧栏分组标题闪没）。缺失/损坏返回空。
pub fn read_groups(tools_dir: &Path) -> Vec<String> {
    read_order_index(tools_dir).groups
}
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

/// 给所有缺失 `sourceId` 的工具补一个（幂等）。sourceId 是跨导入的稳定匹配键：
/// 有了它，同一 bundle 再次导入时按 sourceId 命中已有工具→更新，而非每次新建。
///
/// 时序：在 UUID / order 迁移之后调用（只读改 tool.json 内容，不碰目录名/索引）。
/// 幂等：已有 sourceId 的工具跳过。单个 tool.json 读写失败只跳过并告警，不阻断。
/// 返回是否至少改了一个文件。
pub fn migrate_add_source_id_blocking(tools_dir: &Path) -> bool {
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
        let json_path = entry.path().join("tool.json");
        let raw = match std::fs::read_to_string(&json_path) {
            Ok(s) => s,
            Err(_) => continue, // 无 tool.json 的目录跳过
        };
        let mut v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue, // 损坏的 tool.json 跳过，不破坏
        };
        let already_has = v
            .get("sourceId")
            .and_then(|s| s.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if already_has {
            continue;
        }
        if let Some(obj) = v.as_object_mut() {
            obj.insert("sourceId".into(), serde_json::json!(new_source_id()));
            if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                match std::fs::write(&json_path, format!("{}\n", pretty)) {
                    Ok(()) => changed = true,
                    Err(e) => eprintln!("migrate_add_source_id: write {} failed: {}", json_path.display(), e),
                }
            }
        }
    }
    changed
}

/// 迁移完成标志文件名（相对 configs_dir）。存在即代表迁移已成功完成，可安全跳过。
/// 必须在所有 rename 成功后、最后才写入——这样中途失败（rename 出错 / 进程被杀）
/// 不会留下标志文件，下次启动会重试，旧 tools/ 不致被遗弃在旧位置。
pub const MIGRATION_MARKER: &str = ".migrated";

/// 把旧布局（tools/ 和 quick-commands.md 直接放在 user_data_dir 下）搬迁到
/// 新的 configs/ 子目录（configs 成为 git 仓库根）。
///
/// 幂等判断**不用** configs/ 是否存在（create_dir_all 成功但 rename 失败会留下
/// 空 configs/，那种情况仍需重试），而用 configs/.migrated 标志文件：存在 → 已完成。
/// 否则创建 configs/，把 user_data_dir/tools 和 user_data_dir/quick-commands.md
/// 同卷 rename 进去（原子且瞬时）。单个 rename 失败只跳过并告警，不阻断——旧文件
/// 原地不动，下次启动重试。全部 rename 完成（或本就无源文件）后才写标志文件。
/// 不碰 tools.bak-polluted 等其它目录。
///
/// 同步（std::fs）：与 uuid / order 两个迁移一样，必须在任何 scan/seed/pty 之前、
/// 在 tools_dir 派生之前调用。
pub fn migrate_to_configs_blocking(user_data_dir: &Path) -> bool {
    let configs_dir = user_data_dir.join("configs");
    // 标志文件存在 = 已成功迁移过，跳过。
    if configs_dir.join(MIGRATION_MARKER).exists() {
        return false;
    }
    if let Err(e) = std::fs::create_dir_all(&configs_dir) {
        eprintln!("migrate_to_configs: create_dir_all failed: {}", e);
        return false;
    }

    let mut changed = false;
    let tools_src = user_data_dir.join("tools");
    if tools_src.exists() {
        let tools_dst = configs_dir.join("tools");
        match std::fs::rename(&tools_src, &tools_dst) {
            Ok(()) => changed = true,
            Err(e) => eprintln!("migrate_to_configs: rename tools failed: {}", e),
        }
    }

    let quick_src = user_data_dir.join("quick-commands.md");
    if quick_src.exists() {
        let quick_dst = configs_dir.join("quick-commands.md");
        match std::fs::rename(&quick_src, &quick_dst) {
            Ok(()) => changed = true,
            Err(e) => eprintln!("migrate_to_configs: rename quick-commands failed: {}", e),
        }
    }

    // 所有 rename 完成（或本就无源文件）后写标志文件——一旦写入，后续启动直接跳过。
    // 写失败只告警，不阻断：下次启动会重试整个迁移（标志缺失 → 重新走一遍，幂等安全）。
    if let Err(e) = std::fs::write(configs_dir.join(MIGRATION_MARKER), "1\n") {
        eprintln!("migrate_to_configs: write marker failed: {}", e);
    }

    changed
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
        assert!(read_order_index(_dir.path()).order.is_empty());
    }

    #[test]
    fn read_order_index_parses_array() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a","b","c"]}"#).unwrap();
        assert_eq!(read_order_index(dir).order, vec!["a".to_string(), "b".into(), "c".into()]);
    }

    #[test]
    fn read_order_index_returns_empty_on_corrupt_json() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), "{ not json").unwrap();
        assert!(read_order_index(dir).order.is_empty());
    }

    #[test]
    fn read_order_index_returns_empty_when_order_not_array() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":"notarray"}"#).unwrap();
        assert!(read_order_index(dir).order.is_empty());
    }

    #[test]
    fn read_order_index_returns_groups_when_present() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a","b"],"groups":["前端","后端"]}"#,
        )
        .unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["a".to_string(), "b".into()]);
        assert_eq!(idx.groups, vec!["前端".to_string(), "后端".into()]);
    }

    #[test]
    fn read_order_index_groups_default_empty_when_missing() {
        // 旧版 order.json（无 groups 键）→ groups 读为空（向后兼容）
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["a".to_string()]);
        assert!(idx.groups.is_empty(), "missing groups key → empty");
    }

    #[test]
    fn read_order_index_groups_default_empty_when_corrupt() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), "{ not json").unwrap();
        let idx = read_order_index(dir);
        assert!(idx.order.is_empty());
        assert!(idx.groups.is_empty());
    }

    // ── order index: write_order_index ─────────────────────────────────────────
    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let _dir = tmp();
        let dir = _dir.path();
        let ids = vec!["x".to_string(), "y".into(), "z".into()];
        write_order_index(dir, &ids).await.unwrap();
        assert_eq!(read_order_index(dir).order, ids);
    }

    #[tokio::test]
    async fn write_order_index_preserves_existing_groups() {
        // write_order_index 只改 order，不得覆盖已存在的 groups
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端"]}"#,
        )
        .unwrap();
        write_order_index(dir, &["b".into(), "a".into()]).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["b".to_string(), "a".into()]);
        assert_eq!(idx.groups, vec!["前端".to_string()], "groups must be preserved");
    }

    #[tokio::test]
    async fn append_group_if_new_appends_when_absent() {
        let _dir = tmp();
        let dir = _dir.path();
        // 初始 order.json 无 groups
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string()]);
        // order 不受影响
        assert_eq!(idx.order, vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn append_group_if_new_noop_when_present() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端"]}"#,
        )
        .unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string()], "no duplicate");
    }

    #[tokio::test]
    async fn append_group_if_new_ignores_empty_and_none() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        append_group_if_new(dir, Some("   ")).await.unwrap();
        append_group_if_new(dir, None).await.unwrap();
        let idx = read_order_index(dir);
        assert!(idx.groups.is_empty(), "empty/None group must not be appended");
    }

    #[tokio::test]
    async fn append_group_if_new_appends_multiple_in_order() {
        let _dir = tmp();
        let dir = _dir.path();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        append_group_if_new(dir, Some("后端")).await.unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap(); // 重复 → no-op
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string(), "后端".into()]);
    }

    #[test]
    fn read_groups_returns_indexed_groups() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端","后端"]}"#,
        )
        .unwrap();
        assert_eq!(read_groups(dir), vec!["前端".to_string(), "后端".into()]);
    }

    #[test]
    fn read_groups_empty_when_missing() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        assert!(read_groups(dir).is_empty());
    }

    // ── tool_move：跨分组移动 + 排序调整 ───────────────────────────────────────
    /// 创建一个带 group 的工具目录，返回其 dir（用于断言）。
    fn make_tool(dir: &Path, id: &str, group: Option<&str>) {
        let t = dir.join(id);
        std::fs::create_dir_all(&t).unwrap();
        let mut obj = serde_json::json!({"name": id, "icon": "★"});
        if let Some(g) = group {
            obj["group"] = serde_json::json!(g);
        }
        let pretty = serde_json::to_string_pretty(&obj).unwrap();
        std::fs::write(t.join("tool.json"), format!("{}\n", pretty)).unwrap();
        std::fs::write(t.join("help.md"), "").unwrap();
    }

    #[tokio::test]
    async fn tool_move_updates_group_field_in_tool_json() {
        let _dir = tmp();
        let dir = _dir.path();
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", None);
        std::fs::write(dir.join("order.json"), r#"{"order":["a","b"],"groups":["前端"]}"#).unwrap();

        tool_move(dir, "b", Some("前端"), Some("a")).await.unwrap();

        let raw = std::fs::read_to_string(dir.join("b").join("tool.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v.get("group").and_then(|g| g.as_str()), Some("前端"));
    }

    #[tokio::test]
    async fn tool_move_to_ungrouped_removes_group_field() {
        let _dir = tmp();
        let dir = _dir.path();
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", Some("后端"));
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a","b"],"groups":["前端","后端"]}"#,
        )
        .unwrap();

        tool_move(dir, "a", None, None).await.unwrap();

        let raw = std::fs::read_to_string(dir.join("a").join("tool.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v.get("group").is_none(), "group field should be removed for ungrouped");
    }

    #[tokio::test]
    async fn tool_move_before_id_inserts_before_target() {
        let _dir = tmp();
        let dir = _dir.path();
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", Some("前端"));
        make_tool(dir, "c", Some("前端"));
        std::fs::write(dir.join("order.json"), r#"{"order":["a","b","c"],"groups":["前端"]}"#).unwrap();

        // 把 c 移到 a 之前 → [c, a, b]
        tool_move(dir, "c", Some("前端"), Some("a")).await.unwrap();
        assert_eq!(
            read_order_index(dir).order,
            vec!["c".to_string(), "a".into(), "b".into()]
        );
    }

    #[tokio::test]
    async fn tool_move_append_to_group_puts_after_last_of_group() {
        let _dir = tmp();
        let dir = _dir.path();
        // 前端：a, b；后端：c
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", Some("前端"));
        make_tool(dir, "c", Some("后端"));
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a","b","c"],"groups":["前端","后端"]}"#,
        )
        .unwrap();

        // 把 c 移到「前端」分组末尾 → 前端末尾即 b 之后、c 之前 → [a, b, c]，group 变前端
        tool_move(dir, "c", Some("前端"), None).await.unwrap();
        assert_eq!(
            read_order_index(dir).order,
            vec!["a".to_string(), "b".into(), "c".into()],
            "c should remain at end position but belong to 前端"
        );
        let raw = std::fs::read_to_string(dir.join("c").join("tool.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v.get("group").and_then(|g| g.as_str()), Some("前端"));
    }

    #[tokio::test]
    async fn tool_move_append_to_empty_group_inserts_at_end() {
        let _dir = tmp();
        let dir = _dir.path();
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", Some("后端"));
        // 「测试」分组已在 groups 索引但没有任何工具
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a","b"],"groups":["前端","测试","后端"]}"#,
        )
        .unwrap();

        // 把 a 移到空分组「测试」→ 该分组无工具 → 追加到末尾
        tool_move(dir, "a", Some("测试"), None).await.unwrap();
        assert_eq!(
            read_order_index(dir).order,
            vec!["b".to_string(), "a".into()],
            "empty target group → append at end"
        );
        let raw = std::fs::read_to_string(dir.join("a").join("tool.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v.get("group").and_then(|g| g.as_str()), Some("测试"));
    }

    #[test]
    fn read_tool_groups_parses_group_map() {
        let _dir = tmp();
        let dir = _dir.path();
        make_tool(dir, "a", Some("前端"));
        make_tool(dir, "b", None);
        make_tool(dir, "c", Some("后端"));
        let map = read_tool_groups(dir);
        assert_eq!(map.get("a").and_then(|g| g.as_deref()), Some("前端"));
        assert_eq!(map.get("b").and_then(|g| g.as_deref()), None);
        assert_eq!(map.get("c").and_then(|g| g.as_deref()), Some("后端"));
    }

    // ── 端到端：保存工具时 group 字段进入 order.json.groups 并被 scan 返回 ───────
    #[tokio::test]
    async fn save_tool_with_group_registers_group_and_scan_returns_it() {
        let _dir = tmp();
        let dir = _dir.path();
        let id = "11111111-1111-4111-8111-111111111111";
        let tool_dir = dir.join(id);
        tokio::fs::create_dir_all(&tool_dir).await.unwrap();
        // 初始无 order.json
        tool_save(
            &tool_dir,
            "# Test",
            serde_json::json!({"name":"A","icon":"★","group":"前端"}),
        )
        .await
        .unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap();

        let idx = read_order_index(dir);
        // tool_save 不写 order；append_group_if_new 只登记 group，order 保持原样（空）
        assert!(idx.order.is_empty());
        assert_eq!(idx.groups, vec!["前端".to_string()]);

        let r = crate::tools::scan_tools(dir).await;
        assert_eq!(r.groups, vec!["前端".to_string()]);
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].meta.group.as_deref(), Some("前端"));
        // 不在 order 索引里的工具兜底排末尾（order = i64::MAX）
        assert_eq!(r.tools[0].meta.order, i64::MAX);
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
        assert_eq!(read_order_index(dir).order, ids);
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
        assert_eq!(read_order_index(dir).order, vec!["docker".to_string(), "git".into()]);
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
        assert_eq!(read_order_index(dir).order, vec!["git".to_string()]);
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
        assert_eq!(read_order_index(dir).order, vec!["a".to_string(), "b".into()]);
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

    // ── migrate_to_configs_blocking ───────────────────────────────────────────
    #[test]
    fn migrate_to_configs_moves_tools_and_quick() {
        let _dir = tmp();
        let dir = _dir.path();
        // 预置旧布局：tools/<uuid>/tool.json + quick-commands.md
        let tool_dir = dir.join("tools").join("11111111-1111-4111-8111-111111111111");
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(tool_dir.join("tool.json"), r#"{"name":"Git"}"#).unwrap();
        std::fs::write(dir.join("quick-commands.md"), "# 快捷\n").unwrap();

        let changed = migrate_to_configs_blocking(dir);
        assert!(changed);

        // 旧位置消失，新位置有内容
        assert!(!dir.join("tools").exists(), "old tools/ must be moved");
        assert!(
            !dir.join("quick-commands.md").exists(),
            "old quick-commands.md must be moved"
        );
        let cfg = dir.join("configs");
        let moved_json = std::fs::read_to_string(
            cfg.join("tools/11111111-1111-4111-8111-111111111111/tool.json"),
        )
        .unwrap();
        assert_eq!(moved_json, r#"{"name":"Git"}"#);
        assert_eq!(
            std::fs::read_to_string(cfg.join("quick-commands.md")).unwrap(),
            "# 快捷\n"
        );
        // 迁移完成后必须有标志文件
        assert!(
            cfg.join(MIGRATION_MARKER).exists(),
            "marker must exist after successful migration"
        );
    }

    #[test]
    fn migrate_to_configs_is_idempotent_with_marker() {
        let _dir = tmp();
        let dir = _dir.path();
        // 预置标志文件 = 已迁移完成。即便旧 tools/ 还在（不应出现的情况），也必须跳过。
        std::fs::create_dir_all(dir.join("configs")).unwrap();
        std::fs::write(dir.join("configs").join(MIGRATION_MARKER), "1\n").unwrap();
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::fs::write(dir.join("tools/x.txt"), "x").unwrap();

        let changed = migrate_to_configs_blocking(dir);
        assert!(!changed, "marker exists → skip");
        // 标志文件存在时，旧 tools/ 不被触碰
        assert!(dir.join("tools").exists(), "old tools/ left untouched");
    }

    #[test]
    fn migrate_to_configs_retries_when_empty_configs_without_marker() {
        // 核心边界：configs/ 已存在但无标志文件（上次 create_dir 成功后 rename
        // 失败 / 进程被杀）。必须重试迁移，而非因 configs 存在就跳过。
        let _dir = tmp();
        let dir = _dir.path();
        // 模拟中断后的状态：空 configs/ 已建 + 旧 tools/ 还在
        std::fs::create_dir_all(dir.join("configs")).unwrap();
        let tool_dir = dir.join("tools").join("22222222-2222-4222-8222-222222222222");
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(tool_dir.join("tool.json"), r#"{"name":"Docker"}"#).unwrap();

        let changed = migrate_to_configs_blocking(dir);
        assert!(changed, "no marker → must retry migration");
        // tools 被搬进 configs，且标志文件写入
        assert!(
            dir.join("configs/tools/22222222-2222-4222-8222-222222222222/tool.json").exists(),
            "tools must be moved on retry"
        );
        assert!(dir.join("configs").join(MIGRATION_MARKER).exists());
    }

    #[test]
    fn migrate_to_configs_writes_marker_when_nothing_to_move() {
        let _dir = tmp();
        let dir = _dir.path();
        // 空的 user_data_dir：无源文件可搬，但 configs 创建后仍应写标志文件（首次安装路径）。
        let changed = migrate_to_configs_blocking(dir);
        assert!(!changed, "no files moved");
        assert!(dir.join("configs").exists(), "configs dir created");
        assert!(
            dir.join("configs").join(MIGRATION_MARKER).exists(),
            "marker written even when nothing to move"
        );
    }

    // ── new_source_id ──────────────────────────────────────────────────────────
    #[test]
    fn new_source_id_is_uuid() {
        assert!(is_uuid(&new_source_id()));
    }

    #[test]
    fn new_source_id_is_unique() {
        assert_ne!(new_source_id(), new_source_id());
    }

    // ── migrate_add_source_id_blocking ─────────────────────────────────────────
    fn write_tool_json(dir: &Path, id: &str, json: &str) {
        let t = dir.join(id);
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("tool.json"), json).unwrap();
    }

    #[test]
    fn migrate_add_source_id_adds_for_missing() {
        let _dir = tmp();
        let dir = _dir.path();
        // 两个工具都无 sourceId
        write_tool_json(dir, "11111111-1111-4111-8111-111111111111", r#"{"name":"A"}"#);
        write_tool_json(dir, "22222222-2222-4222-8222-222222222222", r#"{"name":"B"}"#);

        let changed = migrate_add_source_id_blocking(dir);
        assert!(changed, "should report it added sourceId");

        for id in ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join(id).join("tool.json")).unwrap()).unwrap();
            let sid = v.get("sourceId").and_then(|s| s.as_str()).unwrap();
            assert!(is_uuid(sid), "sourceId must be a UUID: {}", sid);
            assert_eq!(v["name"], if id.starts_with("1111") { "A" } else { "B" });
        }
    }

    #[test]
    fn migrate_add_source_id_is_idempotent() {
        let _dir = tmp();
        let dir = _dir.path();
        let existing = "33333333-3333-4333-8333-333333333333";
        // 已有 sourceId 的工具
        write_tool_json(dir, existing, r#"{"name":"A","sourceId":"src-already"}"#);

        let changed = migrate_add_source_id_blocking(dir);
        assert!(!changed, "already has sourceId → skip");
        // sourceId 不被覆盖
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(existing).join("tool.json")).unwrap()).unwrap();
        assert_eq!(v["sourceId"], "src-already");
    }

    #[test]
    fn migrate_add_source_id_skips_empty_value() {
        // sourceId 存在但是空串 → 视为缺失，补一个新的。
        let _dir = tmp();
        let dir = _dir.path();
        write_tool_json(dir, "44444444-4444-4444-8444-444444444444", r#"{"name":"A","sourceId":""}"#);

        let changed = migrate_add_source_id_blocking(dir);
        assert!(changed, "empty sourceId → treat as missing");
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("44444444-4444-4444-8444-444444444444").join("tool.json")).unwrap(),
        )
        .unwrap();
        let sid = v.get("sourceId").and_then(|s| s.as_str()).unwrap();
        assert!(!sid.is_empty(), "must be refilled with non-empty UUID");
        assert!(is_uuid(sid));
    }

    #[test]
    fn migrate_add_source_id_skips_dir_without_tool_json() {
        let _dir = tmp();
        let dir = _dir.path();
        // 一个只有 help.md 没有 tool.json 的目录（损坏/手工建）→ 跳过不崩
        std::fs::create_dir_all(dir.join("stray")).unwrap();
        std::fs::write(dir.join("stray").join("help.md"), "x").unwrap();

        let changed = migrate_add_source_id_blocking(dir);
        assert!(!changed, "no tool.json → nothing to do");
    }
}
