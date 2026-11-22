// @ts-nocheck
// 这个文件用 Node 的 child_process 跑 `bash -n`，而本项目的 tsconfig 只声明了
// Cloudflare 类型（没有 Node 类型）。为了不把 node globals 引入 Worker 代码，
// 只在这个测试文件里关掉类型检查。
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { buildCloudInit } from "../src/cloud_init";

const INPUT = {
  enrollToken: "enr_tok_test",
  enrollUrl: "https://cp-dev.example.com/v1/agent/enroll",
  failUrl: "https://cp-dev.example.com/v1/agent/fail",
  controlUrl: "https://cp-dev.example.com",
  agent: {
    version: "0.1.0",
    sha256: "abc123def456",
    url: "https://cp-dev.example.com/veyl-agent-v0.1.0-linux-amd64",
  },
};

const script = () => buildCloudInit(INPUT);

describe("cloud-init（只装 agent）", () => {
  it("是合法 bash", () => {
    expect(() => execFileSync("bash", ["-n"], { input: script() })).not.toThrow();
  });

  it("下载 agent 并按配置的 sha256 校验后安装", () => {
    const body = script();
    expect(body).toContain('AGENT_URL="https://cp-dev.example.com/veyl-agent-v0.1.0-linux-amd64"');
    expect(body).toContain('AGENT_SHA256="abc123def456"');
    expect(body).toContain('echo "${AGENT_SHA256}  /tmp/veyl-agent" | sha256sum -c -');
    expect(body).toContain("install -m 0755 /tmp/veyl-agent /usr/local/bin/veyl-agent");
  });

  it("写 agent 配置：控制面地址、enroll URL、一次性 token", () => {
    const body = script();
    const configLine = body
      .split("\n")
      .find((line) => line.includes('"control_url"'));
    expect(configLine).toBeTruthy();
    const config = JSON.parse(configLine!);
    expect(config).toEqual({
      control_url: "https://cp-dev.example.com",
      enroll_url: "https://cp-dev.example.com/v1/agent/enroll",
      enroll_token: "enr_tok_test",
    });
    expect(body).toContain("chmod 600 /etc/veyl-agent.json");
  });

  it("装 systemd unit：root 运行、开机自启、失败重启", () => {
    const body = script();
    expect(body).toContain("ExecStart=/usr/local/bin/veyl-agent --config /etc/veyl-agent.json");
    expect(body).toContain("Restart=on-failure");
    expect(body).toContain("WantedBy=multi-user.target");
    expect(body).toContain("systemctl enable veyl-agent");
    expect(body).toContain("systemctl restart veyl-agent");
  });

  it("不再装 sing-box、不再生成密码、不再回传阶段（这些归 agent）", () => {
    const body = script();
    expect(body).not.toContain("sing-box");
    expect(body).not.toContain("od -An -tx1");
    expect(body).not.toContain("report_progress");
    expect(body).not.toContain("/v1/enroll/");
  });

  it("任何一步失败都调用 /v1/agent/fail 回传", () => {
    const body = script();
    expect(body).toContain('FAIL_URL="https://cp-dev.example.com/v1/agent/fail"');
    expect(body).toContain("trap 'on_error ${LINENO}' ERR");
    expect(body).toContain('authorization: Bearer ${ENROLL_TOKEN}');
  });

  it("失败回传带阶段、行号与截断后的 stderr，且不含凭据", () => {
    const body = script();
    for (const stage of ["download", "checksum", "install", "config", "systemd"]) {
      expect(body).toContain(`STAGE=${stage}`);
    }
    expect(body).toContain('head -c 300');
    expect(body).toContain('2>>"${ERR_FILE}"');
    // sha256sum 的失败信息走 stdout，必须一并收进现场文件。
    expect(body).toContain('sha256sum -c - >>"${ERR_FILE}" 2>&1');
    const dataLine = body.split("\n").find((line) => line.includes("--data"));
    expect(dataLine).toBeTruthy();
    expect(dataLine).toContain('\\"stage\\"');
    expect(dataLine).toContain('\\"line\\"');
    expect(dataLine).toContain('\\"error\\"');
    // 凭据只走 Authorization 头，绝不进 body。
    expect(dataLine).not.toContain("ENROLL_TOKEN");
    expect(dataLine).not.toContain("enr_tok_test");
  });

  it("关掉 SSH：agent 不需要它，console 才是带外入口", () => {
    const body = script();
    expect(body).toContain("systemctl stop ssh");
    expect(body).toContain("systemctl disable ssh");
  });

  it("启动后确认 agent 真的 active，否则把 unit 状态回传", () => {
    const body = script();
    expect(body).toContain("systemctl is-active --quiet veyl-agent");
    expect(body).toContain("veyl-agent did not become active within 30s");
    expect(body).toContain("journalctl -u veyl-agent -n 40 --no-pager");
    // 失败时走同一个 trap，控制面能拿到 stage=systemd 与 journal 摘要。
    expect(body).toContain("on_error ${LINENO}");
  });

  it("配置文件先以 600 建出来，脚本以 umask 077 起步", () => {
    const body = script();
    expect(body).toContain("umask 077");
    expect(body).toContain("install -m 600 /dev/null /etc/veyl-agent.json");
    // 先建文件再写，chmod 只作为兜底保留。
    expect(body.indexOf("install -m 600 /dev/null")).toBeLessThan(
      body.indexOf("cat > /etc/veyl-agent.json"),
    );
  });

  it("下载与失败回传都锁定 https + TLS 1.2", () => {
    const body = script();
    expect(body).toContain("curl -fsSL --proto '=https' --tlsv1.2 --retry 5");
    expect(body).toContain("curl -fsS --proto '=https' --tlsv1.2 -m 20");
  });

  it("插值只接受白名单字符：注入字符、非 https、换行一律拒绝", () => {
    expect(() => buildCloudInit({ ...INPUT, enrollToken: "enr_$(id)" })).toThrow(/unsafe/);
    expect(() => buildCloudInit({ ...INPUT, enrollToken: "enr_`id`" })).toThrow(/unsafe/);
    expect(() => buildCloudInit({ ...INPUT, enrollUrl: "https://x/$(id)" })).toThrow(/unsafe/);
    expect(() =>
      buildCloudInit({ ...INPUT, agent: { ...INPUT.agent, url: 'https://x/";id;#' } }),
    ).toThrow(/unsafe/);
    expect(() =>
      buildCloudInit({ ...INPUT, agent: { ...INPUT.agent, version: "1.0\nrm -rf /" } }),
    ).toThrow(/unsafe/);
    expect(() =>
      buildCloudInit({ ...INPUT, controlUrl: "http://insecure.example.com" }),
    ).toThrow(/unsafe/);
  });
});
