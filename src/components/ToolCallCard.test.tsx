/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../state/chatStore";
import { ToolCallCard } from "./ToolCallCard";

afterEach(cleanup);

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "call_1",
    tool: "VpnConnect",
    action: "连接 seed-jp-01",
    permissionLevel: "execute",
    source: "agent",
    state: "ok",
    nextActions: [],
    startedAt: 1000,
    ...overrides,
  };
}

function renderCard(overrides: Partial<ToolCall> = {}) {
  const onNextAction = vi.fn();
  render(<ToolCallCard call={call(overrides)} onNextAction={onNextAction} />);
  return { onNextAction };
}

describe("ToolCallCard：默认一行", () => {
  it("只显示用户文案，不显示工具名、action 与 JSON", () => {
    renderCard({
      display: { text: "已连接", facts: [], changed: "none" },
      result: "已连接到 东京 01，出口 IP 203.0.113.7。",
      argsPreview: { node_id: "seed-jp-01" },
    });

    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.queryByText("VpnConnect")).toBeNull();
    expect(screen.queryByText("连接 seed-jp-01")).toBeNull();
    expect(screen.queryByText(/seed-jp-01/)).toBeNull();
  });

  it("后端没有 display 时用静态完成文案", () => {
    renderCard({ tool: "RuntimeStatus", state: "ok" });
    expect(screen.getByText("已查看连接状态")).toBeTruthy();
  });

  it("进行中只显示当前一句", () => {
    renderCard({ tool: "RuntimeStatus", state: "running" });
    expect(screen.getByText("正在检查连接状态")).toBeTruthy();
    expect(screen.queryByText(/完成|失败/)).toBeNull();
  });

  it("未映射工具进行中、完成、失败都有用户兜底", () => {
    const { unmount } = render(
      <ToolCallCard call={call({ tool: "FooBar", state: "running" })} onNextAction={vi.fn()} />,
    );
    expect(screen.getByText("正在处理…")).toBeTruthy();
    unmount();

    const done = render(
      <ToolCallCard call={call({ tool: "FooBar", state: "ok" })} onNextAction={vi.fn()} />,
    );
    expect(screen.getByText("已完成", { selector: ".tool-line__text" })).toBeTruthy();
    expect(screen.queryByText("FooBar")).toBeNull();
    done.unmount();

    render(<ToolCallCard call={call({ tool: "FooBar", state: "error" })} onNextAction={vi.fn()} />);
    expect(screen.getByText("没成功")).toBeTruthy();
    expect(screen.queryByText("FooBar")).toBeNull();
  });

  it("用时不足 3 秒不显示，≥3 秒显示一位小数", () => {
    const short = render(
      <ToolCallCard call={call({ durationMs: 2999 })} onNextAction={vi.fn()} />,
    );
    expect(screen.queryByText(/用时/)).toBeNull();
    short.unmount();

    render(<ToolCallCard call={call({ durationMs: 3200 })} onNextAction={vi.fn()} />);
    expect(screen.getByText("用时 3.2 秒")).toBeTruthy();
  });
});

describe("ToolCallCard：展开详情", () => {
  it("按配置、节点、出口、延迟、用时排序，来源仅 UI 发起时显示", () => {
    renderCard({
      source: "ui",
      durationMs: 800,
      display: {
        text: "已连接",
        facts: [
          { label: "配置", value: "公司" },
          { label: "节点", value: "东京 01" },
          { label: "出口", value: "203.0.113.7" },
          { label: "延迟", value: "42 毫秒" },
        ],
        changed: null,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /已连接/ }));

    expect(screen.getByText("公司")).toBeTruthy();
    expect(screen.getByText("东京 01")).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("42 毫秒")).toBeTruthy();
    expect(screen.getByText("800 毫秒")).toBeTruthy();
    expect(screen.getByText("从设置页发起")).toBeTruthy();
  });

  it("对话发起时不显示来源", () => {
    renderCard({ source: "agent", display: { text: "已连接", facts: [], changed: null } });
    fireEvent.click(screen.getByRole("button", { name: /已连接/ }));
    expect(screen.queryByText("从设置页发起")).toBeNull();
  });

  it("技术细节隐藏原始工具名与参数，点开后才出现", () => {
    renderCard({
      display: { text: "已连接", facts: [], changed: null },
      argsPreview: { node_name: "东京 01" },
      result: "已连接到 东京 01。",
      errorCode: null,
    });

    fireEvent.click(screen.getByRole("button", { name: /已连接/ }));
    expect(screen.queryByText("VpnConnect")).toBeNull();
    expect(screen.queryByText(/node_name/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "技术细节" }));
    expect(screen.getByText("VpnConnect")).toBeTruthy();
    expect(screen.getByText(/"node_name"/)).toBeTruthy();
    expect(screen.getByText("已连接到 东京 01。")).toBeTruthy();
  });

  it("有技术数据时才出现技术细节按钮", () => {
    renderCard({
      durationMs: 800,
      result: undefined,
      argsPreview: undefined,
      errorCode: null,
      display: { text: "已连接", facts: [], changed: null },
    });
    fireEvent.click(screen.getByRole("button", { name: /已连接/ }));
    expect(screen.queryByRole("button", { name: "技术细节" })).toBeNull();
  });

  it("next_actions 只在展开后出现，点击交给调用方", () => {
    const { onNextAction } = renderCard({
      state: "error",
      display: { text: "节点没有响应，没能连上", facts: [], changed: "none" },
      nextActions: [{ label: "换一个节点", tool: "CatalogSearch", args: { region: "jp" } }],
    });

    expect(screen.queryByRole("button", { name: "换一个节点" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /节点没有响应/ }));
    const action = screen.getByRole("button", { name: "换一个节点" });
    fireEvent.click(action);
    expect(onNextAction).toHaveBeenCalledWith(
      expect.objectContaining({ label: "换一个节点" }),
    );
  });
});

describe("ToolCallCard：失败", () => {
  it("展开固定三行，错误码只在技术细节里", () => {
    renderCard({
      state: "error",
      errorCode: "NODE_UNREACHABLE",
      result: "节点 东京 01 连接超时。",
      display: { text: "节点没有响应，没能连上", facts: [], changed: "none" },
      nextActions: [{ label: "换一个节点", tool: "CatalogSearch", args: {} }],
    });

    expect(screen.getByText("节点没有响应，没能连上")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /节点没有响应/ }));

    expect(screen.getByText("发生了什么")).toBeTruthy();
    expect(screen.getByText("有没有改动")).toBeTruthy();
    expect(screen.getByText("现在能做什么")).toBeTruthy();
    expect(screen.getByText("没有改动任何设置")).toBeTruthy();
    expect(screen.getByText("换一个节点", { selector: "dd" })).toBeTruthy();
    expect(screen.queryByText("NODE_UNREACHABLE")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "技术细节" }));
    expect(screen.getByText("NODE_UNREACHABLE")).toBeTruthy();
  });

  it("changed 为 restored 时说明已恢复原样", () => {
    renderCard({
      tool: "NetRepair",
      state: "error",
      display: { text: "没能恢复网络", facts: [], changed: "restored" },
    });
    fireEvent.click(screen.getByRole("button", { name: /没能恢复网络/ }));
    expect(screen.getByText("已经恢复原样")).toBeTruthy();
  });

  it("只读工具没有 changed 时固定没有改动", () => {
    renderCard({
      tool: "RuntimeStatus",
      state: "error",
      display: { text: "读不到连接状态", facts: [], changed: null },
    });
    fireEvent.click(screen.getByRole("button", { name: /读不到连接状态/ }));
    expect(screen.getByText("没有改动任何设置")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制诊断信息" })).toBeNull();
  });

  it("改动不确定时只说明诊断日志里有记录，不塞复制按钮", () => {
    renderCard({
      state: "error",
      errorCode: "INTERNAL",
      result: "写入失败",
      argsPreview: { config_name: "公司" },
      display: { text: "没能保存配置", facts: [], changed: null },
    });

    fireEvent.click(screen.getByRole("button", { name: /没能保存配置/ }));
    expect(screen.getByText("不确定，诊断日志里有记录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制诊断信息" })).toBeNull();
  });
});
