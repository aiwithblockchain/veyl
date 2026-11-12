/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, TunHelperInfo, TunHelperState } from "../agent/bridge";
import { TunHelperRow, useTunHelper } from "./TunHelper";

afterEach(cleanup);

function helperInfo(state: TunHelperState, extra: Partial<TunHelperInfo> = {}): TunHelperInfo {
  return {
    runningBuild: state === "running" ? "2026.11.1" : null,
    helperVersion: state === "running" ? "2026.11.1" : null,
    expectedBuild: "2026.11.1",
    stale: state === "stale",
    state,
    needsAdminRestart: false,
    ...extra,
  };
}

function harness(
  info: TunHelperInfo,
  {
    active = false,
    overrides = {},
  }: {
    active?: boolean;
    overrides?: Partial<Record<keyof AgentBridge, unknown>>;
  } = {},
) {
  const bridge = {
    mode: "mock",
    tunHelperInfo: vi.fn(async () => info),
    tunHelperRestart: vi.fn(async () => ({
      ok: true,
      restarted: true,
      needsAdminRestart: false,
    })),
    tunHelperOpenSettings: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AgentBridge;

  function Harness() {
    const controller = useTunHelper({ bridge, enabled: true });
    return <TunHelperRow controller={controller} activeConnection={active} />;
  }

  render(<Harness />);
  return { bridge };
}

describe("TunHelperRow", () => {
  it("已是最新时只报状态，不给任何操作", async () => {
    harness(helperInfo("running"));
    expect(await screen.findByText("已是最新（2026.11.1）")).toBeTruthy();
    expect(screen.getByText("接管全部流量时要用的系统服务。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("没有版本号时不显示括号", async () => {
    harness(helperInfo("running", { helperVersion: null }));
    expect(await screen.findByText("已是最新")).toBeTruthy();
  });

  it("空闲退出时说明下次连接会启动，并给系统设置入口", async () => {
    harness(helperInfo("not_running"));
    expect(await screen.findByText("现在没有运行，连接时会自动启动。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开系统设置" })).toBeTruthy();
  });

  it("有更新时说明下次连接自动完成，不给跳转入口", async () => {
    harness(helperInfo("stale"));
    expect(await screen.findByText("有更新，下次连接时自动完成。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("有更新且正在连接时说明断开后完成", async () => {
    harness(helperInfo("stale"), { active: true });
    expect(await screen.findByText("有更新，断开后自动完成。")).toBeTruthy();
  });

  it("打开系统设置按钮调用后端引导命令", async () => {
    const { bridge } = harness(helperInfo("not_running"));
    fireEvent.click(await screen.findByRole("button", { name: "打开系统设置" }));
    await waitFor(() => expect(bridge.tunHelperOpenSettings).toHaveBeenCalledTimes(1));
  });

  it("启动失败压成一行", async () => {
    harness(helperInfo("start_failed"));
    expect(
      await screen.findByText("没有启动成功，连接「全部流量」时会再试一次。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开系统设置" })).toBeTruthy();
  });

  it("文件校验失败只给重装建议，不提授权", async () => {
    harness(helperInfo("file_invalid", { needsAdminRestart: true }));
    expect(await screen.findByText("文件校验失败，重新安装 Veyl 可以修复。")).toBeTruthy();
    expect(screen.queryByText(/会请求一次系统授权/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("需要授权时给一句说明和一个更新按钮", async () => {
    harness(helperInfo("not_running", { needsAdminRestart: true }));
    expect(
      await screen.findByText("需要更新：连接「全部流量」时会请求一次系统授权。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("更新成功后回到正常行并刷新状态", async () => {
    const { bridge } = harness(helperInfo("not_running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperInfo: vi
          .fn()
          .mockResolvedValueOnce(helperInfo("not_running", { needsAdminRestart: true }))
          .mockResolvedValue(helperInfo("running")),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    expect(await screen.findByText("后台组件已更新。")).toBeTruthy();
    expect(await screen.findByText("已是最新（2026.11.1）")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(bridge.tunHelperRestart).toHaveBeenCalledTimes(1);
    expect(bridge.tunHelperInfo).toHaveBeenCalledTimes(2);
  });

  it("取消授权后仍停在需要授权，可再试一次", async () => {
    harness(helperInfo("not_running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw { code: "AUTH_DENIED", message: "用户拒绝管理员授权" };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    expect(await screen.findByText("这次没有授权，可以再试一次。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("更新失败只给一行提示", async () => {
    harness(helperInfo("not_running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw { code: "HELPER_INSTALL_FAILED", message: "后台组件安装失败" };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    expect(await screen.findByText("更新没有完成，请稍后再试。")).toBeTruthy();
    expect(screen.queryByText(/直连可用/)).toBeNull();
  });

  it("PRECONDITION_FAILED + retryable 视为正在准备", async () => {
    harness(helperInfo("running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw {
            code: "PRECONDITION_FAILED",
            retryable: true,
            message: "后台组件正在准备",
            details: { reason: "helper_busy" },
          };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    expect(await screen.findByText("正在准备，请稍后再试。")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("helper_busy 原因同样按正在准备处理", async () => {
    harness(helperInfo("running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw {
            code: "PRECONDITION_FAILED",
            message: "后台组件正在准备",
            details: { reason: "helper_busy" },
          };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    expect(await screen.findByText("正在准备，请稍后再试。")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("命令缺失时降级为只读", async () => {
    harness(helperInfo("running"), {
      overrides: {
        tunHelperInfo: vi.fn(async () => {
          throw new Error("Command tun_helper_info not found");
        }),
      },
    });

    expect(await screen.findByText("暂时读不到后台组件状态。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("更新命令缺失时也转为只读", async () => {
    harness(helperInfo("running", { needsAdminRestart: true }), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw new Error("Command tun_helper_restart not found");
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText("已是最新（2026.11.1）")).toBeTruthy();
  });
});
