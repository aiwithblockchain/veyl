#!/usr/bin/env bash
# UI 冒烟（A5，P1-后置）：启动应用 → 断言主窗口 → 退出。
#
#   bash scripts/dev/ui-smoke.sh
#
# 断言分两档：
#   1. 进程启动、dev 日志非空且无 panic / 编译错误、Vite 已就绪 —— 任何机器都跑。
#   2. 主窗口标题含 Veyl、窗口不小于 900×600 —— 需要「辅助功能」权限。
#      没授权时明确 SKIP，不假装通过，也不让整个冒烟失败。
#
# 授权方式：系统设置 → 隐私与安全性 → 辅助功能，勾选你运行脚本的终端（Terminal/iTerm/IDE）。
# bash 拿不到 WebView 内部 DOM，像素级断言留给后续的 WebDriver / Playwright 入口。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT" || exit 1

TIMEOUT_SECONDS="${SMOKE_TIMEOUT:-180}"
APP_NAME="veyl"
MIN_WIDTH=900
MIN_HEIGHT=600

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

skip() {
  echo "SKIP: $*"
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: ui-smoke 目前只支持 macOS（窗口断言依赖 osascript）。"
  echo "      Windows 请跑 dev-with-log.ps1 后手工确认，或等 PowerShell 版冒烟。"
  exit 0
fi

if [ ! -d "$ROOT/node_modules" ]; then
  fail "缺少 node_modules，先执行 npm install"
fi

# 端口是 Veyl 独占的，用它判断「已有实例」比按进程名更准，
# 也不会误伤同机其它项目。必须限定 LISTEN：只看端口的话，任何一句
# `localhost:1430` 的已关闭客户端连接都会被算进来。
if lsof -nP -iTCP:1430 -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail "1430 端口已被占用（可能已有 dev 实例在跑），先停掉再跑冒烟"
fi

# 辅助功能权限探测：读取窗口需要它。注意「列出进程」不需要权限，
# 所以探测必须真的去读一个窗口；Finder 没开窗口时报 -1728，属于有权限。
AX_PROBE=$(osascript -e 'tell application "System Events" to get name of first window of process "Finder"' 2>&1)
HAVE_AX=1
case "$AX_PROBE" in
  *-1719*|*"assistive access"*) HAVE_AX=0 ;;
esac

LOG_DIR="$ROOT/build/logs"
mkdir -p "$LOG_DIR"
DEV_OUTPUT="$LOG_DIR/.smoke-dev-output"
START_EPOCH=$(date +%s)
SMOKE_PGID=""

# 只收自己拉起来的进程组（见 docs/build-and-release.md §5.4）：
# 不用 pkill 按模式匹配，避免杀掉同机其它 Tauri 项目的 dev 进程。
cleanup() {
  echo "清理进程…"
  if [ -n "${SMOKE_PGID:-}" ]; then
    kill -TERM -"$SMOKE_PGID" 2>/dev/null
    sleep 1
    kill -KILL -"$SMOKE_PGID" 2>/dev/null
  fi
  # 1430 是 Veyl 独占端口，兜底收掉残留监听。
  # 只杀 LISTEN 的那个进程：不带 -sTCP:LISTEN 会连「连过 1430 的客户端」一起杀。
  lsof -nP -iTCP:1430 -sTCP:LISTEN -t 2>/dev/null | xargs -r kill >/dev/null 2>&1
  rm -f "$DEV_OUTPUT"
}
trap cleanup EXIT INT TERM

# 进程是否属于我们自己的进程组，而不是全机同名进程。
group_has_app() {
  [ -n "${SMOKE_PGID:-}" ] || return 1
  ps -o command= -g "$SMOKE_PGID" 2>/dev/null | grep -q "target/debug/$APP_NAME"
}

[ "$HAVE_AX" -eq 1 ] || skip "没有辅助功能权限，窗口标题/尺寸断言会跳过"

echo "启动应用（最长等待 ${TIMEOUT_SECONDS}s）…"
# set -m 让后台任务独占一个进程组；否则它和本脚本同组，
# kill -- -PGID 会把脚本自己也带走。
set -m
bash "$SCRIPT_DIR/dev-with-log.sh" --no-open >"$DEV_OUTPUT" 2>&1 &
SMOKE_PID=$!
SMOKE_PGID=$(ps -o pgid= -p "$SMOKE_PID" | tr -d ' ')
set +m

APP_STARTED=0
while [ $(( $(date +%s) - START_EPOCH )) -lt "$TIMEOUT_SECONDS" ]; do
  if group_has_app; then
    APP_STARTED=1
    break
  fi
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    break
  fi
  sleep 2
done

if [ "$APP_STARTED" -ne 1 ]; then
  echo "--- 启动输出 ---" >&2
  tail -40 "$DEV_OUTPUT" >&2 || true
  fail "应用没有在 ${TIMEOUT_SECONDS}s 内启动"
fi
pass "应用进程已启动"

# 窗口存在一段时间才算真的起来了（不是启动即崩）。
sleep 5
group_has_app || fail "应用启动后 5s 内退出"
pass "应用 5s 后仍在运行"

if [ "$HAVE_AX" -eq 1 ]; then
  TITLE=$(osascript -e "tell application \"System Events\" to get name of front window of process \"$APP_NAME\"" 2>/dev/null)
  [ -n "$TITLE" ] || fail "拿不到主窗口（进程在，但没有可读窗口）"
  case "$TITLE" in
    *Veyl*) pass "主窗口标题：$TITLE" ;;
    *) fail "主窗口标题不符合预期：$TITLE" ;;
  esac

  SIZE=$(osascript -e "tell application \"System Events\" to get size of front window of process \"$APP_NAME\"" 2>/dev/null)
  WIDTH=$(echo "$SIZE" | tr -d ' ' | cut -d, -f1)
  HEIGHT=$(echo "$SIZE" | tr -d ' ' | cut -d, -f2)

  if [ -n "$WIDTH" ] && [ -n "$HEIGHT" ] && [ "$WIDTH" -ge "$MIN_WIDTH" ] && [ "$HEIGHT" -ge "$MIN_HEIGHT" ]; then
    pass "窗口尺寸 ${WIDTH}x${HEIGHT}"
  else
    fail "窗口尺寸异常：${WIDTH:-?}x${HEIGHT:-?}（期望 ≥ ${MIN_WIDTH}x${MIN_HEIGHT}）"
  fi
else
  skip "窗口标题 / 尺寸未断言（需要辅助功能权限）"
fi

DEV_LOG=$(ls -t "$LOG_DIR"/dev-*.log 2>/dev/null | head -1)
[ -n "$DEV_LOG" ] || fail "没有找到 dev 日志（dev-with-log.sh 没落盘？）"
[ -s "$DEV_LOG" ] || fail "dev 日志是空的：$DEV_LOG"

grep -q "ready in" "$DEV_LOG" || fail "前端没有就绪（日志里没有 Vite ready）"
pass "前端已就绪"

if grep -qE "panicked at|error\[E[0-9]+\]|error: could not compile" "$DEV_LOG"; then
  grep -nE "panicked at|error\[E[0-9]+\]|error: could not compile" "$DEV_LOG" | tail -10 >&2
  fail "日志里有 panic 或编译错误"
fi
pass "日志无 panic / 编译错误：$DEV_LOG"

echo
if [ "$HAVE_AX" -eq 1 ]; then
  pass "UI 冒烟通过"
else
  pass "UI 冒烟通过（窗口断言已跳过）"
fi
