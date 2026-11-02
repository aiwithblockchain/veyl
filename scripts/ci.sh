#!/usr/bin/env bash
# 用法：
#   bash scripts/ci.sh            # 六步全跑
#   bash scripts/ci.sh --quick    # 只跑前 4 步（check-secrets / typecheck / cargo test / 契约）
#
# 六步（顺序执行，任一失败即停，失败时原样打印该步输出）：
#   1. bash scripts/check-secrets.sh        ← 密钥扫描，跑不过后面全别跑
#   2. npm run typecheck
#   3. cargo test --manifest-path src-tauri/Cargo.toml
#   4. node tests/contracts/check-contracts.mjs
#   5. cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest
#   6. bash tests/run-mocks.sh --selftest
#
# 前置：npm ci 已执行；node / npm / cargo / curl 可用。
#       第 5 步会真实下载 sing-box 1.14.4（约 28MB），需要网络；第 1–4 步不需要。
# 退出码：0 全部通过 / 1 有步骤失败 / 2 缺依赖
#
# 每一步的完整输出在 build/logs/<step>.log。

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test/lib.sh"
cd "$CI_ROOT" || exit 2

QUICK=0
case "${1:-}" in
  "--quick") QUICK=1 ;;
  "")        QUICK=0 ;;
  *) echo "未知参数：$1（可用：--quick）" >&2; exit 2 ;;
esac

ci_need node npm cargo curl
ci_init

[ -d node_modules ] || { echo "缺 node_modules，先执行：npm ci" >&2; exit 2; }

TOTAL_START=$(date +%s)

if [ "$QUICK" = "1" ]; then
  ci_banner "CI（quick：前 4 步）"
else
  ci_banner "CI（完整：6 步）"
fi
printf '工作区：%s\n' "$CI_ROOT"
printf '日志：%s\n' "$CI_LOG_DIR"

ci_step "check-secrets" bash scripts/check-secrets.sh || exit 1
ci_step "typecheck" npm run --silent typecheck || exit 1
ci_step "cargo-test" cargo test --manifest-path src-tauri/Cargo.toml || exit 1
ci_step "contracts" node tests/contracts/check-contracts.mjs || exit 1

if [ "$QUICK" = "1" ]; then
  printf '\nCI（quick）通过，用时 %ds\n' "$(( $(date +%s) - TOTAL_START ))"
  exit 0
fi

ci_step "runtime-selftest" cargo run --quiet --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest || exit 1
ci_step "mock-selftest" bash tests/run-mocks.sh --selftest || exit 1

printf '\nCI 全部通过，用时 %ds\n' "$(( $(date +%s) - TOTAL_START ))"
