/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServer } from "../agent/bridge";
import { MyServersRail } from "./MyServersRail";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 2 · Vultr",
    region: "nrt1",
    plan: "s-1vcpu-1gb",
    state: "active",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.11",
    port: 8388,
    node_id: "nd_1",
    local_node_id: "local_1",
    hourly_usd: 0.00893,
    monthly_usd: 9,
    daily_price_cents: 30,
    paid_until: null,
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

afterEach(cleanup);

function renderRail({
  onSync,
  syncBusy = false,
  disabled = false,
  compact = false,
}: {
  onSync?: () => void;
  syncBusy?: boolean;
  disabled?: boolean;
  compact?: boolean;
} = {}) {
  return render(
    <MyServersRail
      servers={[server()]}
      selectedId={null}
      loading={false}
      disabled={disabled}
      compact={compact}
      onSync={onSync}
      syncBusy={syncBusy}
      onSelect={() => {}}
      onNew={() => {}}
    />,
  );
}

describe("服务器左栏同步按钮", () => {
  it("点击触发 onSync", () => {
    const onSync = vi.fn();
    renderRail({ onSync });

    fireEvent.click(screen.getByRole("button", { name: "同步节点配置" }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("同步中禁用", () => {
    renderRail({ onSync: () => {}, syncBusy: true });

    expect(
      (screen.getByRole("button", { name: "同步节点配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("身份不可用时禁用", () => {
    renderRail({ onSync: () => {}, disabled: true });

    expect(
      (screen.getByRole("button", { name: "同步节点配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("没有 onSync 时不渲染", () => {
    renderRail();

    expect(screen.queryByRole("button", { name: "同步节点配置" })).toBeNull();
  });

  it("紧凑模式：抽屉打开后可见并可点击", () => {
    const onSync = vi.fn();
    renderRail({ onSync, compact: true });

    fireEvent.click(screen.getByRole("button", { name: "服务器列表，1 台" }));
    fireEvent.click(screen.getByRole("button", { name: "同步节点配置" }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("紧凑模式：同步中禁用", () => {
    renderRail({ onSync: () => {}, syncBusy: true, compact: true });

    fireEvent.click(screen.getByRole("button", { name: "服务器列表，1 台" }));

    expect(
      (screen.getByRole("button", { name: "同步节点配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
