//! 纯数据转换函数，对偶 src/shared/{toolJson,buttonBlock,bundle,toolConfig}.ts
//! 后端用到的最小子集。无 fs/网络，纯函数，#[cfg(test)] 覆盖。

use crate::types::*;
use serde_json::Value;

/// 合并 existing tool.json 与编辑器 patch，裁掉被清空的 optional 字段。
/// 对偶 src/shared/toolJson.ts mergeToolJson。
pub fn merge_tool_json(existing: &Value, patch: &Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(o) = existing.as_object() {
        for (k, v) in o {
            if !v.is_null() {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(o) = patch.as_object() {
        for (k, v) in o {
            if !v.is_null() {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    // 裁掉被清空的 optional 字段（空字符串 = 清空）
    for k in &["cwd", "tmux", "mdUrl"] {
        if merged.get(*k).and_then(|v| v.as_str()) == Some("") {
            merged.remove(*k);
        }
    }
    if merged
        .get("initCommands")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(false)
    {
        merged.remove("initCommands");
    }
    if merged.get("mdUrl").is_none() {
        merged.remove("autoUpdateMinutes");
        merged.remove("useRemote");
    }
    Value::Object(merged)
}

/// 把 body 原样作为 markdown 块追加到 current_md 末尾（不再包裹 ```buttons 围栏）。
/// 快速添加输入框默认预填 buttons 围栏模板，但 body 不再强制包裹——
/// 用户可改围栏类型、删掉围栏写普通文本/标题，或粘贴任意 markdown。
/// 对偶 src/shared/buttonBlock.ts buildMdAppend。
pub fn build_md_append(current_md: &str, body: &str) -> String {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return current_md.to_string();
    }
    let trimmed_md = current_md.trim_end();
    if trimmed_md.is_empty() {
        format!("{}\n", trimmed_body)
    } else {
        format!("{}\n\n{}\n", trimmed_md, trimmed_body)
    }
}

/// 对偶 src/shared/bundle.ts serializeTools。
pub fn serialize_tools(tools: &[Tool], exported_at: &str) -> ToolsBundle {
    ToolsBundle {
        version: BUNDLE_VERSION,
        app: "TermStep".into(),
        exported_at: Some(exported_at.into()),
        tools: tools
            .iter()
            .map(|t| BundleTool {
                meta: t.meta.clone(),
                help_markdown: t.help_markdown.clone(),
            })
            .collect(),
    }
}

pub struct ParseResult {
    pub tools: Vec<BundleTool>,
    pub error: Option<String>,
}

/// 对偶 src/shared/bundle.ts parseToolsBundle。
pub fn parse_tools_bundle(raw: &str) -> ParseResult {
    let obj: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return ParseResult {
                tools: vec![],
                error: Some(format!("JSON 解析失败: {}", e)),
            }
        }
    };
    let o = match obj.as_object() {
        Some(m) => m,
        None => return ParseResult { tools: vec![], error: Some("根元素不是对象".into()) },
    };
    let tools_arr = match o.get("tools").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return ParseResult { tools: vec![], error: Some("缺少 tools 数组".into()) },
    };
    let mut tools: Vec<BundleTool> = vec![];
    for (i, item) in tools_arr.iter().enumerate() {
        let it = match item.as_object() {
            Some(m) => m,
            None => continue,
        };
        // 接受 {meta:{...}} 或扁平 shape
        let meta_in = it.get("meta").and_then(|v| v.as_object()).unwrap_or(it);
        let fallback_id = it
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("tool-{}", i + 1));
        let id = meta_in
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or(fallback_id);
        let meta = parse_tool_meta(&Value::Object(meta_in.clone()), &id);
        let help_markdown = it
            .get("helpMarkdown")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        tools.push(BundleTool { meta, help_markdown });
    }
    if tools.is_empty() {
        return ParseResult { tools: vec![], error: Some("没有可导入的工具".into()) };
    }
    ParseResult { tools, error: None }
}

/// 对偶 src/shared/toolConfig.ts parseToolMeta。
pub fn parse_tool_meta(raw: &Value, id: &str) -> ToolMeta {
    let o = raw.as_object();
    let name = o
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.to_string());
    let icon = o
        .and_then(|m| m.get("icon"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("▣")
        .to_string();
    let order = o.and_then(|m| m.get("order")).and_then(|v| v.as_i64()).unwrap_or(0);
    let mut meta = ToolMeta {
        id: id.to_string(),
        name,
        icon,
        order,
        cwd: None,
        shell: None,
        env: None,
        tmux: None,
        init_commands: None,
        md_url: None,
        auto_update_minutes: None,
        use_remote: None,
    };
    if let Some(cwd) = trim_str_field(o, "cwd") {
        meta.cwd = Some(cwd);
    }
    if let Some(shell) = trim_str_field(o, "shell") {
        meta.shell = Some(shell);
    }
    if let Some(env) = o.and_then(|m| m.get("env")).and_then(|v| v.as_object()).map(|m| {
        m.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect::<std::collections::HashMap<String, String>>()
    }) {
        if !env.is_empty() {
            meta.env = Some(env);
        }
    }
    if let Some(tmux) = trim_str_field(o, "tmux") {
        meta.tmux = Some(tmux);
    }
    meta.init_commands = parse_init_commands(o.and_then(|m| m.get("initCommands")));
    if let Some(md_url) = trim_str_field(o, "mdUrl") {
        meta.md_url = Some(md_url);
    }
    if let Some(aum) = o.and_then(|m| m.get("autoUpdateMinutes")).and_then(|v| v.as_i64()) {
        meta.auto_update_minutes = Some(aum);
    }
    if o.and_then(|m| m.get("useRemote")) == Some(&Value::Bool(true)) {
        meta.use_remote = Some(true);
    }
    meta
}

fn trim_str_field(o: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    o.and_then(|m| m.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_init_commands(raw: Option<&Value>) -> Option<Vec<String>> {
    let raw = raw?;
    let list: Vec<String> = if let Some(arr) = raw.as_array() {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .collect()
    } else if let Some(s) = raw.as_str() {
        // 逗号或换行分隔
        s.split(|c| c == '\n' || c == '\r' || c == ',')
            .map(|s| s.trim().to_string())
            .collect()
    } else {
        return None;
    };
    let cmds: Vec<String> = list.into_iter().filter(|s| !s.is_empty()).collect();
    if cmds.is_empty() {
        None
    } else {
        Some(cmds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── merge_tool_json（对偶 tests/toolJson.test.ts）─────────────────────────
    #[test]
    fn merge_keeps_existing_then_applies_patch() {
        let existing = json!({"name":"A","cwd":"/old","order":0});
        let patch = json!({"name":"B"});
        let m = merge_tool_json(&existing, &patch);
        assert_eq!(m["name"], "B");
        assert_eq!(m["cwd"], "/old");
        assert_eq!(m["order"], 0);
    }

    #[test]
    fn merge_prunes_cleared_cwd() {
        let existing = json!({"cwd":"/old"});
        let patch = json!({"cwd":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("cwd").is_none(), "cleared cwd must be pruned");
    }

    #[test]
    fn merge_prunes_mdurl_and_dependents() {
        let existing = json!({"mdUrl":"http://x","autoUpdateMinutes":5,"useRemote":true});
        let patch = json!({"mdUrl":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("mdUrl").is_none());
        assert!(m.get("autoUpdateMinutes").is_none());
        assert!(m.get("useRemote").is_none());
    }

    // ── build_md_append（对偶 buttonBlock append 行为，body 原样追加不再包裹）──
    #[test]
    fn append_empty_body_is_noop() {
        assert_eq!(build_md_append("existing", "   "), "existing");
    }

    #[test]
    fn append_to_empty_doc() {
        assert_eq!(build_md_append("", "ls\npwd"), "ls\npwd\n");
    }

    #[test]
    fn append_to_existing_doc_adds_separator() {
        let r = build_md_append("# Title\n", "git status");
        assert_eq!(r, "# Title\n\ngit status\n");
    }

    #[test]
    fn append_body_keeps_verbatim_including_buttons_fence() {
        // body 含 ```buttons 围栏时原样追加，不二次包裹
        let r = build_md_append("# Title\n", "```buttons\ngit status\n```");
        assert_eq!(r, "# Title\n\n```buttons\ngit status\n```\n");
    }

    #[test]
    fn append_trims_trailing_whitespace_of_body() {
        let r = build_md_append("", "ls\n\n\n");
        assert_eq!(r, "ls\n");
    }

    // ── parse_tool_meta（对偶 tests/toolConfig.test.ts）───────────────────────
    #[test]
    fn meta_defaults_name_to_id_when_missing() {
        let m = parse_tool_meta(&json!({}), "git");
        assert_eq!(m.id, "git");
        assert_eq!(m.name, "git");
        assert_eq!(m.icon, "▣");
        assert_eq!(m.order, 0);
    }

    #[test]
    fn meta_takes_name_icon_order_from_raw() {
        let m = parse_tool_meta(&json!({"name":"Git","icon":"🌿","order":3}), "git");
        assert_eq!(m.name, "Git");
        assert_eq!(m.icon, "🌿");
        assert_eq!(m.order, 3);
    }

    #[test]
    fn meta_parses_init_commands_from_string() {
        let m = parse_tool_meta(&json!({"initCommands":"a\nb,c"}), "x");
        assert_eq!(m.init_commands, Some(vec!["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn meta_drops_blank_init_commands() {
        let m = parse_tool_meta(&json!({"initCommands":["","","  "]}), "x");
        assert_eq!(m.init_commands, None);
    }

}
