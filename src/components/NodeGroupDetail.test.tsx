/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeGroup } from "../groups/mockGroups";
import { NodeGroupDetail } from "./NodeGroupDetail";

function group(over: Partial<NodeGroup> = {}): NodeGroup {
  return {
    group_id: "grp_mine",
    name: "我的节点",
    read_only: false,
    nodes: [
      {
        node_id: "n1",
        name: "东京 01",
        server: "45.76.20.100",
        port: 8388,
        protocol: "ss",
        latency_ms: 63,
      },
      {
        node_id: "n2",
        name: "新加坡 01",
        server: "45.76.22.102",
        port: 8388,
        protocol: "ss",
        latency_ms: null,
      },
    ],
    ...over,
  };
}

const FREE: NodeGroup = {
  group_id: "grp_free",
  name: "Veyl 免费节点",
  read_only: true,
  nodes: [
    {
      node_id: "f1",
      name: "上海 01",
      server: "1.2.3.4",
      port: 8388,
      protocol: "ss",
      latency_ms: 32,
    },
  ],
};

afterEach(cleanup);

describe("组详情（只读）", () => {
  it("节点行显示状态、地址、协议与延迟；测不通的展开说明", () => {
    render(<NodeGroupDetail group={group()} active={false} />);

    expect(screen.getByText("东京 01")).toBeTruthy();
    expect(screen.getByText("45.76.20.100:8388")).toBeTruthy();
    expect(screen.getByText("63 ms")).toBeTruthy();
    expect(screen.getByText("这次测不通")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 01/ }));
    expect(screen.getByText("这个节点连不上。")).toBeTruthy();
  });

  it("不提供任何本地写入口", () => {
    render(<NodeGroupDetail group={group()} active={false} />);
    expect(screen.queryByRole("button", { name: "添加节点" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "改名" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除组" })).toBeNull();
    expect(screen.queryByRole("button", { name: "设为当前节点组" })).toBeNull();
    expect(screen.queryByRole("button", { name: "测试全部" })).toBeNull();
    expect(screen.getByText("节点组尚未接入，暂时只能查看。")).toBeTruthy();
  });

  it("空组：说明节点组尚未接入", () => {
    render(<NodeGroupDetail group={group({ nodes: [] })} active={false} />);
    expect(screen.getByText("这个组还没有节点")).toBeTruthy();
    expect(screen.getByText("节点组尚未接入，暂时只能查看。")).toBeTruthy();
    expect(document.querySelector(".group-detail .btn--primary")).toBeNull();
  });

  it("免费组显示维护说明与当前徽标", () => {
    render(<NodeGroupDetail group={FREE} active />);
    expect(screen.getByText("由 Veyl 维护，不能修改 · 1 个节点")).toBeTruthy();
    expect(screen.getByText("当前节点组")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制为我的组" })).toBeNull();
  });
});
