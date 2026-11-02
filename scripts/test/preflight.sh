#!/usr/bin/env bash
# 用法：
#   bash scripts/test/preflight.sh                 # 按当前平台检查
#   bash scripts/test/preflight.sh --platform all  # 两个平台的产物都要求存在
#   bash scripts/test/preflight.sh --version 0.1.0 # 指定版本（默认取 tauri.conf.json）
#   bash scripts/test/preflight.sh --dry-run       # 只检查，不写 SHA256SUMS
#
# 检查项：
#   1. 版本号三处一致：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
#   2. git tag v<version> 不存在（存在说明已经发过，不要重复发）
#   3. 图标未过期：src-tauri/icons/icon.icns 的修改时间不早于 veyl.png
#   4. build/packages/ 下对应平台的安装包存在且非空
#   5. 生成 build/packages/SHA256SUMS（--dry-run 时只打印）
#
# 不检查：签名与公证状态（属于 packaging 脚本的职责）、工作区是否干净（属于 release.sh）。
# 退出码：0 通过 / 1 检查不通过 / 2 缺依赖或用法错误

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$CI_ROOT" || exit 2

ci_need node git

PLATFORM="auto"
VERSION=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --version)  VERSION="${2:-}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$PLATFORM" in
  auto)    [ "$(uname -s)" = "Darwin" ] && PLATFORM=macos || PLATFORM=windows ;;
  macos|windows|all) ;;
  *) echo "--platform 只接受 auto / macos / windows / all" >&2; exit 2 ;;
esac

PKG_DIR="$CI_ROOT/build/packages"
FAILED=0
fail() { echo "✗ $1" >&2; FAILED=1; }
ok()   { echo "✓ $1"; }

printf '发布前检查（platform=%s）\n\n' "$PLATFORM"

# --- 1. 版本号三处一致 ---
read -r PKG_VER CARGO_VER TAURI_VER <<<"$(node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tauri = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargo = (fs.readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
process.stdout.write([pkg, cargo || "?", tauri].join(" "));
')"

[ -n "$VERSION" ] || VERSION="$TAURI_VER"

if [ "$PKG_VER" = "$CARGO_VER" ] && [ "$CARGO_VER" = "$TAURI_VER" ]; then
  ok "版本号三处一致：$PKG_VER"
else
  fail "版本号不一致：package.json=$PKG_VER / Cargo.toml=$CARGO_VER / tauri.conf.json=$TAURI_VER"
fi

if [ "$VERSION" != "$TAURI_VER" ]; then
  fail "指定版本 $VERSION 与 tauri.conf.json 的 $TAURI_VER 不同（版本唯一来源是 tauri.conf.json）"
fi

# --- 2. tag 不存在 ---
TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "tag $TAG 已存在——这一版已经打过 tag，换版本号再用"
else
  ok "tag $TAG 尚未存在"
fi

# --- 2.5 图标未过期 ---
# 改了源图却忘了重生成，打出来的包还是旧图标，而 tauri.conf.json 的 bundle.icon 没变，
# 从配置上完全看不出异常。只比时间戳，不读图片内容。
mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

ICON_SRC="$CI_ROOT/veyl.png"
ICON_OUT="$CI_ROOT/src-tauri/icons/icon.icns"

if [ ! -f "$ICON_SRC" ]; then
  ok "图标检查跳过：没有 veyl.png 源图"
elif [ ! -f "$ICON_OUT" ]; then
  fail "缺图标产物：src-tauri/icons/icon.icns（跑 npm run icons 生成）"
else
  SRC_T=$(mtime_of "$ICON_SRC")
  OUT_T=$(mtime_of "$ICON_OUT")
  if [ -n "$SRC_T" ] && [ -n "$OUT_T" ] && [ "$OUT_T" -ge "$SRC_T" ]; then
    ok "图标未过期（icon.icns 不早于 veyl.png）"
  else
    fail "图标已过期：icon.icns 比 veyl.png 旧，打包会带旧图标。跑 npm run icons 重新生成"
  fi
fi

# --- 3. 产物存在 ---
check_artifact() {
  local file="$1"
  if [ ! -f "$file" ]; then
    fail "缺产物：${file#"$CI_ROOT"/}"
  elif [ ! -s "$file" ]; then
    fail "产物为空：${file#"$CI_ROOT"/}"
  else
    ok "产物存在：${file#"$CI_ROOT"/}（$(du -h "$file" | cut -f1)）"
  fi
}

case "$PLATFORM" in
  macos)   check_artifact "$PKG_DIR/Veyl-$VERSION.dmg" ;;
  windows) if [ -f "$PKG_DIR/Veyl-$VERSION.msi" ]; then
             check_artifact "$PKG_DIR/Veyl-$VERSION.msi"
           else
             check_artifact "$PKG_DIR/Veyl-$VERSION-x64.msi"
           fi ;;
  all)     check_artifact "$PKG_DIR/Veyl-$VERSION.dmg"
           if [ -f "$PKG_DIR/Veyl-$VERSION.msi" ]; then
             check_artifact "$PKG_DIR/Veyl-$VERSION.msi"
           else
             check_artifact "$PKG_DIR/Veyl-$VERSION-x64.msi"
           fi ;;
esac

# --- 4. SHA256SUMS ---
if [ "$FAILED" != "0" ]; then
  printf '\n发布前检查未通过。\n'
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
else
  SHA_CMD=(sha256sum)
fi

SUMS="$PKG_DIR/SHA256SUMS"
(
  cd "$PKG_DIR" || exit 2
  for f in AIVPN-"$VERSION"*.dmg AIVPN-"$VERSION"*.msi; do
    [ -f "$f" ] || continue
    "${SHA_CMD[@]}" "$f"
  done
) >"$SUMS.new"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "（--dry-run）将写入 ${SUMS}："
  cat "$SUMS.new"
  rm -f "$SUMS.new"
else
  mv "$SUMS.new" "$SUMS"
  ok "已生成 ${SUMS#"$CI_ROOT"/}"
  cat "$SUMS"
fi

printf '\n发布前检查通过（版本 %s）\n' "$VERSION"
