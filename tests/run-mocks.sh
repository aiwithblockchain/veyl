#!/usr/bin/env bash
# 启动/停止测试用的三个 mock 服务。
#
# 用法：
#   bash tests/run-mocks.sh              # 前台启动，Ctrl-C 退出
#   bash tests/run-mocks.sh --start      # 后台启动后立即返回（供 smoke.sh 编排）
#   bash tests/run-mocks.sh --selftest   # 启动 → 自检 → 退出（CI 第一步跑这个）
#   bash tests/run-mocks.sh --stop       # 停掉残留进程
#
# 端口：catalog 18090 / llm 18091 / echo 18080

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$HERE/.run"
PID_DIR="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"

CATALOG_PORT="${MOCK_CATALOG_PORT:-18090}"
LLM_PORT="${MOCK_LLM_PORT:-18091}"
ECHO_PORT="${MOCK_ECHO_PORT:-18080}"

mkdir -p "$PID_DIR" "$LOG_DIR"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖：$1" >&2; exit 1; }; }
need node
need curl

start_one() {
  local name="$1" port="$2"; shift 2
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[run-mocks] 端口 $port 已被占用，请先 --stop 或换端口" >&2
    exit 1
  fi
  node "$@" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  echo "[run-mocks] $name -> 127.0.0.1:$port (pid $(cat "$PID_DIR/$name.pid"))"
}

wait_http() {
  local url="$1" tries="${2:-50}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

stop_all() {
  for f in "$PID_DIR"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$f"
  done
}

start_all() {
  start_one catalog "$CATALOG_PORT" "$HERE/mock-catalog/server.mjs" --port "$CATALOG_PORT"
  start_one llm     "$LLM_PORT"     "$HERE/mock-llm/server.mjs"     --port "$LLM_PORT"
  start_one echo    "$ECHO_PORT"    "$HERE/echo/server.mjs"         --port "$ECHO_PORT"

  wait_http "http://127.0.0.1:$CATALOG_PORT/__health" || { echo "catalog 未就绪" >&2; cat "$LOG_DIR/catalog.log" >&2; exit 1; }
  wait_http "http://127.0.0.1:$ECHO_PORT/" || { echo "echo 未就绪" >&2; exit 1; }
  for _ in $(seq 1 50); do
    if curl -fsS -m 1 "http://127.0.0.1:$LLM_PORT/__stats" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  echo "[run-mocks] 三个服务已就绪，日志在 $LOG_DIR"
}

selftest() {
  local fail=0
  check() {
    local desc="$1" expect="$2" actual="$3"
    if [ "$expect" = "$actual" ]; then
      printf '  ok   %s\n' "$desc"
    else
      printf '  FAIL %s（期望 %s 实际 %s）\n' "$desc" "$expect" "$actual"
      fail=$((fail + 1))
    fi
  }

  echo "[selftest] mock-catalog"
  check "health 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CATALOG_PORT/__health")"

  local admin
  admin="$(curl -s -X POST "http://127.0.0.1:$CATALOG_PORT/v1/devices" -H 'content-type: application/json' -d '{}')"
  local token
  token="$(printf '%s' "$admin" | sed -n 's/.*"device_token":"\([^"]*\)".*/\1/p')"
  check "设备注册返回 token" "yes" "$([ -n "$token" ] && echo yes || echo no)"

  check "未带 token 的目录查询 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CATALOG_PORT/v1/catalog/nodes")"

  local list
  list="$(curl -s "http://127.0.0.1:$CATALOG_PORT/v1/catalog/nodes?region=jp" -H "Authorization: Bearer $token")"
  check "目录查询含 seed-jp-01" "yes" "$(printf '%s' "$list" | grep -q 'seed-jp-01' && echo yes || echo no)"
  check "目录查询不含凭据" "no" "$(printf '%s' "$list" | grep -q 'credentials\|uuid\|password' && echo yes || echo no)"
  check "故障注入 500" "500" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CATALOG_PORT/v1/catalog/nodes?_fault=500" -H "Authorization: Bearer $token")"

  echo "[selftest] mock-llm"
  check "有效 Key 200" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer sk-test-valid' "http://127.0.0.1:$LLM_PORT/v1/models")"
  check "无效 Key 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer sk-test-invalid' "http://127.0.0.1:$LLM_PORT/v1/models")"

  local reply
  reply="$(curl -s -X POST "http://127.0.0.1:$LLM_PORT/v1/chat/completions" \
    -H 'Authorization: Bearer sk-test-valid' -H 'content-type: application/json' \
    -d '{"model":"deepseek-chat","stream":false,"messages":[{"role":"user","content":"连到日本 [scenario:connect-jp]"}]}')"
  check "剧本首轮返回 CatalogSearch" "yes" "$(printf '%s' "$reply" | grep -q 'CatalogSearch' && echo yes || echo no)"

  echo "[selftest] echo"
  check "回显内容" "VEYL_ECHO_OK" "$(curl -s "http://127.0.0.1:$ECHO_PORT/" | tr -d '\n')"

  echo
  if [ "$fail" -eq 0 ]; then
    echo "[selftest] 全部通过"
  else
    echo "[selftest] $fail 项失败"
  fi
  return "$fail"
}

case "${1:-}" in
  --stop)
    stop_all
    echo "[run-mocks] 已停止"
    exit 0
    ;;
  --start)
    # 非阻塞启动：给 smoke.sh 之类的编排脚本用，结束后由调用方 --stop
    stop_all
    start_all
    exit 0
    ;;
  --selftest)
    stop_all
    start_all
    if selftest; then
      stop_all
      exit 0
    else
      stop_all
      exit 1
    fi
    ;;
  "")
    stop_all
    start_all
    trap 'stop_all; echo "[run-mocks] 已停止"' INT TERM EXIT
    echo "[run-mocks] 前台运行中，Ctrl-C 停止"
    wait
    ;;
  *)
    echo "未知参数：$1" >&2
    exit 2
    ;;
esac
