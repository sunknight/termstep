# buttons-json 参数化按钮 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 help.md 的按钮新增 ` ```buttons-json ` 围栏，支持带参数（占位符 + 弹窗表单）的命令按钮，现有 ` ```buttons ` 行格式零改动、完全向后兼容。

**Architecture:** 在 `src/shared/buttonBlock.ts` 增加纯函数（`substituteParams` / `parseButtonsJson` / `renderButtonsJsonBlock`，并扩展 `parseButtonsFromMarkdown` 与 `ParsedButton` 类型）；markdown.ts 路由新围栏；新增 `useParamPrompt` hook + `ParamPromptModal` 组件；HelpPane 与 QuickCommands 的点击委托按 `data-params` 分叉——有参数则弹表单，替换后再走现有 `runCommandChecked`（危险命令检测作用于替换后的真实命令）。

**Tech Stack:** TypeScript、React 18、markdown-it、vitest（node env，纯函数单测）、electron-vite。

## Global Constraints

- 占位符语法固定为 `{{name}}`（双花括号），不与 shell `$VAR`/`${VAR}` 冲突。
- 参数值**原样替换、不转义**（用户自填、跑在自己终端）。
- 参数统一为「可编辑文本 + 可选 `options` 建议列表」；支持 `required` / `default` / `hint`。
- 现有 ` ```buttons ` 行格式及其解析、渲染、测试**不得改动行为**（新增字段为可选）。
- ` ```buttons-json ` 顶层接受单个对象或数组；解析失败渲染红色 `.cmd-error` 块而非静默丢弃。
- 命令提交前 `substituteParams` 后做首尾 `trim()`，**不**折叠内部空白。
- 每个任务结束保持 `npm run typecheck` 与 `npm run test` 全绿。

---

### Task 0: 建分支并提交 spec

**Files:**
- 已存在（未跟踪）：`docs/superpowers/specs/2026-07-01-buttons-json-params-design.md`

- [ ] **Step 1: 从 main 建特性分支**

Run:
```bash
git checkout -b feat/buttons-json-params
```
Expected: 切到新分支 `feat/buttons-json-params`。

- [ ] **Step 2: 提交 spec 文档**

Run:
```bash
git add docs/superpowers/specs/2026-07-01-buttons-json-params-design.md
git commit -m "docs: buttons-json 参数化按钮设计文档"
```
Expected: 一个新提交。

---

### Task 1: `substituteParams` 与类型（TDD）

**Files:**
- Modify: `src/shared/buttonBlock.ts`（顶部类型 + 新增函数）
- Test: `tests/buttonBlock.test.ts`

**Interfaces:**
- Produces: `ButtonParam`、`ParsedButton.params?: ButtonParam[]`、`substituteParams(template: string, values: Record<string, string>): string`。后续所有任务依赖这些签名。

- [ ] **Step 1: 写失败测试**

在 `tests/buttonBlock.test.ts` 末尾追加：

```ts
import { substituteParams } from '../src/shared/buttonBlock';

describe('substituteParams', () => {
  it('replaces a single placeholder', () => {
    expect(substituteParams('echo {{msg}}', { msg: 'hi' })).toBe('echo hi');
  });
  it('replaces multiple placeholders', () => {
    expect(substituteParams('{{a}} {{b}}', { a: '1', b: '2' })).toBe('1 2');
  });
  it('replaces every occurrence of the same name', () => {
    expect(substituteParams('{{a}}-{{a}}', { a: 'x' })).toBe('x-x');
  });
  it('empty value replaces with empty string', () => {
    expect(substituteParams('git push {{flags}}', { flags: '' })).toBe('git push');
  });
  it('undeclared placeholder left as-is', () => {
    expect(substituteParams('echo {{x}}', {})).toBe('echo {{x}}');
  });
  it('trims leading/trailing whitespace', () => {
    expect(substituteParams('   hi   ', {})).toBe('hi');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/buttonBlock.test.ts -t "substituteParams"`
Expected: FAIL，`substituteParams is not a function`（或导入失败）。

- [ ] **Step 3: 实现**

在 `src/shared/buttonBlock.ts` 中，把现有 `export interface ParsedButton {...}` 替换为下面两段（在 `ParsedButton` 之前新增 `ButtonParam`，并给 `ParsedButton` 加可选 `params`）：

```ts
export interface ButtonParam {
  name: string;
  hint?: string;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface ParsedButton {
  command: string;
  label: string;
  edit: boolean;
  params?: ButtonParam[];
}
```

然后在文件末尾追加：

```ts
// Substitute {{name}} placeholders in a command template with collected form
// values. A placeholder whose name is not a key in `values` is left untouched
// (so undeclared {{x}} shows up literally and is easy to spot). The result is
// trimmed of leading/trailing whitespace; interior whitespace is preserved.
export function substituteParams(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([^{}]+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m
  );
  return out.trim();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: PASS（含原有用例与新增 substituteParams 全部通过）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/buttonBlock.ts tests/buttonBlock.test.ts
git commit -m "feat(buttons): 新增 substituteParams 与 ButtonParam 类型"
```

---

### Task 2: `parseButtonsJson`（TDD）

**Files:**
- Modify: `src/shared/buttonBlock.ts`
- Test: `tests/buttonBlock.test.ts`

**Interfaces:**
- Produces: `parseButtonsJson(code: string): { buttons: ParsedButton[] } | { error: string }`。接受单个对象或数组；丢弃缺 `command`/`name` 的项；`edit`/`required` 仅在严格 `=== true` 时为真；`options` 过滤为字符串数组；无参数时不输出 `params` 字段。

- [ ] **Step 1: 写失败测试**

在 `tests/buttonBlock.test.ts` 末尾追加（更新 import 行，加入 `parseButtonsJson`）：

```ts
import { parseButtonsJson } from '../src/shared/buttonBlock';

describe('parseButtonsJson', () => {
  it('accepts a single object', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'echo hi' }));
    expect('buttons' in r).toBe(true);
    expect((r as { buttons: any[] }).buttons)
      .toEqual([{ command: 'echo hi', label: 'echo hi', edit: false }]);
  });
  it('accepts an array', () => {
    const r = parseButtonsJson(JSON.stringify([{ command: 'a' }, { command: 'b' }]));
    expect((r as { buttons: any[] }).buttons.map((b) => b.command)).toEqual(['a', 'b']);
  });
  it('drops entries without command', () => {
    const r = parseButtonsJson(JSON.stringify([{ command: 'a' }, { label: 'no cmd' }]));
    expect((r as { buttons: any[] }).buttons.length).toBe(1);
  });
  it('drops params without name', () => {
    const r = parseButtonsJson(JSON.stringify({
      command: 'x', params: [{ hint: 'h' }, { name: 'ok' }],
    }));
    expect((r as { buttons: any[] }).buttons[0].params).toEqual([{ name: 'ok' }]);
  });
  it('coerces strictly: only === true is truthy; options filtered to strings', () => {
    const r = parseButtonsJson(JSON.stringify({
      command: 'x',
      edit: 'true',
      params: [{ name: 'p', required: 1, options: ['a', 2, 'b'], default: 'd' }],
    }));
    const btn = (r as { buttons: any[] }).buttons[0];
    expect(btn.edit).toBe(false);
    expect(btn.params[0].required).toBeUndefined();
    expect(btn.params[0].options).toEqual(['a', 'b']);
    expect(btn.params[0].default).toBe('d');
  });
  it('returns error on malformed JSON', () => {
    const r = parseButtonsJson('{ not json');
    expect('error' in r).toBe(true);
  });
  it('label defaults to command when omitted', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'git status' }));
    expect((r as { buttons: any[] }).buttons[0].label).toBe('git status');
  });
  it('keeps explicit label', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'git status', label: '状态' }));
    expect((r as { buttons: any[] }).buttons[0].label).toBe('状态');
  });
  it('omits params key when params is empty', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'x', params: [] }));
    expect((r as { buttons: any[] }).buttons[0].params).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/buttonBlock.test.ts -t "parseButtonsJson"`
Expected: FAIL，`parseButtonsJson is not a function`。

- [ ] **Step 3: 实现**

在 `src/shared/buttonBlock.ts` 末尾追加：

```ts
// Parse the body of a ```buttons-json fence. Accepts a single object or an
// array. Entries missing `command` (or params missing `name`) are dropped.
// edit/required are true only on strict === true so that strings like "false"
// or numbers don't sneak in as truthy. Returns {error} on JSON syntax failure
// so the renderer can surface it instead of silently dropping the block.
export function parseButtonsJson(
  code: string
): { buttons: ParsedButton[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const buttons: ParsedButton[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (!command) continue;
    const label =
      typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : command;
    const edit = obj.edit === true;
    const params = Array.isArray(obj.params) ? coerceParams(obj.params) : [];
    const btn: ParsedButton = { command, label, edit };
    if (params.length > 0) btn.params = params;
    buttons.push(btn);
  }
  return { buttons };
}

function coerceParams(raw: unknown[]): ButtonParam[] {
  const out: ButtonParam[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) continue;
    const param: ButtonParam = { name };
    if (typeof o.hint === 'string') param.hint = o.hint;
    if (Array.isArray(o.options)) {
      const opts = o.options.filter((x): x is string => typeof x === 'string');
      if (opts.length > 0) param.options = opts;
    }
    if (typeof o.default === 'string') param.default = o.default;
    if (o.required === true) param.required = true;
    out.push(param);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/buttonBlock.ts tests/buttonBlock.test.ts
git commit -m "feat(buttons): 新增 parseButtonsJson 解析器"
```

---

### Task 3: 扩展 `parseButtonsFromMarkdown` 扫描两种围栏（TDD）

**Files:**
- Modify: `src/shared/buttonBlock.ts`（替换 `FENCE_RE` 与函数体）
- Test: `tests/buttonBlock.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `parseButtonsJson`。
- Produces: `parseButtonsFromMarkdown` 现在同时返回行按钮与 JSON 按钮，按文档顺序合并；JSON 按钮带 `params`。QuickCommands（Task 7）据此自动获得参数化按钮。

- [ ] **Step 1: 写失败测试**

在 `tests/buttonBlock.test.ts` 的 `describe('parseButtonsFromMarkdown', ...)` 块内追加用例：

```ts
  it('merges buttons and buttons-json in document order', () => {
    const md = [
      '```buttons',
      'git status',
      '```',
      '```buttons-json',
      '[{"command":"git push","label":"推送"}]',
      '```',
    ].join('\n');
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.map((b) => b.command)).toEqual(['git status', 'git push']);
    expect(btns[1].label).toBe('推送');
  });

  it('carries params from buttons-json', () => {
    const md =
      '```buttons-json\n' +
      '{"command":"git commit -m \\"{{message}}\\"","params":[{"name":"message","required":true}]}\n' +
      '```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns[0].params?.[0]).toEqual({ name: 'message', required: true });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/buttonBlock.test.ts -t "merges buttons and buttons-json"`
Expected: FAIL（旧 `FENCE_RE` 不匹配 `buttons-json`，取不到 `git push`）。

- [ ] **Step 3: 实现**

在 `src/shared/buttonBlock.ts` 中，把现有这一段：

```ts
const FENCE_RE = /```buttons[^\n]*\n([\s\S]*?)\n?```/g;
export function parseButtonsFromMarkdown(markdown: string): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    const body = match[1] ?? '';
    for (const line of body.split('\n')) {
      const b = parseButtonLine(line);
      if (b) out.push(b);
    }
  }
  return out;
}
```

替换为（注意 alternation 里 `buttons-json` 必须排在 `buttons` 之前）：

```ts
const FENCE_RE = /```(buttons-json|buttons)[^\n]*\n([\s\S]*?)\n?```/g;
export function parseButtonsFromMarkdown(markdown: string): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    const type = match[1];
    const body = match[2] ?? '';
    if (type === 'buttons-json') {
      const r = parseButtonsJson(body);
      // Errors are ignored here: the dropdown just shows fewer buttons. The
      // rendered help page surfaces the error via renderButtonsJsonBlock.
      if ('buttons' in r) out.push(...r.buttons);
    } else {
      for (const line of body.split('\n')) {
        const b = parseButtonLine(line);
        if (b) out.push(b);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: PASS（含原有 `collects buttons across multiple fences` 等用例不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/buttonBlock.ts tests/buttonBlock.test.ts
git commit -m "feat(buttons): parseButtonsFromMarkdown 支持 buttons-json 围栏"
```

---

### Task 4: `renderButtonsJsonBlock` + `.cmd-error` 样式 + markdown.ts 路由（TDD）

**Files:**
- Modify: `src/shared/buttonBlock.ts`（新增 `renderButtonsJsonBlock`）
- Modify: `src/renderer/lib/markdown.ts`（围栏路由）
- Modify: `src/renderer/styles.css`（`.cmd-error`）
- Test: `tests/buttonBlock.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `parseButtonsJson`、现有 `escapeAttr` / `escapeHtml`。
- Produces: `renderButtonsJsonBlock(code: string): string` —— 返回 `<div class="cmd-buttons">...</div>`，每个参数化按钮带 `data-params`（JSON，属性转义）；解析失败返回 `<div class="cmd-error">...</div>`。

- [ ] **Step 1: 写失败测试**

更新 `tests/buttonBlock.test.ts` 顶部 import，加入 `renderButtonsJsonBlock`，并在文件末尾追加：

```ts
describe('renderButtonsJsonBlock', () => {
  it('renders a button with the template in data-cmd', () => {
    const html = renderButtonsJsonBlock(JSON.stringify({ command: 'echo {{msg}}', label: 'say' }));
    expect(html).toContain('data-cmd="echo {{msg}}"');
    expect(html).toContain('>say<');
  });
  it('omits data-params when the button has no params', () => {
    const html = renderButtonsJsonBlock(JSON.stringify({ command: 'ls' }));
    expect(html).not.toContain('data-params');
  });
  it('serializes params into data-params (attribute-escaped JSON)', () => {
    const html = renderButtonsJsonBlock(
      JSON.stringify({ command: 'x {{p}}', params: [{ name: 'p', required: true }] })
    );
    expect(html).toContain('data-params=');
    expect(html).toContain('&quot;name&quot;');
  });
  it('renders an error block on malformed JSON', () => {
    const html = renderButtonsJsonBlock('{ bad');
    expect(html).toContain('class="cmd-error"');
  });
  it('empty array -> empty string', () => {
    expect(renderButtonsJsonBlock('[]')).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/buttonBlock.test.ts -t "renderButtonsJsonBlock"`
Expected: FAIL，`renderButtonsJsonBlock is not a function`。

- [ ] **Step 3: 实现 renderButtonsJsonBlock**

在 `src/shared/buttonBlock.ts` 现有 `renderButtonsBlock` 函数之后追加：

```ts
// Render a ```buttons-json fence. Parametrized buttons carry their param spec
// serialized (and attribute-escaped) in data-params so the delegated click
// handler can rebuild the form without a separate registry. A parse failure
// renders a visible error block so the author sees the syntax problem.
export function renderButtonsJsonBlock(code: string): string {
  const r = parseButtonsJson(code);
  if ('error' in r) {
    return `<div class="cmd-error">⚠️ buttons-json 解析失败：${escapeHtml(r.error)}</div>`;
  }
  if (r.buttons.length === 0) return '';
  const items = r.buttons
    .map((b) => {
      const paramsAttr = b.params
        ? ` data-params="${escapeAttr(JSON.stringify(b.params))}"`
        : '';
      const tip = b.label !== b.command ? ` data-tip="${escapeAttr(b.command)}"` : '';
      return `<button class="cmd-btn"${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}"${paramsAttr}>${escapeHtml(b.label)}</button>`;
    })
    .join('');
  return `<div class="cmd-buttons">${items}</div>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: PASS。

- [ ] **Step 5: 接入 markdown.ts 围栏路由**

把 `src/renderer/lib/markdown.ts` 整体替换为：

```ts
import MarkdownIt from 'markdown-it';
import { renderButtonsBlock, renderButtonsJsonBlock } from '../../shared/buttonBlock';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  if (info === 'buttons') return renderButtonsBlock(token.content);
  if (info === 'buttons-json') return renderButtonsJsonBlock(token.content);
  return defaultFence(tokens, idx, options, env, self);
};
```

- [ ] **Step 6: 加 `.cmd-error` 样式**

在 `src/renderer/styles.css` 中 `.cmd-buttons { ... }` 那一行之后插入：

```css
.cmd-error {
  margin: 8px 0; padding: 6px 10px;
  background: #fff0f0; color: #8a1500; border: 1px solid #f0b8b8;
  border-radius: 6px; font-size: 12px; font-family: Menlo, monospace;
}
```

- [ ] **Step 7: typecheck + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/shared/buttonBlock.ts src/renderer/lib/markdown.ts src/renderer/styles.css tests/buttonBlock.test.ts
git commit -m "feat(buttons): 渲染 buttons-json 围栏与解析错误提示"
```

---

### Task 5: `useParamPrompt` hook + `ParamPromptModal` 组件 + 表单样式

**Files:**
- Create: `src/renderer/lib/paramPrompt.tsx`（含 JSX，必须 `.tsx`）
- Create: `src/renderer/components/ParamPromptModal.tsx`
- Modify: `src/renderer/styles.css`（表单样式）

**Interfaces:**
- Consumes: Task 1 的 `substituteParams`、`ButtonParam`。
- Produces: `useParamPrompt(): { open: (spec: ParamPromptSpec, resolve: (values: Record<string,string>|null)=>void) => void; node: ReactNode }`，`ParamPromptSpec = { command: string; edit: boolean; params: ButtonParam[] }`。HelpPane（Task 6）与 QuickCommands（Task 7）据此弹表单。

> 此任务为 React UI，仓库未配 React Testing Library，按现有惯例用 `npm run typecheck` 验证；端到端在 Task 9 手动验证。

- [ ] **Step 1: 写 hook**

创建 `src/renderer/lib/paramPrompt.tsx`：

```ts
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { ButtonParam } from '../../shared/buttonBlock';
import { ParamPromptModal } from '../components/ParamPromptModal';

export interface ParamPromptSpec {
  command: string; // template containing {{name}}
  edit: boolean;
  params: ButtonParam[];
}

type Resolve = (values: Record<string, string> | null) => void;

// Shared hook: each consumer (HelpPane, QuickCommands) calls this once and
// renders {node} at the end of its JSX. `open` stores the resolve callback in
// a ref and calls it from `close` OUTSIDE any setState updater, so React 18
// StrictMode's double-invocation of updaters can't fire the command twice.
export function useParamPrompt(): { open: (spec: ParamPromptSpec, resolve: Resolve) => void; node: ReactNode } {
  const [spec, setSpec] = useState<ParamPromptSpec | null>(null);
  const resolveRef = useRef<Resolve | null>(null);

  const open = useCallback((s: ParamPromptSpec, resolve: Resolve) => {
    resolveRef.current = resolve;
    setSpec(s);
  }, []);

  const close = useCallback((values: Record<string, string> | null) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setSpec(null);
    r?.(values);
  }, []);

  const node: ReactNode = spec ? <ParamPromptModal spec={spec} onClose={close} /> : null;
  return { open, node };
}
```

- [ ] **Step 2: 写 modal 组件**

创建 `src/renderer/components/ParamPromptModal.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { substituteParams } from '../../shared/buttonBlock';
import type { ParamPromptSpec } from '../lib/paramPrompt';

export function ParamPromptModal(props: {
  spec: ParamPromptSpec;
  onClose: (values: Record<string, string> | null) => void;
}) {
  const { spec, onClose } = props;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of spec.params) init[p.name] = p.default ?? '';
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the first field on open.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setVal = (name: string, v: string) => {
    setValues((cur) => ({ ...cur, [name]: v }));
    if (error) setError(null);
  };

  const submit = () => {
    for (const p of spec.params) {
      if (p.required && !values[p.name].trim()) {
        setError(`「${p.name}」为必填项`);
        return;
      }
    }
    onClose(values);
  };

  const preview = substituteParams(spec.command, values);

  return (
    <div className="modal-overlay" onClick={() => onClose(null)}>
      <div className="modal param-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">填写参数{spec.edit ? '（编辑模式）' : ''}</div>
        <div className="param-preview">{preview || '(空)'}</div>
        <div className="param-fields">
          {spec.params.map((p, i) => (
            <div className="param-field" key={p.name}>
              <label>{p.name}{p.required ? ' *' : ''}</label>
              <input
                ref={i === 0 ? firstRef : undefined}
                type="text"
                value={values[p.name]}
                list={p.options ? `param-opt-${p.name}` : undefined}
                onChange={(e) => setVal(p.name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
              {p.options && (
                <datalist id={`param-opt-${p.name}`}>
                  {p.options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
              {p.hint && <div className="param-hint">{p.hint}</div>}
            </div>
          ))}
        </div>
        {error && <div className="param-error">{error}</div>}
        <div className="modal-actions">
          <button className="primary" onClick={submit}>
            确定
          </button>
          <button onClick={() => onClose(null)}>取消</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 加表单样式**

在 `src/renderer/styles.css` 末尾追加：

```css
/* ParamPromptModal (reuses .modal / .modal-overlay / .modal-actions). */
.param-modal { width: 420px; }
.param-preview {
  flex: 0 0 auto; font-family: Menlo, monospace; font-size: 12px; color: #444;
  background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px;
  padding: 6px 10px; margin: 8px 16px 0; word-break: break-all;
}
.param-fields { flex: 1 1 auto; overflow-y: auto; padding: 8px 16px; display: flex; flex-direction: column; gap: 8px; }
.param-field label { font-size: 12px; font-weight: 600; display: block; margin-bottom: 2px; }
.param-field input {
  width: 100%; box-sizing: border-box; font-family: Menlo, monospace; font-size: 12px;
  padding: 5px 8px; border: 1px solid #c8d2ff; border-radius: 5px; outline: none;
}
.param-field input:focus { border-color: #6b8aff; box-shadow: 0 0 0 2px #dbe3ff; }
.param-hint { font-size: 11px; color: #888; margin-top: 2px; }
.param-error { flex: 0 0 auto; font-size: 12px; color: #b00; padding: 0 16px 4px; }
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 全绿（main/preload/shared 与 renderer 两份 tsconfig 都通过）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/lib/paramPrompt.tsx src/renderer/components/ParamPromptModal.tsx src/renderer/styles.css
git commit -m "feat(buttons): 参数输入弹窗 ParamPromptModal 与 useParamPrompt hook"
```

---

### Task 6: HelpPane 点击委托接入参数表单

**Files:**
- Modify: `src/renderer/components/HelpPane.tsx`

**Interfaces:**
- Consumes: Task 5 的 `useParamPrompt`、Task 1 的 `substituteParams`。读 `btn.dataset['params']`（Task 4 写入）。

- [ ] **Step 1: 加 import**

在 `src/renderer/components/HelpPane.tsx` 顶部 import 区，把：

```ts
import { runCommandChecked } from '../lib/runCommandChecked';
```

替换为：

```ts
import { runCommandChecked } from '../lib/runCommandChecked';
import { useParamPrompt } from '../lib/paramPrompt';
import { substituteParams } from '../../shared/buttonBlock';
```

- [ ] **Step 2: 在组件内取 hook**

在 `HelpPane` 函数体内、`const [tip, setTip] = useState<TipState | null>(null);` 这一行之后加入：

```ts
  const prompt = useParamPrompt();
```

- [ ] **Step 3: 点击委托分叉**

把 `onClick` 里处理 `.cmd-btn` 的这一段：

```ts
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        const edit = btn.dataset['edit'] === '1';
        const opts = {
          cwd: props.tool.meta.cwd,
          shell: props.tool.meta.shell,
          env: props.tool.meta.env,
          tmux: props.tool.meta.tmux,
          initCommands: props.tool.meta.initCommands,
        };
        runCommandChecked(props.activeToolId, command, edit, opts);
        return;
      }
```

替换为：

```ts
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        const edit = btn.dataset['edit'] === '1';
        const paramsRaw = btn.dataset['params'];
        const opts = {
          cwd: props.tool.meta.cwd,
          shell: props.tool.meta.shell,
          env: props.tool.meta.env,
          tmux: props.tool.meta.tmux,
          initCommands: props.tool.meta.initCommands,
        };
        if (paramsRaw) {
          // Parametrized button: open the form, then run the substituted command.
          let params;
          try {
            params = JSON.parse(paramsRaw);
          } catch {
            params = [];
          }
          prompt.open({ command, edit, params }, (values) => {
            if (!values) return;
            runCommandChecked(props.activeToolId, substituteParams(command, values), edit, opts);
          });
          return;
        }
        runCommandChecked(props.activeToolId, command, edit, opts);
        return;
      }
```

- [ ] **Step 4: 渲染弹窗节点**

把组件 return 的片段：

```tsx
  return (
    <>
      <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {tip && (
```

改为在 `<>` 之后插入 `{prompt.node}`：

```tsx
  return (
    <>
      {prompt.node}
      <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {tip && (
```

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/HelpPane.tsx
git commit -m "feat(buttons): HelpPane 参数化按钮点击弹表单"
```

---

### Task 7: QuickCommands 点击委托接入参数表单

**Files:**
- Modify: `src/renderer/components/QuickCommands.tsx`

**Interfaces:**
- Consumes: Task 5 的 `useParamPrompt`、Task 1 的 `substituteParams`，以及 `parseButtonsFromMarkdown`（Task 3 扩展后）返回的 `ParsedButton.params`。

- [ ] **Step 1: 加 import**

`QuickCommands.tsx` 顶部已有 `import { parseButtonsFromMarkdown } from '../../shared/buttonBlock';` 和 `import { runCommandChecked } from '../lib/runCommandChecked';`。把前者扩展，并在后者之后新增 hook import：

```ts
import { parseButtonsFromMarkdown, substituteParams, type ButtonParam } from '../../shared/buttonBlock';
```

```ts
import { runCommandChecked } from '../lib/runCommandChecked';
import { useParamPrompt } from '../lib/paramPrompt';
```

- [ ] **Step 2: 取 hook 并改 run**

把组件内这一段：

```ts
  const run = (command: string, edit: boolean) => {
    const a = props.activeTool;
    if (!a) return;
    const opts: PtySpawnOpts = {
      cwd: a.meta.cwd,
      shell: a.meta.shell,
      env: a.meta.env,
      tmux: a.meta.tmux,
      initCommands: a.meta.initCommands,
    };
    runCommandChecked(a.meta.id, command, edit, opts);
    setOpen(false);
  };
```

替换为：

```ts
  const prompt = useParamPrompt();

  const run = (command: string, edit: boolean, params?: ButtonParam[]) => {
    const a = props.activeTool;
    if (!a) return;
    const opts: PtySpawnOpts = {
      cwd: a.meta.cwd,
      shell: a.meta.shell,
      env: a.meta.env,
      tmux: a.meta.tmux,
      initCommands: a.meta.initCommands,
    };
    setOpen(false);
    if (params && params.length > 0) {
      prompt.open({ command, edit, params }, (values) => {
        if (!values) return;
        runCommandChecked(a.meta.id, substituteParams(command, values), edit, opts);
      });
      return;
    }
    runCommandChecked(a.meta.id, command, edit, opts);
  };
```

- [ ] **Step 3: 按钮点击传 params**

把下拉里渲染按钮的 `onClick`：

```tsx
                  onClick={() => run(b.command, b.edit)}
```

改为：

```tsx
                  onClick={() => run(b.command, b.edit, b.params)}
```

- [ ] **Step 4: 渲染弹窗节点**

在最外层 `<>` 之后（`<div className="quick-cmd" ref={wrapRef}>` 之前）插入 `{prompt.node}`：

```tsx
  return (
    <>
      {prompt.node}
      <div className="quick-cmd" ref={wrapRef}>
```

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/QuickCommands.tsx
git commit -m "feat(buttons): 快捷命令下拉支持参数化按钮"
```

---

### Task 8: 给示例 git 工具加参数化按钮示范

**Files:**
- Modify: `src/main/seed.ts`

- [ ] **Step 1: 更新 seed help.md 内容**

在 `src/main/seed.ts` 中，把 `help.md` 内容数组的 ` ```buttons ` 块之后、结尾 `].join('\n')` 之前，追加一个 `buttons-json` 块。把这一段：

```ts
      '```buttons',
      'git status # 查看状态',
      'git log --oneline -20',
      'git commit -m "" // edit',
      'git push # 推送',
      '```',
      '',
    ].join('\n')
```

替换为：

```ts
      '```buttons',
      'git status # 查看状态',
      'git log --oneline -20',
      'git commit -m "" // edit',
      'git push # 推送',
      '```',
      '',
      '带参数：',
      '',
      '```buttons-json',
      '[',
      '  {',
      '    "label": "提交（填信息）",',
      '    "command": "git commit -m \\"{{message}}\\"",',
      '    "edit": true,',
      '    "params": [',
      '      { "name": "message", "hint": "提交信息", "required": true }',
      '    ]',
      '  }',
      ']',
      '```',
      '',
    ].join('\n')
```

> 注意：JSON 字符串里的内层引号必须写成 `\\"`（在 JS 单引号字符串里即 `\"`），如 `git commit -m \\"{{message}}\\"`。

- [ ] **Step 2: typecheck + 测试**

Run: `npm run typecheck && npm run test`
Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add src/main/seed.ts
git commit -m "feat(buttons): 示例 git 工具加入参数化按钮示范"
```

---

### Task 9: 端到端验证

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量类型检查与测试**

Run: `npm run typecheck && npm run test`
Expected: 全绿。

- [ ] **Step 2: 启动应用**

Run: `npm run dev`（在新终端，或 `! npm run dev`）

- [ ] **Step 3: 手动验证清单**

在 help 页（用一个含 ` ```buttons-json ` 的工具，或新装时由 seed 生成的 git 工具）：

- [ ] 参数化按钮正常渲染，显示 `label`。
- [ ] 点击 → 弹出表单，首个字段自动聚焦。
- [ ] 实时预览随输入更新（如 `git commit -m "xxx"`）。
- [ ] 必填项留空点「确定」→ 显示红字、不关闭。
- [ ] 有 `options` 的字段下拉有建议项，也可手输任意值。
- [ ] 回车 = 提交；Esc / 点遮罩 = 取消。
- [ ] 提交后命令正确注入终端；`edit` 模式不补回车。
- [ ] 危险命令（如把参数填成 `rm -rf` 相关）仍弹二次确认。
- [ ] 故意写一段语法错的 `buttons-json` → help 页显示红色 `.cmd-error` 提示。

在全局快捷命令下拉（⚡）：

- [ ] 同一份 markdown 里的参数化按钮也出现在下拉里。
- [ ] 点击 → 关闭下拉 → 弹同一个表单 → 提交后在当前激活工具的终端执行。

向后兼容：

- [ ] 仅含 ` ```buttons ` 行格式的旧工具/help.md 渲染与执行行为完全不变。

- [ ] **Step 4: 收尾（可选）合并回 main**

验证通过后：

```bash
git checkout main
git merge --no-ff feat/buttons-json-params
```
