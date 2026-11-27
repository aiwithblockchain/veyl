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

function renderList(
  props: Partial<React.ComponentProps<typeof ProfileList>> = {},
) {
  return render(
    <ProfileList
      profiles={[]}
      activeId={null}
      onSelect={() => {}}
      onImport={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      {...props}
    />,
  );
}

describe("配置列表", () => {
  it("空列表给一句能看懂的空态", () => {
    renderList();
    expect(screen.getByText("还没有配置")).toBeTruthy();
  });

  it("每行显示名称、节点数、来源与同步状态", () => {
    renderList({ profiles: [profile({})], activeId: "p1" });
    expect(screen.getByText("配置一")).toBeTruthy();
    const row = screen.getByRole("button", { name: "配置一" });
    expect(row.textContent).toContain("3 个节点");
    expect(row.textContent).toContain("订阅");
    expect(row.textContent).toContain("已同步");
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("点击一行会把它选为当前", () => {
    const onSelect = vi.fn();
    renderList({
      profiles: [profile({ id: "p2", name: "配置二" })],
      onSelect,
    });
    fireEvent.click(screen.getByRole("button", { name: "配置二" }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("双击名称就地改名，回车交给后端", () => {
    const onRename = vi.fn();
    renderList({ profiles: [profile({})], activeId: "p1", onRename });

    fireEvent.doubleClick(screen.getByText("配置一"));
    const input = screen.getByLabelText("配置名称") as HTMLInputElement;
    expect(input.value).toBe("配置一");

    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("p1", "新名字");
  });

  it("悬停出现的重命名按钮同样进入编辑", () => {
    renderList({ profiles: [profile({})], activeId: "p1" });
    fireEvent.click(screen.getByRole("button", { name: "重命名 配置一" }));
    expect(screen.getByLabelText("配置名称")).toBeTruthy();
  });

  it("删除要先确认，并且写清后果", () => {
    const onDelete = vi.fn();
    renderList({ profiles: [profile({})], activeId: "p1", onDelete });

    fireEvent.click(screen.getByRole("button", { name: "删除 配置一" }));
    const confirm = screen.getByRole("group", { name: "确认删除 配置一" });
    expect(confirm.textContent).toContain("本机副本");
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onDelete).toHaveBeenCalledWith("p1");
  });

  it("按 Esc 放弃改名，失焦也不会偷偷保存", () => {
    const onRename = vi.fn();
    renderList({ profiles: [profile({})], activeId: "p1", onRename });

    fireEvent.doubleClick(screen.getByText("配置一"));
    const input = screen.getByLabelText("配置名称");
    fireEvent.change(input, { target: { value: "改了一半" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("取消删除不会触发回调", () => {
    const onDelete = vi.fn();
    renderList({ profiles: [profile({})], activeId: "p1", onDelete });

    fireEvent.click(screen.getByRole("button", { name: "删除 配置一" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "确认删除 配置一" })).toBeNull();
  });

  it("同步状态各有自己的文案", () => {
    expect(syncLabel("ok")).toBe("已同步");
    expect(syncLabel("failed")).toBe("上次同步失败");
    expect(syncLabel("unauthorized")).toBe("链接已失效");
    expect(syncLabel("never")).toBe("不参与同步");
  });
});
