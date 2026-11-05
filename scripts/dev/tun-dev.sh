#!/usr/bin/env bash
#
# 用法：
#   bash scripts/dev/tun-dev.sh             构建 → 签名 → 装 /Applications → 启动
#   bash scripts/dev/tun-dev.sh --no-open   只构建与安装，不启动
#   bash scripts/dev/tun-dev.sh --help
#
# 为什么需要它：TUN 在开发态用 `tauri dev` **测不了**。
# SMAppService 只认已签名 .app 里 `Contents/Library/LaunchDaemons/` 下的 plist，
# 裸二进制（`src-tauri/target/debug/veyl`）上永远 `not_found`。
# 所以这里走和发布包同一条「签名 + 装进 /Applications + 由 App 注册 daemon」的路径，
# 只是构建配置换成 debug、不公证。
#
# **不改变架构，也不开调试特权通道**：没有管理员弹窗直拉进程，没有跳过验签的开关。
#
# 环境变量：
#   VEYL_DEV_ID_APP   指定签名身份（留空则自动挑：先 Apple Development，再 Developer ID，
#                     都要求 Team 与 VEYL_TEAM_ID 一致）
#   VEYL_TEAM_ID      期望的 Team ID，默认 2XYK8RBB6M（与 build.rs 的默认值一致）
#
# 前置：macOS、node/npm、cargo、Xcode Command Line Tools、
#       src-tauri/resources/runtime/sing-box、src-tauri/resources/rules/veyl-rules-*.tar.zst

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${VEYL_INSTALL_DIR:-/Applications}"
TEAM="${VEYL_TEAM_ID:-2XYK8RBB6M}"
OPEN_APP=1

for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_APP=0 ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf '错误：未知参数 %s\n' "$arg" >&2; exit 2 ;;
  esac
done

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "tun-dev.sh 只能在 macOS 上运行"

for tool in node npm cargo codesign ditto python3 security; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少命令：$tool"
done

PRODUCT="$(python3 - "$ROOT/src-tauri/tauri.conf.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["productName"])
PY
)"
[ -n "$PRODUCT" ] || die "读取 productName 失败"

APP_SRC="$ROOT/src-tauri/target/debug/bundle/macos/$PRODUCT.app"
APP_DEST="$INSTALL_DIR/$PRODUCT.app"

printf '== Veyl TUN 开发包 ==\n'
printf '仓库：%s\n' "$ROOT"
printf '安装：%s\n' "$APP_DEST"
printf 'Team：%s\n\n' "$TEAM"

# ---- 0. 资源前置检查：缺了就在构建前失败，别让用户装上才发现 TUN 起不来 ----
RUNTIME_SRC="$ROOT/src-tauri/resources/runtime/sing-box"
[ -f "$RUNTIME_SRC" ] || die "缺少运行时：$RUNTIME_SRC
  先执行：node scripts/runtime/fetch-runtime.mjs"
RULES_ARCHIVE="$(ls "$ROOT"/src-tauri/resources/rules/veyl-rules-*.tar.zst 2>/dev/null | head -1)"
[ -n "$RULES_ARCHIVE" ] || die "缺少规则归档：src-tauri/resources/rules/veyl-rules-*.tar.zst
  先执行：npm run rules:fetch"

# ---- 1. 挑签名身份 ----
# 对端验签要求里写死了 Team ID（build.rs 编进 helper），所以证书的 Team 必须一致，
# 否则 App 装得上、连不上，而且编译期完全无感。
team_of() {
  printf '%s' "$1" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p'
}

identities() {
  security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p'
}

pick_identity() {
  if [ -n "${VEYL_DEV_ID_APP:-}" ]; then
    printf '%s\n' "$VEYL_DEV_ID_APP"
    return 0
  fi
  local name
  # Developer ID 优先：Apple Development 不一定被 SMAppService 接受（daemon 要求
  # 正式签名身份）。两个都只认 Team 对得上的。
  for prefix in "Developer ID Application:" "Apple Development:"; do
    while IFS= read -r name; do
      case "$name" in
        "$prefix"*)
          if [ "$(team_of "$name")" = "$TEAM" ]; then
            printf '%s\n' "$name"
            return 0
          fi
          ;;
      esac
    done <<EOF
$(identities)
EOF
  done
  return 1
}

IDENTITY="$(pick_identity || true)"
if [ -z "$IDENTITY" ]; then
  printf '可用的签名身份：\n' >&2
  identities | sed 's/^/  - /' >&2
  die "没有 Team 为 $TEAM 的可用签名证书。
  · 想用别的证书：设 VEYL_DEV_ID_APP=<完整证书名>，并同时把 VEYL_TEAM_ID 设成该证书的 Team
  · 例：VEYL_DEV_ID_APP=\"Developer ID Application: Yushian (Beijing) Technology Co., Ltd. (2XYK8RBB6M)\""
fi

IDENTITY_TEAM="$(team_of "$IDENTITY")"
[ "$IDENTITY_TEAM" = "$TEAM" ] || die "签名身份的 Team（${IDENTITY_TEAM:-未知}）与 VEYL_TEAM_ID（$TEAM）不一致。
  helper 的对端验签会拒绝这个 App，连不上。把 VEYL_TEAM_ID 改成 $IDENTITY_TEAM 后重试。"

case "$IDENTITY" in
  "Apple Development:"*) IDENTITY_KIND="development" ;;
  "Developer ID Application:"*) IDENTITY_KIND="developer-id" ;;
  *) IDENTITY_KIND="unknown" ;;
esac
printf '签名身份：%s（%s）\n\n' "$IDENTITY" "$IDENTITY_KIND"
if [ "$IDENTITY_KIND" != "developer-id" ]; then
  printf '若注册失败，用 VEYL_DEV_ID_APP 指定 Developer ID Application 证书重试\n\n'
fi

# ---- 2. 构建 ----
printf '[1/5] 构建 debug .app\n'
export VEYL_TEAM_ID="$TEAM"
(cd "$ROOT" && npm run tauri -- build --debug --bundles app)

[ -d "$APP_SRC" ] || die "找不到构建产物：$APP_SRC"

printf '\n[2/5] 构建特权助手（debug）\n'
(cd "$ROOT/src-tauri" && cargo build --bin veyl-helper)
HELPER_SRC="$ROOT/src-tauri/target/debug/veyl-helper"
[ -f "$HELPER_SRC" ] || die "找不到 helper：$HELPER_SRC"

# ---- 3. 组装包：helper / LaunchDaemon plist / 运行时 ----
# Tauri 不会把 [[bin]] 放进包，也不会带 resources/runtime（它只声明了 rules）。
printf '\n[3/5] 安装包内组件\n'
mkdir -p "$APP_SRC/Contents/MacOS"
cp "$HELPER_SRC" "$APP_SRC/Contents/MacOS/veyl-helper"
chmod 755 "$APP_SRC/Contents/MacOS/veyl-helper"

LAUNCHD_SRC="$ROOT/src-tauri/resources/launchd/com.veyl.helper.plist"
[ -f "$LAUNCHD_SRC" ] || die "缺少 $LAUNCHD_SRC"
mkdir -p "$APP_SRC/Contents/Library/LaunchDaemons"
cp "$LAUNCHD_SRC" "$APP_SRC/Contents/Library/LaunchDaemons/com.veyl.helper.plist"

mkdir -p "$APP_SRC/Contents/Resources/runtime"
cp "$RUNTIME_SRC" "$APP_SRC/Contents/Resources/runtime/sing-box"
chmod 755 "$APP_SRC/Contents/Resources/runtime/sing-box"

RULES_IN_APP="$(ls "$APP_SRC"/Contents/Resources/resources/rules/veyl-rules-*.tar.zst 2>/dev/null | head -1)"
[ -n "$RULES_IN_APP" ] || die "包内没有规则归档：$APP_SRC/Contents/Resources/resources/rules/
  Tauri 的 resources 映射与预期不符，TUN 的分流会起不来。检查 tauri.conf.json 的 bundle.resources。"

printf '  helper / plist / 运行时 / 规则归档 就位\n'

# ---- 4. 签名：与发布包同一套嵌套签名逻辑，只是不公证 ----
printf '\n[4/5] 签名\n'
# 开发证书不保证被 timestamp 服务接受；Developer ID 必须带时间戳。
if [ "$IDENTITY_KIND" = "development" ]; then
  export VEYL_SIGN_TIMESTAMP=0
else
  export VEYL_SIGN_TIMESTAMP=1
fi
export VEYL_DEV_ID_APP="$IDENTITY"
# shellcheck source=../packaging/lib/sign-macos.sh
source "$ROOT/scripts/packaging/lib/sign-macos.sh"
sign_app "$APP_SRC"
codesign --verify --deep --strict --verbose=2 "$APP_SRC" >/dev/null
printf '  签名校验通过\n'

# ---- 5. 安装 ----
printf '\n[5/5] 安装到 %s\n' "$INSTALL_DIR"
if pgrep -f "$PRODUCT.app/Contents/MacOS/$PRODUCT" >/dev/null 2>&1; then
  die "$PRODUCT 正在运行。先退出（菜单里「退出 Veyl」），再执行本脚本：
  替换正在运行的包会得到半新半旧的应用。"
fi

# 只允许删这一个路径，避免 productName 读错时误删别处。
case "$APP_DEST" in
  "$INSTALL_DIR/$PRODUCT.app") ;;
  *) die "拒绝删除意外的路径：$APP_DEST" ;;
esac

if [ -e "$APP_DEST" ] && [ ! -w "$(dirname "$APP_DEST")" ]; then
  die "没有权限替换 $APP_DEST。用管理员账号运行。"
fi

# 先装到同目录的临时路径并验签，成功后再换上去：
# 直接 `rm -rf` 旧包再 ditto，一旦 ditto 失败，daemon 的 BundleProgram
# 就指着一个不存在的路径了。
STAGING="$INSTALL_DIR/.$PRODUCT.app.staging.$$"
BACKUP="$INSTALL_DIR/.$PRODUCT.app.previous.$$"
cleanup_staging() {
  rm -rf "$STAGING" 2>/dev/null || true
  # 信号可能正好打断在「旧包已挪走、新包还没就位」之间：把旧包移回来，
  # 否则 daemon 的 BundleProgram 会指向一个不存在的路径。
  if [ -e "$BACKUP" ] && [ ! -e "$APP_DEST" ]; then
    mv "$BACKUP" "$APP_DEST" 2>/dev/null || true
  fi
}
trap cleanup_staging EXIT

rm -rf "$STAGING" 2>/dev/null || true
ditto "$APP_SRC" "$STAGING" 2>/dev/null || die "没有权限写入 $INSTALL_DIR。用管理员账号运行。"
codesign --verify --deep --strict "$STAGING" >/dev/null 2>&1 \
  || die "临时副本验签失败，旧包保持原样：$APP_DEST"

if [ -e "$APP_DEST" ]; then
  mv "$APP_DEST" "$BACKUP" 2>/dev/null || die "没有权限替换 $APP_DEST。用管理员账号运行。"
fi
if ! mv "$STAGING" "$APP_DEST" 2>/dev/null; then
  if [ -e "$BACKUP" ]; then
    mv "$BACKUP" "$APP_DEST" 2>/dev/null || true
  fi
  die "替换 $APP_DEST 失败，已尝试恢复旧包"
fi
rm -rf "$BACKUP" 2>/dev/null || true
trap - EXIT
touch "$APP_DEST"
printf '  已安装：%s\n' "$APP_DEST"

if [ "$OPEN_APP" -eq 1 ]; then
  open "$APP_DEST"
fi

cat <<EOF

完成。下一步：
  1. 新建或选择一套 TUN 配置，点「连接」。
  2. 首次会**失败一次**并打开「系统设置 › 登录项与扩展」——这是预期行为。
  3. 打开 Veyl 的后台助手开关，回到 App 再点一次「连接」。
  4. 失败时看这两处：
       $APP_DEST/Contents/MacOS/veyl-helper 的 stderr（统一日志：log show --predicate 'process == "veyl-helper"' --last 5m）
       /Library/Application Support/Veyl/tun/sing-box.log

注意：换过签名证书后，旧的 daemon 注册可能还在，导致注册失败。那时先卸载助手（M4 的入口），
或手工：sudo launchctl bootout system/com.veyl.helper
EOF
