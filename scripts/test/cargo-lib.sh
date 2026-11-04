#!/usr/bin/env bash
# 用法：
#   bash scripts/test/cargo-lib.sh
#   bash scripts/test/cargo-lib.sh --test-threads=1
#
# 作用：固定跑 `cargo test --lib -- --nocapture`。
#   - 完整输出落到 build/logs/cargo-test-lib.log
#   - 失败时额外生成 build/logs/cargo-test-lib-failure.txt，包含：
#       失败测试名、panic 位置、left/right、最后 120 行输出
# 这样全量跑挂掉时，不会只剩一行 "test result: FAILED"。
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$CI_ROOT" || exit 2

ci_init

LOG="$CI_LOG_DIR/cargo-test-lib.log"
FAILURE="$CI_LOG_DIR/cargo-test-lib-failure.txt"
rm -f "$FAILURE"

STARTED=$(date +%s)
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --nocapture "$@" >"$LOG" 2>&1
STATUS=$?
TOOK=$(( $(date +%s) - STARTED ))

if [ "$STATUS" -eq 0 ]; then
  printf '✓ %-28s %3ds\n' "cargo-test-lib" "$TOOK"
  exit 0
fi

{
  printf 'time: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'command: cargo test --manifest-path src-tauri/Cargo.toml --lib -- --nocapture %s\n' "$*"
  printf 'status: %s\n\n' "$STATUS"

  printf '== failing tests ==\n'
  awk '
    /^failures:$/ { in_failures = 1 }
    in_failures { print }
    /^test result:/ { if (in_failures) exit }
  ' "$LOG"

  printf '\n== panic locations ==\n'
  grep -n -E 'panicked at|assertion .* failed|^ *left:|^ *right:' "$LOG" | tail -80 || true

  printf '\n== last 120 lines ==\n'
  tail -120 "$LOG"
} >"$FAILURE"

printf '✗ %-28s %3ds\n' "cargo-test-lib" "$TOOK"
printf '%s\n' "--- 失败摘要（完整日志 $LOG，摘要在 $FAILURE）---"
cat "$FAILURE"
printf '%s\n' "--- 失败摘要结束 ---"
exit 1
