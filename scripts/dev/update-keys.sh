#!/usr/bin/env bash
# update-keys.sh — 本地开发用的更新清单签名密钥。
#
# 用法：
#   bash scripts/dev/update-keys.sh gen
#       在 ~/.veyl/dev-keys/ 生成 Ed25519 私钥（0600），并打印构建时要设的
#       VEYL_UPDATE_PUBKEYS。
#   bash scripts/dev/update-keys.sh sign payload.json > envelope.json
#       用该私钥签 payload.json，输出清单信封。
#
# **私钥永不进仓库、日志或模型上下文。** 仓库里只放公钥；
# CI 用 secret 注入同名环境变量（见 docs/build-and-release.md §4.7）。
#
# 生成的 envelope 可放到测试服务器上，或用 `python3 -m http.server` 配合
# 修改过的 MANIFEST_URL 做联调——正式构建的地址固定为
# https://updates.veyl.app/runtime/manifest-v1.json。

set -euo pipefail

KEY_DIR="${VEYL_UPDATE_KEY_DIR:-$HOME/.veyl/dev-keys}"
KEY="$KEY_DIR/updates.key"
KEY_ID="${VEYL_UPDATE_KEY_ID:-dev}"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || die "缺少 openssl"
command -v base64 >/dev/null 2>&1 || die "缺少 base64"

case "${1:-}" in
  gen)
    mkdir -p "$KEY_DIR"
    chmod 700 "$KEY_DIR"
    [ -f "$KEY" ] && die "私钥已存在：$KEY（先移走再重建）"
    openssl genpkey -algorithm ED25519 -out "$KEY" 2>/dev/null
    chmod 600 "$KEY"
    PUB_HEX="$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | tail -c 32 | od -An -tx1 | tr -d ' \n')"
    printf '私钥：%s（0600）\n' "$KEY"
    printf '构建时设置：\n  export VEYL_UPDATE_PUBKEYS="%s:%s"\n' "$KEY_ID" "$PUB_HEX"
    ;;
  sign)
    PAYLOAD="${2:-}"
    [ -n "$PAYLOAD" ] && [ -f "$PAYLOAD" ] || die "用法：update-keys.sh sign <payload.json>"
    [ -f "$KEY" ] || die "没有私钥：先执行 update-keys.sh gen"
    SIG_B64="$(openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$PAYLOAD" | base64)"
    PAYLOAD_B64="$(base64 <"$PAYLOAD" | tr -d '\n')"
    printf '{"payload":"%s","sig":"%s","key_id":"%s"}' \
      "$PAYLOAD_B64" "$SIG_B64" "$KEY_ID"
    printf '\n'
    ;;
  *)
    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
