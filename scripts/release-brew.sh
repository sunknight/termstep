#!/usr/bin/env bash
# 把一个已打 tag 的版本发布到 GitHub Release + Homebrew tap。
#
# 前置（release-wizard skill 已完成）：
#   1. 版本号四处已同步（package.json / Cargo.toml / tauri.conf.json / Cargo.lock）
#   2. CHANGELOG 已写
#   3. 已 commit（chore(release): <版本>）并 tag v<版本>
#   4. tag + main 已推到私有 origin（Gitea）
#
# 本脚本做剩下的第 5~9 步：
#   5. 构建 universal dmg
#   6. 算 sha256
#   7. 推源码 + tag 到 GitHub 公开镜像（github remote）
#   8. 创建 GitHub Release 并上传 dmg
#   9. 更新 Homebrew tap 的 cask（version + sha256）
#
# 用法： ./scripts/release-brew.sh <版本号>   例： ./scripts/release-brew.sh 1.2.0
#
# 依赖：gh（已登录）、Rust 工具链、Node 依赖。gh 访问 github.com 需走代理时，
# 本脚本自动注入 HTTPS_PROXY/HTTP_PROXY=127.0.0.1:7897（与 AGENTS.md 约定一致）。
set -euo pipefail

VERSION="${1:?用法: ./scripts/release-brew.sh <版本号，如 1.2.0>}"
# 去掉可能误带的前缀 v
VERSION="${VERSION#v}"
TAP_REPO="sunknight/homebrew-termstep"
APP_REPO="sunknight/termstep"
CASK_PATH="Casks/termstep.rb"
DMG_NAME="TermStep_${VERSION}_universal.dmg"
TAG="v${VERSION}"
PROXY="http://127.0.0.1:7897"

# 项目根（脚本可能在 scripts/ 下被调用，也可能从别处）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "==> [0/9] 前置检查"
# 当前分支、tag 存在、tag 指向 HEAD
if ! git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "错误：本地不存在 tag ${TAG}。先用 release-wizard 完成升版本+commit+tag。" >&2
  exit 1
fi
TAG_COMMIT="$(git rev-parse "${TAG}")"
HEAD_COMMIT="$(git rev-parse HEAD)"
if [ "${TAG_COMMIT}" != "${HEAD_COMMIT}" ]; then
  echo "警告：${TAG} 指向 ${TAG_COMMIT:0:8}，但 HEAD 是 ${HEAD_COMMIT:0:8}。" >&2
  echo "       tag 应打在 release commit（HEAD）上。继续？[y/N]" >&2
  read -r resp || resp=""
  [ "${resp}" = "y" ] || { echo "已取消。"; exit 1; }
fi
# GitHub Release 幂等：已存在则停（绝不覆盖）
if HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" gh release view "${TAG}" --repo "${APP_REPO}" >/dev/null 2>&1; then
  echo "错误：GitHub Release ${TAG} 已存在于 ${APP_REPO}。如需更新用 gh release edit，绝不覆盖已发布版本。" >&2
  exit 1
fi
echo "    tag ${TAG} @ ${TAG_COMMIT:0:8} = HEAD ✓；GitHub Release 尚未创建 ✓"

echo "==> [1/9 → 第5步] 构建 universal dmg"
npm run release
if [ ! -f "release/${DMG_NAME}" ]; then
  echo "错误：构建后未找到 release/${DMG_NAME}。检查 tauri.conf.json 的 dmg 文件名格式。" >&2
  exit 1
fi

echo "==> [2/9 → 第6步] 计算 sha256"
SHA="$(shasum -a 256 "release/${DMG_NAME}" | awk '{print $1}')"
echo "    sha256: ${SHA}"

echo "==> [3/9 → 第7步] 推送源码 + tag 到 GitHub 镜像 (${APP_REPO})"
# 用 ssh 推可能更稳；此处 github remote 是 https，走代理
HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" git push github main
HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" git push github "${TAG}"

echo "==> [4/9 → 第8步] 创建 GitHub Release 并上传 dmg"
# 从 CHANGELOG 抽取本版本小节作为 Release notes（参数化，不写死下一版本号）。
# 逻辑：从 `## [${VERSION}]` 行的下一行开始打印，直到遇到下一个 `## [` 标题（不含）停止。
# 用 index() 字面量匹配（而非 ~ 正则），避免版本号里的 [] 被当成字符类。
NOTES="$(awk -v v="## [${VERSION}]" '
  index($0, v) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md)"
if [ -z "${NOTES}" ]; then
  echo "警告：未从 CHANGELOG.md 抽取到 [${VERSION}] 小节，Release notes 将留空（可后续 gh release edit 补）。" >&2
fi
HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" gh release create "${TAG}" \
  --repo "${APP_REPO}" \
  --title "${VERSION}" \
  --notes "${NOTES}" \
  "release/${DMG_NAME}"
echo "    Release 已创建：https://github.com/${APP_REPO}/releases/tag/${TAG}"

echo "==> [5/9 → 第9步] 更新 Homebrew cask (${TAP_REPO}/${CASK_PATH})"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" gh repo clone "${TAP_REPO}" "${TMP}" -- --depth 1
if [ ! -f "${TMP}/${CASK_PATH}" ]; then
  echo "错误：tap 仓库里没有 ${CASK_PATH}。请确认 cask 路径。" >&2
  exit 1
fi
# macOS sed 需要 -i '' ；version 行和 sha256 行就地替换
sed -i '' -E \
  -e "s/^  version \".*\"/  version \"${VERSION}\"/" \
  -e "s/^  sha256 \".*\"/  sha256 \"${SHA}\"/" \
  "${TMP}/${CASK_PATH}"
# 确认确实改动了（避免空提交）
if ! ( cd "${TMP}" && git diff --quiet -- "${CASK_PATH}" ); then
  ( cd "${TMP}" && \
    git add "${CASK_PATH}" && \
    git commit -m "termstep ${VERSION}" && \
    HTTPS_PROXY="${PROXY}" HTTP_PROXY="${PROXY}" git push )
  echo "    cask 已更新到 ${VERSION} (sha256 ${SHA:0:12}…)"
else
  echo "警告：cask 内容无变化（version/sha256 可能已是该值），未提交。请手动检查 ${TAP_REPO}。" >&2
fi

echo ""
echo "==> 完成。用户现在可以："
echo "    brew update && brew upgrade --cask termstep    # 升级"
echo "    brew install --cask termstep                   # 全新安装"
echo "    # 首次安装/升级后需解除 Gatekeeper："
echo "    xattr -cr /Applications/TermStep.app"
