// @ts-nocheck
// 这个文件用 Node 的 child_process 跑 `bash -n`，而本项目的 tsconfig 只声明了
// Cloudflare 类型（没有 Node 类型）。为了不把 node globals 引入 Worker 代码，
// 只在这个测试文件里关掉类型检查。
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { buildCloudInit } from "../src/cloud_init";

const script = () =>
  buildCloudInit({ port: 20443, enrollUrl: "https://cp-dev.example.com/v1/enroll/tok_test" });

describe("cloud-init", () => {
  it("是合法 bash", () => {
    expect(() => execFileSync("bash", ["-n"], { input: script() })).not.toThrow();
  });

  it("生成密码不用会触发 SIGPIPE 的 head -c（pipefail 会直接杀掉脚本）", () => {
    expect(script()).not.toMatch(/head -c/);
    expect(script()).toContain("od -An -tx1");
  });

  it("任何一步失败都会回传，而不是静默退出", () => {
    const body = script();
    expect(body).toContain("trap 'on_error ${LINENO}' ERR");
    expect(body).toContain("${ACTIVE}");
    expect(body).toContain("${FAILURE}");
  });

  it("起服务前先做配置自检，失败带原文回传", () => {
    const body = script();
    expect(body).toContain("sing-box check -c /usr/local/etc/sing-box/config.json");
    expect(body).toContain("config_invalid:");
    expect(body).toContain("service_inactive:");
  });

  it("回传的 active 是 JSON 布尔，不是数字", () => {
    const body = script();
    expect(body).toContain("active_json=true");
    expect(body).toContain("active_json=false");
    expect(body).not.toContain('\\"active\\":${ACTIVE}');
  });

  it("端口与回传地址按参数写入", () => {
    const body = script();
    expect(body).toContain("PORT=20443");
    expect(body).toContain('ENROLL_URL="https://cp-dev.example.com/v1/enroll/tok_test"');
  });
});
