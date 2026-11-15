// cloud-init：在服务器上自己装 sing-box（不依赖外部安装脚本）。
// 端口由控制面选定并写死；密码只在这台机器上生成，只经 enrollment 回传。
// 上限 64 KiB（DigitalOcean user_data 的限制），当前约 4 KB。
//
// 两条硬约束：
// 1. 不用 `... | head -c N` 生成密码：head 提前退出会让上游命令收到 SIGPIPE，
//    配合 `set -o pipefail` + `set -e` 会直接杀掉整个脚本（实测每台机器都死在这里）。
// 2. 任何一步失败都必须回传（active=false + error），否则控制面看不到、
//    机器却在计费。

export const SING_BOX_VERSION = "1.14.4";
export const SING_BOX_SHA256 = "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968";

export function buildCloudInit(input: { port: number; enrollUrl: string }): string {
  return `#!/bin/bash
set -euo pipefail

PORT=${input.port}
ENROLL_URL="${input.enrollUrl}"
SING_BOX_VERSION="${SING_BOX_VERSION}"
SING_BOX_SHA256="${SING_BOX_SHA256}"
ARCH="amd64"
PASSWORD=""
ACTIVE=0
FAILURE=""

report() {
  local body safe active_json
  # error 进 JSON 前先去掉引号和反斜杠，否则回传体本身就坏了。
  safe=$(printf '%s' "\${FAILURE}" | tr -d '"\\\\')
  # active 必须是 JSON 布尔值：发数字 1 会被控制面判成「不是 true」。
  if [ "\${ACTIVE}" = "1" ]; then active_json=true; else active_json=false; fi
  body="{\\"port\\":\${PORT},\\"password\\":\\"\${PASSWORD}\\",\\"version\\":\\"\${SING_BOX_VERSION}\\",\\"active\\":\${active_json},\\"error\\":\\"\${safe}\\"}"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if curl -fsS -X POST "\${ENROLL_URL}" -H 'content-type: application/json' --data "\${body}" >/dev/null; then
      return 0
    fi
    sleep $((attempt * 10))
  done
  return 1
}

# 失败也要回传，让控制面销毁这台（不留计费实例），而不是静默卡住。
on_error() {
  FAILURE="script_failed_line_\${1}"
  ACTIVE=0
  report || true
  exit 1
}
trap 'on_error \${LINENO}' ERR

# 1. 先关掉 SSH：我们永远不登录服务器，也没有 root 密码通道。
systemctl stop ssh 2>/dev/null || systemctl stop sshd 2>/dev/null || true
systemctl disable ssh 2>/dev/null || systemctl disable sshd 2>/dev/null || true

# 2. 基础工具
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq curl ca-certificates tar >/dev/null 2>&1

# 3. 下载并校验 sing-box
cd /tmp
curl -fsSL --retry 5 --retry-delay 5 -o sb.tar.gz "https://github.com/SagerNet/sing-box/releases/download/v\${SING_BOX_VERSION}/sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}.tar.gz"
echo "\${SING_BOX_SHA256}  sb.tar.gz" | sha256sum -c -
tar -xzf sb.tar.gz
install -m 0755 "sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}/sing-box" /usr/local/bin/sing-box
rm -rf sb.tar.gz "sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}"

# 4. 密码在这台机器上生成：od 只读 16 字节，下游 tr/cut 读满全部输入，不会 SIGPIPE。
PASSWORD=$(od -An -tx1 -N 16 /dev/urandom | tr -d ' \\n' | cut -c1-16)

# 5. 配置（加密方式固定 aes-256-gcm）
mkdir -p /usr/local/etc/sing-box
cat > /usr/local/etc/sing-box/config.json <<EOF
{
  "log": { "level": "info" },
  "inbounds": [
    {
      "type": "shadowsocks",
      "listen": "0.0.0.0",
      "listen_port": \${PORT},
      "method": "aes-256-gcm",
      "password": "\${PASSWORD}"
    }
  ],
  "outbounds": [{ "type": "direct" }]
}
EOF
chmod 600 /usr/local/etc/sing-box/config.json

# 配置先自检：不合法就带着报错原文回传，而不是等 systemd 起不来再猜。
if ! sing-box check -c /usr/local/etc/sing-box/config.json >/tmp/sb-check.log 2>&1; then
  FAILURE="config_invalid:$(tr '\\n' ' ' </tmp/sb-check.log | cut -c1-180)"
  exit 1
fi

# 6. systemd
cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box service
After=network.target nss-lookup.target network-online.target

[Service]
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/sing-box run -c /usr/local/etc/sing-box/config.json
Restart=on-failure
RestartSec=10s
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sing-box >/dev/null 2>&1
systemctl restart sing-box

# 7. 等它自己起来（起不来也照常回传，active=false）
for _ in $(seq 1 15); do
  if systemctl is-active --quiet sing-box; then break; fi
  sleep 2
done
if systemctl is-active --quiet sing-box; then
  ACTIVE=1
else
  ACTIVE=0
  # 没起来就把最后两行日志带上，否则回传里只有一个 false，什么也查不出。
  FAILURE="service_inactive:$(journalctl -u sing-box -n 2 --no-pager -o cat 2>/dev/null | tr '\\n' ' ' | cut -c1-160)"
fi

# 8. 上报
report || true
`;
}
