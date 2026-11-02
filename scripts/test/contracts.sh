#!/usr/bin/env bash
# 用法：
#   bash scripts/test/contracts.sh            # 常规：只把硬性偏差算失败
#   bash scripts/test/contracts.sh --strict   # 严格：advisory 项也算失败
#
# 内容：包一层 node tests/contracts/check-contracts.mjs
#   检查事件名、chatStore 覆盖、快照字段、剧本工具名，以及（advisory）实现里的
#   contract_version 常量是否与 docs/contracts/ 一致。
#
# 前置：node；不依赖网络，不依赖构建产物。
# 退出码：0 通过 / 1 有不一致 / 2 缺依赖

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$CI_ROOT" || exit 2

ci_need node
ci_init

if [ "${1:-}" = "--strict" ]; then
  export AIVPN_CONTRACT_STRICT=1
  echo "严格模式：advisory 项也会导致失败"
fi

ci_banner "契约一致性"

if ci_step "contracts" node tests/contracts/check-contracts.mjs; then
  printf '\n契约检查通过\n'
  exit 0
fi

cat >&2 <<'EOF'

契约检查未通过。排查方式：
  1. 上面每条 FAIL 都指向具体的文件与符号；
  2. 事实来源是 docs/contracts/ 下的四份文档（已冻结），不要改用例或检查去迁就实现；
  3. 若确认是契约本身需要改，报给架构师，不要自己改 docs/contracts/。
EOF
exit 1
