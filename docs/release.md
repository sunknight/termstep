# TermStep 发布指南

> 本文档描述从「代码改完准备发版」到「用户能 `brew upgrade` 拿到新版」的完整流程。
> 面向**维护者**（即你自己），不是给用户的安装说明——用户安装说明见 [README](../README.md#-下载与安装普通用户)。

## 前置条件

- 在 `main` 分支上，且本地 `main` 不落后远程（`git fetch` 后 `git log main..origin/main` 应无输出）。
- 工作区干净（无未提交改动）。
- 已安装：`gh`（GitHub CLI，已登录）、Rust 工具链、Node 依赖（`npm install` 过）。
- 远程 `github` 指向公开镜像仓库 `sunknight/termstep`（源码仍在私有 Gitea）：
  ```bash
  git remote -v
  # github  https://github.com/sunknight/termstep.git   (push)
  ```

## 发布渠道一览

| 渠道 | 内容 | 仓库 |
|------|------|------|
| GitHub Release | universal dmg（公开下载源） | `sunknight/termstep` |
| Homebrew tap | cask 文件（`termstep.rb`） | `sunknight/homebrew-termstep` |

cask 的 `url` 指向 GitHub Release 的 dmg asset，所以 **Release 必须先发，cask 后更新**。

---

## 标准发版流程

下面以发 `1.1.3` 为例。**推荐用 `release-wizard` skill 一键走完前 4 步**（升版本 + 写 CHANGELOG + 提交 + 打 tag 推送），在对话里说「用 release-wizard 发版」即可；之后的构建 + 发 Release + 更新 cask 需要手动跑。

### 第 1 步：升版本号

```bash
npm run version:set -- 1.1.3
```

同步四处版本号：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock`。

> ⚠️ **不要加 `--tag`**。tag 放到第 3 步，与 CHANGELOG 一起的同一个提交上打。`--tag` 会提前在版本文件提交上打 tag，导致 tag 与 release commit 错位。

### 第 2 步：写 CHANGELOG

手写，面向用户（不写模块名/函数名/数据字段/内部机制）。从 `<最近 tag>..HEAD` 的提交里提炼「用户能看到/能做到什么」。

编辑 `CHANGELOG.md`，在顶部 `# Changelog` 标题下方、第一个 `## [` 之前插入新版本小节：

```markdown
## [1.1.3] - 2026-07-27
### Added
- 用「用户能做什么」的语言写。例如：可在编辑工具时选择或新建分组。

### Fixed
- 用「用户的问题被修好」的语言写。例如：删除工具后分组标题不再消失。
```

规则细节见全局 skill `release-wizard` 及其项目参考文件 `skills/release-wizard/references/termstep.md`（sk_scripts 仓库）。核心：**绝不照抄 commit subject，绝不写实现细节**。

### 第 3 步：提交（版本号 + CHANGELOG 一个提交）

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore(release): 1.1.3"
```

### 第 4 步：打 tag 并推送

```bash
# 预检：tag 不存在
git tag | grep v1.1.3   # 应无输出

git tag v1.1.3
# 推到私有 origin（Gitea）
git push origin main
git push origin v1.1.3
```

> 若远程已有同名 tag，**停下确认，绝不 `--force` 覆盖**。

---

## 第 5 步：构建 universal dmg

```bash
npm run release
```

产出 `release/TermStep_1.1.3_universal.dmg`（文件名格式固定：`TermStep_<版本>_universal.dmg`，下划线分隔）。

> 首次构建较慢（Rust release 编译）。后续增量构建会快很多。

## 第 6 步：算 sha256

```bash
shasum -a 256 release/TermStep_1.1.3_universal.dmg
# 输出形如：a242bc9f4a6ce1fbb5bb64f95329f51b24ab0dc1c63fc630baad7e70e3eb9fdc
```

记下这个值，下一步更新 cask 要用。

## 第 7 步：推送源码到 GitHub 镜像

```bash
git push github main
git push github v1.1.3
```

GitHub Release 必须挂在 tag 上，所以 **tag 要先推到 github remote**。

## 第 8 步：创建 GitHub Release 并上传 dmg

```bash
gh release create v1.1.3 \
  --repo sunknight/termstep \
  --title "1.1.3" \
  --notes "$(awk '/^## \[1.1.3\]/{f=1} f; /^## \[1.1.2\]/{exit}' CHANGELOG.md)" \
  release/TermStep_1.1.3_universal.dmg
```

`--notes` 从 CHANGELOG 抽取本版本小节作为 Release 说明（保持与 CHANGELOG 一致）。`--title` 用纯版本号即可。

## 第 9 步：更新 Homebrew cask

cask 在 `sunknight/homebrew-termstep` 仓库的 `Casks/termstep.rb`。改两处：`version` 和 `sha256`：

```ruby
cask "termstep" do
  version "1.1.3"                                    # ← 改这里
  sha256 "上一步 shasum 的输出"                       # ← 改这里

  url "https://github.com/sunknight/termstep/releases/download/v#{version}/TermStep_#{version}_universal.dmg"
  # ... 其余不变
end
```

> `url` 用 `#{version}` 插值，文件名格式稳定就不用动。

改法（任选）：

```bash
# 方式 A：本地 clone 了 tap 仓库
cd ~/code/homebrew-termstep   # 你的 tap 仓库本地路径
$EDITOR Casks/termstep.rb
git add Casks/termstep.rb && git commit -m "termstep 1.1.3" && git push

# 方式 B：没 clone，用 gh API 直接改（需要先取文件 sha）
SHA=$(gh api repos/sunknight/homebrew-termstep/contents/Casks/termstep.rb --jq '.sha')
# 编辑后 base64 编码上传，或用网页编辑器
```

---

## 第 10 步：验证

```bash
# 拉取新 cask
brew update

# 模拟用户升级
brew upgrade --cask termstep

# 或全新安装（先卸载）
brew uninstall --cask termstep
brew install --cask termstep

# 解除 Gatekeeper 拦截（应用未签名）
xattr -cr /Applications/TermStep.app

# 打开确认
open -a TermStep
```

确认能正常启动、版本号正确（菜单 → 关于，或看 `brew info --cask termstep`）。

---

## 一键脚本：`scripts/release-brew.sh`

第 5~9 步已串成一条命令，脚本就在仓库里（`scripts/release-brew.sh`）。

```bash
./scripts/release-brew.sh 1.2.0
```

脚本做的事：构建 universal dmg → 算 sha256 → 推源码 + tag 到 `github` 镜像 → 创建 GitHub Release 并上传 dmg（notes 自动从 CHANGELOG 抽取本版本小节）→ clone tap 仓库更新 cask 的 version + sha256 并 push。内含幂等检查：tag 不存在 / tag 不在 HEAD / GitHub Release 已存在 都会停下报错，绝不覆盖已发布版本。`gh` 命令自动注入代理 `127.0.0.1:7897`。

> 用法：先走完第 1~4 步（升版本 + CHANGELOG + commit + tag 推 origin），再跑 `./scripts/release-brew.sh <版本>`。

---

## 故障排查

### `gh release create` 报 tag 不存在

GitHub Release 必须挂在已推送的 tag 上。确认 `git push github v<版本>` 执行过，且 `gh api repos/sunknight/termstep/tags --jq '.[].name'` 能看到该 tag。

### `brew install` 报 sha256 不匹配

cask 里的 `sha256` 与实际 dmg 不一致。重新 `shasum -a 256 release/<dmg>` 并更新 cask。常见原因：dmg 重新构建过但没更新 cask。

### `brew install` 报下载 404

cask 的 `url` 与 GitHub Release asset 名不一致。注意文件名是**下划线**分隔（`TermStep_1.1.3_universal.dmg`），不是连字符。确认 Release 里 asset 名与 cask `url` 完全一致。

### 用户报「应用已损坏」

这是 Gatekeeper 拦截未签名应用，不是真的损坏。让用户执行：

```bash
xattr -cr /Applications/TermStep.app
```

或右键 TermStep.app →「打开」→ 弹窗选「打开」。详见 [README 用户安装说明](../README.md#-下载与安装普通用户)。

### 升级后版本号没变

用户侧 `brew update` 没拉到新 cask，或 cask 的 `version` 字段没改。确认 tap 仓库 `Casks/termstep.rb` 已 push，且用户跑了 `brew update`。

---

## 附录：仓库与地址速查

| 用途 | 地址 |
|------|------|
| 公开镜像（源码 + Release） | `github.com/sunknight/termstep` |
| Homebrew tap | `github.com/sunknight/homebrew-termstep` |
| cask 文件 | `Casks/termstep.rb` |
| dmg 下载 URL 模板 | `https://github.com/sunknight/termstep/releases/download/v<版本>/TermStep_<版本>_universal.dmg` |
| 私有源码（origin） | Gitea `127.0.0.1:33199/sk/termstep.git` |
