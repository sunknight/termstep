use serde::{Deserialize, Serialize};

// Rust 对偶 of src/shared/types.ts。serde camelCase 对齐前端字段名。
// Option<T> 字段用 skip_serializing_if 让序列化输出与 TS（undefined 字段不出现）一致。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMeta {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `@/` 占位符的锚点（工具根目录）。优先级 root_dir > cwd > ~。
    /// 为空/缺失时退化为 cwd，再退化为 ~（shell 展开）。
    /// **不参与 pty spawn**（spawn 仍用 cwd）；仅渲染端 substituteCwd 用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_commands: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "mdUrl")]
    pub md_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_remote: Option<bool>,
    /// 稳定来源标识（UUID v4）。跨导入不变：同一 bundle 再次导入时按它匹配已有
    /// 工具决定更新 vs 新建，而非每次生成新目录。区别于 `id`（物理目录名）。
    #[serde(skip_serializing_if = "Option::is_none", rename = "sourceId")]
    pub source_id: Option<String>,
    /// 分组名（用户赋值，自由文本）。空/None = 未分组。仅用于侧栏展示分区，
    /// 不影响执行。对偶 src/shared/types.ts 的 meta.group。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// 布局方向：`"LR"` = 文档左/终端右（默认），`"TB"` = 文档上/终端下。
    /// 对偶 src/shared/types.ts 的 meta.layout。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    /// 终端初始是否隐藏（配置默认值，运行时可被顶栏 toggle 覆盖）。
    /// 对偶 src/shared/types.ts 的 meta.terminalHidden。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_hidden: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub meta: ToolMeta,
    #[serde(rename = "helpMarkdown")]
    pub help_markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub tools: Vec<Tool>,
    pub errors: Vec<ScanError>,
    /// 分组展示顺序（来自 tools/order.json 的 groups 数组）。渲染端据此按
    /// 索引顺序画分组标题；工具引用但未在此列表里的分组追加其后。
    #[serde(default)]
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnOpts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_commands: Option<Vec<String>>,
}

// UpdateState 对齐 TS 的 discriminated union {status:'available', version, url, notes}。
// 用 serde internally-tagged enum：序列化时 tag 字段 = "status"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available {
        version: String,
        url: String,
        notes: String,
    },
    Error {
        error: String,
    },
}

impl Default for UpdateState {
    fn default() -> Self {
        UpdateState::Idle
    }
}

// --- Bundle format (对偶 src/shared/bundle.ts) ---
pub const BUNDLE_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleTool {
    pub meta: ToolMeta,
    #[serde(rename = "helpMarkdown")]
    pub help_markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsBundle {
    pub version: i64,
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    pub tools: Vec<BundleTool>,
}

// --- VCS diff 结果 ---
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VcsDiff {
    pub diff: String,
}
