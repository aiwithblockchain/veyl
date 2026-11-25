#!/usr/bin/env bash
#
# 用法：
#   bash client/pc/scripts/dev.sh                 构建 debug .app → 安装 → 前台启动
#   bash client/pc/scripts/dev.sh --detach        装完即返回（App 在后台跑）
#   bash client/pc/scripts/dev.sh --no-open       只构建与安装，不启动
#   bash client/pc/scripts/dev.sh --kill-existing 安装前先结束正在运行的实例
#   bash client/pc/scripts/dev.sh --help
#
# 形态与主客户端的 scripts/dev/tun-dev.sh 一致，但当前是骨架：
# 不构建 helper、不装 LaunchDaemon、不投放运行时与规则。
# 接入隧道层（M0 之后）时，在下面标了 `TODO(TUN)` 的位置补回那几步。
#
# 环境变量：
#   VEYL_CLI_INSTALL_DIR    安装目录，默认 /Applications
#   VEYL_CLI_SIGN_IDENTITY  签名证书名；不设则 ad-hoc 签名（仅本机可运行）
#   VEYL_CLI_RUST_LOG       应用日志级别（骨架暂未接日志，保留给后续）
#
# 前置：macOS、node/npm、cargo、Xcode Command Line Tools；
#       先在本目录执行过 `npm install`。
#
# 日志：client/pc/build/logs/dev-<时间戳>.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${VEYL_CLI_INSTALL_DIR:-/Applications}"
NO_OPEN=0
DETACH=0
KILL_EXISTING=0

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR == 1 { next }
       /^#/ { sub(/^# ?/, ""); if ($0 == "" && !seen) next; seen = 1; print; next }
       { exit }' "${BASH_SOURCE[0]}"
}

for arg in "$@"; do
  case "$arg" in
    --no-open) NO_OPEN=1 ;;
    --detach) DETACH=1 ;;
    --kill-existing) KILL_EXISTING=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '错误：未知参数 %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [ "$NO_OPEN" -eq 1 ] && [ "$DETACH" -eq 1 ]; then
  die "--no-open 与 --detach 不能同时使用"
fi

[ "$(uname -s)" = "Darwin" ] || die "dev.sh 只能在 macOS 上运行；Windows 用 scripts/dev.ps1"

for tool in node npm cargo python3 codesign ditto plutil pgrep; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少命令：$tool"
done

[ -d "$ROOT/node_modules" ] || die "缺少 node_modules。先执行：cd \"$ROOT\" && npm install"

PRODUCT="$(python3 - "$ROOT/src-tauri/tauri.conf.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["productName"])
PY
)"
[ -n "$PRODUCT" ] || die "读取 productName 失败"

APP_SRC="$ROOT/src-tauri/target/debug/bundle/macos/$PRODUCT.app"
APP_DEST="$INSTALL_DIR/$PRODUCT.app"

resolve_executable() {
  local plist name
  for plist in "$APP_DEST/Contents/Info.plist" "$APP_SRC/Contents/Info.plist"; do
    [ -f "$plist" ] || continue
    name="$(plutil -extract CFBundleExecutable raw "$plist" 2>/dev/null || true)"
    if [ -n "$name" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

app_pids() {
  [ -n "${EXECUTABLE:-}" ] || return 0
  {
    pgrep -f "$APP_DEST/Contents/MacOS/$EXECUTABLE" 2>/dev/null || true
    pgrep -f "$APP_SRC/Contents/MacOS/$EXECUTABLE" 2>/dev/null || true
  } | sort -u
}

terminate_app() {
  local pids i
  pids="$(app_pids)"
  [ -n "$pids" ] || return 0
  kill -TERM $pids 2>/dev/null || true
  i=0
  while [ "$i" -lt 10 ]; do
    pids="$(app_pids)"
    [ -n "$pids" ] || return 0
    sleep 0.5
    i=$((i + 1))
  done
  pids="$(app_pids)"
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    [ -z "$(app_pids)" ] && return 0
    sleep 0.05
    i=$((i + 1))
  done
  return 0
}

printf '== veyl-cli 开发包 ==\n'
printf '目录：%s\n' "$ROOT"
printf '安装：%s\n\n' "$APP_DEST"

printf '[1/4] 构建 debug .app\n'
(cd "$ROOT" && npm run tauri -- build --debug --bundles app)
[ -d "$APP_SRC" ] || die "找不到构建产物：$APP_SRC"

printf '\n[2/4] 签名\n'
SIGN_ID="${VEYL_CLI_SIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  printf '  未设置 VEYL_CLI_SIGN_IDENTITY，使用 ad-hoc 签名（仅本机可用）\n'
  codesign --force --deep --sign - "$APP_SRC"
else
  printf '  使用证书：%s\n' "$SIGN_ID"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_ID" "$APP_SRC"
fi
codesign --verify --deep --strict "$APP_SRC" >/dev/null
printf '  签名校验通过\n'

# TODO(TUN)：接入隧道层后，在这里构建并拷入 helper / service、安装 LaunchDaemon
# plist、拷贝 sing-box 运行时——照 scripts/dev/tun-dev.sh 的 [2/5] 与 [3/5]。

printf '\n[3/4] 安装到 %s\n' "$INSTALL_DIR"
EXECUTABLE="$(resolve_executable)" || die "读不到 CFBundleExecutable，无法识别 veyl-cli 进程"

RUNNING_PIDS="$(app_pids)"
if [ -n "$RUNNING_PIDS" ]; then
  if [ "$KILL_EXISTING" -eq 1 ]; then
    printf '  结束正在运行的实例：%s\n' "$(printf '%s' "$RUNNING_PIDS" | tr '\n' ' ')"
    terminate_app
    [ -z "$(app_pids)" ] || die "结束旧实例失败，先手动退出再重试"
  else
    die "$PRODUCT 正在运行（PID：$(printf '%s' "$RUNNING_PIDS" | tr '\n' ' ')）。
  先退出 App，或加 --kill-existing。"
  fi
fi

case "$APP_DEST" in
  "$INSTALL_DIR/$PRODUCT.app") ;;
  *) die "拒绝删除意外的路径：$APP_DEST" ;;
esac

[ -w "$INSTALL_DIR" ] || die "没有权限写入 $INSTALL_DIR。用有权限的账号运行，或设置 VEYL_CLI_INSTALL_DIR"

STAGING="$INSTALL_DIR/.$PRODUCT.app.staging.$$"
BACKUP="$INSTALL_DIR/.$PRODUCT.app.previous.$$"
cleanup_staging() {
  rm -rf "$STAGING" 2>/dev/null || true
  if [ -e "$BACKUP" ] && [ ! -e "$APP_DEST" ]; then
    mv "$BACKUP" "$APP_DEST" 2>/dev/null || true
  fi
}
trap cleanup_staging EXIT

rm -rf "$STAGING" 2>/dev/null || true
ditto "$APP_SRC" "$STAGING"
codesign --verify --deep --strict "$STAGING" >/dev/null 2>&1 \
  || die "临时副本验签失败，旧包保持原样"

if [ -e "$APP_DEST" ]; then
  mv "$APP_DEST" "$BACKUP"
fi
if ! mv "$STAGING" "$APP_DEST"; then
  [ -e "$BACKUP" ] && mv "$BACKUP" "$APP_DEST" 2>/dev/null || true
  die "替换 $APP_DEST 失败"
fi
rm -rf "$BACKUP" 2>/dev/null || true
trap - EXIT
printf '  已安装：%s\n' "$APP_DEST"

# 构建产物被 LaunchServices 注册后，启动台会出现第二个 veyl-cli。
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP_SRC" 2>/dev/null || true

printf '\n[4/4] 启动\n'
BIN="$APP_DEST/Contents/MacOS/$EXECUTABLE"
[ -x "$BIN" ] || die "找不到可执行文件：$BIN"

LOG_DIR="$ROOT/build/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/dev-$(date +%Y%m%d-%H%M%S).log"

APP_PID=""
cleanup_app() {
  [ -n "${APP_PID:-}" ] || return 0
  kill -0 "$APP_PID" 2>/dev/null || return 0
  kill -TERM "$APP_PID" 2>/dev/null || true
  sleep 0.5
  kill -KILL "$APP_PID" 2>/dev/null || true
}

if [ "$NO_OPEN" -eq 1 ]; then
  printf '  已跳过启动（--no-open）\n'
elif [ "$DETACH" -eq 1 ]; then
  nohup "$BIN" >> "$LOG_FILE" 2>&1 &
  printf '  已在后台启动（PID %s）\n日志：%s\n' "$!" "$LOG_FILE"
else
  printf '  前台启动，Ctrl-C 结束\n日志：%s\n\n' "$LOG_FILE"
  trap cleanup_app EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$BIN" > >(tee -a "$LOG_FILE") 2>&1 &
  APP_PID=$!
  status=0
  wait "$APP_PID" || status=$?
  APP_PID=""
  printf '\nApp 退出码：%s\n' "$status"
  exit "$status"
fi
