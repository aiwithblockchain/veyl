import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionSnapshot, ProfileDetail } from "../api";
import { ProfileDetail } from "./ProfileDetail";

function detail(nodeCount = 2): ProfileDetail {
  return {
    profile: {
      id: "p1",
      name: "配置一",
      source: { kind: "subscription", host: "vpn.example.com" },
      node_count: nodeCount,
      last_synced_at: 1_763_000_000_000,
      sync_state: "ok",
      sync_error: null,
      created_at: 1_763_000_000_000,
      kernel_check: "passed",
    },
    source_label: "vpn.example.com",
    nodes: nodeCount
      ? [
          { tag: "悉尼", kind: "shadowsocks" },
          { tag: "新加坡", kind: "shadowsocks" },
        ]
      : [],
  };
}

const idle: ConnectionSnapshot = { state: "idle", uptime_seconds: null };

const connected: ConnectionSnapshot = {
  state: "connected",
  config_id: "p1",
  pid: 42,
  since: "2026-11-27T00:00:00Z",
  node: "悉尼",
  uptime_seconds: 65,
};

function renderDetail(overrides: {
  connection?: ConnectionSnapshot | null;
  nodeCount?: number;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSwitchNode?: (tag: string) => void;
}) {
  return render(
    <ProfileDetail
      detail={detail(overrides.nodeCount)}
      busy={false}
      connection={overrides.connection ?? idle}
      onRefresh={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onConnect={overrides.onConnect ?? (() => {})}
      onDisconnect={overrides.onDisconnect ?? (() => {})}
      onSwitchNode={overrides.onSwitchNode ?? (() => {})}
    />,
  );
}

describe("配置详情的连接入口", () => {
  it("未连接时给「启动 VPN」", () => {
    const onConnect = vi.fn();
    renderDetail({ onConnect });
    expect(screen.getByText("未连接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "启动 VPN" }));
    expect(onConnect).toHaveBeenCalled();
  });

  it("已连接时给「断开 VPN」与计时器", () => {
    const onDisconnect = vi.fn();
    renderDetail({ connection: connected, onDisconnect });
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("01:05")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开 VPN" }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("零节点时不能启动", () => {
    renderDetail({ nodeCount: 0 });
    const start = screen.getByRole("button", { name: "启动 VPN" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/没有可用节点/)).toBeTruthy();
  });

  it("点节点行即切换", () => {
    const onSwitchNode = vi.fn();
    renderDetail({ connection: connected, onSwitchNode });
    fireEvent.click(screen.getByRole("button", { name: /新加坡/ }));
    expect(onSwitchNode).toHaveBeenCalledWith("新加坡");
  });

  it("失败时按三段式显示原因与动作", () => {
    renderDetail({
      connection: {
        state: "failed",
        code: "TUN_DENIED",
        message: "需要先允许后台项",
        reason: "系统还没有批准",
        hint: "到登录项里允许后再试。",
        uptime_seconds: null,
      },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("需要先允许后台项");
    expect(alert.textContent).toContain("系统还没有批准");
    expect(alert.textContent).toContain("到登录项里允许后再试。");
    expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  });
});
