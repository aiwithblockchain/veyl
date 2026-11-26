#!/usr/bin/env bash
# 验证 TUN DNS 转发器「被杀掉后不断网」的兜底。
#
# 无论测试结果如何，退出时都会把活动网卡的 DNS 恢复成 223.5.5.5 并刷新缓存，
# 避免出现「DNS 指向已消失的转发器、只能重启」的情况。
#
# 用法（先连上 TUN）：bash scripts/dev/verify-dns-fallback.sh
set -uo pipefail

service_for_en0() {
  local dev=""
  networksetup -listnetworkserviceorder 2>/dev/null | awk '
    /^\([0-9]+\)/ { name=$0; sub(/^\([0-9]+\) /, "", name) }
    /Device: en0/ { print name; exit }
  '
}

SERVICE="$(service_for_en0)"
SERVICE="${SERVICE:-Wi-Fi}"

restore() {
  # 先把恢复动作做完，再做任何可能失败的回显——安全网本身不能先挂。
  sudo networksetup -setdnsservers "$SERVICE" 223.5.5.5 >/dev/null 2>&1 || true
  sudo dscacheutil -flushcache >/dev/null 2>&1 || true
  sudo killall -HUP mDNSResponder >/dev/null 2>&1 || true
  echo "[restore] 已把 ${SERVICE} 的 DNS 恢复为 223.5.5.5"
}
trap restore EXIT INT TERM

PID="$(pgrep -f veyl-helper | head -1)"
if [ -z "$PID" ]; then
  echo "找不到 veyl-helper，请先连上 TUN 再跑本脚本" >&2
  exit 1
fi

# 先在开头要一次密码，避免退出时 trap 里的 sudo 再弹一次（那会让人以为卡住）。
sudo -v || { echo "需要 sudo 权限" >&2; exit 1; }

echo "helper pid = $PID"
echo "服务 = $SERVICE"
echo "--- 杀之前 ---"
scutil --dns | grep -m3 "nameserver\[0\]" || true

echo "--- 杀掉 helper ---"
sudo kill -9 "$PID"
sleep 1

echo "--- 杀之后（10 秒内必须给出结果；卡住按 Ctrl-C 也会恢复 DNS）---"
dscacheutil -q host -a name www.example.com 2>&1 | head -6 || echo "解析失败"

echo "--- 判读 ---"
echo "看到 ip_address 且不卡住 = 兜底成立（走次选 223.5.5.5）"
echo "卡住或空 = 兜底不成立，需要让回收逻辑在 helper 之外生效"
