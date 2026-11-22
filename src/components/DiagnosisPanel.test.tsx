/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiagnosisDeps,
  DiagnosisFacts,
  ProbeReport,
} from "../myservers/useNodeDiagnosis";
import { DiagnosisPanel } from "./DiagnosisPanel";

afterEach(cleanup);

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
  icmp: { ok: true, rtt_ms: 32, loss: 0 },
  tcp: { ok: true, ms: 41, error: null },
};

const silent: ProbeReport = {
  icmp: { ok: false, rtt_ms: null, loss: 100 },
  tcp: { ok: false, ms: null, error: "timeout" },
};

function makeDeps(over: Partial<DiagnosisDeps> = {}): DiagnosisDeps {
  return {
    facts: facts(),
    tunnelRunning: true,
    probeReachability: vi.fn(async () => reachable),
    syncConfig: vi.fn(async () => ({ changed: false, port: 20343 })),
    reprobe: vi.fn(async () => false),
    reconnectAndProbe: vi.fn(async () => true),
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
        icmp: { ok: false, rtt_ms: null, loss: 100 },
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

    expect(await screen.findByText("探测没能执行")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "去销毁并重建" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "去问 AI" })).toBeTruthy();
  });

  it("ICMP 被屏蔽但 TCP 通：继续更新配置，并标出走的是 TCP", async () => {
    const deps = makeDeps({
      probeReachability: vi.fn(async () => ({
        icmp: { ok: false, rtt_ms: null, loss: 100 },
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
    const reconnectAndProbe = vi.fn(async () => true);
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
        reason: "agent_timeout",
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

    expect(await screen.findByText("重置失败（agent_timeout）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去问 AI" }));

    expect(openAi).toHaveBeenCalledTimes(1);
    const context = openAi.mock.calls[0][0] as Record<string, unknown>;
    expect(context.rotate).toEqual({ ok: false, reason: "agent_timeout" });
    expect(JSON.stringify(context)).not.toContain("password");
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
});
