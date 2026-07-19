---
name: changelog-gen
description: "为 TermStep 项目写 CHANGELOG.md 版本条目并插入文件顶部。用户说「写 changelog / 更新版本记录 / 写发布说明 / 0.9.x 有哪些变化 / 把这版改动记下来」或打版本 tag 前后需要补充用户可见的变化说明时触发。本 skill 自己跑 git log 取提交、按「面向用户」原则提炼成条目、直接插入 CHANGELOG.md，不依赖先跑 set-version.mjs。绝不照抄 commit subject，绝不写模块名/函数名/数据字段/内部机制。"
---

# TermStep CHANGELOG 生成器

为 **TermStep** 项目（`/Users/sunknight/web/code/sk_ideas/termstep`）生成 CHANGELOG.md 版本条目，并插入文件顶部 `## [` 标题之前。

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

## 何时触发

- 用户说「写 changelog / 更新版本记录 / 写发布说明 / 把这版改动记下来」→ 直接生成。
- 用户准备打版本 tag（`npm run version:set -- <v> --tag`）前后 → 主动提醒/补 CHANGELOG。
- 用户问「0.9.x 有哪些变化 / 这版做了什么」→ 读 CHANGELOG 回答，**不**触发生成。

## 工作流

1. **确认版本号和日期**。版本号从用户消息取（如「0.9.6」）；用户没给就读 `package.json` 的 `version` 字段 + 1 个 patch，或问。日期用今天（`date +%Y-%m-%d`），除非用户指定。
2. **确定提交范围**：
   - 默认 `<最近 tag>..HEAD`（与 `set-version.mjs` 一致的范围）。
   - 用户指定范围（如 `v0.9.5..HEAD`、某 commit 之后）就用指定的。
   - 取命令：`git -C <项目根> log <range> --no-merges --format='- %s'`
   - **git tag 边界只是下界参考，不是硬切线**。一条用户可感知的变化若横跨 tag（功能在 A 版本提交、体验打磨延续到 B 版本，或实现散落在两次 release 之间），归到「用户第一次完整感受到它」的版本——通常是**功能首次亮相的版本**，让用户看到「这个功能 + 它的好体验」一起出现，而不是把收尾打磨单列在下一个版本让人摸不着头脑。反过来，若某次打磨独立于任何功能、单独发生在某个版本，就归那个版本。
     - 实例：0.9.5「跨分组拖拽」是本版本新功能，落点指示优化是这功能的体验收尾（commit 落在拖拽实现周期内）→ 归 0.9.5，与功能合并成一条 Added；不要因为某条 commit 越过 tag 边界就单列或漏写。
3. **读 CHANGELOG.md 顶部**，确认插入位置（第一个 `## [` 之前）和现有格式风格。
4. **按「提炼规则」**把 commit subject 转成用户视角条目。**绝不照抄 subject**——subject 是面向开发的，必须转译。
5. **按格式组装**条目（见下），插入 CHANGELOG.md 顶部。
6. **自查**（见下），告诉用户结果，附「下一步：版本号/打 tag」提示。

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

## 与脚本的关系

- `npm run version:set -- <v> [--tag]` 只同步版本号 + 打 tag，**不碰 CHANGELOG**（脚本末尾会打印一段提示词，但本 skill 不依赖它——本 skill 自己取 git log）。
- **推荐顺序**：先用本 skill 写 CHANGELOG 条目 → `git add CHANGELOG.md` → 再跑 `npm run version:set -- <v> --tag`（脚本会把版本文件一起 commit 打 tag；CHANGELOG 由你单独提交）。
- 或反过来：先打 tag（确定版本号），再用本 skill 补 CHANGELOG——两种顺序都可，关键是**别忘写 CHANGELOG**。

## 边界 / 不做什么

- **不**改版本号（那是 `set-version.mjs` 的事）。
- **不**改历史 CHANGELOG 条目（只新增，不重写——除非用户明确要求修订）。
- **不**为同版本内自修的 bug 写 Fixed（用户没经历过）。
- **不**写「重构」「补测试」「写文档」这类用户无感知的条目。
- **不**照抄 commit subject，哪怕它看起来已经像用户语言——都要过一遍「用户能看懂吗」。

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
3. 确认 frontmatter `name` = 目录名（`changelog-gen`），`description` 含触发词（changelog/版本记录/发布说明）。

**不要**直接改 `~/.zcode/skills/` 里的副本——会脱离 git、丢失历史。

**规则权威来源**：本 skill 的「面向用户」原则来自项目记忆 `topics/project_changelog-update-on-version.md`；提示词范围（`<tag>..HEAD`）来自 `scripts/set-version.mjs` 的 `buildChangelogPrompt`。这两处是单一真相源，本 skill 是它们的可触发封装。
