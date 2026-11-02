#!/usr/bin/env bash
#
# 用法：
#   bash scripts/release/release.sh --dry-run                 只打印命令，不执行任何操作
#   bash scripts/release/release.sh                           本地构建，然后打印后续命令
#   bash scripts/release/release.sh --upload --confirm 0.1.0  构建 → 建草稿 release → 上传
#
# 前置：
#   build-dmg.sh 能跑通（本地构建）
#   --upload 还需要 gh 已登录且有 contents: write
#
# 硬规则：
#   - 脚本绝不执行 git push（不推分支、不推 tag）。远程写入只发生在 --upload 分支，且由 gh 完成。
#   - 一律 --draft，不自动发布；正式发布由 PM 在 GitHub 上手动点。
#   - 不修改 docs/、不改版本号、不提交。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DRY_RUN=0
UPLOAD=0
CONFIRM=""
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
用法：
  release.sh [--dry-run] [--allow-dirty]
  release.sh --upload --confirm <x.y.z> [--allow-dirty]

  --dry-run        只打印将要执行的命令，构建与上传都不执行
  --allow-dirty    允许工作区有未提交改动
  --upload         本地构建后创建草稿 release 并上传产物（需要 gh 登录）
  --confirm <ver>  与当前版本号手打一致才允许上传

无 --upload 时不会对远端做任何操作。
EOF
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --upload) UPLOAD=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --confirm)
      [ $# -ge 2 ] || die "--confirm 需要版本号"
      CONFIRM="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（见 --help）" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "缺少 python3"
command -v git >/dev/null 2>&1 || die "缺少 git"

if [ "$UPLOAD" -eq 1 ]; then
  [ -n "$CONFIRM" ] || die "--upload 必须同时给 --confirm <版本号>"
fi
if [ -n "$CONFIRM" ] && [ "$UPLOAD" -eq 0 ]; then
  die "--confirm 只能和 --upload 一起使用"
fi

read_versions() {
  python3 - "$ROOT" <<'PY'
import json, re, sys
from pathlib import Path

root = Path(sys.argv[1])
pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
tauri = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))

cargo_version = None
section = None
for line in (root / "src-tauri/Cargo.toml").read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped
        continue
    if section == "[package]":
        match = re.match(r'\s*version\s*=\s*"([^"]+)"', line)
        if match:
            cargo_version = match.group(1)
            break

print(pkg["version"], tauri["version"], cargo_version or "", tauri["productName"])
PY
}

read -r PKG_VERSION CARGO_VERSION TAURI_VERSION PRODUCT <<< "$(read_versions)"

[ -n "$PKG_VERSION" ] || die "读取 package.json 版本失败"
[ "$PKG_VERSION" = "$CARGO_VERSION" ] || die "版本号不一致：package.json ${PKG_VERSION}，Cargo.toml $CARGO_VERSION"
[ "$PKG_VERSION" = "$TAURI_VERSION" ] || die "版本号不一致：package.json ${PKG_VERSION}，tauri.conf.json $TAURI_VERSION"

VERSION="$PKG_VERSION"
TAG="v$VERSION"
DMG="$ROOT/build/packages/$PRODUCT-$VERSION.dmg"

printf '== %s 发布（macOS）==\n' "$PRODUCT"
printf '版本：%s\n标签：%s\n产物：%s\n\n' "$VERSION" "$TAG" "$DMG"

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    git -C "$ROOT" status --short >&2
    die "工作区不干净；提交后再发布，或用 --allow-dirty 显式跳过"
  fi
else
  printf '注意：--allow-dirty，跳过工作区检查\n'
fi

if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "本地已有 tag ${TAG}，版本号已用过"
fi

BUILD_CMD=(bash "$ROOT/scripts/packaging/build-dmg.sh")
RELEASE_CMD=(gh release create "$TAG" "$DMG" --draft --title "$PRODUCT $VERSION" --generate-notes)

print_cmd() {
  local out=""
  for part in "$@"; do
    out="$out $(printf '%q' "$part")"
  done
  printf '  %s\n' "${out# }"
}

if [ "$DRY_RUN" -eq 1 ]; then
  printf '将要执行：\n'
  print_cmd "${BUILD_CMD[@]}"
  [ "$UPLOAD" -eq 1 ] && print_cmd "${RELEASE_CMD[@]}"
  printf '\n--dry-run：未构建、未上传、未改动任何文件\n'
  exit 0
fi

printf '[1/2] 本地构建\n'
"${BUILD_CMD[@]}"

if [ "$UPLOAD" -eq 0 ]; then
  printf '\n产物已就绪。要上传草稿 release，手动执行：\n'
  print_cmd "${RELEASE_CMD[@]}"
  printf '\n（脚本不会执行 git push；tag 由 gh 在远端创建，发布动作请在 GitHub 上点）\n'
  exit 0
fi

[ "$CONFIRM" = "$VERSION" ] || die "确认版本号不匹配（输入 ${CONFIRM}，当前 ${VERSION}），已取消"

command -v gh >/dev/null 2>&1 || die "缺少 gh CLI：https://cli.github.com"

if gh release view "$TAG" >/dev/null 2>&1; then
  die "远端已存在 release ${TAG}，版本号已用过"
fi

printf '\n[2/2] 创建草稿 release 并上传\n'
print_cmd "${RELEASE_CMD[@]}"
"${RELEASE_CMD[@]}"

printf '\n草稿已创建：%s\n' "$TAG"
printf '产物 SHA256：%s\n' "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
printf '下一步：到 GitHub Releases 页面检查附件并点 Publish。\n'
