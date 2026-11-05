#!/usr/bin/env bash
#
# 用法：
#   bash scripts/dev/tun-dev.sh                 构建 → 签名 → 装 /Applications → 前台启动
#   bash scripts/dev/tun-dev.sh --detach        装完即返回（App 在后台跑）
#   bash scripts/dev/tun-dev.sh --no-open       只构建与安装，不启动
#   bash scripts/dev/tun-dev.sh --kill-existing 安装前先结束正在运行的实例
#   bash scripts/dev/tun-dev.sh --help
#
# 为什么需要它：TUN 在开发态用 `tauri dev` **测不了**。
# SMAppService 只认已签名 .app 里 `Contents/Library/LaunchDaemons/` 下的 plist，
# 裸二进制（`src-tauri/target/debug/veyl`）上永远 `not_found`。
# 所以这里走和发布包同一条「签名 + 装进 /Applications + 由 App 注册 daemon」的路径，
# 只是构建配置换成 debug、不公证。
#
# 默认在前台运行 App：Ctrl-C 或脚本退出时先 TERM、最多等 5 秒、再 KILL，
# 重复执行不会和上一个实例打架。日志落在 build/logs/tun-dev-<时间戳>.log。
#
# **不改变架构，也不开调试特权通道**：没有管理员弹窗直拉进程，没有跳过验签的开关。
# App 退出不会停 TUN（产品设计）：**若 TUN 仍在运行，请在 App 内断开**，
# 本脚本不会去 kill helper 或 bootout daemon。
#
# 环境变量：
#   VEYL_DEV_ID_APP   指定签名身份（留空则自动挑：先 Developer ID，再 Apple Development，
#                     都要求 Team 与 VEYL_TEAM_ID 一致）
#   VEYL_TEAM_ID      期望的 Team ID，默认 2XYK8RBB6M（与 build.rs 的默认值一致）
#
# 前置：macOS、node/npm、cargo、Xcode Command Line Tools、
#       src-tauri/resources/runtime/sing-box、src-tauri/resources/rules/veyl-rules-*.tar.zst

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${VEYL_INSTALL_DIR:-/Applications}"
TEAM="${VEYL_TEAM_ID:-2XYK8RBB6M}"
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
if [ "$NO_OPEN" -eq 1 ]; then
  LAUNCH_MODE="none"
elif [ "$DETACH" -eq 1 ]; then
  LAUNCH_MODE="detach"
else
  LAUNCH_MODE="foreground"
fi

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

# 可执行文件名必须来自 Info.plist：productName 是 `Veyl`，实际二进制是 `veyl`。
# 拿 productName 去 pgrep 永远匹配不到，`--kill-existing` 会当成「没有实例」。
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

# 在第一次匹配进程前赋值；取不到就 die，绝不退化成 productName。
EXECUTABLE=""

# 只匹配装进 /Applications 的这一份，不碰别的构建产物。
app_pids() {
  pgrep -f "$APP_DEST/Contents/MacOS/$EXECUTABLE" 2>/dev/null || true
}

# 结束该路径下所有实例：先 TERM，最多等 5 秒，再 KILL。
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
  if [ -n "$pids" ]; then
    kill -KILL $pids 2>/dev/null || true
    # KILL 之后进程还要一点时间从进程表消失，别让调用方读到残留。
    i=0
    while [ "$i" -lt 20 ]; do
      if [ -z "$(app_pids)" ]; then
        return 0
      fi
      sleep 0.05
      i=$((i + 1))
    done
  fi
  return 0
}

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

# 替换正在运行的包会得到半新半旧的应用。默认拒绝，--kill-existing 时先结束。
EXECUTABLE="$(resolve_executable)" || die "读不到 CFBundleExecutable：$APP_DEST 与 $APP_SRC 都没有可解析的 Info.plist，无法识别 Veyl 进程"
[ -n "$EXECUTABLE" ] || die "Info.plist 里的 CFBundleExecutable 为空，无法识别 Veyl 进程"

RUNNING_PIDS="$(app_pids)"
if [ -n "$RUNNING_PIDS" ]; then
  if [ "$KILL_EXISTING" -eq 1 ]; then
    printf '发现正在运行的 %s（PID：%s），先结束它\n' \
      "$PRODUCT" "$(printf '%s' "$RUNNING_PIDS" | tr '\n' ' ')"
    terminate_app
    REMAINING="$(app_pids)"
    if [ -n "$REMAINING" ]; then
      die "结束旧实例失败（PID：$(printf '%s' "$REMAINING" | tr '\n' ' ')）。先手动退出再重试。"
    fi
  else
    die "$PRODUCT 正在运行（PID：$(printf '%s' "$RUNNING_PIDS" | tr '\n' ' ')）。
  先退出 App（菜单里「退出 Veyl」），或加 --kill-existing 让脚本结束它。"
  fi
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

print_next_steps() {
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

TUN 是独立进程：关闭 App 不会断开连接。若 TUN 仍在运行，请在 App 内断开——
本脚本不会去 kill helper 或 bootout daemon。
EOF
}

# 前台运行期间的生命周期：脚本退出（含 Ctrl-C）时收掉自己起的这个实例。
APP_PID=""
LOG_FILE=""

cleanup_app() {
  [ -n "${APP_PID:-}" ] || return 0
  kill -0 "$APP_PID" 2>/dev/null || return 0
  kill -TERM "$APP_PID" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 10 ]; do
    kill -0 "$APP_PID" 2>/dev/null || return 0
    sleep 0.5
    i=$((i + 1))
  done
  kill -KILL "$APP_PID" 2>/dev/null || true
  return 0
}

on_exit() {
  cleanup_app
  if [ -n "${LOG_FILE:-}" ]; then
    printf '\n日志：%s\n' "$LOG_FILE"
  fi
}

run_foreground() {
  local bin="$APP_DEST/Contents/MacOS/$EXECUTABLE"
  [ -x "$bin" ] || die "找不到可执行文件：$bin"

  local log_dir="$ROOT/build/logs"
  mkdir -p "$log_dir" || die "无法创建日志目录：$log_dir"
  LOG_FILE="$log_dir/tun-dev-$(date +%Y%m%d-%H%M%S).log"

  printf '\n前台启动：%s\n日志：%s\n按 Ctrl-C 结束。\n\n' "$bin" "$LOG_FILE"

  local started
  started="$(date +%s)"

  # 直接执行包内二进制：Bundle.main 仍解析到 .app，SMAppService 的行为与 open 一致。
  # 万一实测不一致，退回 `open -W` 并按进程组结束。
  "$bin" > >(tee -a "$LOG_FILE") 2>&1 &
  APP_PID=$!

  # wait 被信号打断时返回非零，交给 trap 收尾。
  local status=0
  wait "$APP_PID" || status=$?
  APP_PID=""
  # 给 tee 一点时间把最后几行刷进文件。
  sleep 0.2

  # 2 秒内退出却还有同名进程：单实例插件挡住了新实例，旧进程没死。
  # 这不能静默——用户会以为已经换上新构建。
  if [ $(( $(date +%s) - started )) -le 2 ]; then
    local others
    others="$(app_pids)"
    if [ -n "$others" ]; then
      printf '\n错误：旧实例仍在运行（PID：%s），新实例已退出（单实例保护）。\n' \
        "$(printf '%s' "$others" | tr '\n' ' ')" >&2
      printf '先退出旧实例，或用 --kill-existing 重跑本脚本。\n' >&2
      return 1
    fi
  fi

  if [ "$status" -ne 0 ]; then
    printf '\nApp 退出码：%s\n' "$status"
  fi
  return "$status"
}

print_next_steps

case "$LAUNCH_MODE" in
  none)
    ;;
  detach)
    open "$APP_DEST"
    printf '\n已在后台启动：%s\n' "$APP_DEST"
    ;;
  foreground)
    trap on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    run_foreground
    ;;
esac
