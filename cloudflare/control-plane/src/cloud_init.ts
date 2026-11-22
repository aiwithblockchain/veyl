// cloud-init：只负责把节点 agent 装上并启动（node-agent-mcp.md §4）。
// sing-box 的安装、配置与三阶段上报全部交给 agent；这里不再生成任何凭据。
// 上限 64 KiB（DigitalOcean user_data 的限制），当前约 1.5 KB。

export interface AgentInstallInput {
  /** 一次性 enrollment token；agent 用它换长期 server_token 与期望状态。 */
  enrollToken: string;
  /** `POST /v1/agent/enroll` 的完整地址。 */
  enrollUrl: string;
  /** `POST /v1/agent/fail` 的完整地址：装机失败时由 trap 回传，控制面据此销毁。 */
  failUrl: string;
  /** 控制面根地址：agent 后续拉期望状态、上报都基于它。 */
  controlUrl: string;
  /** agent 二进制的下载地址、sha256 与版本（控制面配置下发）。 */
  agent: { version: string; sha256: string; url: string };
}

// 这些值会被拼进 shell 脚本：只放行白名单字符，不合法直接拒绝，绝不尝试转义。
const URL_SAFE = /^https:\/\/[A-Za-z0-9:/._\-?=&%~]+$/;
const TOKEN_SAFE = /^[A-Za-z0-9_-]+$/;
const VERSION_SAFE = /^[0-9A-Za-z._-]{1,32}$/;

function assertSafe(name: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`unsafe cloud-init value: ${name}`);
  }
}

export function buildCloudInit(input: AgentInstallInput): string {
  assertSafe("enrollToken", input.enrollToken, TOKEN_SAFE);
  assertSafe("enrollUrl", input.enrollUrl, URL_SAFE);
  assertSafe("failUrl", input.failUrl, URL_SAFE);
  assertSafe("controlUrl", input.controlUrl, URL_SAFE);
  assertSafe("agent.sha256", input.agent.sha256, TOKEN_SAFE);
  assertSafe("agent.version", input.agent.version, VERSION_SAFE);
  assertSafe("agent.url", input.agent.url, URL_SAFE);

  // JSON.stringify 负责转义；单引号 heredoc 阻止 shell 展开，token/URL 里的 `$` 不会被吃掉。
  const config = JSON.stringify({
    control_url: input.controlUrl,
    enroll_url: input.enrollUrl,
    enroll_token: input.enrollToken,
  });

  return `#!/bin/bash
set -euo pipefail
# 配置文件里有一次性 token：从这里开始新建文件默认 600，消除 chmod 前的可读窗口。
umask 077

ENROLL_TOKEN="${input.enrollToken}"
FAIL_URL="${input.failUrl}"
AGENT_URL="${input.agent.url}"
AGENT_SHA256="${input.agent.sha256}"

# 任何一步失败都立即回传：控制面据此销毁这台机器，不留「在计费但没装好」的实例。
on_error() {
  curl -fsS --proto '=https' --tlsv1.2 -m 20 -X POST "\${FAIL_URL}" \\
    -H "authorization: Bearer \${ENROLL_TOKEN}" >/dev/null 2>&1 || true
  exit 1
}
trap 'on_error \${LINENO}' ERR

# 1. 下载并校验 agent（版本 ${input.agent.version}）
# 极简镜像可能没有 curl / CA 证书：只补这一层，其它一律交给 agent。
if ! command -v curl >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates
fi
curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 5 -o /tmp/veyl-agent "\${AGENT_URL}"
echo "\${AGENT_SHA256}  /tmp/veyl-agent" | sha256sum -c -
install -m 0755 /tmp/veyl-agent /usr/local/bin/veyl-agent
rm -f /tmp/veyl-agent

# 2. 写 agent 配置（控制面地址、enroll URL、一次性 token）
mkdir -p /etc
install -m 600 /dev/null /etc/veyl-agent.json
cat > /etc/veyl-agent.json <<'VEYL_AGENT_CONFIG'
${config}
VEYL_AGENT_CONFIG
chmod 600 /etc/veyl-agent.json

# 3. systemd unit：root 运行、开机自启、失败重启
cat > /etc/systemd/system/veyl-agent.service <<'VEYL_AGENT_UNIT'
[Unit]
Description=Veyl node agent
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/veyl-agent --config /etc/veyl-agent.json
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
VEYL_AGENT_UNIT

# 4. 关掉 SSH：我们永远不登录服务器，console 是唯一的带外入口。
systemctl stop ssh 2>/dev/null || systemctl stop sshd 2>/dev/null || true
systemctl disable ssh 2>/dev/null || systemctl disable sshd 2>/dev/null || true

# 5. 启动
systemctl daemon-reload
systemctl enable veyl-agent >/dev/null 2>&1
systemctl restart veyl-agent
`;
}
