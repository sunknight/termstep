# 待实现功能

> 实现状态：2026-07-01 全部完成。typecheck 通过；62 个测试全绿（含新增 dangerous / tmux / bundle / parseButtonsFromMarkdown / initCommands 注入）。

* ✅ 添加全局快捷命令。放到重启终端旁边，点击显示命令下拉列表，点击输入到终端。命令列表从一个特殊工具里读取，可在特殊工具里修改
  - 预留特殊工具 `_quick`（启动时自动创建，可在侧栏像普通工具一样编辑）；终端右上角「⚡ 快捷」下拉读取其所有 `buttons` 块；点击在**当前激活工具**的终端执行。`src/shared/buttonBlock.ts:parseButtonsFromMarkdown`、`src/renderer/components/QuickCommands.tsx`。
* ✅ 增加tmux参数，如设置，尝试 attach || new -t NAME
  - 工具新增 `tmux` 字段；设置后 spawn 改为 `shell -c 'exec tmux new -A -s NAME'`（已存在则 attach，否则新建+attach）。名称经 `sanitizeTmuxName` 校验，防注入。`src/shared/tmux.ts`、`src/main/ptyService.ts`。
* ✅ md渲染链接，用系统默认浏览器打开
  - HelpPane 拦截 `<a>` 点击，http(s)/mailto 经新 IPC `shell:openExternal` → `shell.openExternal` 打开。`src/renderer/components/HelpPane.tsx`、`src/main/ipc.ts`。
* ✅ 增加导入导出功能，需要定义json配置文件格式
  - 格式 `{version, app, exportedAt, tools:[{meta, helpMarkdown}]}`（`src/shared/bundle.ts`，含版本号与校验）。原生保存/打开对话框；导入按 id 去重（不覆盖已有工具）。侧栏底部「导出/导入」按钮。
* ✅ 实现远程共享只读配置（订阅）；可配置从远程地址读取md内容，并自动更新。本地markdown或url二选一。从url读取的内容不可修改；增加重新读取按钮
  - 工具新增 `mdUrl`（+`autoUpdateMinutes`，默认 5）。设置后扫描器从 URL 拉取 help.md、标记 `readOnly`，本地 help.md 被忽略（二选一）。ToolManager 每 30s 检查并在间隔到期后自动重新拉取；只读工具显示「重新读取」按钮，编辑器中 markdown 只读但 meta（URL/间隔等）仍可改，清空 URL 即转回本地。`src/main/toolsScanner.ts`、`src/main/toolManager.ts`。
* ✅ 拦截危险命令
  - `src/shared/dangerous.ts:isDangerousCommand`（rm -rf 根/家目录、mkfs、dd 到设备、fork bomb、shutdown/reboot、curl|sh 等）。按钮注入与快捷命令执行前弹 `confirm`；常规 `rm -rf ./build` 等不拦截。
* ✅ 配置启动终端的初始化命令（多个命令）
  - 工具新增 `initCommands: string[]`（编辑器中每行一条）；spawn 后立即注入，每条附 `\r`。已加运行时测试验证（ptyService）。
