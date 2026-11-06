/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, TunHelperInfo, TunHelperState } from "../agent/bridge";
import { TunHelperRow, useTunHelper } from "./TunHelper";

afterEach(cleanup);

function helperInfo(state: TunHelperState, extra: Partial<TunHelperInfo> = {}): TunHelperInfo {
  return {
    runningBuild: state === "running" ? "2026.11.1" : null,
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
  it("运行中展示版本与检查并更新", async () => {
    harness(helperInfo("running"));
    expect(await screen.findByText("正在使用 2026.11.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查并更新" })).toBeTruthy();
  });

  it("空闲已退出时说明下次连接自动启动", async () => {
    harness(helperInfo("not_running"));
    expect(await screen.findByText("空闲已退出，下次连接会自动启动")).toBeTruthy();
  });

  it("需要更新且有活动连接时按钮不可点", async () => {
    harness(helperInfo("stale"), { active: true });
    expect(await screen.findByText("需要更新，连接结束后生效")).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "连接结束后自动更新",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("连接结束后会自动更新。")).toBeTruthy();
  });

  it("需要更新但没有连接时可以立即更新", async () => {
    harness(helperInfo("stale"));
    expect(await screen.findByText("需要更新，连接结束后生效")).toBeTruthy();
    const button = screen.getByRole("button", { name: "检查并更新" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("启动失败给三段式", async () => {
    harness(helperInfo("start_failed", { needsAdminRestart: true }));
    expect(await screen.findByText("没有启动成功")).toBeTruthy();
    expect(screen.getByText("直连可用，接管全部流量暂时不可用。")).toBeTruthy();
    expect(
      screen.getByText("点「检查并更新」再试一次；仍失败就复制诊断信息发给助手。"),
    ).toBeTruthy();
    expect(
      screen.getByText("后台组件需要更新：连接「全部流量」时会请求一次系统授权。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查并更新" })).toBeTruthy();
  });

  it("文件校验失败提示重新安装", async () => {
    harness(helperInfo("file_invalid", { needsAdminRestart: true }));
    expect(await screen.findByText("文件校验失败，重新安装可修复")).toBeTruthy();
    expect(
      screen.getByText("点「检查并更新」重新安装；仍失败就复制诊断信息发给助手。"),
    ).toBeTruthy();
  });

  it("需要管理员授权时如实提示", async () => {
    harness(helperInfo("not_running", { needsAdminRestart: true }));
    expect(
      await screen.findByText("后台组件需要更新：连接「全部流量」时会请求一次系统授权。"),
    ).toBeTruthy();
    expect(screen.queryByText("需要输入一次管理员密码")).toBeNull();
    expect(screen.getByRole("button", { name: "检查并更新" })).toBeTruthy();
  });

  it("文件校验失败不说会请求授权，授权修不好它", async () => {
    harness(helperInfo("file_invalid", { needsAdminRestart: true }));
    expect(await screen.findByText("文件校验失败，重新安装可修复")).toBeTruthy();
    expect(screen.queryByText(/会请求一次系统授权/)).toBeNull();
  });

  it("静默换新的 stale 不说会请求授权", async () => {
    harness(helperInfo("stale"));
    expect(await screen.findByText("需要更新，连接结束后生效")).toBeTruthy();
    expect(screen.queryByText(/会请求一次系统授权/)).toBeNull();
  });

  it("待授权又连着时，同时说明授权与结束后更新", async () => {
    harness(helperInfo("stale", { needsAdminRestart: true }), { active: true });
    expect(await screen.findByText("需要更新，连接结束后生效")).toBeTruthy();
    expect(
      screen.getByText("后台组件需要更新：连接「全部流量」时会请求一次系统授权。"),
    ).toBeTruthy();
    expect(screen.getByText("连接结束后会自动更新。")).toBeTruthy();
  });

  it("更新成功后刷新状态", async () => {
    const { bridge } = harness(helperInfo("not_running"), {
      overrides: {
        tunHelperInfo: vi
          .fn()
          .mockResolvedValueOnce(helperInfo("not_running"))
          .mockResolvedValue(helperInfo("running")),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    expect(
      await screen.findByText("后台组件已更新。", undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(await screen.findByText("正在使用 2026.11.1")).toBeTruthy();
    expect(bridge.tunHelperRestart).toHaveBeenCalledTimes(1);
    expect(bridge.tunHelperInfo).toHaveBeenCalledTimes(2);
  });

  it("拒绝管理员授权时说明影响", async () => {
    harness(helperInfo("not_running"), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw { code: "AUTH_DENIED", message: "用户拒绝管理员授权" };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    expect(await screen.findByText("没有获得管理员授权。")).toBeTruthy();
    expect(screen.getByText("直连可用，接管全部流量暂时不可用。")).toBeTruthy();
    expect(screen.getByText("需要时再点「检查并更新」，输入管理员密码即可。")).toBeTruthy();
  });

  it("更新失败给三段式", async () => {
    harness(helperInfo("not_running"), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw { code: "HELPER_INSTALL_FAILED", message: "后台组件安装失败" };
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    expect(await screen.findByText("后台组件没有更新成功。")).toBeTruthy();
    expect(screen.getByText("直连可用，接管全部流量暂时不可用。")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("PRECONDITION_FAILED + retryable 视为正在准备", async () => {
    harness(helperInfo("running"), {
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

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    expect(await screen.findByText("正在准备，请稍后再试")).toBeTruthy();
    expect(screen.queryByText("需要输入一次管理员密码")).toBeNull();
    expect(screen.queryByText("没有获得管理员授权。")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("helper_busy 原因同样按正在准备处理", async () => {
    harness(helperInfo("running"), {
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

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    expect(await screen.findByText("正在准备，请稍后再试")).toBeTruthy();
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
    harness(helperInfo("running"), {
      overrides: {
        tunHelperRestart: vi.fn(async () => {
          throw new Error("Command tun_helper_restart not found");
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查并更新" }));

    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText("正在使用 2026.11.1")).toBeTruthy();
  });
});
