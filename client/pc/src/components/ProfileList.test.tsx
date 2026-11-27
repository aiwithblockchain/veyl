import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Profile } from "../api";
import { ProfileList, syncLabel } from "./ProfileList";

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: "p1",
    name: "配置一",
    source: { kind: "subscription", host: "vpn.example.com" },
    node_count: 3,
    last_synced_at: 1_763_000_000_000,
    sync_state: "ok",
    sync_error: null,
    created_at: 1_763_000_000_000,
    kernel_check: "passed",
    ...overrides,
  };
}

describe("配置列表", () => {
  it("空列表给一句能看懂的空态", () => {
    render(
      <ProfileList profiles={[]} activeId={null} onSelect={() => {}} onImport={() => {}} />,
    );
    expect(screen.getByText("还没有配置")).toBeTruthy();
  });

  it("每行显示名称、节点数、来源与同步状态", () => {
    render(
      <ProfileList
        profiles={[profile({})]}
        activeId="p1"
        onSelect={() => {}}
        onImport={() => {}}
      />,
    );
    expect(screen.getByText("配置一")).toBeTruthy();
    const row = screen.getByRole("button", { name: /配置一/ });
    expect(row.textContent).toContain("3 个节点");
    expect(row.textContent).toContain("订阅");
    expect(row.textContent).toContain("已同步");
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("点击一行会把它选为当前", () => {
    const onSelect = vi.fn();
    render(
      <ProfileList
        profiles={[profile({ id: "p2", name: "配置二" })]}
        activeId={null}
        onSelect={onSelect}
        onImport={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /配置二/ }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("同步状态各有自己的文案", () => {
    expect(syncLabel("ok")).toBe("已同步");
    expect(syncLabel("failed")).toBe("上次同步失败");
    expect(syncLabel("unauthorized")).toBe("链接已失效");
    expect(syncLabel("never")).toBe("不参与同步");
  });
});
