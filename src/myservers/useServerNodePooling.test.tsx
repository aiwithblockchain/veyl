/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServer, MyServerCredentialNode } from "../agent/bridge";
import type { ActionResult, VpnConnectionState } from "../config/useVpnSession";
import { useServerNodePooling } from "./useServerNodePooling";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1",
    region: "nrt",
    plan: "vc2-1c-1gb",
    state: "active",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: null,
    local_node_id: null,
    hourly_usd: 0.007,
    monthly_usd: 5,
    daily_price_cents: 30,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    traffic_used_bytes: 0,
    traffic_limit_bytes: 0,
    traffic_reset_at: "",
    traffic_state: "ok",
    failure: null,
    ...over,
  };
}

function credentialNode(nodeId = "local_node_srv_1"): MyServerCredentialNode {
  return {
    server_id: "srv_1",
    node_id: nodeId,
    name: "新加坡 1 01",
    host: "45.76.20.100",
    port: 8388,
    method: "aes-256-gcm",
  };
}

function setup({
  servers,
  connection,
}: {
  servers: MyServer[];
  connection: VpnConnectionState;
}) {
  const credentials = vi.fn(async () => credentialNode());
  const attach = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
  const view = renderHook(
    (props: {
      servers: MyServer[];
      connection: VpnConnectionState;
    }) =>
      useServerNodePooling({
        servers: props.servers,
        connection: props.connection,
        credentials,
        attach,
      }),
    { initialProps: { servers, connection } },
  );
  return { credentials, attach, ...view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useServerNodePooling", () => {
  it("active 且本地还没有节点行：只取一次凭据，在途不重复", async () => {
    const credentials = vi.fn(
      () => new Promise<MyServerCredentialNode>(() => {}),
    );
    const attach = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { rerender } = renderHook(
      (props: { servers: MyServer[]; connection: VpnConnectionState }) =>
        useServerNodePooling({
          servers: props.servers,
          connection: props.connection,
          credentials,
          attach,
        }),
      { initialProps: { servers: [server()], connection: "idle" } },
    );
    await act(async () => {});

    // 同样的服务器、新的数组引用：在途集合挡住第二次请求。
    rerender({ servers: [server()], connection: "idle" });
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});

    expect(credentials).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledWith("srv_1");
  });

  it("已连接时只入队，不 attach；转 idle 后冲刷一次", async () => {
    const { credentials, attach, rerender } = setup({
      servers: [server()],
      connection: "connected",
    });
    await act(async () => {});

    expect(credentials).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();

    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(["local_node_srv_1"]);

    // 绑定成功后队列清空：再多的 idle 重渲染也不重复发。
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("attach 失败不循环：重渲染不发，离开再回到 idle 会立即重试（同周期冷却见下一条）", async () => {
    const credentials = vi.fn(async () => credentialNode());
    const attach = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    attach.mockResolvedValueOnce({ ok: false, message: "没绑上" });
    const { rerender } = renderHook(
      (props: { servers: MyServer[]; connection: VpnConnectionState }) =>
        useServerNodePooling({
          servers: props.servers,
          connection: props.connection,
          credentials,
          attach,
        }),
      { initialProps: { servers: [server()], connection: "idle" } },
    );
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);

    // 还在 idle：重渲染不再发。
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);

    rerender({ servers: [server()], connection: "connected" });
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(2);

    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("取凭据失败静默且冷却：10 秒内不重试，过后再试", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 19, 10, 0, 0) });
    const credentials = vi.fn(async () => credentialNode());
    credentials.mockRejectedValueOnce(new Error("timeout"));
    const attach = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { rerender } = renderHook(
      (props: { servers: MyServer[]; connection: VpnConnectionState }) =>
        useServerNodePooling({
          servers: props.servers,
          connection: props.connection,
          credentials,
          attach,
        }),
      { initialProps: { servers: [server()], connection: "idle" } },
    );
    await act(async () => {});
    expect(credentials).toHaveBeenCalledTimes(1);

    // 快照轮询每几秒带同一台进来：冷却期内不再打失败请求。
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(credentials).toHaveBeenCalledTimes(1);

    // 冷却到期后没有新快照也自己扫回来（定时器驱动，不依赖 effect 重跑）。
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    await act(async () => {});
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenCalledWith(["local_node_srv_1"]);
  });

  it("idle 下 attach 失败：冷却 10 秒后在同一 idle 周期里再冲一次", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 19, 10, 0, 0) });
    const credentials = vi.fn(async () => credentialNode());
    const attach = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    attach.mockResolvedValueOnce({ ok: false, message: "没绑上" });
    const { rerender } = renderHook(
      (props: { servers: MyServer[]; connection: VpnConnectionState }) =>
        useServerNodePooling({
          servers: props.servers,
          connection: props.connection,
          credentials,
          attach,
        }),
      { initialProps: { servers: [server()], connection: "idle" } },
    );
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);

    // 冷却期内即使重渲染也不再发。
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith(["local_node_srv_1"]);

    // 成功后队列清空，再等也不会多发。
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    rerender({ servers: [server()], connection: "idle" });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("两台服务器错峰取回凭据：排队期间新入队的节点不会被漏绑", async () => {
    const pending = new Map<string, (node: MyServerCredentialNode) => void>();
    const credentials = vi.fn(
      (serverId: string) =>
        new Promise<MyServerCredentialNode>((resolve) => {
          pending.set(serverId, resolve);
        }),
    );
    let releaseAttach: () => void = () => {};
    const attach = vi.fn(
      (_nodeIds: string[]): Promise<ActionResult> =>
        new Promise<ActionResult>((resolve) => {
          releaseAttach = () => resolve({ ok: true });
        }),
    );
    renderHook(
      (props: { servers: MyServer[]; connection: VpnConnectionState }) =>
        useServerNodePooling({
          servers: props.servers,
          connection: props.connection,
          credentials,
          attach,
        }),
      {
        initialProps: {
          servers: [server({ server_id: "srv_a" }), server({ server_id: "srv_b" })],
          connection: "idle",
        },
      },
    );
    await act(async () => {});
    expect(credentials).toHaveBeenCalledTimes(2);

    // A 先回来：冲刷开始，attach 挂在半空。
    await act(async () => {
      pending.get("srv_a")!(credentialNode("node_a"));
    });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenLastCalledWith(["node_a"]);

    // B 在冲刷期间回来：只排队，不并发发第二次。
    await act(async () => {
      pending.get("srv_b")!(credentialNode("node_b"));
    });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);

    // A 的 attach 成功收尾后，队列里的 B 立刻被冲走，不丢。
    await act(async () => {
      releaseAttach();
    });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith(["node_b"]);
  });

  it("healthy 且本地还没有节点行：装好的新机器也会取一次凭据", async () => {
    // 生产控制面结算时直接写 active；healthy 只来自 mock 与历史数据。两种都要覆盖。
    const { credentials } = setup({
      servers: [server({ state: "healthy" })],
      connection: "idle",
    });
    await act(async () => {});

    expect(credentials).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledWith("srv_1");
  });

  it("控制面 node_id 已写但本地还没有节点行：照常取凭据", async () => {
    // 生产里 active 机器的 node_id 一直是 nd_…（控制面 id），本地镜像另有一套 id。
    const { credentials, attach } = setup({
      servers: [server({ state: "active", node_id: "nd_abc123" })],
      connection: "idle",
    });
    await act(async () => {});

    expect(credentials).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledWith("srv_1");
    expect(attach).toHaveBeenCalledWith(["local_node_srv_1"]);
  });

  it("非 healthy / active 的状态：一个请求都不发", async () => {
    const { credentials, attach } = setup({
      servers: [
        server({ server_id: "srv_creating", state: "creating" }),
        server({ server_id: "srv_verifying", state: "verifying" }),
        server({ server_id: "srv_error", state: "error" }),
        server({ server_id: "srv_gone", state: "gone" }),
      ],
      connection: "idle",
    });
    await act(async () => {});

    expect(credentials).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("重启自愈：已就绪且本地有节点行会入队并绑一次，同会话快照不再发", async () => {
    const { credentials, attach, rerender } = setup({
      servers: [server({ state: "active", local_node_id: "local_node_srv_1" })],
      connection: "idle",
    });
    await act(async () => {});

    // 本地节点行已有：不再取凭据，但上次可能没绑上，直接入队补一次。
    expect(credentials).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(["local_node_srv_1"]);

    rerender({
      servers: [server({ state: "active", local_node_id: "local_node_srv_1" })],
      connection: "idle",
    });
    await act(async () => {});
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
