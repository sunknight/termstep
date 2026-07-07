//! 对偶 src/main/ipc.ts 中 tool CRUD / bundle / quick 部分。纯 fs 操作。

use crate::pure::{build_buttons_append, merge_tool_json, parse_tool_meta, slugify};
use std::path::Path;

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

/// 第一个空闲 id（base 冲突 → -2,-3…）。对偶 ipc.ts uniqueId。
pub async fn unique_id(tools_dir: &Path, base_raw: &str) -> String {
    let base = {
        let s = slugify(base_raw);
        if s.is_empty() {
            "tool".to_string()
        } else {
            s
        }
    };
    let mut id = base.clone();
    let mut n = 2;
    loop {
        if !tools_dir.join(&id).exists() {
            return id;
        }
        id = format!("{}-{}", base, n);
        n += 1;
    }
}

/// tool_create：建目录 + 写 tool.json + starter help.md。返回新 id。对偶 TOOL_CREATE。
pub async fn tool_create(tools_dir: &Path, name: &str) -> std::io::Result<String> {
    let id = unique_id(tools_dir, name).await;
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
