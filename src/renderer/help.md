# TermStep 使用帮助

TermStep 是一个本地 macOS 应用，把常用的 CLI 命令变成可点击的按钮。你为每个工作场景创建一个「工具」，每个工具有自己的终端和帮助页，帮助页里的 `buttons` 围栏会渲染成一键执行的按钮。

## 界面布局

应用分三个面板：

- **左侧栏（工具列表）**：显示所有工具。点击切换，拖动图标排序。
- **中间（终端）**：当前工具的持久终端，点击按钮后命令会粘贴到这里执行。
- **右侧（帮助页）**：当前工具的 markdown 文档，其中的 `buttons` 块渲染为可点击按钮。

## 基本操作

- **新建工具**：点击侧边栏的「+ 新建工具」。
- **选中工具**：点击工具列表中的任意一项。终端和帮助页会同步切换。
- **拖拽排序**：拖动工具图标（左侧方块字符）来调整顺序。
- **编辑工具**：点击帮助页顶部的「编辑」按钮，修改 markdown 文档和工具配置。
- **删除工具**：点击帮助页顶部的「✕ 删除」按钮。
- **调整面板宽度**：拖动面板之间的分隔条。

## 终端

每个工具的终端是**持久的**——切换到其它工具再切回来，终端状态（历史输出、当前目录）保持不变。

- 终端使用你的默认 shell（`$SHELL` 或 `/bin/zsh`），以 login shell 方式启动。
- 点击按钮执行的命令会粘贴到终端并自动回车（edit 模式除外）。

## `buttons` 语法

在帮助页的 markdown 中，用 ` ```buttons ` 围栏声明命令按钮。**每行一条命令**，渲染成一个按钮：

````
```buttons
git status
git pull
make build
```
````

### 按钮类型

| 写法 | 效果 |
|------|------|
| `git status` | 普通按钮，点击执行 `git status` |
| `git status # 状态` | 带标签的按钮，显示「状态」，执行 `git status`（标签和命令用 ` # ` 分隔） |
| `docker run -it ubuntu // edit` | edit 模式：粘贴命令但**不回车**，让你修改后再执行 |
| `// 这是说明文字` | 纯文本行（不是按钮），用作分组标题或注释 |
| `# 这是一个注释` | 注释行，仅保留在源码中，**不渲染** |

> **注意**：`#` 在行首是注释（不渲染）；` # ` 在行中间是标签分隔符。`//` 在行首是纯文本；` // edit` 在行尾是 edit 模式标记。

### 完整示例

````
```buttons
# Git 常用命令
git status # 状态
git pull
git log --oneline -20 # 日志

// Docker
docker ps
docker run -it ubuntu // edit
```
````

## `buttons-json` 语法

当命令需要**参数**（用户输入），用 ` ```buttons-json ` 围栏。它接受 JSON 格式（单个对象或数组），支持表单参数和 `{{name}}` 占位符。

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | string | **必填**。命令模板，可用 `{{name}}` 占位符引用参数 |
| `label` | string | 按钮显示文字，默认同 command |
| `edit` | boolean | `true` 则粘贴不回车（edit 模式） |
| `params` | array | 参数定义列表（见下） |

### 参数（params）字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | **必填**。参数名，对应 command 中的 `{{name}}` |
| `hint` | string | 输入框提示文字 |
| `options` | string[] | 下拉选项，提供则渲染为下拉框而非文本输入 |
| `default` | string | 默认值 |
| `required` | boolean | 是否必填（`true` 时留空会阻止执行） |

> **占位符替换**：参数值会经过 POSIX shell 引号转义后替换到命令中，所以直接写 `git commit -m {{message}}` 即可，不需要自己加引号。未定义的占位符会原样保留（方便发现拼写错误）。

### 完整示例

````markdown
```buttons-json
{
  "command": "git commit -m {{message}}",
  "label": "提交",
  "params": [
    { "name": "message", "hint": "提交信息", "required": true }
  ]
}
```
````

多个按钮用数组：

````markdown
```buttons-json
[
  {
    "command": "kubectl delete pod {{name}}",
    "label": "删除 Pod",
    "params": [
      { "name": "name", "hint": "Pod 名称" }
    ]
  },
  {
    "command": "ssh {{user}}@{{host}}",
    "label": "SSH 连接",
    "edit": true,
    "params": [
      { "name": "user", "default": "root" },
      { "name": "host", "hint": "IP 地址", "required": true }
    ]
  }
]
```
````

带下拉选项的例子：

````markdown
```buttons-json
{
  "command": "make {{target}}",
  "label": "构建",
  "params": [
    {
      "name": "target",
      "options": ["build", "test", "clean", "install"],
      "default": "build"
    }
  ]
}
```
````

## 快速添加

点击帮助页顶部的「+」按钮，弹出快速添加对话框：

- 输入框默认预填一个 ` ```buttons ` 围栏模板，你可以直接在里面填写命令。
- 如果剪贴板有内容，会自动插入到围栏内。
- 提交时输入内容**原样作为 markdown 块**追加到文档末尾——你可以改围栏类型（如 ` ```sh `）、删掉围栏写标题/普通文本，或粘贴任意 markdown。

## 导入导出

- **导出**：将所有工具打包为一个 JSON 文件。
- **导入**：从 JSON 文件导入工具（会自动处理 ID 冲突）。

按钮位于侧边栏底部。
