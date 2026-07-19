# 仅文档型工具（Document-only Tools）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TermStep 支持「仅文档型」工具——不创建终端，整个右半屏合并为文档区；编辑器加「模式」单选切换。

**Architecture:** `tool.json` 新增可选 `type` 字段（`"terminal"` 默认 / `"document"`），零迁移。Rust 端 `ToolMeta` 对偶加同字段；TS 端 `mergeToolJson` / `parseToolMeta` 对偶处理。`App.tsx` 按 `active.meta.type` 分发布局：terminal 型走原三栏，document 型不渲染 `.terminal-area` 与 `.help-pane`，改为新组件 `<DocumentPane>` 占据中+右栏位置。`pty.rs` 的 `ensure` 防御性 skip document 型。编辑器「基本」分组加「模式」单选。

**Tech Stack:** Tauri v2 + React 18 / TypeScript + Rust；vitest（node）+ cargo test；复用 markdown.ts / buttonBlock.ts / PreviewOverlay / clipboardToast / copyOnModifier。

**Spec:** `docs/superpowers/specs/2026-07-19-document-only-tools-design.md`

**字段名约定：** JSON 里用 `"type"`（短、JSON 不是 JS）；Rust 字段名 `tool_type` 配 `#[serde(rename = "type")]` 避开 `rename_all="camelCase"` 自动转 `toolType`。

---

## 文件结构

**新建：**
- `src/renderer/components/DocumentPane.tsx` — 文档型工具主面板组件（复用 `md` / `classifyLink` / `copyOnModifier` / `runCommandChecked` 等），渲染 markdown + 链接路由 + 按钮（点击无动作，⌘复制）。

**修改：**
- `src/shared/types.ts:33-66` — `ToolMeta` 加 `type?: 'terminal' | 'document'`。
- `src/shared/toolJson.ts:6` — `PRUNE_WHEN_EMPTY_STRING` 加 `'type'`（空串裁掉，回到默认）。
- `src/shared/toolConfig.ts:42` — `parseToolMeta` 解析 `type` 字段。
- `src-tauri/src/types.rs:6-42` — Rust `ToolMeta` 加 `tool_type` 字段（`#[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]`）。
- `src-tauri/src/pure.rs` — `merge_tool_json`（裁剪）+ `parse_tool_meta`（解析）对偶；测试对偶。
- `src-tauri/src/pty.rs:96-108` — `ensure` 入口防御性 skip document 型。
- `src-tauri/src/types.rs:72-85` — `PtySpawnOpts` 加 `tool_type`（传递到 ensure）。
- `src/renderer/components/EditorPane.tsx:36-52,106-141,162-224` — 加 `typeMode` state、save 时写入、UI 单选。
- `src/renderer/App.tsx:279-369` — 按 `active.meta.type` 分发：terminal 走原三栏；document 渲染 `<DocumentPane>`。
- `src/renderer/lib/api.ts` — `pty.open` / `pty.restart` / `pty.write` 调用点携带 `toolType`（仅 restart 受影响，open/write 复用 opts）。
- `src/renderer/styles.css` — 加 `.document-area` / `.document-pane` 样式。
- `tests/toolJson.test.ts` / `tests/toolConfig.test.ts` — 加 `type` 字段测试组。

---

## Task 1：TS 端 `type` 字段——类型 + 解析 + 合并

**Files:**
- Modify: `src/shared/types.ts:33-66`
- Modify: `src/shared/toolJson.ts:6`
- Modify: `src/shared/toolConfig.ts:42`
- Test: `tests/toolJson.test.ts`
- Test: `tests/toolConfig.test.ts`

- [ ] **Step 1: 给 `ToolMeta` 加 `type` 字段**

修改 `src/shared/types.ts`，在 `group?: string;` 后（约 66 行）加：

```ts
  /**
   * 工具类型。`"terminal"`（默认）= 持久终端 + 右栏帮助页；
   * `"document"` = 仅文档型：不创建终端，整个右半屏合并为文档区，按钮无动作（保留 ⌘/Ctrl+点击复制）。
   * 缺省视为 `"terminal"`，向后兼容旧 tool.json。
   */
  type?: 'terminal' | 'document';
```

- [ ] **Step 2: 给 `mergeToolJson` 的 PRUNE 列表加 `type`**

修改 `src/shared/toolJson.ts:6`：

```ts
const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'rootDir', 'tmux', 'mdUrl', 'group', 'type'] as const;
```

（理由：编辑器里切回 terminal 模式时，把 `type` 字段清空让它从 tool.json 消失，自然回到默认 terminal；与 cwd/group 同模式。）

- [ ] **Step 3: 给 `parseToolMeta` 加 `type` 解析**

修改 `src/shared/toolConfig.ts`，在 `if (typeof o.group === 'string' ...)` 块（约 42 行）后加：

```ts
  if (o.type === 'terminal' || o.type === 'document') meta.type = o.type;
```

（理由：只接受这两个值，其它一律视为缺省 → undefined → 默认 terminal。比 trim+non-empty 更严格，避免脏数据 `type: "foo"` 漏过。）

- [ ] **Step 4: 在 `tests/toolConfig.test.ts` 末尾加测试组**

在 `tests/toolConfig.test.ts` 文件末尾追加：

```ts
describe('parseToolMeta type', () => {
  it('parses type=document', () => {
    const meta = parseToolMeta({ type: 'document' }, 't1');
    expect(meta.type).toBe('document');
  });
  it('parses type=terminal', () => {
    const meta = parseToolMeta({ type: 'terminal' }, 't1');
    expect(meta.type).toBe('terminal');
  });
  it('type defaults undefined when missing', () => {
    const meta = parseToolMeta({}, 't1');
    expect(meta.type).toBeUndefined();
  });
  it('drops invalid type values', () => {
    const meta = parseToolMeta({ type: 'foo' }, 't1');
    expect(meta.type).toBeUndefined();
  });
  it('drops blank type string', () => {
    const meta = parseToolMeta({ type: '  ' }, 't1');
    expect(meta.type).toBeUndefined();
  });
});
```

- [ ] **Step 5: 在 `tests/toolJson.test.ts` 末尾加测试组**

在 `tests/toolJson.test.ts` 文件末尾追加：

```ts
describe('mergeToolJson type', () => {
  it('prunes cleared type (empty string)', () => {
    const existing = { type: 'document' };
    const patch = { type: '' };
    const merged = mergeToolJson(existing, patch);
    expect('type' in merged).toBe(false);
  });
  it('keeps type=document when set', () => {
    const existing = {};
    const patch = { type: 'document' };
    const merged = mergeToolJson(existing, patch);
    expect(merged.type).toBe('document');
  });
  it('keeps existing type when patch does not touch it', () => {
    const existing = { type: 'document' };
    const patch = { name: 'New Name' };
    const merged = mergeToolJson(existing, patch);
    expect(merged.type).toBe('document');
  });
});
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `npx vitest run tests/toolConfig.test.ts tests/toolJson.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7: 跑类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/toolJson.ts src/shared/toolConfig.ts tests/toolConfig.test.ts tests/toolJson.test.ts
git commit -m "feat(tool-meta): TS 端加 type 字段（terminal | document）"
```

---

## Task 2：Rust 端 `type` 字段——struct + merge + parse + 测试

**Files:**
- Modify: `src-tauri/src/types.rs:6-42`
- Modify: `src-tauri/src/pure.rs:9-44` (merge) + `pure.rs:179-249` (parse) + `pure.rs:280-506` (tests)

- [ ] **Step 1: 给 Rust `ToolMeta` 加 `tool_type` 字段**

修改 `src-tauri/src/types.rs`，在 `pub group: Option<String>,`（约 41 行）后加：

```rust
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
```

（注意：`#[serde(rename = "type")]` 显式覆盖外层的 `rename_all = "camelCase"`，确保 JSON 里是 `"type"` 而非 `"toolType"`；`default` 让旧文件反序列化时不报错；`skip_serializing_if` 保证 None 时不写出来，对齐 TS 端 undefined 不出现的约定。）

- [ ] **Step 2: `parse_tool_meta` 初始化时填 `tool_type: None`**

修改 `src-tauri/src/pure.rs` 的 `parse_tool_meta`（约 194-210 行），在 `group: None,`（约 209 行）后加：

```rust
        tool_type: None,
```

- [ ] **Step 3: `parse_tool_meta` 末尾解析 `type`**

修改 `src-tauri/src/pure.rs`，在 `if let Some(g) = trim_str_field(o, "group") { meta.group = Some(g); }`（约 245-247 行）后加：

```rust
    if let Some(t) = trim_str_field(o, "type") {
        // 只接受 terminal / document，其它一律视为缺省。
        if t == "terminal" || t == "document" {
            meta.tool_type = Some(t);
        }
    }
```

- [ ] **Step 4: `merge_tool_json` 的裁剪列表加 `"type"`**

修改 `src-tauri/src/pure.rs` 的 `merge_tool_json`（约 26-30 行）：

```rust
    for k in &["cwd", "rootDir", "tmux", "mdUrl", "group", "type"] {
        if merged.get(*k).and_then(|v| v.as_str()) == Some("") {
            merged.remove(*k);
        }
    }
```

- [ ] **Step 5: 在 `pure.rs` 的 `mod tests` 块末尾加测试**

在 `src-tauri/src/pure.rs` 的 `mod tests` 块（约 280-506 行）末尾、最后一个测试后追加：

```rust
    #[test]
    fn meta_parses_type_document() {
        let raw = json!({ "type": "document" });
        let m = parse_tool_meta(&raw, "t1");
        assert_eq!(m.tool_type.as_deref(), Some("document"));
    }

    #[test]
    fn meta_parses_type_terminal() {
        let raw = json!({ "type": "terminal" });
        let m = parse_tool_meta(&raw, "t1");
        assert_eq!(m.tool_type.as_deref(), Some("terminal"));
    }

    #[test]
    fn meta_type_defaults_none_when_missing() {
        let raw = json!({});
        let m = parse_tool_meta(&raw, "t1");
        assert_eq!(m.tool_type, None);
    }

    #[test]
    fn meta_drops_invalid_type_values() {
        let raw = json!({ "type": "foo" });
        let m = parse_tool_meta(&raw, "t1");
        assert_eq!(m.tool_type, None);
    }

    #[test]
    fn merge_prunes_cleared_type() {
        let existing = json!({ "type": "document" });
        let patch = json!({ "type": "" });
        let merged = merge_tool_json(&existing, &patch);
        assert!(merged.get("type").is_none());
    }

    #[test]
    fn merge_keeps_type_when_set() {
        let existing = json!({});
        let patch = json!({ "type": "document" });
        let merged = merge_tool_json(&existing, &patch);
        assert_eq!(merged.get("type").and_then(|v| v.as_str()), Some("document"));
    }

    #[test]
    fn merge_keeps_existing_type_when_patch_does_not_touch_it() {
        let existing = json!({ "type": "document" });
        let patch = json!({ "name": "New" });
        let merged = merge_tool_json(&existing, &patch);
        assert_eq!(merged.get("type").and_then(|v| v.as_str()), Some("document"));
    }
```

- [ ] **Step 6: 跑 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure::tests`
Expected: 全部 PASS（含新增 7 个 type 相关测试）。

- [ ] **Step 7: Rust check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 无错误、无警告。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/pure.rs
git commit -m "feat(tool-meta): Rust 端对偶 type 字段（terminal | document）"
```

---

## Task 3：pty.rs 防御性 skip document 型

**Files:**
- Modify: `src-tauri/src/types.rs:72-85` (`PtySpawnOpts`)
- Modify: `src-tauri/src/pty.rs:96-108` (`ensure`)
- Modify: `src-tauri/src/commands.rs` (`pty_open` / `pty_write` / `pty_restart` 透传 tool_type)

**说明：** 防御性兜底——前端不会为 document 型工具调 pty.* 命令（Task 5 的 App.tsx 分发保证），但若因为 bug 或残留调用触达，后端应直接拒绝 spawn，而不是创建无用的 shell 进程。最小切入点是 `ensure` 入口早 return。

- [ ] **Step 1: `PtySpawnOpts` 加 `tool_type` 字段**

先查看 `src-tauri/src/types.rs` 的 `PtySpawnOpts` 定义（约 72-85 行）。在末尾字段后加：

```rust
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
```

确保结构体派生含 `Deserialize`（用于 Tauri 命令参数反序列化）。

- [ ] **Step 2: `ensure` 入口早 return document 型**

修改 `src-tauri/src/pty.rs` 的 `ensure` 函数（约 96-108 行）。在函数体最开头（双重检查之前）加：

```rust
    // 防御性：document 型工具不应 spawn 终端。前端分发已避免调用，
    // 这里兜底防止 bug / 残留调用创建无用 shell 进程。
    if opts.tool_type.as_deref() == Some("document") {
        return;
    }
```

（注意：放在最开头，连 `ptys` 锁都不取，避免在 `ptys` map 里留下任何痕迹。）

- [ ] **Step 3: 确认 commands.rs 透传 opts**

查看 `src-tauri/src/commands.rs` 的 `pty_open` / `pty_write` / `pty_restart`（约 730-760 行）。这三个命令接收前端传来的 `PtySpawnOpts`（参数名可能是 `opts`），直接传给 `PtyService::open/write/restart` → `ensure`。**无需改动**——前端在 opts 里塞 `type: 'document'` 时会自动透传。

如果 commands.rs 里这三个命令**没有**接收 `opts` 参数（比如 write 只接 `data`），那么 `pty_write` 路径不需要 tool_type（write 不触发 ensure），无需处理。

- [ ] **Step 4: Rust check + test**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，所有现有测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/pty.rs
git commit -m "feat(pty): ensure 防御性 skip document 型工具"
```

---

## Task 4：编辑器加「模式」单选

**Files:**
- Modify: `src/renderer/components/EditorPane.tsx:36-52` (state)
- Modify: `src/renderer/components/EditorPane.tsx:106-141` (save)
- Modify: `src/renderer/components/EditorPane.tsx:162-224` (UI)

- [ ] **Step 1: 加 `typeMode` state**

查看 `src/renderer/components/EditorPane.tsx` 顶部 state 区（约 36-52 行）。在现有 state（name/icon/group/cwd/...）后加：

```tsx
  const [typeMode, setTypeMode] = useState<'terminal' | 'document'>(
    props.tool.meta.type === 'document' ? 'document' : 'terminal',
  );
```

- [ ] **Step 2: `save()` 写入 `type`**

查看 `EditorPane.tsx` 的 `save` 函数（约 106-141 行），找到构造 `Partial<ToolMeta>` / patch 的地方（约 115-124 行）。在 patch 里加：

```tsx
    type: typeMode,
```

**注意**：因为 Task 1 让 `mergeToolJson` 把 `type: ''` 裁掉，这里直接写 `'terminal'` 或 `'document'` 不会被裁；但若编辑器某天把 typeMode 默认值改成空串，会被裁掉回到 undefined（= terminal）。当前实现是显式二选一，安全。

如果 save 函数构造的是 `Record<string, unknown>`（patch 是裸对象），确保 `type: typeMode` 直接进入该对象。

- [ ] **Step 3: 在「基本」fieldset 加单选 UI**

查看 `EditorPane.tsx` 的「基本」fieldset（约 162-224 行）。在「分组」`<div className="form-row">`（约 206-223 行）之后、`</fieldset>`（约 224 行）之前插入：

```tsx
          <div className="form-row">
            <label className="field">
              <span className="field-label">模式 <em>仅文档=不创建终端，整个右半屏渲染文档；按钮无动作（保留 ⌘复制）</em></span>
              <div className="mode-radio-group" role="radiogroup" aria-label="工具模式">
                <label className="mode-radio">
                  <input
                    type="radio"
                    name="tool-mode"
                    value="terminal"
                    checked={typeMode === 'terminal'}
                    onChange={() => setTypeMode('terminal')}
                  />
                  <span>终端</span>
                </label>
                <label className="mode-radio">
                  <input
                    type="radio"
                    name="tool-mode"
                    value="document"
                    checked={typeMode === 'document'}
                    onChange={() => setTypeMode('document')}
                  />
                  <span>仅文档</span>
                </label>
              </div>
            </label>
          </div>
```

- [ ] **Step 4: 加 CSS 样式**

在 `src/renderer/styles.css` 末尾追加：

```css
.mode-radio-group {
  display: inline-flex;
  gap: 12px;
}
.mode-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.mode-radio input[type='radio'] {
  margin: 0;
}
```

- [ ] **Step 5: 类型检查 + 启动 dev 手测**

Run: `npm run typecheck`
Expected: 无错误。

然后 `npm run dev` 手测：
1. 新建一个工具，编辑；
2. 看到「基本」分组底部出现「模式」单选（终端 / 仅文档）；
3. 选「仅文档」→ 保存 → 打开用户数据目录里该工具的 `tool.json`，确认有 `"type": "document"`；
4. 再编辑，切回「终端」→ 保存 → 确认 `tool.json` 里 `type` 字段消失（被 merge 裁掉）。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/EditorPane.tsx src/renderer/styles.css
git commit -m "feat(editor): 基本分组加「模式」单选（终端 | 仅文档）"
```

---

## Task 5：新建 `<DocumentPane>` 组件

**Files:**
- Create: `src/renderer/components/DocumentPane.tsx`

**说明：** 该组件是 document 型工具的主面板。结构上参照 `HelpPane`，但：
- 不需要 TOC 折叠 toolbar（产品/运营场景以阅读为主，全宽渲染）；
- 链接点击路由到 `onPreview`（与 HelpPane 一致）；
- 按钮（`.cmd-btn`）渲染保留，但点击**无动作**，仅 ⌘/Ctrl + 点击复制命令。

- [ ] **Step 1: 先看一下 `HelpPane.tsx` 的完整 onClick handler 与 imports**

Read: `src/renderer/components/HelpPane.tsx`（全文）
目的：确认要复用的 imports（`md`, `classifyLink`, `copyOnModifier`, `runCommandChecked`, `substituteParams`, `substituteCwd`, `prompt`, `confirmDialog`, `api`, types）和 onClick handler 结构。

- [ ] **Step 2: 创建 `DocumentPane.tsx`**

Create: `src/renderer/components/DocumentPane.tsx`

```tsx
import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import { md } from '../lib/markdown';
import { classifyLink, isTxtPath } from '../../shared/previewLink';
import { copyOnModifier } from '../lib/clipboardToast';
import type { Tool, PreviewRequest } from '../shared/types';

interface Props {
  tool: Tool;
  isRemote: boolean;
  /** 渲染的 markdown 内容：优先 help.md，mdUrl 兜底时由父组件传 remoteMarkdown。 */
  markdown: string;
  onPreview?: (req: PreviewRequest) => void;
}

/**
 * 仅文档型工具的主面板：渲染 markdown 文档；链接点击路由到 onPreview；
 * 按钮（.cmd-btn）渲染保留但点击无动作，仅 ⌘/Ctrl+点击复制命令到剪贴板。
 */
export default function DocumentPane(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => md.render(props.markdown, { isRemote: props.isRemote } as any),
    [props.markdown, props.isRemote],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onClick = async (e: MouseEvent) => {
      // 1. 按钮：document 型工具下点击无动作，仅 ⌘/Ctrl+点击复制命令。
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        if (e.metaKey || e.ctrlKey) {
          void copyOnModifier(e, command);
        }
        // 普通点击：什么都不做（document 型工具按钮不可执行）。
        return;
      }

      // 2. Markdown 链接：按 href 形式分类路由到预览弹层（与 HelpPane 一致）。
      const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        const text = (anchor.textContent ?? '').trim() || href;
        e.preventDefault();
        const c = classifyLink(href, props.tool.meta.cwd);
        switch (c.kind) {
          case 'web':
            props.onPreview?.({ type: 'web', url: c.url, title: titleFor(c.url, text) });
            return;
          case 'remoteDoc':
            props.onPreview?.({
              type: 'doc',
              url: c.url,
              title: titleFor(c.url, text),
              isTxt: isTxtPath(c.url),
            });
            return;
          case 'localDoc':
            props.onPreview?.({
              type: 'doc',
              url: c.path,
              title: titleFor(c.path, text),
              isTxt: isTxtPath(c.path),
            });
            return;
          case 'mailto':
            void api.shell.openExternal(href);
            return;
          case 'unsupported':
          case 'blocked':
          default:
            return;
        }
      }
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [props.tool.meta.cwd, props.isRemote, props.onPreview]);

  return (
    <div className="document-pane">
      <div className="document-scroll help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function titleFor(href: string, text: string): string {
  if (text && text !== href) return text;
  try {
    const u = new URL(href);
    return u.hostname;
  } catch {
    return href;
  }
}
```

**注意 import：** 检查 `classifyLink` / `isTxtPath` 的实际导出路径——根据 HelpPane 的 import 写法对齐。`api` 来自 `../lib/api`（如果 HelpPane 直接用全局 `api`，DocumentPane 也照做）。如果 `titleFor` 已在某个 lib 里，import 复用，不要自己重写。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。若有 import 路径错误，按 HelpPane.tsx 实际路径修正。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/DocumentPane.tsx
git commit -m "feat(renderer): 新增 DocumentPane 组件（文档型工具主面板）"
```

---

## Task 6：App.tsx 按 type 分发布局 + CSS

**Files:**
- Modify: `src/renderer/App.tsx:279-369`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: import `DocumentPane`**

在 `src/renderer/App.tsx` 顶部 import 区（与 `HelpPane`、`TerminalPane` 同处）加：

```tsx
import DocumentPane from './components/DocumentPane';
```

- [ ] **Step 2: 计算 `isDocument` 标志**

在 `App.tsx` 的 return 之前（约 277 行），加：

```tsx
  const isDocument = active?.meta.type === 'document';
```

- [ ] **Step 3: 改造 return 块——document 型渲染 DocumentPane**

查看 `App.tsx` 的 return（约 279-369 行）。把现有结构改为按 `isDocument` 分支：

**原结构（terminal 型，保持不变）：**
```tsx
return (
  <div className="app">
    {!sidebarCollapsed && sidebarContent}
    <section className="terminal-area">...</section>
    {!helpCollapsed && renderHelp(false)}
    ...modals...
  </div>
);
```

**改为：**
```tsx
  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      {isDocument ? (
        <DocumentPane
          tool={active!}
          isRemote={active!.helpMarkdown == null && !!active!.remoteMarkdown}
          markdown={active!.remoteMarkdown && active!.helpMarkdown == null ? active!.remoteMarkdown : active!.helpMarkdown}
          onPreview={openPreview}
        />
      ) : (
        <>
          <section className="terminal-area">
            {/* ...原有 term-header + term-pane-wrap... */}
          </section>
          {!helpCollapsed && renderHelp(false)}
        </>
      )}
      {/* ...modals 不变（EditorModal/PreviewOverlay/...）... */}
    </div>
  );
```

**关键点：**
- document 型不渲染 `.terminal-area`、不渲染右栏 help、不渲染 `<TerminalPane>`；
- document 型渲染 `<DocumentPane>`，占据原「中栏 + 右栏」位置（CSS 用 flex 让它 `flex: 1`）；
- modals（EditorModal / PreviewOverlay / QuickAddModal 等）**完全不变**，仍然在 document 型下可用（用户在 document 型工具上点编辑、看预览、加快捷命令都正常）。

**`markdown` prop 的取值：** 看一下 `renderHelp` 函数（App.tsx:233-277）里 help.md 是怎么取的——优先 helpMarkdown，没有时用 remoteMarkdown。把同样的逻辑搬到 DocumentPane 调用处。如果该逻辑可以抽成一个本地函数（如 `activeMarkdown(active)`），抽出后两处都用。

**`isRemote` prop：** 同样参照 renderHelp——若该工具用远程 mdUrl 渲染则 isRemote=true。直接复用 renderHelp 里的判断。

- [ ] **Step 4: 加 `.document-pane` CSS**

在 `src/renderer/styles.css` 末尾追加：

```css
/* 仅文档型工具：占据原「中栏 + 右栏」位置，全宽渲染文档。 */
.document-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: var(--text);
  overflow: hidden;
  border-left: 1px solid var(--border); /* 与原 .help-area 左边框一致 */
}
.document-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 32px; /* 比 .help-scroll 更宽松，阅读更舒适 */
  /* 可读行宽上限：长文档不撑满超宽屏，避免阅读疲劳 */
  max-width: 920px;
  margin: 0 auto;
}
.document-scroll.help {
  /* 复用 .help 的 markdown 排版（line-height/font-size/code/pre 等） */
  line-height: 1.6;
}
```

- [ ] **Step 5: 类型检查 + 启动 dev 手测**

Run: `npm run typecheck`
Expected: 无错误。

`npm run dev` 手测：
1. 创建一个工具，编辑器里切到「仅文档」模式，help.md 里写点 markdown（含 ` ```buttons ` 围栏和 `[链接](https://example.com)`），保存；
2. 工具激活时：左栏不变；整个右半屏是文档；终端区域消失；
3. 文档里的链接点击 → PreviewOverlay modal 弹出（行为与终端型工具的右栏 help 一致）；
4. 文档里的按钮可见，普通点击无反应；⌘/Ctrl + 点击按钮 → 复制命令 + toast；
5. 活动监视器里没有该工具对应的 shell 进程（验证 pty skip 生效）；
6. 在 terminal 型工具与 document 型工具之间切换：布局正确分发，无报错、无残留。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(app): 按 tool.type 分发布局——document 型渲染 DocumentPane"
```

---

## Task 7：端到端验收 + 收尾

**Files:** 无新改动，只跑全套验收。

- [ ] **Step 1: 全套测试**

Run:
```bash
npm run typecheck
npm run test
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 三套全绿。

- [ ] **Step 2: 手测回归（terminal 型工具完全不受影响）**

`npm run dev` 手测：
1. 选一个现有 terminal 型工具（type 未设置，默认 terminal）；
2. 三栏布局正常（侧栏 / 终端 / 右栏 help）；
3. 右栏按钮正常执行（写终端）、参数表单正常弹出、危险命令二次确认正常；
4. ⌘/Ctrl + 点击按钮复制命令正常；
5. 重启终端按钮、QuickCommands、PreviewOverlay、EditorModal 都正常；
6. 切到 document 型工具，再切回 terminal 型工具——terminal 型工具的终端实例仍常驻、能正常输入。

- [ ] **Step 3: 手测 document 型工具完整体验**

`npm run dev` 手测：
1. document 型工具激活：右半屏全宽文档，无终端、无右栏；
2. 文档里链接 → PreviewOverlay modal；
3. 文档里按钮 → 普通点击无动作，⌘/Ctrl+点击复制；
4. 编辑器「模式」单选正确回显当前类型（document 工具打开编辑器默认选中「仅文档」）；
5. 切换类型并保存：tool.json 字段正确更新；
6. document 型工具的「重启终端」按钮：要么隐藏（理想），要么点了无害（pty skip 兜底）。如果 term-header 在 document 型下根本不渲染（Task 6 的实现），这点自动满足。

- [ ] **Step 4: 检查用户数据格式**

打开 `~/Library/Application Support/TermStep/configs/tools/<UUID>/tool.json`，确认：
- document 型工具的 tool.json 含 `"type": "document"`；
- terminal 型工具的 tool.json **不含** type 字段（默认）；
- 两类工具的其它字段（name/icon/cwd/...）完全一致。

- [ ] **Step 5: 更新 AGENTS.md（如必要）**

如果实施过程中发现 spec 里没预见的坑（比如某个 modals 在 document 型下需要特殊处理），在 `AGENTS.md` 的 §5（架构）或 §8（历史坑点）补一条。

- [ ] **Step 6: 最终 commit（如有 docs 改动）**

```bash
git add AGENTS.md
git commit -m "docs(AGENTS): 补充 document 型工具说明"
```

---

## Self-Review 检查表

**1. Spec coverage（spec 各节对应 task）：**
- 工具类型字段 `type` → Task 1 (TS) + Task 2 (Rust)
- 布局分发（中+右栏合并） → Task 6
- `<DocumentPane>` 组件 → Task 5
- PTY 防御性 skip → Task 3
- 编辑器「模式」单选 → Task 4
- 链接/按钮行为（按钮无动作、⌘复制、链接 PreviewOverlay） → Task 5
- 文档来源（help.md 优先 / mdUrl 兜底） → Task 6（App.tsx 取 markdown 的逻辑）
- 向后兼容（默认 terminal） → Task 1/2 的缺省处理
- 安全（无新对外能力） → 整个计划无新 IPC 通道、无新对外调用

**2. Placeholder scan:** 无 TBD/TODO；所有步骤含具体代码或命令。

**3. Type consistency:** `type?: 'terminal' | 'document'` (TS) ↔ `tool_type: Option<String>` + `rename = "type"` (Rust) ↔ JSON key `"type"`，三端一致；`PtySpawnOpts.tool_type` 同模式；`typeMode` state 在 EditorPane 内部，save 时写入 patch 的 `type` key。

**4. 跨 task 依赖顺序：** Task 1 (TS 类型) → Task 2 (Rust 对偶) → Task 3 (pty skip) → Task 4 (编辑器) → Task 5 (DocumentPane) → Task 6 (App 分发) → Task 7 (验收)。Task 4 依赖 Task 1（要能写 type 字段）；Task 5/6 依赖 Task 1（要能读 meta.type）。每个 task 独立可 commit。
