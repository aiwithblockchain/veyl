/** @vitest-environment jsdom */
// @ts-expect-error 测试跑在 Node 里；项目 tsconfig 只带浏览器类型（vite/client），没有 @types/node。
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, LlmProvider } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { Settings } from "./Settings";

afterEach(cleanup);

/**
 * jsdom 不加载样式表，尺寸类规则只能从源文件断言；
 * 这里只钉住本轮评审明确给出的值，避免以后被顺手改回去。
 */
const css = readFileSync("src/styles/app.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `缺少规则 ${selector}`).not.toBeNull();
  return match![1];
}

function expectDecls(selector: string, ...decls: string[]) {
  const body = rule(selector);
  for (const decl of decls) expect(body).toContain(decl);
}

describe("设置三页的布局规则", () => {
  it("只保留一层内边距：pane 归零，section 给 20/24", () => {
    expectDecls(".settings-pane", "padding: 0");
    expectDecls(".settings-section", "padding: 20px 24px");
    // 内容列宽度由这两层决定；弹层右侧另留 4，给滚动条让位。
    expectDecls(".settings-body", "padding-right: 4px");
  });

  it("滚动条内收 4、宽 12、4px 透明边、槽位常驻", () => {
    expectDecls(".settings-pane", "scrollbar-gutter: stable");
    expectDecls(".settings-pane::-webkit-scrollbar", "width: 12px");
    expectDecls(
      ".settings-pane::-webkit-scrollbar-thumb",
      "border: 4px solid transparent",
      "background-clip: padding-box",
    );
  });

  it("按钮不折行，行内按钮不被压缩，生成问题报告最小宽 96", () => {
    expectDecls(".btn", "white-space: nowrap");
    expectDecls(".settings-row > .btn", "flex: 0 0 auto");
    expectDecls(".settings-row__btn--wide", "min-width: 96px");
  });

  it("重置网络危险卡：圆角 10、正文 13、按钮右下、上一行不画分隔线", () => {
    expectDecls(".danger-zone", "border-radius: var(--r-md)", "margin-top: 20px");
    expectDecls(".danger-zone .settings-row__value", "font-size: 13px", "color: var(--ink-2)");
    expectDecls(".danger-zone > .btn", "align-self: flex-end");
    expectDecls(".settings-row:has(+ .danger-zone)", "border-bottom: 0");
  });

  it("AI 卡选中态是左侧竖条；动作行 12/500、gap 16、删除靠右", () => {
    const active = rule(".provider-item.is-active");
    expect(active).toContain("box-shadow: inset 2px 0 0 var(--link)");
    expect(active).not.toContain("--signal-line");
    expectDecls(".provider-item__badge", "border: 0", "font-weight: 500");
    expectDecls(".provider-item__actions", "gap: 16px");
    expectDecls(".provider-item__btn", "font-size: 12px", "padding: 6px 0");
    expectDecls(
      ".provider-item__btn--danger",
      "margin-left: auto",
      "color: var(--err-text)",
    );
  });
});

function makeBridge(providers: LlmProvider[] = []): AgentBridge {
  return {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    coreInfo: vi.fn(async () => ({
      bundledVersion: "1.14.4",
      activeVersion: "1.14.4",
      activeSource: "bundled" as const,
      restartRequired: false,
    })),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: null,
      helperVersion: null,
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
    })),
    coreCheckUpdates: vi.fn(async () => ({
      network: "ok" as const,
      candidates: [],
      cached: false,
    })),
    getDeepSeekKey: vi.fn(async () => ({
      masked: null,
      verified: false,
      validation: "unverified",
    })),
    llmProviderList: vi.fn(async () => ({
      providers,
      activeProviderId: providers.find((provider) => provider.isActive)?.providerId ?? null,
    })),
    getAppVersion: vi.fn(async () => "0.1.0"),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
    issueReportPreference: vi.fn(async (includeDomains?: boolean) => ({
      includeDomains: includeDomains ?? false,
    })),
  } as unknown as AgentBridge;
}

const PROVIDERS: LlmProvider[] = [
  {
    providerId: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "",
    model: "deepseek-flash",
    hasKey: true,
    isActive: true,
    isBuiltin: true,
  },
  {
    providerId: "custom",
    name: "我的服务",
    protocol: "openai",
    baseUrl: "https://api.example.com",
    model: "gpt-4o",
    hasKey: true,
    isActive: false,
    isBuiltin: false,
  },
];

function renderSection(
  bridge: AgentBridge,
  section: "ai" | "network" | "account" | "advanced",
) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      onClose={() => {}}
      onNotice={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onReportProblem={() => {}}
      onAskAi={() => {}}
      initialSection={section}
    />,
  );
}

describe("设置三页的 DOM 结构", () => {
  it("只有一层内容列：settings-pane 里直接是 settings-section", () => {
    const { container } = renderSection(makeBridge(), "advanced");
    const pane = container.querySelector(".settings-pane");
    expect(pane).not.toBeNull();
    expect(pane?.querySelector(".settings-section")).not.toBeNull();
    expect(container.querySelectorAll(".settings-section")).toHaveLength(1);
  });

  it("生成问题报告：文案不变，带最小宽类", () => {
    renderSection(makeBridge(), "advanced");
    const button = screen.getByRole("button", { name: "生成问题报告" });
    expect(button.className).toContain("settings-row__btn--wide");
    expect(button.className).toContain("btn");
  });

  it("危险卡：按钮是卡片内的直接子元素（右下定位的前提）", () => {
    const { container } = renderSection(makeBridge(), "advanced");
    const zone = container.querySelector(".danger-zone");
    expect(zone).not.toBeNull();
    const button = Array.from(zone?.children ?? []).find((child) =>
      child.classList.contains("btn"),
    );
    expect(button?.textContent).toBe("重置网络");
  });

  it("AI 卡：选中的卡只有一个 is-active，当前是纯文字、内置仍是灰 chip", async () => {
    const { container } = renderSection(makeBridge(PROVIDERS), "ai");
    await screen.findByText("我的服务");

    const cards = Array.from(container.querySelectorAll(".provider-item"));
    expect(cards).toHaveLength(2);
    expect(cards.filter((card) => card.classList.contains("is-active"))).toHaveLength(1);

    const active = cards[0] as HTMLElement;
    const badge = active.querySelector(".provider-item__badge");
    expect(badge?.textContent).toBe("当前");
    const tag = active.querySelector(".provider-item__tag");
    expect(tag?.textContent).toBe("内置");

    // 模块化的删除动作：文本按钮 + 危险色，不再是描边按钮。
    const deletes = screen.getAllByRole("button", { name: "删除" });
    expect(deletes).toHaveLength(2);
    expect(deletes[1].className).toContain("provider-item__btn--danger");
    expect(deletes[1].className).not.toContain("btn--danger-ghost");
    expect((deletes[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
