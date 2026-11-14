// cloud-init：在服务器上自己装 sing-box（不依赖外部安装脚本）。
// 端口由控制面选定并写死；密码只在这台机器上生成，只经 enrollment 回传。
// 上限 64 KiB（DigitalOcean user_data 的限制），当前约 3 KB。

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

# 1. 先关掉 SSH：我们永远不登录服务器，也没有 root 密码通道。
systemctl stop ssh 2>/dev/null || systemctl stop sshd 2>/dev/null || true
systemctl disable ssh 2>/dev/null || systemctl disable sshd 2>/dev/null || true

# 2. 基础工具
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq curl ca-certificates tar >/dev/null 2>&1

# 3. 下载并校验 sing-box
cd /tmp
curl -fsSL -o sb.tar.gz "https://github.com/SagerNet/sing-box/releases/download/v\${SING_BOX_VERSION}/sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}.tar.gz"
echo "\${SING_BOX_SHA256}  sb.tar.gz" | sha256sum -c -
tar -xzf sb.tar.gz
install -m 0755 "sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}/sing-box" /usr/local/bin/sing-box
rm -rf sb.tar.gz "sing-box-\${SING_BOX_VERSION}-linux-\${ARCH}"

# 4. 密码在这台机器上生成，不经过 user_data、不经过控制面明文存储
PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)

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
      "password": "\${PASSWORD}",
      "multiplex": { "enabled": false }
    }
  ],
  "outbounds": [{ "type": "direct" }]
}
EOF
chmod 600 /usr/local/etc/sing-box/config.json

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

# 7. 等它自己起来；起不来也要回传，让控制面知道失败
for _ in $(seq 1 15); do
  if systemctl is-active --quiet sing-box; then break; fi
  sleep 2
done
ACTIVE=0
systemctl is-active --quiet sing-box && ACTIVE=1 || ACTIVE=0

# 8. 上报（退避重试，失败不影响机器运行）
for attempt in 1 2 3 4 5 6 7 8; do
  if curl -fsS -X POST "\${ENROLL_URL}" \\
      -H 'content-type: application/json' \\
      --data "{\\"port\\":\${PORT},\\"password\\":\\"\${PASSWORD}\\",\\"version\\":\\"\${SING_BOX_VERSION}\\",\\"active\\":\${ACTIVE}}" \\
      >/dev/null; then
    break
  fi
  sleep $((attempt * 15))
done
`;
}
