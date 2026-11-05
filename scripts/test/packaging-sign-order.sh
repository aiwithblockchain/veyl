#!/usr/bin/env bash
# packaging-sign-order.sh — 随包运行时的哈希必须来自**签名后**的字节。
#
# 背景：codesign 会改写 Mach-O（插入 CodeDirectory 与时间戳）。如果打包流程
# 先构建、让 build.rs 算哈希，再在组装阶段签名，安装时校验必然失败，
# 全新安装就会静默回退到 GitHub 下载。
#
# 断言三件事：
#   1. 签名确实会改变文件字节 —— 否则这个测试证明不了任何事；
#   2. prepare_bundled_runtime 之后，源文件就是「签名后的字节」；
#   3. sign_app（含嵌套签名与封 bundle）之后，包内运行时与源文件逐字节相同，
#      即 build.rs 哈希的那份 == 安装时校验的那份。
#
# 用 ad-hoc 签名跑，不需要证书。非 macOS 直接跳过（退出 0）。
#
# 用法：bash scripts/test/packaging-sign-order.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "跳过：packaging-sign-order 只在 macOS 上验证签名行为"
  exit 0
fi

for tool in codesign file ditto; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "缺少命令：$tool" >&2
    exit 2
  }
done

fail() {
  printf '失败：%s\n' "$*" >&2
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/veyl-sign-order.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ad-hoc 签名：不需要证书，行为与 Developer ID 相同（都会改写字节）。
export VEYL_DEV_ID_APP=""
unset VEYL_SIGN_TIMESTAMP || true
# shellcheck source=../packaging/lib/sign-macos.sh
source "$ROOT/scripts/packaging/lib/sign-macos.sh"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# ---- 1. 源文件：签名会改字节 ----
RUNTIME_SRC="$WORK/resources/runtime/sing-box"
mkdir -p "$(dirname "$RUNTIME_SRC")"
cp /bin/echo "$RUNTIME_SRC"

BEFORE="$(sha "$RUNTIME_SRC")"
prepare_bundled_runtime "$RUNTIME_SRC" >/dev/null || fail "prepare_bundled_runtime 失败"
AFTER="$(sha "$RUNTIME_SRC")"
[ "$BEFORE" != "$AFTER" ] || fail "签名没有改变字节——测试前提不成立，检查 codesign 是否真的执行了"

# ---- 2. 组装并签名一个最小 .app ----
APP="$WORK/Test.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime"
cp /bin/echo "$APP/Contents/MacOS/Test"
cp "$RUNTIME_SRC" "$APP/Contents/Resources/runtime/sing-box"
cat >"$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.veyl.sign-order-test</string>
<key>CFBundleExecutable</key><string>Test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST

sign_app "$APP" >/dev/null || fail "sign_app 失败"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || fail "签名后验签失败"

# ---- 3. 包内副本必须与 build.rs 哈希过的那份完全一致 ----
BUNDLED="$(sha "$APP/Contents/Resources/runtime/sing-box")"
[ "$AFTER" = "$BUNDLED" ] || fail "签名流程改写了包内运行时
  构建时哈希 $AFTER
  包内副本   $BUNDLED
  组装阶段不能再给运行时签名（见 sign_nested_files / sign_app）。"

echo "通过：签名后的运行时字节在组装与封 bundle 后保持不变（$AFTER）"
