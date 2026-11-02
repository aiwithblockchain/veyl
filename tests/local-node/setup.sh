#!/usr/bin/env bash
# 本地测试节点：一台真实 sing-box 服务端 + 一台真实 sing-box 客户端。
# 用于集成测试「配置生成 → 启动 → Clash API → 代理转发 → 断开」整条链路。
#
# 用法：
#   bash tests/local-node/setup.sh --download   # 下载官方 sing-box 到 tests/local-node/out/bin
#   bash tests/local-node/setup.sh              # 生成配置并启动
#   bash tests/local-node/setup.sh --selftest   # 启动 + 自检 + 退出
#   bash tests/local-node/setup.sh --stop
#
# 端口：vless 18443 / reality 握手 18444 / mixed 12080 / clash api 19090
# 回显服务 18080 由 tests/run-mocks.sh 提供；--selftest 会在缺失时自动拉起。
#
# 说明：Reality 的握手目标只影响未通过认证的连接，因此本地用自签证书的 TLS 服务充当即可，
# 不需要真实外部站点。这一点已在本机 1.14.4 上实测通过。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
LOG="$OUT/logs"
PIDF="$OUT/pids"

VLESS_PORT="${LOCAL_NODE_VLESS_PORT:-18443}"
HS_PORT="${LOCAL_NODE_HS_PORT:-18444}"
MIXED_PORT="${LOCAL_NODE_MIXED_PORT:-12080}"
CLASH_PORT="${LOCAL_NODE_CLASH_PORT:-19090}"
ECHO_PORT="${MOCK_ECHO_PORT:-18080}"
CLASH_SECRET="test-secret-123"

mkdir -p "$OUT" "$LOG" "$PIDF"

log() { printf '[local-node] %s\n' "$*"; }
die() { printf '[local-node] 错误：%s\n' "$*" >&2; exit 1; }

resolve_singbox() {
  if [ -n "${SING_BOX_BIN:-}" ] && [ -x "${SING_BOX_BIN}" ]; then
    printf '%s' "$SING_BOX_BIN"; return
  fi
  if [ -x "$OUT/bin/sing-box" ]; then
    printf '%s' "$OUT/bin/sing-box"; return
  fi
  if command -v sing-box >/dev/null 2>&1; then
    printf '%s' "$(command -v sing-box)"; return
  fi
  die "找不到 sing-box。先运行：bash tests/local-node/setup.sh --download，或用 SING_BOX_BIN 指定"
}

download_singbox() {
  local os arch asset ver
  ver="${SING_BOX_VERSION:-1.14.4}"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in darwin|linux) ;; *) die "不支持的系统：$os（Windows 请手工下载 zip）" ;; esac
  arch="$(uname -m)"
  case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; *) die "不支持的架构：$arch" ;; esac
  asset="sing-box-${ver}-${os}-${arch}.tar.gz"
  local url="https://github.com/SagerNet/sing-box/releases/download/v${ver}/${asset}"
  mkdir -p "$OUT/bin"
  log "下载 $url"
  curl -fL --max-time 180 -o "$OUT/$asset" "$url"
  log "sha256: $(shasum -a 256 "$OUT/$asset" | awk '{print $1}')  size: $(wc -c < "$OUT/$asset" | tr -d ' ')"
  tar -xzf "$OUT/$asset" -C "$OUT"
  cp "$OUT/sing-box-${ver}-${os}-${arch}/sing-box" "$OUT/bin/sing-box"
  chmod +x "$OUT/bin/sing-box"
  rm -rf "$OUT/sing-box-${ver}-${os}-${arch}" "$OUT/$asset"
  "$OUT/bin/sing-box" version
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

prepare() {
  local sb; sb="$(resolve_singbox)"
  log "使用 sing-box：$sb（$("$sb" version)）"

  for p in "$VLESS_PORT" "$HS_PORT" "$MIXED_PORT" "$CLASH_PORT"; do
    port_busy "$p" && die "端口 $p 已被占用，先 --stop 或换端口"
  done

  local kp priv pub uuid shortid
  kp="$("$sb" generate reality-keypair)"
  priv="$(printf '%s' "$kp" | sed -n 's/^PrivateKey: *//p')"
  pub="$(printf '%s' "$kp" | sed -n 's/^PublicKey: *//p')"
  uuid="$("$sb" generate uuid)"
  shortid="$("$sb" generate rand --hex 8)"
  [ -n "$priv" ] && [ -n "$pub" ] || die "生成 reality keypair 失败"

  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$OUT/hs.key" -out "$OUT/hs.crt" -days 2 \
    -subj "/CN=www.example.com" >/dev/null 2>&1

  cat > "$OUT/server.json" <<EOF
{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "127.0.0.1",
      "listen_port": $VLESS_PORT,
      "users": [ { "uuid": "$uuid", "flow": "xtls-rprx-vision" } ],
      "tls": {
        "enabled": true,
        "server_name": "www.example.com",
        "reality": {
          "enabled": true,
          "handshake": { "server": "127.0.0.1", "server_port": $HS_PORT },
          "private_key": "$priv",
          "short_id": [ "$shortid" ]
        }
      }
    }
  ],
  "outbounds": [ { "type": "direct", "tag": "direct" } ]
}
EOF

  cat > "$OUT/client.json" <<EOF
{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": $MIXED_PORT }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "proxy",
      "server": "127.0.0.1",
      "server_port": $VLESS_PORT,
      "uuid": "$uuid",
      "flow": "xtls-rprx-vision",
      "tls": {
        "enabled": true,
        "server_name": "www.example.com",
        "utls": { "enabled": true, "fingerprint": "chrome" },
        "reality": { "enabled": true, "public_key": "$pub", "short_id": "$shortid" }
      }
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "proxy" },
  "experimental": {
    "clash_api": { "external_controller": "127.0.0.1:$CLASH_PORT", "secret": "$CLASH_SECRET" }
  }
}
EOF

  "$sb" check -c "$OUT/server.json" || die "server.json 未通过 sing-box check"
  "$sb" check -c "$OUT/client.json" || die "client.json 未通过 sing-box check"

  # 供应用测试使用的节点描述（与 tests/fixtures/nodes.json 的 seed-jp-01 字段结构一致）
  cat > "$OUT/node.json" <<EOF
{
  "id": "seed-local-01",
  "name": "本地节点",
  "region": "local",
  "city": "Localhost",
  "protocol": "vless-reality",
  "server": "127.0.0.1",
  "server_port": $VLESS_PORT,
  "credentials": { "uuid": "$uuid" },
  "tls": { "server_name": "www.example.com", "reality": { "public_key": "$pub", "short_id": "$shortid" } },
  "health": { "score": 1.0, "latency_ms": 1, "checked_at": "1970-01-01T00:00:00Z" },
  "tags": ["local"]
}
EOF

  log "配置已生成：$OUT/server.json $OUT/client.json $OUT/node.json"
}

start() {
  local sb; sb="$(resolve_singbox)"
  [ -f "$OUT/server.json" ] || prepare

  openssl s_server -accept "$HS_PORT" -cert "$OUT/hs.crt" -key "$OUT/hs.key" -www -quiet \
    >"$LOG/handshake.log" 2>&1 &
  echo $! > "$PIDF/handshake.pid"

  "$sb" run -c "$OUT/server.json" >"$LOG/server.log" 2>&1 &
  echo $! > "$PIDF/server.pid"

  sleep 0.5

  "$sb" run -c "$OUT/client.json" >"$LOG/client.log" 2>&1 &
  echo $! > "$PIDF/client.pid"

  for _ in $(seq 1 50); do
    if curl -fsS -m 1 -H "Authorization: Bearer $CLASH_SECRET" \
        "http://127.0.0.1:$CLASH_PORT/version" >/dev/null 2>&1; then
      log "客户端已就绪：mixed 127.0.0.1:$MIXED_PORT，clash http://127.0.0.1:$CLASH_PORT"
      return 0
    fi
    sleep 0.1
  done
  cat "$LOG/client.log" >&2
  die "客户端 5 秒内未就绪"
}

stop() {
  for f in "$PIDF"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  log "已停止"
}

ensure_echo() {
  if port_busy "$ECHO_PORT"; then return 0; fi
  node "$HERE/../echo/server.mjs" --port "$ECHO_PORT" >"$LOG/echo.log" 2>&1 &
  echo $! > "$PIDF/echo.pid"
  sleep 0.3
}

selftest() {
  local sb; sb="$(resolve_singbox)"
  prepare
  start
  ensure_echo

  local fail=0
  check() {
    if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s（期望 %s 实际 %s）\n' "$1" "$2" "$3"; fail=$((fail + 1)); fi
  }

  check "clash /version 200" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLASH_SECRET" "http://127.0.0.1:$CLASH_PORT/version")"
  check "无 secret 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CLASH_PORT/version")"
  check "经代理访问回显" "VEYL_ECHO_OK" \
    "$(curl -s -m 5 -x "http://127.0.0.1:$MIXED_PORT" "http://127.0.0.1:$ECHO_PORT/" | tr -d '\n')"

  # 停掉服务端后，经代理应得到 502（节点不可达的可观测信号）
  kill "$(cat "$PIDF/server.pid")" 2>/dev/null || true
  wait "$(cat "$PIDF/server.pid")" 2>/dev/null || true
  rm -f "$PIDF/server.pid"
  sleep 0.3
  check "服务端停止后经代理 502" "502" \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -x "http://127.0.0.1:$MIXED_PORT" "http://127.0.0.1:$ECHO_PORT/")"

  echo
  [ "$fail" -eq 0 ] && echo "[selftest] 全部通过" || echo "[selftest] $fail 项失败"
  stop
  return "$fail"
}

case "${1:-}" in
  --download) download_singbox ;;
  --stop)     stop ;;
  --selftest) selftest ;;
  --prepare)  prepare ;;
  "")         prepare; start ;;
  *)          echo "未知参数：$1" >&2; exit 2 ;;
esac
