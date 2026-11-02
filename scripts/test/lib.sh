#!/usr/bin/env bash
# CI 脚本公共函数。被 scripts/ci.sh 与 scripts/test/*.sh 引用，不单独执行。
#
# 约定：
#   - 每个步骤的完整输出写到 build/logs/<name>.log，成功时只打一行摘要，失败时原样打出来。
#   - 缺依赖时返回 2 并说清楚缺哪个，不静默跳过。
#   - 所有路径从脚本位置推导，不写死绝对路径。

CI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_LOG_DIR="$CI_ROOT/build/logs"
CI_FAILED=0

ci_init() {
  mkdir -p "$CI_LOG_DIR"
}

# ci_need <命令>... —— 缺任何一个就报出来并退出 2
ci_need() {
  local missing=()
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    printf '缺依赖：%s\n' "${missing[*]}" >&2
    printf '安装后重试。macOS 可用 brew install %s\n' "${missing[*]}" >&2
    exit 2
  fi
}

# ci_step <名称> <命令...>
#   成功：打印 "✓ 名称 (1.2s)"
#   失败：打印 "✗ 名称 (1.2s)"，随后原样打印该步输出，返回 1
ci_step() {
  local name="$1"; shift
  local log="$CI_LOG_DIR/$name.log"
  local started
  started=$(date +%s)

  if "$@" >"$log" 2>&1; then
    local took=$(( $(date +%s) - started ))
    printf '✓ %-28s %3ds\n' "$name" "$took"
    return 0
  fi

  local took=$(( $(date +%s) - started ))
  printf '✗ %-28s %3ds\n' "$name" "$took"
  printf '%s\n' "--- $name 输出（$log）---"
  cat "$log"
  printf '%s\n' "--- $name 输出结束 ---"
  return 1
}

# ci_banner <文本>
ci_banner() {
  printf '\n== %s ==\n' "$1"
}
