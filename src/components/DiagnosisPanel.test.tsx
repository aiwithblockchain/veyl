/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLog } from "../log/uiLog";
import type {
  ConnectionDiagnosisDeps,
  ConnectionFacts,
  ConnectionLocalCheck,
  DiagnosisDeps,
  DiagnosisFacts,
  ProbeReport,
} from "../myservers/useNodeDiagnosis";
import { DiagnosisPanel } from "./DiagnosisPanel";

vi.mock("../log/uiLog", () => ({ uiLog: vi.fn() }));

afterEach(cleanup);

beforeEach(() => {
  vi.mocked(uiLog).mockClear();
});

function logLines(): string[] {
  return vi.mocked(uiLog).mock.calls.map(([, message]) => message);
}

function facts(over: Partial<DiagnosisFacts> = {}): DiagnosisFacts {
  return {
    serverId: "srv_1",
    region: "sgp1",
    createdAt: "2026-11-01T00:00:00Z",
    state: "active",
    localNodeId: "nd_local_1",
    port: 20343,
    nodeInUse: true,
    appVersion: "1.0.0",
    platform: "macos",
    uiLogPath: "/tmp/veyl-ui.log",
    controlPlaneError: null,
    ...over,
  };
}

const reachable: ProbeReport = {
  icmp: { ok: true, rtt_ms: 32, loss: 0, error: null },
  tcp: { ok: true, ms: 41, error: null },
};

const silent: ProbeReport = {
  icmp: { ok: false, rtt_ms: null, loss: 100, error: null },
  tcp: { ok: false, ms: null, error: "timeout" },
};

function makeDeps(over: Partial<DiagnosisDeps> = {}): DiagnosisDeps {
  return {
    facts: facts(),
    isTunnelRunning: () => true,
    isRuntimeRunning: () => true,
    probeReachability: vi.fn(async () => reachable),
    syncConfig: vi.fn(async () => ({ changed: false, port: 20343 })),
    reprobe: vi.fn(async () => false),
    reconnectAndProbe: vi.fn(async () => "ok" as const),
    rotateCredentials: vi.fn(async () => ({ ok: true as const, port: 21345 })),
    openAi: vi.fn(),
    onGoToServers: vi.fn(),
    ...over,
  };
}

function open(deps: DiagnosisDeps, onClose: () => void = () => {}) {
  const view = render(
    <DiagnosisPanel nodeName="东京 01" deps={deps} onClose={onClose} />,
  );
  return view;
}

async function start() {
  fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
}

async function startAndUpdate() {
  await start();
  fireEvent.click(await screen.findByRole("button", { name: "更新配置" }));
}

describe("节点诊断面板", () => {
  it("ICMP 与 TCP 都不通：结论是整机不可达，只有销毁入口回调", async () => {
    const onGoToServers = vi.fn();
    const deps = makeDeps({
      probeReachability: vi.fn(async () => silent),
      onGoToServers,
    });
    open(deps);

    await start();

    expect(await screen.findByText("这台机器整机不可达")).toBeTruthy();
    const destroy = screen.getByRole("button", { name: "去销毁并重建" });
    expect(destroy.className).toContain("btn--danger-ghost");
    fireEvent.click(destroy);
    expect(onGoToServers).toHaveBeenCalledTimes(1);
  });

  it("控制面请求也失败：结论是本机网络可能不通，不给销毁", async () => {
    const deps = makeDeps({
      facts: facts({ controlPlaneError: "control_plane_unreachable" }),
      probeReachability: vi.fn(async () => silent),
    });
    open(deps);

    await start();

    expect(await screen.findByText("本机网络可能不通")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "去销毁并重建" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("TCP 端口拒绝连接：机器在线但控制服务不可用，不给销毁", async () => {
    const deps = makeDeps({
      probeReachability: vi.fn(async () => ({
        icmp: { ok: false, rtt_ms: null, loss: 100, error: null },
        tcp: { ok: false, ms: null, error: "refused" },
      })),
    });
    open(deps);

    await start();

    expect(
      await screen.findByText("机器在线，控制服务不可用"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "去销毁并重建" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("探测命令没跑起来：结论是探测没能执行，不给销毁，下一步去问 AI", async () => {
    const deps = makeDeps({
      probeReachability: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    open(deps);

    await start();

    expect(await screen.findByText(/探测没能执行/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "去销毁并重建" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("ICMP 命令自己没跑成：按探测失败处理，不给销毁", async () => {
    const deps = makeDeps({
      probeReachability: vi.fn(async () => ({
        icmp: { ok: false, rtt_ms: null, loss: 100, error: "timeout" },
        tcp: { ok: false, ms: null, error: "timeout" },
      })),
    });
    open(deps);

    await start();

    expect(await screen.findByText("探测超时，没能完成。")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "去销毁并重建" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("ICMP 被屏蔽但 TCP 通：继续更新配置，并标出走的是 TCP", async () => {
    const deps = makeDeps({
      probeReachability: vi.fn(async () => ({
        icmp: { ok: false, rtt_ms: null, loss: 100, error: null },
        tcp: { ok: true, ms: 18, error: null },
      })),
    });
    open(deps);

    await start();

    expect(await screen.findByText(/ICMP 未通，TCP 连通/)).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新配置" })).toBeTruthy();
  });

  it("同步有变化且重连成功：结束在「配置已更新，连接已恢复」", async () => {
    const reconnectAndProbe = vi.fn(async () => "ok" as const);
    const deps = makeDeps({
      syncConfig: vi.fn(async () => ({ changed: true, port: 21345 })),
      reconnectAndProbe,
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("配置已更新，连接已恢复")).toBeTruthy();
    expect(reconnectAndProbe).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
  });

  it("同步无变化但隧道跑的是这台：也先重连再测（端口可能已在别处重置）", async () => {
    const reconnectAndProbe = vi.fn(async () => "ok" as const);
    const reprobe = vi.fn(async () => false);
    const deps = makeDeps({
      syncConfig: vi.fn(async () => ({ changed: false, port: 20343 })),
      reconnectAndProbe,
      reprobe,
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("配置没有变化，连接已恢复")).toBeTruthy();
    expect(reconnectAndProbe).toHaveBeenCalledTimes(1);
    expect(reprobe).not.toHaveBeenCalled();
  });

  it("同步无变化且重测仍不通：给出重置入口", async () => {
    const reprobe = vi.fn(async () => false);
    const deps = makeDeps({ isTunnelRunning: () => false, reprobe });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("配置没有变化，仍然不通")).toBeTruthy();
    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "重置端口与密码" }),
    ).toBeTruthy();
  });

  it("重置失败：结论带 reason，下一步是去问 AI", async () => {
    const openAi = vi.fn();
    const deps = makeDeps({
      reconnectAndProbe: vi.fn(async () => "probe-failed" as const),
      rotateCredentials: vi.fn(async () => ({
        ok: false as const,
        reason: "agent_unreachable",
      })),
      openAi,
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );

    expect(
      screen.getByText(
        "会断开当前连接，端口和密码都会变；其它设备需要更新配置后才能继续用。",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(await screen.findByText("重置失败：没能连上这台服务器。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("agent_unreachable");
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    expect(openAi).toHaveBeenCalledTimes(1);
    const context = openAi.mock.calls[0][0] as Record<string, unknown>;
    expect(context.rotate).toEqual({
      ok: false,
      reason: "agent_unreachable",
      timed_out: false,
    });
    expect(JSON.stringify(context)).not.toContain("password");
  });

  it("配置有变化但隧道没在跑：不重连、不探测，提示重新连接后生效", async () => {
    const reconnectAndProbe = vi.fn(async () => "ok" as const);
    const reprobe = vi.fn(async () => true);
    const deps = makeDeps({
      isRuntimeRunning: () => false,
      isTunnelRunning: () => false,
      syncConfig: vi.fn(async () => ({ changed: true, port: 21345 })),
      reconnectAndProbe,
      reprobe,
    });
    open(deps);

    await startAndUpdate();

    expect(
      await screen.findByText("配置已更新，重新连接后生效"),
    ).toBeTruthy();
    expect(reconnectAndProbe).not.toHaveBeenCalled();
    expect(reprobe).not.toHaveBeenCalled();
  });

  it("重置后隧道没在跑：不探测、不自动连接", async () => {
    const reconnectAndProbe = vi.fn(async () => "ok" as const);
    const reprobe = vi.fn(async () => true);
    const deps = makeDeps({
      isRuntimeRunning: () => false,
      isTunnelRunning: () => false,
      reprobe,
      reconnectAndProbe,
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    expect(
      screen.getByText(
        "会重启这台节点，端口和密码都会变；其它设备需要更新配置后才能继续用。",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(await screen.findByText("已重置，重新连接后生效")).toBeTruthy();
    expect(reconnectAndProbe).not.toHaveBeenCalled();
    expect(reprobe).not.toHaveBeenCalled();
  });

  it("重置后跑的是别的节点：只重测、不重启", async () => {
    const reconnectAndProbe = vi.fn(async () => "ok" as const);
    const reprobe = vi.fn(async () => false);
    const deps = makeDeps({
      isRuntimeRunning: () => true,
      isTunnelRunning: () => false,
      reprobe,
      reconnectAndProbe,
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(
      await screen.findByText("端口与密码已重置，但仍然不通"),
    ).toBeTruthy();
    expect(reprobe).toHaveBeenCalled();
    expect(reconnectAndProbe).not.toHaveBeenCalled();
  });

  it("步骤列表是 aria-live，动作切换后焦点跟到新的主按钮", async () => {
    open(makeDeps());

    await start();
    const update = await screen.findByRole("button", { name: "更新配置" });
    await waitFor(() => expect(document.activeElement).toBe(update));
    expect(
      document.querySelector(".diagnosis__steps")?.getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("重置确认：初始焦点在取消，Esc 仍关闭面板", async () => {
    const onClose = vi.fn();
    open(
      makeDeps({ reconnectAndProbe: vi.fn(async () => "probe-failed" as const) }),
      onClose,
    );

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );

    const cancel = screen.getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Host 没接重置命令：UNSUPPORTED 走人话，不显示稳定码", async () => {
    const deps = makeDeps({
      reconnectAndProbe: vi.fn(async () => "probe-failed" as const),
      rotateCredentials: vi.fn(async () => ({
        ok: false as const,
        reason: "UNSUPPORTED",
      })),
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(
      await screen.findByText("重置失败：这个版本还不支持重置端口。"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("UNSUPPORTED");
  });

  it("关闭后重新打开从第一步开始，不保留上次的步骤", async () => {
    const deps = makeDeps();
    const first = open(deps);

    await start();
    expect(await screen.findByText(/ICMP 通/)).toBeTruthy();
    first.unmount();

    open(makeDeps());
    expect(screen.getByRole("button", { name: "开始分析" })).toBeTruthy();
    expect(screen.queryByText("连通性")).toBeNull();
  });

  it("开始分析：开始与连通性日志共用同一个 run 短码", async () => {
    open(makeDeps());

    await start();
    await screen.findByText(/ICMP 通/);

    const lines = logLines();
    const startLine = lines.find((line) => line.includes("start server=srv_1"));
    expect(startLine).toBeTruthy();
    expect(startLine!.length).toBeLessThanOrEqual(300);

    const run = /run=(\d{6})/.exec(startLine ?? "")?.[1];
    expect(run).toBeTruthy();
    expect(lines.find((line) => line.includes("connectivity icmp=ok"))).toContain(
      `run=${run}`,
    );
    expect(vi.mocked(uiLog).mock.calls[0][2]).toBe("node-diagnosis");
  });

  it("重置失败：日志带 reason 与同一个 run 码", async () => {
    const deps = makeDeps({
      reconnectAndProbe: vi.fn(async () => "probe-failed" as const),
      rotateCredentials: vi.fn(async () => ({
        ok: false as const,
        reason: "agent_timeout",
      })),
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await screen.findByText(/重置还没返回结果/);

    const line = logLines().find((item) => item.includes("rotate ok=false"));
    expect(line).toBeTruthy();
    expect(line).toContain("reason=agent_timeout");
    expect(line).toMatch(/run=\d{6}/);
  });

  it("配置同步撞上控制面不可达：补一条带短码的日志", async () => {
    const deps = makeDeps({
      syncConfig: vi.fn(async () => ({
        changed: false,
        controlPlaneError: "control_plane_unreachable",
      })),
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("控制面暂时不可达")).toBeTruthy();
    const line = logLines().find((item) =>
      item.includes("config control-plane"),
    );
    expect(line).toContain("error=control_plane_unreachable");
    expect(line).toMatch(/run=\d{6}/);
  });

  it("关闭面板：收尾日志带 run 码与步骤结果", async () => {
    const view = open(makeDeps());

    await start();
    await screen.findByText(/ICMP 通/);
    view.unmount();

    const line = logLines().find((item) =>
      item.includes("steps=connectivity:passed"),
    );
    expect(line).toBeTruthy();
    expect(line).toMatch(/run=\d{6}/);
  });

  it("配置有变化且重测仍不通：仍然给重置（配置可能是别的设备改的）", async () => {
    const deps = makeDeps({
      syncConfig: vi.fn(async () => ({ changed: true, port: 21345 })),
      isTunnelRunning: () => false,
      isRuntimeRunning: () => true,
      reprobe: vi.fn(async () => false),
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("配置已更新，但仍然不通")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重置端口与密码" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });

  it("重测没跑成：结论是没能重测，下一步重新测一次而不是重置", async () => {
    const reprobe = vi.fn(async () => null);
    const deps = makeDeps({ isTunnelRunning: () => false, reprobe });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText(/这次没能重测/)).toBeTruthy();
    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "更新配置" })).toBeTruthy();
  });

  it("重测没跑成时带 Host 原因：显示人话，状态是未完成", async () => {
    const deps = makeDeps({
      isTunnelRunning: () => false,
      probeUntestedReason: () => "node_not_in_config",
      reprobe: vi.fn(async () => null),
    });
    open(deps);

    await startAndUpdate();

    expect(
      await screen.findByText("这次没能重测：这个节点还没进节点池，稍后再试。"),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "未完成" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "失败" })).toBeNull();
  });

  it("节点在池里但还没进运行中的配置：提示重新连接后再试", async () => {
    const deps = makeDeps({
      isTunnelRunning: () => false,
      probeUntestedReason: () => "node_not_in_running_config",
      reprobe: vi.fn(async () => null),
    });
    open(deps);

    await startAndUpdate();

    expect(
      await screen.findByText(
        "这次没能重测：这个节点还没生效，重新连接后再试。",
      ),
    ).toBeTruthy();
  });

  it("重置后重测没跑成：结论是没能重测，绝不再给重置", async () => {
    const reprobe = vi
      .fn<() => Promise<boolean | null>>(async () => false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(null);
    const deps = makeDeps({
      isTunnelRunning: () => false,
      isRuntimeRunning: () => true,
      reprobe,
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(
      await screen.findByText("端口与密码已重置，但这次没能重测。"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "重新测一次" })).toBeTruthy();
  });

  it("重连本身失败：说没能重连，不说不通，也不给重置", async () => {
    const deps = makeDeps({
      syncConfig: vi.fn(async () => ({ changed: true, port: 21345 })),
      reconnectAndProbe: vi.fn(async () => "reconnect-failed" as const),
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText("配置已更新，但没能重连。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("仍然不通");
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("重置后重连本身失败：说没能重连，不说不通", async () => {
    const deps = makeDeps({
      reprobe: vi.fn(async () => false),
      // 第一次是配置步骤的重连（模拟配置无变化、先重连再测仍不通）；第二次是重置后的重连。
      reconnectAndProbe: vi
        .fn<() => Promise<"ok" | "probe-failed" | "probe-untested" | "reconnect-failed">>(
          async () => "probe-failed",
        )
        .mockResolvedValueOnce("probe-failed")
        .mockResolvedValueOnce("reconnect-failed"),
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(
      await screen.findByText("端口与密码已重置，但没能重连"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "端口与密码已重置，但仍然不通",
    );
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("同步超时：说还没返回结果，状态是中性的未完成", async () => {
    const openAi = vi.fn();
    const deps = makeDeps({
      openAi,
      syncConfig: vi.fn(async () => {
        throw {
          code: "TIMEOUT",
          message: "",
          retryable: true,
          details: { reason: "timeout" },
        };
      }),
    });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText(/更新配置还没返回结果/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "未完成" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("控制面暂时不可达");
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));
    const context = openAi.mock.calls[0][0] as {
      config_update: { timed_out: boolean };
    };
    expect(context.config_update.timed_out).toBe(true);
  });

  it("重置超时：说还没返回结果，状态中性，收尾日志写 timed_out", async () => {
    const openAi = vi.fn();
    const view = open(
      makeDeps({
        openAi,
        reconnectAndProbe: vi.fn(async () => "probe-failed" as const),
        rotateCredentials: vi.fn(async () => {
          throw {
            code: "TIMEOUT",
            message: "",
            retryable: true,
            details: { reason: "agent_timeout" },
          };
        }),
      }),
    );

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(await screen.findByText(/重置还没返回结果/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "未完成" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("重置失败");
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));
    const context = openAi.mock.calls[0][0] as {
      rotate: { timed_out: boolean };
    };
    expect(context.rotate.timed_out).toBe(true);

    view.unmount();
    const line = logLines().find((item) => item.includes("rotate=timed_out"));
    expect(line).toBeTruthy();
  });

  it("告警盖在上面时暂停焦点陷阱，Esc 不先关面板", async () => {
    const onClose = vi.fn();
    render(
      <DiagnosisPanel
        nodeName="东京 01"
        deps={makeDeps()}
        onClose={onClose}
        trapPaused
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "智能诊断：东京 01" }),
    ).toBeTruthy();
  });

  it("更新配置连续三次没测成：不再给更新配置，只给去问 AI", async () => {
    const reprobe = vi.fn<() => Promise<boolean | null>>(async () => null);
    open(makeDeps({ isTunnelRunning: () => false, reprobe }));

    await startAndUpdate();
    await screen.findByText(/这次没能重测/);

    fireEvent.click(screen.getByRole("button", { name: "更新配置" }));
    await waitFor(() => expect(reprobe).toHaveBeenCalledTimes(2));

    fireEvent.click(
      await screen.findByRole("button", { name: "更新配置" }),
    );
    await waitFor(() => expect(reprobe).toHaveBeenCalledTimes(3));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "更新配置" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("重置后连续两次没测成：不再给重新测，只剩去问 AI", async () => {
    const reprobe = vi
      .fn<() => Promise<boolean | null>>(async () => null)
      // 第一次是配置步骤的重测：判为不通，先走到重置。
      .mockResolvedValueOnce(false);
    open(
      makeDeps({
        isTunnelRunning: () => false,
        isRuntimeRunning: () => true,
        reprobe,
      }),
    );

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    await screen.findByText("端口与密码已重置，但这次没能重测。");
    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));
    await waitFor(() => expect(reprobe).toHaveBeenCalledTimes(3));

    fireEvent.click(
      await screen.findByRole("button", { name: "重新测一次" }),
    );
    await waitFor(() => expect(reprobe).toHaveBeenCalledTimes(4));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "重新测一次" }),
      ).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("关闭重开：次数计数清零，重新从第一次更新配置开始", async () => {
    const firstProbe = vi.fn<() => Promise<boolean | null>>(async () => null);
    const first = open(
      makeDeps({ isTunnelRunning: () => false, reprobe: firstProbe }),
    );

    await startAndUpdate();
    await screen.findByText(/这次没能重测/);
    fireEvent.click(screen.getByRole("button", { name: "更新配置" }));
    await waitFor(() => expect(firstProbe).toHaveBeenCalledTimes(2));
    fireEvent.click(
      await screen.findByRole("button", { name: "更新配置" }),
    );
    await waitFor(() => expect(firstProbe).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "更新配置" }),
      ).toBeNull(),
    );
    first.unmount();

    open(
      makeDeps({
        isTunnelRunning: () => false,
        reprobe: vi.fn<() => Promise<boolean | null>>(async () => null),
      }),
    );
    await startAndUpdate();

    expect(await screen.findByText(/这次没能重测/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新配置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });
});

describe("连接失败的智能诊断（profile: connection）", () => {
  function connectionFacts(
    over: Partial<ConnectionFacts> = {},
  ): ConnectionFacts {
    return {
      failureStage: "failed",
      errorCode: "RUNTIME_HEALTH_FAILED",
      errorReason: null,
      nodeName: "东京 01",
      nodeSource: "owned",
      region: "日本",
      connectMode: "tun",
      controlPlaneError: null,
      appVersion: "1.0.0",
      platform: "macos",
      ...over,
    };
  }

  function localCheck(
    over: Partial<ConnectionLocalCheck> = {},
  ): ConnectionLocalCheck {
    return {
      runtimeState: "failed",
      runtimeErrorCode: null,
      runtimeErrorReason: null,
      helperState: "ok",
      configFound: true,
      nodeInConfig: true,
      ...over,
    };
  }

  function connectionDeps(
    over: Partial<ConnectionDiagnosisDeps> = {},
    probe: () => Promise<ProbeReport> = async () => silent,
  ): DiagnosisDeps {
    return {
      profile: "connection",
      facts: facts(),
      isTunnelRunning: () => false,
      isRuntimeRunning: () => false,
      probeReachability: vi.fn(() => probe()),
      connection: {
        facts: connectionFacts(),
        check: vi.fn(async () => localCheck()),
        retest: vi.fn(async () => ({
          reachable: false,
          reason: null,
          latencyMs: null,
        })),
        openSettings: vi.fn(),
        updateConfig: vi.fn(),
        changeNode: vi.fn(),
        reconnect: vi.fn(),
        openAi: vi.fn(),
        ...over,
      },
    };
  }

  function openConnection(deps: DiagnosisDeps) {
    return render(
      <DiagnosisPanel nodeName="东京 01" deps={deps} onClose={() => {}} />,
    );
  }

  it("能定位到节点地址不通：给换节点动作，不出现问 AI", async () => {
    const changeNode = vi.fn();
    openConnection(connectionDeps({ changeNode }));

    expect(await screen.findByText("节点地址连不上")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "换一个节点" }));
    expect(changeNode).toHaveBeenCalledTimes(1);
  });

  it("helper 未运行：结论与打开设置，不出现问 AI", async () => {
    const openSettings = vi.fn();
    openConnection(
      connectionDeps({
        check: vi.fn(async () => localCheck({ helperState: "blocked" })),
        openSettings,
      }),
    );

    expect(
      await screen.findByText("后台组件没有在运行或没有授权"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("配置里没有这个节点：换一个节点；重读配置是死路，也不出现问 AI", async () => {
    const changeNode = vi.fn();
    openConnection(
      connectionDeps({
        check: vi.fn(async () => localCheck({ nodeInConfig: false })),
        changeNode,
      }),
    );

    expect(await screen.findByText("当前配置里没有这个节点")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "换一个节点" }));
    expect(changeNode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "更新配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });

  it("定位不到：出现问 AI，清单含 10.5 字段且无敏感项", async () => {
    const openAi = vi.fn((_context: unknown) => true);
    openConnection(connectionDeps({ openAi }, async () => reachable));

    expect(
      await screen.findByText("本地检查都通过了，但还是连不上"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    expect(openAi).toHaveBeenCalledTimes(1);
    const context = openAi.mock.calls[0][0] as {
      failure: { stage: string; code: string | null };
      node: Record<string, unknown>;
      runtime: Record<string, unknown>;
      config: Record<string, unknown>;
      steps: Array<{ id: string }>;
      probe: {
        icmp: { ok: boolean } | null;
        tcp: { ok: boolean } | null;
      };
      attempted: Array<{ action: string; result: string }>;
      client: Record<string, unknown>;
    };
    expect(context.failure.stage).toBe("failed");
    expect(context.failure.code).toBe("RUNTIME_HEALTH_FAILED");
    expect(context.node).toEqual({
      name: "东京 01",
      source: "owned",
      region: "日本",
    });
    expect(context.runtime).toMatchObject({
      state: "failed",
      helper: "ok",
      mode: "tun",
    });
    expect(context.config).toEqual({ found: true, node_present: true });
    expect(context.steps.map((step) => step.id)).toEqual([
      "connectivity",
      "config",
    ]);
    expect(context.probe.icmp?.ok).toBe(true);
    expect(context.probe.tcp?.ok).toBe(true);
    expect(context.attempted).toEqual([
      { action: "reachability", result: "ok" },
      { action: "local_check", result: "connection-undetermined" },
    ]);
    expect(context.client).toEqual({
      app_version: "1.0.0",
      platform: "macos",
    });

    const text = JSON.stringify(context);
    for (const secret of ["password", "token", "private_key", "uuid", "203."]) {
      expect(text).not.toContain(secret);
    }
  });

  it("离线：结论是没有网络 + 重新测一次，不出现问 AI", async () => {
    openConnection(
      connectionDeps({
        facts: connectionFacts({ controlPlaneError: "control_plane_unreachable" }),
      }),
    );

    expect(await screen.findByText("当前没有网络")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新测一次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });

  it("连通性硬超时：结论是探测失败、去问 AI，本地结论仍进清单", async () => {
    const openAi = vi.fn((_context: unknown) => true);
    const deps = connectionDeps(
      {
        openAi,
        check: vi.fn(async () => localCheck({ nodeInConfig: false })),
      },
      async () => {
        throw {
          code: "TIMEOUT",
          message: "",
          retryable: true,
          details: { reason: "timeout" },
        };
      },
    );
    openConnection(deps);

    expect(await screen.findByText("探测超时，没能完成。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    const context = openAi.mock.calls[0][0] as {
      steps: Array<Record<string, unknown>>;
      config: Record<string, unknown>;
      probe: { error: string | null };
    };
    expect(context.steps).toEqual([
      {
        id: "connectivity",
        status: "failed",
        conclusion: "probe-error",
        code: "timeout",
      },
      {
        id: "config",
        status: "failed",
        conclusion: "config-node-missing",
        code: null,
      },
    ]);
    expect(context.config).toEqual({ found: true, node_present: false });
    expect(context.probe.error).toBe("timeout");
  });

  it("AI 未配置：点问 AI 被拦下，结论保留在面板上", async () => {
    const openAi = vi.fn((_context: unknown) => false);
    openConnection(connectionDeps({ openAi }, async () => reachable));

    expect(
      await screen.findByText("本地检查都通过了，但还是连不上"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    expect(openAi).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("本地检查都通过了，但还是连不上"),
    ).toBeTruthy();
    expect(screen.queryByText("已把诊断信息交给 AI")).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("结论后的重新测一次：没测成按 reason 给人话并回到重测", async () => {
    const retest = vi.fn(async () => ({
      reachable: null,
      reason: "connection_busy",
      latencyMs: null,
    }));
    openConnection(connectionDeps({ retest }, async () => reachable));

    await screen.findByText("本地检查都通过了，但还是连不上");
    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));

    expect(
      await screen.findByText("这次没能重新测：连接正在忙。"),
    ).toBeTruthy();
    expect(retest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "重新测一次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });

  it("TCP refused：结论是节点服务没有响应，与地址不通分开，给换节点", async () => {
    const changeNode = vi.fn();
    const refused: ProbeReport = {
      icmp: { ok: false, rtt_ms: null, loss: 100, error: null },
      tcp: { ok: false, ms: null, error: "refused" },
    };
    openConnection(
      connectionDeps({ changeNode }, async () => refused),
    );

    expect(await screen.findByText("节点服务没有响应")).toBeTruthy();
    expect(screen.queryByText("节点地址连不上")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "换一个节点" }));
    expect(changeNode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
  });

  it("重新测一次测通了：结论是节点现在能连通，动作是重新连接", async () => {
    const retest = vi.fn(async () => ({
      reachable: true,
      reason: null,
      latencyMs: 42,
    }));
    const reconnect = vi.fn();
    openConnection(connectionDeps({ retest, reconnect }, async () => reachable));

    await screen.findByText("本地检查都通过了，但还是连不上");
    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));

    expect(await screen.findByText("节点现在能连通")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("probe-untested 八个 reason 的动作按定稿表", async () => {
    const cases = [
      ["node_not_in_config", "更新配置"],
      ["node_not_in_running_config", "重新测一次"],
      ["connection_busy", "重新测一次"],
      ["clash_unavailable", "重新测一次"],
      ["no_credentials", "换一个节点"],
      ["runtime_missing", "去问 AI"],
      ["runtime_failed", "去问 AI"],
      ["runtime_timeout", "去问 AI"],
    ] as const;

    for (const [reason, label] of cases) {
      const retest = vi.fn(async () => ({
        reachable: null,
        reason,
        latencyMs: null,
      }));
      const view = openConnection(
        connectionDeps({ retest }, async () => reachable),
      );
      await screen.findByText("本地检查都通过了，但还是连不上");
      fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));
      await screen.findByText(/这次没能重新测/);

      expect(screen.getByRole("button", { name: label })).toBeTruthy();
      if (label !== "去问 AI") {
        expect(screen.queryByRole("button", { name: "去问 AI" })).toBeNull();
      }
      view.unmount();
    }
  });

  it("clash_unavailable 重测后仍是该原因：记运行时报错走问 AI，不再循环", async () => {
    const retest = vi.fn(async () => ({
      reachable: null,
      reason: "clash_unavailable",
      latencyMs: null,
    }));
    openConnection(connectionDeps({ retest }, async () => reachable));

    await screen.findByText("本地检查都通过了，但还是连不上");
    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));
    await screen.findByText(/本地测速组件不可用/);
    expect(screen.getByRole("button", { name: "重新测一次" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));

    expect(
      await screen.findByText("运行时报了错，本地没有能替你修的动作"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
    expect(retest).toHaveBeenCalledTimes(2);
  });

  it("未知 untested reason 按 askAi 兜底，并原样记进 facts", async () => {
    const openAi = vi.fn((_context: unknown) => true);
    const retest = vi.fn(async () => ({
      reachable: null,
      reason: "weird_reason",
      latencyMs: null,
    }));
    openConnection(connectionDeps({ retest, openAi }, async () => reachable));

    await screen.findByText("本地检查都通过了，但还是连不上");
    fireEvent.click(screen.getByRole("button", { name: "重新测一次" }));
    fireEvent.click(await screen.findByRole("button", { name: "去问 AI" }));

    expect(openAi).toHaveBeenCalledTimes(1);
    const context = openAi.mock.calls[0][0] as {
      probe: { retest: { reason: string | null } | null };
    };
    expect(context.probe.retest?.reason).toBe("weird_reason");
  });

  it("拿不到地址的节点：连通性记 skipped，由本地检查决定", async () => {
    const deps = connectionDeps();
    delete deps.probeReachability;
    openConnection(deps);

    expect(
      await screen.findByText("这项检查在这台节点上不适用"),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "跳过" })).toBeTruthy();
    // 本地检查都过：落到 connection-undetermined，走问 AI。
    expect(
      screen.getByText("本地检查都通过了，但还是连不上"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("本地检查本身没跑完：结论是运行时报错，facts 带失败命令与短码", async () => {
    const openAi = vi.fn((_context: unknown) => true);
    openConnection(
      connectionDeps(
        {
          openAi,
          check: vi.fn(async () => {
            throw {
              code: "INTERNAL",
              message: "",
              retryable: false,
              details: { reason: "runtime_status:INTERNAL" },
            };
          }),
        },
        async () => reachable,
      ),
    );

    expect(
      await screen.findByText("运行时报了错，本地没有能替你修的动作"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    const context = openAi.mock.calls[0][0] as {
      runtime: { check_error: string | null };
    };
    expect(context.runtime.check_error).toBe("runtime_status:INTERNAL");
  });
});
