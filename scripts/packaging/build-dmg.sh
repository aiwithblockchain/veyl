#!/usr/bin/env bash
#
# 用法：
#   bash scripts/packaging/build-dmg.sh                 完整流程（签名 + 公证）
#   bash scripts/packaging/build-dmg.sh --skip-notarize 本地快速出包（ad-hoc 或自签，不公证）
#
# 前置：
#   macOS、node/npm、cargo、Xcode Command Line Tools
#   rustup target add x86_64-apple-darwin（universal 构建需要）
#   签名证书与公证 profile 已内置默认值（见 lib/sign-macos.sh），开箱即用；
#   需要换证书/换 profile 时用同名环境变量覆盖。本机没有证书时只能 --skip-notarize。
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

for tool in node npm cargo lipo codesign hdiutil ditto xcrun python3 shasum; do
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
  if [ "$(signing_identity)" = "-" ]; then
    printf '\n' >&2
    die "本机钥匙串里没有 Developer ID 证书，无法公证。本地验证可以加 --skip-notarize"
  fi
  if ! has_notary_credentials; then
    printf '\n' >&2
    die "缺少 VEYL_NOTARY_PROFILE（xcrun notarytool store-credentials 保存的 profile 名）"
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

# 正式包必须带安全时间戳（嵌套的运行时也一起算）。开发脚本会设
# VEYL_SIGN_TIMESTAMP=0，那是给开发证书用的；这个变量留在环境里会让正式包
# 静默失去时间戳，所以这里强制改回来——必须在签名运行时之前生效。
if [ -n "${VEYL_DEV_ID_APP:-}" ]; then
  if [ "${VEYL_SIGN_TIMESTAMP:-1}" = "0" ]; then
    printf '警告：忽略残留的 VEYL_SIGN_TIMESTAMP=0，正式包强制带安全时间戳\n' >&2
  fi
  export VEYL_SIGN_TIMESTAMP=1
fi

# 两样东西必须已经在仓库里，否则打出来的包 TUN 用不了。在这里失败，
# 而不是让用户装完才发现——也省得白等一轮构建。
RUNTIME_SRC="$ROOT/src-tauri/resources/runtime/sing-box"
[ -f "$RUNTIME_SRC" ] || die "缺少运行时：$RUNTIME_SRC
  先执行：node scripts/runtime/fetch-runtime.mjs
  TUN 的特权 helper 只执行随包那一份（用户目录里的二进制以 root 执行是提权漏洞）。"

# **签名必须先于构建**：build.rs 把运行时**签名后**的 sha256 编进主程序和 helper，
# 安装时按这个值校验随包副本。组装完再签会改字节，哈希必然对不上，
# 全新安装就会一直回退到 GitHub 下载。
prepare_bundled_runtime "$RUNTIME_SRC" || die "签名随包运行时失败：$RUNTIME_SRC"

# fetch-rules.mjs 的产物是归档，manifest.json 在归档**里面**——不要在这里找它。
RULES_ARCHIVE="$(ls "$ROOT"/src-tauri/resources/rules/veyl-rules-*.tar.zst 2>/dev/null | head -1)"
[ -n "$RULES_ARCHIVE" ] || die "缺少规则归档：src-tauri/resources/rules/veyl-rules-*.tar.zst
  先执行：npm run rules:fetch
  特权 helper 会自己解开这个归档、校验后放到自己拥有的目录；
  缺了它，带分流的 TUN 起不来。"

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
    # 自测二进制需要可选 feature（`runtime-selftest`），发布包不构建、不携带。
    if [ "$extra_bin" = "veyl-runtime-selftest" ]; then
      continue
    fi
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
  # veyl-helper 是 TUN 的特权助手，必须留在包里；其余 [[bin]] 是本机开发工具。
  if [ "$extra_bin" = "veyl-helper" ]; then
    continue
  fi
  rm -f "$APP_PATH/Contents/MacOS/$extra_bin"
done

# Tauri 不会把 [[bin]] 放进包（没有 externalBin 配置），这里显式安装 helper。
# 它要和主程序同一个签名身份，否则 SMAppService 注册会失败。
HELPER_SRC="$ROOT/src-tauri/target/universal-apple-darwin/release/veyl-helper"
if [ -f "$HELPER_SRC" ]; then
  mkdir -p "$APP_PATH/Contents/MacOS"
  cp "$HELPER_SRC" "$APP_PATH/Contents/MacOS/veyl-helper"
  chmod 755 "$APP_PATH/Contents/MacOS/veyl-helper"
  printf '  已安装特权助手：Contents/MacOS/veyl-helper\n'
else
  die "缺少 universal 的 veyl-helper，无法打包 TUN 特权助手"
fi

# SMAppService 只认 Contents/Library/LaunchDaemons/ 下的 plist。
LAUNCHD_SRC="$ROOT/src-tauri/resources/launchd/com.veyl.helper.plist"
[ -f "$LAUNCHD_SRC" ] || die "缺少 $LAUNCHD_SRC"
mkdir -p "$APP_PATH/Contents/Library/LaunchDaemons"
cp "$LAUNCHD_SRC" "$APP_PATH/Contents/Library/LaunchDaemons/com.veyl.helper.plist"
printf '  已安装 LaunchDaemon plist：com.veyl.helper.plist\n'

# 运行时必须随包：helper 只从自己签名过的 bundle 里取 sing-box 再以 root 执行。
# 放用户目录、从网上下载的二进制以 root 执行，是提权漏洞。
RUNTIME_SRC="$ROOT/src-tauri/resources/runtime/sing-box"
if [ -f "$RUNTIME_SRC" ]; then
  mkdir -p "$APP_PATH/Contents/Resources/runtime"
  cp "$RUNTIME_SRC" "$APP_PATH/Contents/Resources/runtime/sing-box"
  chmod 755 "$APP_PATH/Contents/Resources/runtime/sing-box"
  # 包里那份必须与构建时被哈希的源文件逐字节相同，否则哈希断言一定失败。
  cmp -s "$RUNTIME_SRC" "$APP_PATH/Contents/Resources/runtime/sing-box" \
    || die "包内运行时与签名后的源文件不一致：$RUNTIME_SRC"
  printf '  已安装运行时：Contents/Resources/runtime/sing-box\n'
else
  die "缺少运行时：$RUNTIME_SRC
  TUN 的特权 helper 只执行随包那一份（用户目录里的二进制以 root 执行是提权漏洞），
  所以没有它就打不出可用的包。把对应版本的 sing-box 放到这个位置再重试。
  哈希由 src-tauri/build.rs 编译进 helper，换了二进制必须重新构建。"
fi

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

printf '\n[3.5/9] 校验包内资源落点\n'
# helper 运行时只从这两个路径取资源。它们是 Tauri 对 resources 映射的**推断结果**，
# 猜错的话带分流的 TUN 会全部 rule_set_missing。所以在签名之前就断言，
# 让路径猜测失败暴露在构建阶段，而不是等用户装上、连不上。
RUNTIME_IN_APP="$APP_PATH/Contents/Resources/runtime/sing-box"
[ -f "$RUNTIME_IN_APP" ] || die "包内缺少运行时：$RUNTIME_IN_APP"

RULES_IN_APP_DIR="$APP_PATH/Contents/Resources/resources/rules"
[ -d "$RULES_IN_APP_DIR" ] || die "包内缺少规则目录：$RULES_IN_APP_DIR"

RULES_IN_APP_COUNT="$(find "$RULES_IN_APP_DIR" -maxdepth 1 -name 'veyl-rules-*.tar.zst' | wc -l | tr -d ' ')"
[ "$RULES_IN_APP_COUNT" = "1" ] || die "包内规则归档应当恰好一个，实际 $RULES_IN_APP_COUNT 个：$RULES_IN_APP_DIR"

RULES_IN_APP="$(find "$RULES_IN_APP_DIR" -maxdepth 1 -name 'veyl-rules-*.tar.zst' -print -quit)"
SRC_SHA="$(shasum -a 256 "$RULES_ARCHIVE" | awk '{print $1}')"
APP_SHA="$(shasum -a 256 "$RULES_IN_APP" | awk '{print $1}')"
[ "$SRC_SHA" = "$APP_SHA" ] || die "包内规则归档与源归档哈希不一致
  源   $SRC_SHA
  包内 $APP_SHA"
printf '  运行时与规则归档落点正确\n'

printf '\n[4/9] 签名嵌套 Mach-O 与 App\n'
# `sign_app` 内部已断言：包内运行时签名有效、identifier 是 `sing-box`、
# 签名身份与当前证书一致。macOS 的运行时判定用的是验签，不是编译期哈希。
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
