import { describe, expect, it } from "vitest";
import { settingsOverviewPrompt, type SettingsOverviewSnapshot } from "./settingsOverview";

function snapshot(over: Partial<SettingsOverviewSnapshot> = {}): SettingsOverviewSnapshot {
  return {
    connection: {
      connectMode: "system_proxy",
      routingMode: null,
      proxyPort: 7890,
      portFallback: null,
      runtimeState: "idle",
      cleanupProxyAvailable: false,
      hasConfig: true,
      seed: { nodeCount: 12, version: "2026.11.18", newVersionAvailable: false },
      ...over.connection,
    },
    ai: { providers: [], ...over.ai },
    account: { loggedIn: false, email: null, balanceCents: null, ...over.account },
    advanced: { includeDomains: false, appVersion: "0.1.0", helper: null, ...over.advanced },
  };
}

describe("settingsOverviewPrompt", () => {
  it("全默认：Proxy + 智能 + 报告关，标默认、不写不存在的分区", () => {
    const text = settingsOverviewPrompt(snapshot());

    expect(text).toContain("接管方式：Proxy 模式（默认）");
    expect(text).toContain("流量范围：智能（默认）");
    expect(text).toContain("本地代理端口：127.0.0.1:7890");
    expect(text).toContain("当前连接：未连接");
    expect(text).toContain("免费节点：12 个，包版本 2026.11.18");
    expect(text).toContain("域名写入报告：关（默认）");
    expect(text).toContain("## 账户");
    expect(text).toContain("- 未登录");
    // 没有的东西不写：Tun、顺延、AI 服务、清除残留代理。
    expect(text).not.toContain("Tun 模式");
    expect(text).not.toContain("顺延");
    expect(text).not.toContain("## AI");
    expect(text).not.toContain("清除残留代理");
  });

  it("Proxy 已连接且端口顺延：连接状态、顺延原因、AI 与余额照实写", () => {
    const text = settingsOverviewPrompt(
      snapshot({
        connection: {
          connectMode: "system_proxy",
          routingMode: "proxy_all",
          proxyPort: 7890,
          portFallback: { requested: 7890, actual: 7891, reason: "occupied" },
          runtimeState: "running",
          hasConfig: true,
          seed: {
            nodeCount: 32,
            version: "2026.11.19",
            newVersionAvailable: true,
          },
        },
        ai: {
          providers: [
            {
              name: "DeepSeek",
              model: "deepseek-chat",
              baseUrl: "https://api.deepseek.com",
              hasKey: true,
              isActive: true,
            },
          ],
        },
        account: {
          loggedIn: true,
          email: "someone@example.com",
          balanceCents: 1230,
        },
        advanced: {
          includeDomains: true,
          appVersion: "0.2.0",
          helper: { state: "running", version: "1.2.3" },
        },
      }),
    );

    expect(text).toContain("流量范围：全局");
    expect(text).not.toContain("流量范围：智能");
    expect(text).toContain("当前连接：已连接");
    expect(text).toContain("顺延到 7891（端口被占用）");
    expect(text).toContain("免费节点：32 个，包版本 2026.11.19，有新版本可以更新");
    expect(text).toContain("当前服务：DeepSeek（模型 deepseek-chat，https://api.deepseek.com，已保存 Key）");
    expect(text).toContain("服务总数：1 个");
    expect(text).toContain("已登录：someone@example.com");
    expect(text).toContain("余额：$12.30");
    expect(text).toContain("域名写入报告：开");
    expect(text).not.toContain("域名写入报告：关");
    expect(text).toContain("后台组件：已是最新（1.2.3）");
  });

  it("Tun 未连接：没有端口行与免费节点，接管方式不标默认", () => {
    const text = settingsOverviewPrompt(
      snapshot({
        connection: {
          connectMode: "tun",
          routingMode: "direct",
          proxyPort: 7890,
          runtimeState: "idle",
          cleanupProxyAvailable: true,
          hasConfig: false,
          seed: null,
        },
      }),
    );

    expect(text).toContain("接管方式：Tun 模式");
    expect(text).not.toContain("Tun 模式（默认）");
    expect(text).not.toContain("Proxy 模式");
    expect(text).not.toContain("本地代理端口");
    expect(text).not.toContain("免费节点");
    expect(text).not.toContain("节点导入");
    expect(text).toContain("清除残留代理：可用");
    expect(text).toContain("当前连接：未连接");
    // 没有 AI / 没有配置时也不臆造分区。
    expect(text).not.toContain("## AI");
  });
});
