#!/usr/bin/env bash
#
# 用法：
#   bash scripts/packaging/build-dmg.sh                 完整流程（签名 + 公证）
#   bash scripts/packaging/build-dmg.sh --skip-notarize 本地快速出包（ad-hoc 或自签，不公证）
#
# 前置：
#   macOS、node/npm、cargo、Xcode Command Line Tools
#   rustup target add x86_64-apple-darwin（universal 构建需要）
#   完整流程还需 VEYL_DEV_ID_APP 与 VEYL_NOTARY_PROFILE
#
# 产物：build/packages/Veyl-<version>.dmg
# 日志：build/logs/build-dmg-<timestamp>.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

SKIP_NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf '错误：未知参数 %s\n' "$arg" >&2; exit 2 ;;
  esac
done

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "build-dmg.sh 只能在 macOS 上运行"

BUILD_DIR="$ROOT/build"
PACKAGES_DIR="$BUILD_DIR/packages"
LOGS_DIR="$BUILD_DIR/logs"
mkdir -p "$PACKAGES_DIR" "$LOGS_DIR"
LOG="$LOGS_DIR/build-dmg-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

printf '== Veyl macOS 打包 ==\n'
printf '仓库：%s\n' "$ROOT"
printf '日志：%s\n' "$LOG"

for tool in node npm cargo lipo codesign hdiutil ditto xcrun python3; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少命令：$tool"
done

VERSION="$(python3 - "$ROOT/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])
PY
)"
PRODUCT="$(python3 - "$ROOT/src-tauri/tauri.conf.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["productName"])
PY
)"
[ -n "$VERSION" ] || die "读取版本号失败"
[ -n "$PRODUCT" ] || die "读取 productName 失败"
printf '版本：%s\n产品名：%s\n' "$VERSION" "$PRODUCT"

if ! rustup target list --installed 2>/dev/null | grep -qx 'x86_64-apple-darwin'; then
  die "缺少 x86_64-apple-darwin 目标，请先执行：rustup target add x86_64-apple-darwin"
fi

# shellcheck source=lib/sign-macos.sh
source "$LIB_DIR/sign-macos.sh"

printf '\n签名环境：\n'
describe_signing_env

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  if [ -z "${VEYL_DEV_ID_APP:-}" ] || [ -z "${VEYL_NOTARY_PROFILE:-}" ]; then
    printf '\n' >&2
    if [ -z "${VEYL_DEV_ID_APP:-}" ]; then
      printf '缺少 VEYL_DEV_ID_APP（Developer ID Application 证书名）\n' >&2
    fi
    if [ -z "${VEYL_NOTARY_PROFILE:-}" ]; then
      printf '缺少 VEYL_NOTARY_PROFILE（xcrun notarytool store-credentials 保存的 profile 名）\n' >&2
    fi
    printf '本地验证可以先跳过公证：\n  bash scripts/packaging/build-dmg.sh --skip-notarize\n' >&2
    die "签名/公证凭据不完整"
  fi
else
  printf '\n--skip-notarize：只签名，不公证\n'
fi

printf '\n[0/9] 规则数据与图标\n'
# 规则数据不入库：有归档就校验，没有就现场拉取并打包。
if compgen -G "$ROOT/src-tauri/resources/rules/veyl-rules-*.tar.zst" >/dev/null; then
  (cd "$ROOT" && node scripts/rules/verify-rules.mjs --required)
else
  (cd "$ROOT" && node scripts/rules/fetch-rules.mjs)
fi

ICON_SOURCE="$ROOT/veyl.png"
ICON_ICNS="$ROOT/src-tauri/icons/icon.icns"
if [ ! -f "$ICON_ICNS" ]; then
  printf '警告：找不到 src-tauri/icons/icon.icns，先跑 npm run icons\n' >&2
elif [ -f "$ICON_SOURCE" ] && [ "$ICON_SOURCE" -nt "$ICON_ICNS" ]; then
  printf '警告：icon.icns 比 veyl.png 旧，建议先跑 npm run icons（本次仍用现有图标打包）\n' >&2
else
  printf '  图标不早于源图\n'
fi

printf '\n[1/9] 构建前端\n'
(cd "$ROOT" && npm run build)

printf '\n[2/9] 构建 universal .app\n'

# Tauri 的 universal 打包只对主二进制做 lipo，crate 里其它 [[bin]] 不会被构建，
# 但打包阶段仍要求它们在 universal 目录里存在。这里提前补齐，打包后再删掉，
# 保证发布包里不带开发用工具。
EXTRA_BINS="$(python3 - "$ROOT/src-tauri/Cargo.toml" <<'PY'
import re, sys

names = []
in_bin = False
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        stripped = line.strip()
        if stripped.startswith("["):
            in_bin = stripped == "[[bin]]"
            continue
        if in_bin:
            match = re.match(r'name\s*=\s*"([^"]+)"', stripped)
            if match:
                names.append(match.group(1))
print(" ".join(names))
PY
)"

if [ -n "$EXTRA_BINS" ]; then
  printf '  辅助二进制：%s\n' "$EXTRA_BINS"
  for extra_bin in $EXTRA_BINS; do
    for arch in aarch64-apple-darwin x86_64-apple-darwin; do
      (cd "$ROOT/src-tauri" && cargo build --release --bin "$extra_bin" --target "$arch")
    done
    mkdir -p "$ROOT/src-tauri/target/universal-apple-darwin/release"
    lipo -create \
      "$ROOT/src-tauri/target/aarch64-apple-darwin/release/$extra_bin" \
      "$ROOT/src-tauri/target/x86_64-apple-darwin/release/$extra_bin" \
      -output "$ROOT/src-tauri/target/universal-apple-darwin/release/$extra_bin"
  done
fi

(cd "$ROOT" && npm run tauri -- build --target universal-apple-darwin --bundles app)

APP_PATH="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/$PRODUCT.app"
[ -d "$APP_PATH" ] || die "找不到构建产物：$APP_PATH"

for extra_bin in $EXTRA_BINS; do
  rm -f "$APP_PATH/Contents/MacOS/$extra_bin"
done

BUNDLED_ICON="$APP_PATH/Contents/Resources/icon.icns"
if [ -f "$BUNDLED_ICON" ]; then
  if [ -f "$ICON_ICNS" ] && ! cmp -s "$BUNDLED_ICON" "$ICON_ICNS"; then
    printf '警告：产物里的 icon.icns 与 src-tauri/icons/icon.icns 不一致\n' >&2
  else
    printf '  产物图标与仓库图标一致\n'
  fi
else
  printf '警告：产物里没有 Contents/Resources/icon.icns\n' >&2
fi

printf '\n[3/9] 校验 universal 二进制\n'
BINARY="$APP_PATH/Contents/MacOS/$PRODUCT"
[ -f "$BINARY" ] || die "找不到可执行文件：$BINARY"
ARCHS="$(lipo -archs "$BINARY")"
printf '  lipo -archs: %s\n' "$ARCHS"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *) die "不是 universal 二进制（需要 arm64 与 x86_64）：$ARCHS" ;;
esac

printf '\n[4/9] 签名嵌套 Mach-O 与 App\n'
sign_app "$APP_PATH"

printf '\n[5/9] 校验签名\n'
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  printf '\n[6/9] 公证 App 并 staple\n'
  notarize_app "$APP_PATH"
else
  printf '\n[6/9] 跳过公证（--skip-notarize）\n'
fi

printf '\n[7/9] 制作 DMG\n'
STAGE="$BUILD_DIR/dmg-stage"
DMG="$PACKAGES_DIR/$PRODUCT-$VERSION.dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$APP_PATH" "$STAGE/$PRODUCT.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$PRODUCT $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
printf '  %s\n' "$DMG"

printf '\n[8/9] 签名并公证 DMG\n'
sign_dmg "$DMG"
if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  notarize_dmg "$DMG"
else
  printf '  跳过 DMG 公证（--skip-notarize）\n'
fi

printf '\n[9/9] Gatekeeper 校验\n'
if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  verify_app "$APP_PATH"
  verify_dmg "$DMG"
else
  codesign --verify --strict --verbose=2 "$DMG" || printf '警告：DMG 签名未通过校验（ad-hoc 模式）\n' >&2
  if ! verify_dmg "$DMG"; then
    printf '警告：Gatekeeper 校验未通过——未公证的包在本机之外会被拦截，属预期\n' >&2
  fi
fi

printf '\n完成\n'
printf '  产物：%s\n' "$DMG"
printf '  大小：%s\n' "$(du -h "$DMG" | cut -f1)"
printf '  摘要：%s\n' "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
