---
name: changelog-gen
description: "TermStep 项目的发版向导：一步步问版本级别（大/中/小）→ 是否更新版本记录 → 是否提交推送，按回答自动完成「升版本号 + 写 CHANGELOG + 打 tag + push」。用户说「发版 / 发布新版本 / 打 tag / 升级版本 / 发布 0.9.x / 写 changelog / 更新版本记录」时触发。CHANGELOG 条目严格按「面向用户、不面向开发」原则从 git log 提炼，绝不照抄 commit subject，绝不写模块名/函数名/数据字段/内部机制。也支持只做其中一步（如只写 CHANGELOG、只打 tag）。"
---

# TermStep 发版向导

为 **TermStep** 项目（`/Users/sunknight/web/code/sk_ideas/termstep`）按交互式流程完成发版：升版本号、写 CHANGELOG、提交、打 tag、推送——逐步问，按用户回答执行，免去手动一条条敲命令。

**整体流程（5 步交互）**：

```
0 前置检查 ──→ ①版本级别? ──→ ②更新版本记录? ──→ ③提交? ──→ ④推送+打tag?
 分支/工作区      大/中/小           是/否               是/否          是/否
```

每一步**先问、再按回答执行**，不偷跑。用户随时可在某步答「否/跳过」停下来，已完成步骤保留。

---

## 第 0 步：前置检查（分支与工作区）

发版前必须确认当前分支和工作区状态，避免把无关改动或遗漏的文件打进版本。

**执行：**

```bash
git branch --show-current
git status --short
```

**根据结果处理：**

- **工作区有未提交改动**（`git status --short` 非空）→ **停下，用 `AskUserQuestion` 问用户**：

  > 当前工作区还有未提交改动，继续发版会把这些改动也包含进 `chore(release)` 提交。建议先检查并提交/暂存无关改动。
  >
  > - **继续发版**（把这些改动一并提交进 release commit）
  > - **先提交/暂存改动，稍后重触发发版**（停止流程）
  > - **取消**

  - 选「继续发版」→ 进入第 1 步（后续 `chore(release)` commit 会 add 所有工作区改动，不止版本号四文件）。
  - 选「先提交/暂存」或「取消」→ **停止整个流程**，让用户自己处理工作区。

- **工作区干净** → 直接进入第 1 步。

- **当前不在 main 分支**：在提示里说明当前分支（不强制中断），第 3 步提交前还会再次判断并给出合并/当前分支提交/取消的选择。

---

## 第 1 步：确定新版本号

**先读当前版本**：`package.json` 的 `version` 字段（形如 `0.9.6`）。

**用 `AskUserQuestion` 问版本级别**（不要让用户手输版本号）：

| 选项 | 语义化版本规则 | 例子（当前 0.9.6） |
|------|---------------|-------------------|
| 大版本（major） | 第一段 +1，后两段归 0；有不兼容/重大改动 | `1.0.0` |
| 中版本（minor） | 第二段 +1，第三段归 0；有新功能 | `0.10.0` |
| 小版本（patch） | 第三段 +1；仅修复或小调整 | `0.9.7` |

问法示例：
> 这版是什么级别的变更？
> - 大版本（major）：不兼容/重大改动，`0.9.6` → `1.0.0`
> - 中版本（minor）：有新功能，`0.9.6` → `0.10.0`
> - 小版本（patch）：仅修复或小调整，`0.9.6` → `0.9.7`

用户也可选「Other」手输自定义版本号（如预发布 `0.10.0-beta.1`）。

**拿到版本号后立即执行**（**不再问**，这步是确定的）：

```bash
npm run version:set -- <新版本>
```

脚本会同步四处（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock`）。

> ⚠️ **不加 `--tag`**：tag 放到第 4 步，与提交、推送一起决策。脚本末尾会打印一段「用 changelog-gen skill」的提示，那只是提示，无视即可——本 skill 正在驱动。

---

## 第 2 步：更新版本记录（CHANGELOG）

**用 `AskUserQuestion` 问**：是否更新 CHANGELOG？

- **是**（默认推荐）→ 按下面「CHANGELOG 生成流程」执行。
- **否** → 跳过（如本版本无用户可见变化、或用户要手写）。**即使跳过，也建议留一行标题**，见「格式 · 无可见变化」。

### CHANGELOG 生成流程

1. **取提交范围**：`<最近 tag>..HEAD`。命令：
   ```bash
   git -C <项目根> log <最近tag>..HEAD --no-merges --format='- %s'
   ```
   最近 tag 取 `git tag -l --sort=-v:refname | head -1`。用户指定范围就用指定的。
   - **git tag 边界只是下界参考，不是硬切线**。一条用户可感知的变化若横跨 tag（功能在 A 版本提交、体验打磨延续到 B 版本），归到「用户第一次完整感受到它」的版本——通常是**功能首次亮相的版本**，让用户看到「功能 + 体验收尾」一起出现，不要把收尾单列到下一版。
     - 实例：0.9.5「跨分组拖拽」是本版本新功能，落点指示优化是这功能的体验收尾 → 归 0.9.5 合并成一条 Added。

2. **读 CHANGELOG.md 顶部**，确认插入位置（第一个 `## [` 之前）和现有格式风格。

3. **按「提炼规则」**（见下）把 commit subject 转成用户视角条目。**绝不照抄 subject**——subject 是面向开发的，必须转译。

4. **按「格式」**组装条目，插入 CHANGELOG.md 顶部第一个 `## [` 标题**之前**。

5. **过「自查清单」**，修完才算完成。

---

## 第 3 步：提交

**先判断分支**（提交前必做）：

```bash
git branch --show-current    # 取当前分支
```

- **在 main** → 直接进「问是否提交」。
- **不在 main**（在 feature/分支上）→ **停下，用 `AskUserQuestion` 问用户如何处理**：

  | 选项 | 做什么 |
  |------|--------|
  | 合并到 main 再提交（推荐） | 见下方「合并到 main 流程」 |
  | 就在当前分支提交 | 跳过合并，在当前分支 commit（适用于想发预发布版、或分支即发版分支的情况） |
  | 取消 | 停止整个流程，工作区改动保留 |

  **「合并到 main」流程**（用户选了这个才执行）：
  ```bash
  # 工作区有未提交改动（第 1、2 步产生的）→ 先暂存，避免 checkout 冲突
  git stash push -u -m "release-wizard: <新版本> wip"
  git checkout main
  git merge --no-ff <原分支> -m "Merge branch '<原分支>'"
  git stash pop    # 把第 1、2 步改动恢复到 main 上
  ```
  - 合并后**仍在 main**，继续「问是否提交」。**原 feature 分支不删**（留给用户处理）。
  - `stash pop` 若冲突：停下报错，让用户手动解决，**不强行覆盖**。
  - 若 main 落后远程：先停下提示用户 `git pull`，不自动 pull。

**用 `AskUserQuestion` 问**：是否提交（git commit）？

- **是** → 把第 1、2 步改动的文件提交：
  ```bash
  git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
  [ -n "$(git status --short CHANGELOG.md)" ] && git add CHANGELOG.md
  git commit -m "chore(release): <新版本>"
  ```
  **一个提交**含全部版本相关改动（版本号 + CHANGELOG 一起），信息用 `chore(release): <版本>`。CHANGELOG 若在第 2 步选了「否」则不 add（脚本不动它）。

- **否** → 保留工作区改动，跳到下一步。用户可能还想再加点东西再提交。

---

## 第 4 步：打 tag + 推送

**用 `AskUserQuestion` 问**：是否打 tag 并推送？

- **是（打 tag + push）**：
  ```bash
  git tag v<新版本>
  git push origin <当前分支>
  git push origin v<新版本>
  ```
  - **tag 打在当前分支 HEAD**（第 3 步若提交了，就是那个 commit；若没提交，就是当前 HEAD）。推荐先提交再打 tag，tag 指向 release commit。
  - **预检**：打 tag 前先查 `git tag -l v<新版本>`，已存在则**停下问用户**（不要 `--force`，可能覆盖别人的 tag）。
  - **当前分支**用 `git branch --show-current` 取，不要假设是 main。
  - push 失败（如无权限、远程冲突）如实报错，不强行 `--force`。

- **否** → 全部本地完成，告诉用户「未推送，手动 `git push origin <分支> --tags` 即可」。

---

## 完成总结

四步走完后，给用户一个简短总结：

```
✓ 版本号：0.9.6 → 0.10.0（四处同步）
✓ CHANGELOG：已插入 [0.10.0] 条目（2 Added）
✓ 提交：abc1234 chore(release): 0.10.0
✓ 推送：main + tag v0.10.0 已上 origin
```

若某步跳过，如实标注「（跳过）」。

---

# CHANGELOG 规则（第 2 步的细节，下面是原本独立的生成器内容，原样保留）

## 核心原则：面向用户，不面向开发

CHANGELOG.md 是给**用户**看的版本变动说明。条目必须用「用户能看到/能做到什么」的语言写，**不写实现细节**。

写每一条之前先问自己一句：**「用户读完这条，知道这个版本给他带来了什么吗？」** 如果答案是「不知道，只看到一堆内部名词」，就重写或删除。

### 不该出现的（实现/开发视角）

- 模块/函数/类名：`buildGroupedView`、`OrderIndex 结构`、`parse_tool_meta`、`substituteCwd`、`append_group_if_new`
- 数据字段名：`group 字段`、`sourceId`、`rootDir`、`order.json 的 groups 键`、`meta.root_dir`
- 内部机制描述：`emit 保留 groups`、`端到端验证`、`向后兼容`、`ToolMeta/ScanResult 增加字段`、`后端对偶`
- 代码重构、测试补全、文档改动、设计稿（除非直接影响用户感知）
- 纯内部自修（同版本内某个新功能自己的 bug，用户从未见过旧版，**不写 Fixed**）

### 该写的（用户视角）

- 用户能**做**什么新事：「可在编辑工具时选择或新建分组」「拖动工具调整顺序」
- 用户能**看到**什么新东西：「左侧工具列表按分组分区展示」「网页链接可在弹层预览」
- 用户的**问题被修好了**：「删除工具后分组标题不再消失」「`~` 开头的路径能正确识别」

## 提炼规则（subject → 用户视角）

提交 subject 是**参考素材**，不是条目。提炼时：

### 合并

**同一条用户可见变化背后的多个内部提交，合并成一条 Added/Changed/Fixed。** 典型：

- `feat(rust): 后端对偶新增 X 字段` + `feat(types): TS 加 X 字段` + `feat(buttons): 用 X 做某事` → **一条 Added**：「可用 `X` 做 Y」
- 设计文档（`docs: 设计/计划`）+ 实现提交 → **一条 Added**（文档不单列）
- `feat` + 同版本内 `fix` 自己的 bug → **只写 feat**，bug 用户没见过

### 分类（Keep a Changelog 风格）

| 段落 | 写什么 | 空则 |
|------|--------|------|
| `### Added` | 用户**新能做**的事、**新能看到**的东西 | 省略 |
| `### Changed` | 用户感知到的行为/样式变化（非新增、非修复） | 省略 |
| `### Fixed` | 用户**经历过**的 bug 被修好（同版本内自修不算） | 省略 |

**所有段落为空就只留版本标题 + 一句说明**（如 `## [0.8.3]\n- 版本号整理，无面向用户的新功能。`）。

### 用词

- 每条一句话，**动词开头**：可/能/不再/现在/支持/新增/修复/优化/去掉。
- 主语省略或用「工具/帮助页/侧栏/终端」等用户能看到的对象，**不用**「后端/前端/渲染端/Rust/TS」。
- 用户能改、能点、能拖、能看——落到**具体动作或可见对象**上。

### 反例（这些 subject 直接照抄就是错的）

| commit subject | ❌ 照抄 | ✅ 转译 |
|----------------|--------|---------|
| `feat(rust): ToolMeta 后端对偶新增 root_dir 字段` | 「ToolMeta 后端对偶新增 root_dir 字段」 | （并入下面的功能条目，不单列） |
| `feat(buttons): 新增 substituteCwd 替换 @/ 占位符` | 「新增 substituteCwd 替换 @/」 | 「可在命令按钮里用 `@/` 引用工具主目录」 |
| `fix(buttons): substituteCwd 用函数替换防 $ 注入` | 「修复 substituteCwd 的 $ 注入」 | （同版本自修，**不写**） |
| `docs: @/ spec §4.6 对齐实现顺序` | 「@/ spec §4.6 对齐」 | （文档，**不写**） |
| `ui(EditorPane): 终端配置加「工具根目录」输入框` | 「EditorPane 加输入框」 | 「编辑工具时可设置工具根目录 (@/)」 |

## 格式

插入到 CHANGELOG.md 顶部第一个 `## [` 标题**之前**：

```markdown
## [0.9.6] - 2026-07-19
### Added
- 可在命令按钮和快捷命令里用 `@/` 占位符引用工具主目录，点击执行时自动替换为实际路径。
- 编辑工具时能设置「工具根目录 (@/)」；未设置时 `@/` 依次回退到终端工作目录、用户主目录。
```

规则：
- 版本标题格式 `## [<version>] - <YYYY-MM-DD>`，与文件已有风格一致。
- 段落顺序固定 Added → Changed → Fixed，**空段落整段省略**（不留空标题）。
- 每条 `- ` 开头，句末用句号。
- 行内代码（命令、字段、文件名）用反引号。

## 自查清单（写完必过）

- [ ] 插入位置在第一个 `## [` 之前（不是文件末尾、不是说明段之后）。
- [ ] 版本标题格式 `## [<v>] - <date>`，日期是今天。
- [ ] 段落顺序 Added → Changed → Fixed，空段落已删。
- [ ] **没有任何**模块名/函数名/类名/数据字段名（`substituteCwd`、`ToolMeta`、`rootDir`、`emit` 等）。
- [ ] **没有照抄** commit subject（subject 是素材，不是条目）。
- [ ] 同一用户变化的多个内部提交已合并（含设计文档、后端对偶、同版本自修 fix）。
- [ ] 每条动词开头、一句话、用户能看懂「这版给我带来什么」。
- [ ] 行内代码用反引号；句末有句号。
- [ ] 没有重复现有 CHANGELOG 已有的条目。
- [ ] 横跨 tag 边界的用户可感知变化归到了「用户第一次完整感受到它」的版本（功能 + 体验收尾合并，不因 commit 越界而单列或漏写）。

## 三个完整示例

### 示例 1：单功能多内部提交（v0.9.6）

输入提交（`v0.9.5..HEAD`）：
```
- docs: @/ spec §4.6 对齐实际实现顺序 + 记录 ParamPromptModal 预览决策
- ui(EditorPane): 终端配置加「工具根目录 (@/)」输入框
- feat(QuickCommands): 全局快捷命令点击时替换 @/ 占位符
- feat(HelpPane): 按钮点击时替换 @/ 占位符
- feat(rust): ToolMeta 后端对偶新增 root_dir 字段
- feat(types): ToolMeta 新增 rootDir 字段
- fix(buttons): substituteCwd 用函数替换防 $ 注入 + 注释英文化
- docs: 修正 @/ 触发正则（只替换 @，保留原文 /）
- feat(buttons): 新增 substituteCwd 替换 @/ 占位符
- docs: @/ 占位符实现计划（7 个 task，TDD）
- docs: @/ 锚点新增独立 rootDir 字段，优先级 rootDir > cwd > ~
- docs: @/ 空 cwd 直接吐 ~，交给 shell 展开
- docs: 工具主目录占位符 @/ 设计继续
```

产出（已提炼，11 条 → 2 条 Added，其余丢弃）：
```markdown
## [0.9.6] - 2026-07-19
### Added
- 可在命令按钮和快捷命令里用 `@/` 占位符引用工具主目录，点击执行时自动替换为实际路径。
- 编辑工具时能设置「工具根目录 (@/)」；未设置时 `@/` 依次回退到终端工作目录、用户主目录。
```

### 示例 2：混合 Added + Fixed（v0.9.4）

输入提交（假设）：
```
- feat: 工具分组（编辑时选/建分组、列表分区展示、折叠展开）
- feat: 同分组内拖动排序
- feat: 导入去重（同 bundle 不再重复创建）
- fix: 删除或重排后分组标题偶发消失
- refactor: OrderIndex 结构调整（内部）
- test: 补充分组排序单测
```

产出（refactor/test 丢弃）：
```markdown
## [0.9.4] - 2026-07-18
### Added
- 工具分组：可在编辑工具时选择已有分组或新建分组，左侧工具列表按分组分区展示，分组可点击折叠/展开。
- 同一分组内可拖动工具调整顺序。
- 导入工具包时，重复导入同一份文件不再重复创建工具，而是更新已有工具。

### Fixed
- 删除或重排工具后分组标题偶发消失的问题。
```

### 示例 3：无用户可见变化（v0.8.3）

输入提交全是 `chore` / 内部整理：
```markdown
## [0.8.3] - 2026-07-14
- 版本号整理，无面向用户的新功能。
```

## 与脚本/手动命令的关系

- 本 skill 是**一键发版**：内部调 `npm run version:set -- <v>` 升版本号、自己写 CHANGELOG、git commit/tag/push，免去手敲多条命令。
- `scripts/set-version.mjs` **只负责升版本号**（同步四处），不碰 CHANGELOG、不自动打 tag（除非加 `--tag`，本 skill 不加——tag 决策放在第 4 步）。脚本末尾打印「用 changelog-gen skill」的提示，本 skill 触发时无视它。
- 若用户只想升版本号不想走全流程，直接 `npm run version:set -- <v>` 即可，不必触发本 skill。
- 若用户只想写 CHANGELOG 不发版，对本 skill 说「只写 CHANGELOG」/「跳过版本号和推送」，只执行第 2 步。

## 边界 / 不做什么

- **不**改历史 CHANGELOG 条目（只新增，不重写——除非用户明确要求修订）。
- **不**为同版本内自修的 bug 写 Fixed（用户没经历过）。
- **不**写「重构」「补测试」「写文档」这类用户无感知的条目。
- **不**照抄 commit subject，哪怕它看起来已经像用户语言——都要过一遍「用户能看懂吗」。
- **不**在没问清的情况下 `--force` 推送或覆盖已存在的 tag。
- **发版提交和 tag 打在 main 上**（第 3 步判断分支，feature 分支上会停下来问是否先合并回 main）。用户明确选择「就在当前分支提交」才例外。

---

## 维护约定（本 skill 的来源与发布）

**本项目 `/Users/sunknight/web/code/sk_ideas/termstep` 是此 skill 的权威来源**：
- 源文件：`skills/changelog-gen/SKILL.md`（纳入 git）。
- 发布位置：`~/.zcode/skills/changelog-gen/SKILL.md`（ZCode 用户级 skill 目录）。

**更新流程**：
1. 先改项目源 `skills/changelog-gen/SKILL.md`，提交进 git。
2. 同步发布：
   ```bash
   cp /Users/sunknight/web/code/sk_ideas/termstep/skills/changelog-gen/SKILL.md \
      /Users/sunknight/.zcode/skills/changelog-gen/SKILL.md
   ```
3. 确认 frontmatter `name` = 目录名（`changelog-gen`），`description` 含触发词（发版/打 tag/changelog/版本记录）。

**不要**直接改 `~/.zcode/skills/` 里的副本——会脱离 git、丢失历史。

**规则权威来源**：本 skill 的「面向用户」原则来自项目记忆 `topics/project_changelog-update-on-version.md`；升版本号由 `scripts/set-version.mjs` 完成（本 skill 调用它）。这两处是单一真相源。
