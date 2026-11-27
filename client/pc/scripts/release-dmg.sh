#!/usr/bin/env bash
#
# 用法：
#   bash client/pc/scripts/release-dmg.sh                  完整流程（签名 + 公证，需要证书与 profile）
#   bash client/pc/scripts/release-dmg.sh --skip-notarize  只签名，不公证
#   bash client/pc/scripts/release-dmg.sh --current-arch   只出本机架构（默认 universal）
#   bash client/pc/scripts/release-dmg.sh --help
#
# 产物：client/pc/build/packages/veyl-cli-<version>.dmg
# 日志：client/pc/build/logs/release-dmg-<时间戳>.log
#
# 签名与公证（环境变量）：
#   VEYL_CLI_SIGN_IDENTITY   证书名；不设则自动挑第一张 Developer ID Application
#   VEYL_CLI_NOTARY_PROFILE  notarytool 保存的 profile 名；公证时必填
#   VEYL_CLI_INSTALL_DIR     仅 dev.sh 使用，本脚本不读
#
# 本机没有 Developer ID 证书时自动退回 ad-hoc 并跳过公证：
# 产物只能本机运行，DMG 可以拿来验证打包流程，不能分发。
#
# 前置：macOS、node/npm、cargo、Xcode Command Line Tools；
#       universal 需要 `rustup target add x86_64-apple-darwin`；
#       先在 client/pc 执行过 `npm install`。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build"
PACKAGES_DIR="$BUILD_DIR/packages"
LOGS_DIR="$BUILD_DIR/logs"

SKIP_NOTARIZE=0
CURRENT_ARCH=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --current-arch) CURRENT_ARCH=1 ;;
    -h|--help)
      awk 'NR == 1 { next }
           /^#/ { sub(/^# ?/, ""); if ($0 == "" && !seen) next; seen = 1; print; next }
           { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) printf '错误：未知参数 %s\n' "$arg" >&2; exit 2 ;;
  esac
done

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "release-dmg.sh 只能在 macOS 上运行"

mkdir -p "$PACKAGES_DIR" "$LOGS_DIR"
LOG="$LOGS_DIR/release-dmg-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

printf '== veyl-cli macOS 打包 ==\n'
printf '目录：%s\n' "$ROOT"
printf '日志：%s\n\n' "$LOG"

for tool in node npm cargo rustup security codesign hdiutil ditto xcrun python3 shasum lipo; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少命令：$tool"
done
[ -d "$ROOT/node_modules" ] || die "缺少 node_modules。先执行：cd \"$ROOT\" && npm install"

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
CONF_VERSION="$(python3 - "$ROOT/src-tauri/tauri.conf.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])
PY
)"
[ -n "$VERSION" ] || die "读取版本号失败"
[ -n "$PRODUCT" ] || die "读取 productName 失败"
[ "$VERSION" = "$CONF_VERSION" ] || die "package.json 版本（$VERSION）与 tauri.conf.json（$CONF_VERSION）不一致"
printf '版本：%s\n产品名：%s\n' "$VERSION" "$PRODUCT"

# shellcheck source=lib/tun-macos.sh
source "$ROOT/scripts/lib/tun-macos.sh"

if [ "$CURRENT_ARCH" -eq 1 ]; then
  TARGET="$(rustc -vV | sed -n 's/^host: //p')"
  printf '架构：%s（--current-arch）\n' "$TARGET"
else
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    rustup target list --installed 2>/dev/null | grep -qx "$t" \
      || die "缺少 $t。先执行：rustup target add $t；或加 --current-arch 只出本机架构"
  done
  TARGET="universal-apple-darwin"
  printf '架构：universal（arm64 + x86_64）\n'
fi

find_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' \
    | head -1
}

SIGN_ID="${VEYL_CLI_SIGN_IDENTITY:-$(find_identity || true)}"
if [ "$SIGN_ID" = "-" ]; then
  SIGN_ID=""
fi
if [ -z "$SIGN_ID" ]; then
  if [ "$SKIP_NOTARIZE" -eq 0 ]; then
    die "本机没有 Developer ID Application 证书，无法签名与公证。
  本地验证请显式加 --skip-notarize（产物只能本机运行，不可分发）。"
  fi
  SIGN_ID="-"
  printf '\n没有 Developer ID Application 证书：按 --skip-notarize 使用 ad-hoc 签名。\n'
  printf '产物只能本机运行；要分发请安装证书后重跑。\n'
else
  printf '签名身份：%s\n' "$SIGN_ID"
  if [ "$SKIP_NOTARIZE" -eq 0 ] && [ -z "${VEYL_CLI_NOTARY_PROFILE:-}" ]; then
    die "缺少 VEYL_CLI_NOTARY_PROFILE（xcrun notarytool store-credentials 保存的 profile 名）。
  本地验证可以加 --skip-notarize。"
  fi
fi
# helper 的验签根是 Team ID：证书 Team 与 build.rs 编进去的不一致，会「装得上、连不上」。
if [ -n "$SIGN_ID" ] && [ "$SIGN_ID" != "-" ]; then
  CERT_TEAM="$(cli_cert_team "$SIGN_ID")"
  [ "$CERT_TEAM" = "$CLI_TEAM_ID" ] \
    || die "证书 Team（$CERT_TEAM）与 build.rs 的 $CLI_TEAM_ID 不一致，helper 会拒绝连接。"
  case "$SIGN_ID" in
    "Developer ID Application: "*) ;;
    *)
      [ "$SKIP_NOTARIZE" -eq 1 ] \
        || die "公证只接受 Developer ID Application 证书；本地验证请加 --skip-notarize。"
      ;;
  esac
fi

printf '\n[准备] 随包运行时与规则\n'
prepare_tun_artifacts || die "准备随包运行时/规则失败"
if [ -n "${SIGN_ID:-}" ] && [ "$SIGN_ID" != "-" ]; then
  CLI_SIGN_ID="$SIGN_ID"
else
  CLI_SIGN_ID=""
fi

printf '\n[1/6] 构建前端与 .app\n'
(cd "$ROOT" && npm run tauri -- build --target "$TARGET" --bundles app)

APP_PATH="$ROOT/src-tauri/target/$TARGET/release/bundle/macos/$PRODUCT.app"
[ -d "$APP_PATH" ] || die "找不到构建产物：$APP_PATH"

BINARY="$APP_PATH/Contents/MacOS/$PRODUCT"
[ -f "$BINARY" ] || die "找不到可执行文件：$BINARY"
if [ "$TARGET" = "universal-apple-darwin" ]; then
  ARCHS="$(lipo -archs "$BINARY")"
  printf '  lipo -archs: %s\n' "$ARCHS"
  case "$ARCHS" in
    *arm64*x86_64*|*x86_64*arm64*) ;;
    *) die "不是 universal 二进制：$ARCHS" ;;
  esac
fi

printf '\n[构建] 特权 helper\n'
if [ "$TARGET" = "universal-apple-darwin" ]; then
  for arch in aarch64-apple-darwin x86_64-apple-darwin; do
    (cd "$ROOT/src-tauri" && cargo build --release --target "$arch" --bin veyl-cli-helper) \
      || die "构建 $arch helper 失败"
  done
  mkdir -p "$ROOT/src-tauri/target/universal-apple-darwin/release"
  lipo -create -output "$ROOT/src-tauri/target/universal-apple-darwin/release/veyl-cli-helper" \
    "$ROOT/src-tauri/target/aarch64-apple-darwin/release/veyl-cli-helper" \
    "$ROOT/src-tauri/target/x86_64-apple-darwin/release/veyl-cli-helper" \
    || die "lipo helper 失败"
  HELPER_BIN="$ROOT/src-tauri/target/universal-apple-darwin/release/veyl-cli-helper"
else
  (cd "$ROOT/src-tauri" && cargo build --release --target "$TARGET" --bin veyl-cli-helper) \
    || die "构建 helper 失败"
  HELPER_BIN="$ROOT/src-tauri/target/$TARGET/release/veyl-cli-helper"
fi
assemble_tun_bundle "$APP_PATH" "$HELPER_BIN" || die "组装 .app 失败"

printf '\n[2/6] 签名 App\n'
case "${SIGN_ID:-}" in
  "Developer ID Application: "*) VEYL_SIGN_TIMESTAMP=1 ;;
  *) VEYL_SIGN_TIMESTAMP=0 ;;
esac
sign_cli_app "$APP_PATH" || die "签名失败"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  printf '\n[3/6] 公证 App 并 staple\n'
  # notarytool 只接受 zip / dmg / pkg，不接受 .app 目录。
  APP_ZIP="$BUILD_DIR/$PRODUCT-$VERSION.zip"
  rm -f "$APP_ZIP"
  ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"
  xcrun notarytool submit "$APP_ZIP" --keychain-profile "$VEYL_CLI_NOTARY_PROFILE" --wait
  rm -f "$APP_ZIP"
  xcrun stapler staple "$APP_PATH"
else
  printf '\n[3/6] 跳过公证\n'
fi

printf '\n[4/6] 制作 DMG\n'
STAGE="$BUILD_DIR/dmg-stage"
DMG="$PACKAGES_DIR/$PRODUCT-$VERSION.dmg"
cleanup_stage() {
  rm -rf "$STAGE" 2>/dev/null || true
}
trap cleanup_stage EXIT
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$APP_PATH" "$STAGE/$PRODUCT.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$PRODUCT $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
cleanup_stage
trap - EXIT
printf '  %s\n' "$DMG"

printf '\n[5/6] 签名 DMG\n'
if [ "$SIGN_ID" = "-" ]; then
  codesign --force --sign - "$DMG"
else
  codesign --force --sign "$SIGN_ID" "$DMG"
fi

# 没有证书时只能显式 --skip-notarize；这里不再静默降级，避免把 ad-hoc 包当可分发包。
if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  printf '\n[6/6] 公证 DMG 并 staple\n'
  xcrun notarytool submit "$DMG" --keychain-profile "$VEYL_CLI_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG" || true
else
  printf '\n[6/6] 跳过 DMG 公证\n'
fi

printf '\n完成\n'
printf '  产物：%s\n' "$DMG"
printf '  大小：%s\n' "$(du -h "$DMG" | cut -f1)"
printf '  摘要：%s\n' "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
