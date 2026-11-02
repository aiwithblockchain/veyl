#!/usr/bin/env bash
# 日常开发启动：跑 `tauri dev`，同时把输出落到 build/logs/dev-<时间戳>.log。
#
#   bash scripts/dev/dev-with-log.sh              # 日常开发
#   bash scripts/dev/dev-with-log.sh --clean      # 清 Vite 缓存 + target/debug 后启动
#   bash scripts/dev/dev-with-log.sh --no-open    # 不自动开 DevTools
#
# 日志目录 build/logs/ 已在 .gitignore 之外，提交前别把它带进去。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

CLEAN=0
OPEN_DEVTOOLS=1

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --no-open) OPEN_DEVTOOLS=0 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "未知参数：$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$ROOT" || exit 1

if [ ! -d node_modules ]; then
  echo "缺少 node_modules。" >&2
  echo "先在 $ROOT 执行：npm install" >&2
  exit 1
fi

if [ "$CLEAN" -eq 1 ]; then
  echo "清理缓存：dist/  node_modules/.vite/  src-tauri/target/debug"
  rm -rf "$ROOT/dist" "$ROOT/node_modules/.vite" "$ROOT/src-tauri/target/debug"
fi

# 外部显式设置的 RUST_LOG 优先。不打印变量值，只说来源。
if [ -n "${RUST_LOG:-}" ]; then
  RUST_LOG_SOURCE="已由外部设置"
else
  RUST_LOG_SOURCE="使用默认值"
fi
export RUST_LOG="${RUST_LOG:-veyl=debug,tauri=info}"
# 目前 Host 还没读这个变量（自动开 DevTools 需要 src-tauri 侧支持），
# 先留作约定，等接线后生效。
export VEYL_OPEN_DEVTOOLS="$OPEN_DEVTOOLS"

LOG_DIR="$ROOT/build/logs"
mkdir -p "$LOG_DIR" || exit 1
LOG_FILE="$LOG_DIR/dev-$(date +%Y%m%d-%H%M%S).log"

print_log_path() {
  echo
  echo "日志：$LOG_FILE"
}

trap 'print_log_path' EXIT

echo "启动 Veyl（RUST_LOG：${RUST_LOG_SOURCE}）"
echo "日志：$LOG_FILE"
echo

# 让 tee 记录全过程，同时保留 npm 的退出码。
npm run app:dev 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
exit "$status"
