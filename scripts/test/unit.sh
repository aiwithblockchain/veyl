#!/usr/bin/env bash
# 用法：
#   bash scripts/test/unit.sh
#
# 内容：npm run typecheck → cargo test --lib（--nocapture，失败写失败摘要）
# 前置：已执行 npm ci；cargo 可用。不依赖网络。
# 退出码：0 通过 / 1 失败 / 2 缺依赖
#
# 单独跑某一步的原始输出见 build/logs/{typecheck,cargo-test}.log。

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$CI_ROOT" || exit 2

ci_need node npm cargo
ci_init

[ -d node_modules ] || { echo "缺 node_modules，先执行：npm ci" >&2; exit 2; }

ci_banner "单元测试"

ci_step "typecheck" npm run --silent typecheck || exit 1
ci_step "cargo-test" bash scripts/test/cargo-lib.sh || exit 1

printf '\n单元测试通过\n'
