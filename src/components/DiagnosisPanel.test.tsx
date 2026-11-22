/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLog } from "../log/uiLog";
import type {
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

  it("同步无变化且重测仍不通：给出重置入口", async () => {
    const reprobe = vi.fn(async () => false);
    const deps = makeDeps({ reprobe });
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
    expect(context.rotate).toEqual({ ok: false, reason: "agent_unreachable" });
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
    open(makeDeps(), onClose);

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
    const deps = makeDeps({ reprobe });
    open(deps);

    await startAndUpdate();

    expect(await screen.findByText(/这次没能重测/)).toBeTruthy();
    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "更新配置" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
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
      reconnectAndProbe: vi.fn(async () => "reconnect-failed" as const),
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

  it("同步超时：说还没返回结果，不按控制面不可达处理", async () => {
    const deps = makeDeps({
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
    expect(document.body.textContent).not.toContain("控制面暂时不可达");
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
  });

  it("重置超时：说还没返回结果，不说失败", async () => {
    const deps = makeDeps({
      rotateCredentials: vi.fn(async () => {
        throw {
          code: "TIMEOUT",
          message: "",
          retryable: true,
          details: { reason: "agent_timeout" },
        };
      }),
    });
    open(deps);

    await startAndUpdate();
    fireEvent.click(
      await screen.findByRole("button", { name: "重置端口与密码" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    expect(await screen.findByText(/重置还没返回结果/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("重置失败");
    expect(
      screen.queryByRole("button", { name: "重置端口与密码" }),
    ).toBeNull();
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
      screen.getByRole("dialog", { name: "诊断：东京 01" }),
    ).toBeTruthy();
  });
});
