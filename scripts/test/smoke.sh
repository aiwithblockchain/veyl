#!/usr/bin/env bash
# 用法：
#   bash scripts/test/smoke.sh                 # mock 链路 + （有内核时）真实连接
#   bash scripts/test/smoke.sh --with-singbox  # 强制要求内核，没有就失败
#   bash scripts/test/smoke.sh --mocks-only    # 只跑 mock 链路，不起 sing-box
#
# 两段：
#   1) mock 链路：起 mock catalog/llm/echo → 设备注册 → 目录查询 → 剧本推进 → 回显可达
#   2) 真实链路（有 sing-box 时）：本地服务端 + 客户端 → Clash /version → 经代理访问回显 → 断开
# 第二段缺内核时**明确打印 SKIP 与原因**，不静默跳过；--with-singbox 时视为失败。
#
# 退出时必杀所有子进程（trap EXIT），结束时校验 18080/18090/18091 无监听。

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$CI_ROOT" || exit 2

MODE="auto"
case "${1:-}" in
  "--with-singbox") MODE="require" ;;
  "--mocks-only")   MODE="off" ;;
  "")               MODE="auto" ;;
  *) echo "未知参数：$1" >&2; exit 2 ;;
esac

ci_need node curl
ci_init

MOCK_PORTS=(18080 18090 18091)
NODE_STARTED=0

do_cleanup() {
  bash "$CI_ROOT/tests/run-mocks.sh" --stop >/dev/null 2>&1 || true
  if [ "$NODE_STARTED" = "1" ]; then
    bash "$CI_ROOT/tests/local-node/setup.sh" --stop >/dev/null 2>&1 || true
  fi
}
trap 'do_cleanup' EXIT INT TERM

ports_listening() {
  command -v lsof >/dev/null 2>&1 || return 0
  local p
  for p in "${MOCK_PORTS[@]}"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "$p"; fi
  done
}

find_singbox() {
  if [ -n "${SING_BOX_BIN:-}" ] && [ -x "${SING_BOX_BIN}" ]; then printf '%s' "$SING_BOX_BIN"; return 0; fi
  if [ -x "$CI_ROOT/tests/local-node/out/bin/sing-box" ]; then printf '%s' "$CI_ROOT/tests/local-node/out/bin/sing-box"; return 0; fi
  if command -v sing-box >/dev/null 2>&1; then command -v sing-box; return 0; fi
  return 1
}

ci_banner "冒烟测试"

# 上一轮残留先清掉，否则端口占用会被误判
bash "$CI_ROOT/tests/run-mocks.sh" --stop >/dev/null 2>&1 || true

bash "$CI_ROOT/tests/run-mocks.sh" --start || { echo "mock 服务启动失败" >&2; exit 1; }

ci_step "smoke-mocks" node "$CI_ROOT/scripts/test/smoke.mjs" || exit 1

# --- 第二段：真实内核 ---
if [ "$MODE" = "off" ]; then
  echo "SKIP 真实链路：--mocks-only"
elif SB="$(find_singbox)"; then
  echo "真实链路：使用 $SB"
  NODE_STARTED=1
  export SING_BOX_BIN="$SB"
  ci_step "smoke-singbox" bash "$CI_ROOT/tests/local-node/setup.sh" --selftest || exit 1
  NODE_STARTED=0
else
  if [ "$MODE" = "require" ]; then
    cat >&2 <<'EOF'
SKIP 被拒绝：--with-singbox 要求有 sing-box 内核，但没找到。
  SING_BOX_BIN=/path/to/sing-box bash scripts/test/smoke.sh --with-singbox
  或先执行：bash tests/local-node/setup.sh --download
EOF
    exit 1
  fi
  cat <<'EOF'
SKIP 真实链路：未找到 sing-box 内核（不是静默跳过，是这一段确实没跑）。
  启用方式：SING_BOX_BIN=/path/to/sing-box bash scripts/test/smoke.sh
        或：bash tests/local-node/setup.sh --download 后重跑
EOF
fi

# --- 收尾：先清进程，再验端口 ---
do_cleanup
trap - EXIT INT TERM

LEFT="$(ports_listening)"
if [ -n "$LEFT" ]; then
  echo "FAIL 冒烟结束后仍有端口被占用：$LEFT" >&2
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ":($(echo "$LEFT" | tr '\n' '|' | sed 's/|$//'))" >&2 || true
  exit 1
fi

printf '\n冒烟测试通过，端口已释放\n'
