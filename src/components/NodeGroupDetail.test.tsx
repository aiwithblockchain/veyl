/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function renderDetail(over: Partial<Parameters<typeof NodeGroupDetail>[0]> = {}) {
  const props = {
    group: group(),
    active: false,
    activeConfigName: "全部流量",
    connection: "idle" as const,
    onActivate: vi.fn(),
    onAddNode: vi.fn(),
    onCopy: vi.fn(),
    onOpenServers: vi.fn(),
    onRemoveNode: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  render(<NodeGroupDetail {...props} />);
  return props;
}

afterEach(cleanup);

describe("组详情", () => {
  it("节点行显示状态、地址、协议与延迟；测不通的展开三段式", () => {
    renderDetail();

    expect(screen.getByText("东京 01")).toBeTruthy();
    expect(screen.getByText("45.76.20.100:8388")).toBeTruthy();
    expect(screen.getByText("63 ms")).toBeTruthy();
    expect(screen.getByText("这次测不通")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 01/ }));
    expect(screen.getByText("这个节点连不上。")).toBeTruthy();
    expect(screen.getByText("先点「测试连通」；还是不行，换一个节点。")).toBeTruthy();
  });

  it("未激活的自建组：主按钮 + 上下文行；连接中禁用并说明", () => {
    const { rerender } = render(
      <NodeGroupDetail
        group={group()}
        active={false}
        activeConfigName="全部流量"
        connection="idle"
        onActivate={vi.fn()}
        onAddNode={vi.fn()}
        onCopy={vi.fn()}
        onOpenServers={vi.fn()}
        onRemoveNode={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("将用于「全部流量」")).toBeTruthy();
    expect(screen.getByRole("button", { name: "设为当前节点组" })).toBeTruthy();

    rerender(
      <NodeGroupDetail
        group={group()}
        active={false}
        activeConfigName="全部流量"
        connection="starting"
        onActivate={vi.fn()}
        onAddNode={vi.fn()}
        onCopy={vi.fn()}
        onOpenServers={vi.fn()}
        onRemoveNode={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "设为当前节点组" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("正在连接，等这次连完再改。")).toBeTruthy();
  });

  it("没有 active 配置时不给主按钮，说明先创建一套配置", () => {
    renderDetail({ activeConfigName: null });
    expect(screen.getByText("先创建一套配置")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "设为当前节点组" })).toBeNull();
  });

  it("已激活的组不出现主按钮，只留徽标", () => {
    renderDetail({ active: true });
    expect(screen.getByText("当前节点组")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "设为当前节点组" })).toBeNull();
  });

  it("免费组只读：没有添加、改名、删除；给复制入口", () => {
    const props = renderDetail({ group: FREE, active: true });
    expect(screen.queryByRole("button", { name: "添加节点" })).toBeNull();
    expect(screen.queryByRole("button", { name: "改名" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除组" })).toBeNull();
    expect(screen.getByText("由 Veyl 维护，不能修改 · 1 个节点")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制为我的组" }));
    expect(props.onCopy).toHaveBeenCalled();
  });

  it("空组：说明 + 唯一主按钮", () => {
    renderDetail({ group: group({ nodes: [] }) });
    expect(screen.getByText("这个组还没有节点")).toBeTruthy();
    expect(screen.getByText("添加一个节点后，就能把它设为当前节点组。")).toBeTruthy();
    expect(document.querySelectorAll(".group-detail .btn--primary")).toHaveLength(1);
  });

  it("只有一个节点与整组不通的提示", () => {
    renderDetail({ group: FREE });
    expect(screen.getByText("组里只有一个节点，连不上时没有别的可换。")).toBeTruthy();

    renderDetail({
      group: group({
        nodes: [
          {
            node_id: "x1",
            name: "东京 01",
            server: "1.1.1.1",
            port: 8388,
            protocol: "ss",
            latency_ms: null,
          },
        ],
      }),
    });
    expect(screen.getByText("这个组的节点都连不上。换一组，或到组里重新测试。")).toBeTruthy();
  });

  it("添加节点弹层：三个来源，没有主按钮", () => {
    const props = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    expect(screen.getByRole("dialog", { name: "添加节点到「我的节点」" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /从我的服务器添加/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /粘贴或订阅/ })).toBeTruthy();
    expect(document.querySelectorAll(".add-node .btn--primary")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /手动填写/ }));
    expect(props.onAddNode).toHaveBeenCalledWith("manual");
  });

  it("移除节点、改名、删组都走回调", () => {
    const props = renderDetail();
    fireEvent.click(screen.getAllByRole("button", { name: "移除" })[0]);
    expect(props.onRemoveNode).toHaveBeenCalledWith("n1");

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("组名称");
    fireEvent.change(input, { target: { value: "上海 1 号" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("上海 1 号");

    fireEvent.click(screen.getByRole("button", { name: "删除组" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(props.onDelete).toHaveBeenCalled();
  });
});
