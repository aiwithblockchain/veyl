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
    fail_url: input.failUrl,
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
# 回传只带阶段、行号与截断后的 stderr；不含 token、配置内容或下载地址。
ERR_FILE=/tmp/veyl-cloud-init.err
: > "\${ERR_FILE}"
STAGE=download

on_error() {
  local line="\${1:-0}"
  local message
  message="$(head -c 300 "\${ERR_FILE}" 2>/dev/null | tr -d '\\\\"' | tr -d '\\000-\\037' || true)"
  curl -fsS --proto '=https' --tlsv1.2 -m 20 -X POST "\${FAIL_URL}" \\
    -H "authorization: Bearer \${ENROLL_TOKEN}" \\
    -H 'content-type: application/json' \\
    --data "{\\"stage\\":\\"\${STAGE}\\",\\"line\\":\${line},\\"error\\":\\"\${message}\\"}" \\
    >/dev/null 2>&1 || true
  exit 1
}
trap 'on_error \${LINENO}' ERR

# 1. 下载并校验 agent（版本 ${input.agent.version}）
# 极简镜像可能没有 curl / CA 证书：只补这一层，其它一律交给 agent。
: > "\${ERR_FILE}"
if ! command -v curl >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq 2>>"\${ERR_FILE}"
  apt-get install -y -qq curl ca-certificates 2>>"\${ERR_FILE}"
fi
# 计量依赖 nft 与 ip：镜像通常自带，缺了就让 agent 的启动探针 100% 失败，
# 所以在这里兜一层，而不是等建机后才发现。
if ! command -v nft >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq 2>>"\${ERR_FILE}"
  apt-get install -y -qq nftables iproute2 2>>"\${ERR_FILE}"
fi
curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 5 -o /tmp/veyl-agent "\${AGENT_URL}" 2>>"\${ERR_FILE}"
STAGE=checksum
: > "\${ERR_FILE}"
echo "\${AGENT_SHA256}  /tmp/veyl-agent" | sha256sum -c - >>"\${ERR_FILE}" 2>&1
STAGE=install
: > "\${ERR_FILE}"
install -m 0755 /tmp/veyl-agent /usr/local/bin/veyl-agent 2>>"\${ERR_FILE}"
rm -f /tmp/veyl-agent

# 2. 写 agent 配置（控制面地址、enroll URL、一次性 token）
STAGE=config
: > "\${ERR_FILE}"
mkdir -p /etc 2>>"\${ERR_FILE}"
install -m 600 /dev/null /etc/veyl-agent.json 2>>"\${ERR_FILE}"
cat > /etc/veyl-agent.json 2>>"\${ERR_FILE}" <<'VEYL_AGENT_CONFIG'
${config}
VEYL_AGENT_CONFIG
chmod 600 /etc/veyl-agent.json 2>>"\${ERR_FILE}"

# 3. systemd unit：root 运行、开机自启、失败重启
STAGE=systemd
: > "\${ERR_FILE}"
cat > /etc/systemd/system/veyl-agent.service 2>>"\${ERR_FILE}" <<'VEYL_AGENT_UNIT'
[Unit]
Description=Veyl node agent
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
Type=exec
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
systemctl daemon-reload 2>>"\${ERR_FILE}"
systemctl enable veyl-agent >/dev/null 2>&1
systemctl restart veyl-agent 2>>"\${ERR_FILE}"

# 6. 真的可用了才算装好：Type=exec 下单元在 execve 成功时就 active，早于 agent 的
#    计量探针，所以这里等 agent 自己写的就绪文件。探针最坏要 ~24 秒（三次重试 + 建表），
#    窗口给到 60 秒；期间没就绪就走 on_error 用**尚未消费的** token 销毁实例。
#    这一段的失败归 stage=ready：systemd 早就成功了，报成 systemd 会误导排查。
#    路径 /run/veyl-agent/ready 必须与 agent/src/agent.rs 的 READY_FILE 一致——
#    两边各有一份字面量，改一处忘一处就是 60 秒后建机失败。
STAGE=ready
for _ in $(seq 1 60); do
  if systemctl is-active --quiet veyl-agent && [ -f /run/veyl-agent/ready ]; then
    exit 0
  fi
  sleep 1
done
{
  echo "veyl-agent did not become ready within 60s"
  systemctl status veyl-agent --no-pager 2>&1 | tail -20
  journalctl -u veyl-agent -n 40 --no-pager 2>&1
} >>"\${ERR_FILE}" 2>&1
on_error \${LINENO}
`;
}
