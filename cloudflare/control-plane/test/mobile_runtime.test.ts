// 运行期语义：`sing-box check` 只做静态校验，这份 profile 曾经静态通过、启动就 FATAL
// （`dns/udp[dns-cn]: detour to an empty direct outbound makes no sense`）。
// 这里把非零 profile 交给随包真实内核跑几秒，启动失败会以非零码退出。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { singboxConfig } from "../src/mobile";

/** 随包二进制；路径相对本测试文件，避免依赖 cwd。 */
const SING_BOX = new URL("../../../src-tauri/resources/runtime/sing-box", import.meta.url).pathname;
const ASSETS = new URL("../assets/rules/", import.meta.url).pathname;

interface Outcome {
  /** running：到点仍在跑；exited：提前退出。 */
  result: "running" | "exited";
  code: number | null;
  stderr: string;
  spawnError: Error | null;
}

function runFor(configPath: string, milliseconds: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(SING_BOX, ["run", "-c", configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    child.stderr?.on("data", (chunk) => {
      stderr += new TextDecoder().decode(chunk);
    });
    child.on("error", (error) => {
      finish({ result: "exited", code: null, stderr, spawnError: error });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ result: "running", code: null, stderr, spawnError: null });
    }, milliseconds);
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ result: "exited", code, stderr, spawnError: null });
    });
  });
}

describe("sing-box 运行期语义", () => {
  it("非零 profile 启动后不会立即退出", async (context) => {
    // 二进制不在（或换了平台/架构跑不起来）就跳过：这条是运行期冒烟，不该变成 CI 假红。
    if (!existsSync(SING_BOX)) return context.skip();

    const config = singboxConfig(
      [{ tag: "香港 01", host: "198.51.100.10", port: 8388, password: "node-password" }],
      "https://cp.example.com",
    ) as {
      inbounds?: unknown;
      route: { rule_set: unknown };
    };
    // 测试环境没有 root，TUN 建不起来（`configure tun interface: operation not permitted`）；
    // 这与本次要抓的 DNS 启动语义无关，去掉 inbounds。
    delete config.inbounds;
    // 规则集改成本地文件：测试不联网，remote 下载失败会先把启动卡在别的错误上。
    config.route.rule_set = [
      {
        tag: "geosite-cn",
        type: "local",
        format: "binary",
        path: join(ASSETS, "geosite-cn.srs"),
      },
      { tag: "geoip-cn", type: "local", format: "binary", path: join(ASSETS, "geoip-cn.srs") },
    ];
    // 出站服务器是 IP，启动阶段不会真的拨号。

    const dir = mkdtempSync(join(tmpdir(), "veyl-singbox-"));
    const configPath = join(dir, "profile.json");
    writeFileSync(configPath, JSON.stringify(config));
    try {
      const outcome = await runFor(configPath, 3000);
      if (outcome.spawnError) return context.skip();
      expect(outcome.result, outcome.stderr).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
