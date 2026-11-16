/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer } from "../agent/bridge";
import { DESTROY_RETRY_MS, MyServerDetail } from "./MyServerDetail";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1 · DigitalOcean",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "healthy",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: "nd_control_1",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    failure: null,
    ...over,
  };
}

function renderDetail(
  over: Partial<MyServer> = {},
  onGone = vi.fn(),
  onUseServer: (server: MyServer) => void | Promise<void> = vi.fn(),
) {
  const destroy = vi.fn(async (id: string) =>
    server({ server_id: id, state: "destroyed" }),
  );
  const onCreateAnother = vi.fn();
  const view = render(
    <MyServerDetail
      bridge={{ myServerDestroy: destroy } as unknown as AgentBridge}
      server={server(over)}
      regionLabel="新加坡 1"
      onCreateAnother={onCreateAnother}
      onUseServer={onUseServer}
      onChanged={() => {}}
      onRebuilt={() => {}}
      onGone={onGone}
    />,
  );
  return { destroy, onCreateAnother, onUseServer, onGone, unmount: view.unmount };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("服务器详情", () => {
  it("可用时主按钮不要求控制面 node_id，点击交回服务器", () => {
    const { onUseServer } = renderDetail({ node_id: null, state: "healthy" });

    fireEvent.click(screen.getByRole("button", { name: "用来建配置" }));
    expect(onUseServer).toHaveBeenCalledWith(
      expect.objectContaining({ server_id: "srv_1" }),
    );
  });

  it("取凭据在途时按钮禁用，连点只发一次", async () => {
    let release: () => void = () => {};
    const onUseServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderDetail({}, vi.fn(), onUseServer);
    const button = screen.getByRole("button", { name: "用来建配置" });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(onUseServer).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release();
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("卸载时清理销毁重试计时器", () => {
    vi.useFakeTimers();
    const { unmount } = renderDetail({ state: "destroying" });

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("销毁中先显示进度；超过 60 秒允许重试销毁", async () => {
    vi.useFakeTimers();
    const { destroy } = renderDetail({ state: "destroying" });

    expect(screen.getByText("正在销毁…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试销毁" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(DESTROY_RETRY_MS);
    });

    fireEvent.click(screen.getByRole("button", { name: "重试销毁" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    });
    expect(destroy).toHaveBeenCalledWith("srv_1", true);
  });
});
