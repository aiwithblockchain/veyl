/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import type { NodeSummary } from "../agent/protocol";
import nodesSource from "../../src-tauri/src/nodes.rs?raw";
import { NodeImportDialog } from "./NodeImportDialog";

afterEach(cleanup);

function makeBridge() {
  return {
    mode: "mock",
    nodeCreate: vi.fn(async (input) => ({
      node_id: "nd_1",
      name: input.name,
      server: input.server,
      port: input.port,
      method: input.method,
      protocol: "shadowsocks" as const,
      source: "manual" as const,
      created_at: 0,
    })),
    nodeImportText: vi.fn(async () => ({ imported: 1, skipped: [], nodes: [] })),
    nodeImportUrl: vi.fn(async () => ({ imported: 2, skipped: [], nodes: [] })),
    nodeImportFile: vi.fn(async () => ({ imported: 1, skipped: [], nodes: [] })),
    pickNodeFile: vi.fn(async () => null),
    nodeUpdate: vi.fn(async () => ({
      updated: true,
      wasCurrent: false,
      disconnected: false,
      paramsChanged: true,
      rebuilt: false,
    })),
  } as unknown as AgentBridge;
}

function renderDialog(
  over: { bridge?: AgentBridge; editing?: NodeSummary | null } = {},
) {
  const bridge = over.bridge ?? makeBridge();
  const onClose = vi.fn();
  const onNotice = vi.fn();
  const onSaved = vi.fn();
  const ui = (open: boolean) => (
    <NodeImportDialog
      open={open}
      bridge={bridge}
      editing={over.editing ?? null}
      onSaved={onSaved}
      onClose={onClose}
      onNotice={onNotice}
    />
  );
  const view = render(ui(true));
  return {
    bridge,
    onClose,
    onNotice,
    onSaved,
    container: view.container,
    rerenderOpen: (open: boolean) => view.rerender(ui(open)),
  };
}

function openManual() {
  fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
}

function fillManual(
  values: { name?: string; server?: string; port?: string; password?: string } = {},
) {
  const name = values.name ?? "东京 01";
  const server = values.server ?? "203.0.113.9";
  const port = values.port ?? "8388";
  const password = values.password ?? "secret";

  fireEvent.change(screen.getByRole("textbox", { name: "节点名" }), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText("example.com 或 1.2.3.4"), {
    target: { value: server },
  });
  fireEvent.change(screen.getByPlaceholderText("8388"), {
    target: { value: port },
  });
  fireEvent.change(screen.getByPlaceholderText("连接密码"), {
    target: { value: password },
  });
}

describe("链接 / 订阅段", () => {
  it("空输入时「添加」禁用，文件入口在弹层里", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "添加节点" });

    expect(
      within(dialog).getByText(
        "支持多行 ss:// 链接或 https 订阅地址；文件里的节点密码不要外传。",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "从文件导入" })).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "添加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("ss:// 文本走 node_import_text，成功提示走 toast，跳过原因用中文", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeImportText: ReturnType<typeof vi.fn> }).nodeImportText =
      vi.fn(async () => ({
        imported: 1,
        skipped: [{ name: "旧节点", reason: "duplicate" }],
        nodes: [],
      }));
    const { onNotice } = renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    const field = within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" });

    fireEvent.change(field, { target: { value: "ss://abc\nss://def" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(bridge.nodeImportText).toHaveBeenCalledWith("ss://abc\nss://def"),
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "info",
        text: "已添加 1 个节点",
      }),
    );
    expect(within(dialog).getByText("旧节点：已有同名节点")).toBeTruthy();
    expect(within(dialog).queryByText("duplicate")).toBeNull();
  });

  it("https 订阅走 node_import_url", async () => {
    const bridge = makeBridge();
    const { onNotice } = renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" }),
      { target: { value: "https://sub.example/nodes" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(bridge.nodeImportUrl).toHaveBeenCalledWith(
        "https://sub.example/nodes",
      ),
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "info",
        text: "已添加 2 个节点",
      }),
    );
  });

  it("从文件导入：先显示文件名确认，再调 node_import_file", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { pickNodeFile: ReturnType<typeof vi.fn> }).pickNodeFile =
      vi.fn(async () => "/Users/me/nodes.txt");
    const { onNotice } = renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    fireEvent.click(within(dialog).getByRole("button", { name: "从文件导入" }));

    expect(await within(dialog).findByText("nodes.txt")).toBeTruthy();
    expect(bridge.nodeImportFile).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "导入" }));
    await waitFor(() =>
      expect(bridge.nodeImportFile).toHaveBeenCalledWith("/Users/me/nodes.txt"),
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "info",
        text: "已添加 1 个节点",
      }),
    );
  });

  it("文件导入失败按错误码给三段文案", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { pickNodeFile: ReturnType<typeof vi.fn> }).pickNodeFile =
      vi.fn(async () => "/Users/me/big.txt");
    (bridge as unknown as { nodeImportFile: ReturnType<typeof vi.fn> }).nodeImportFile =
      vi.fn(async () => {
        throw {
          code: "INVALID_ARGUMENT",
          message: "file too large",
          details: { reason: "file_too_large", max_bytes: 1048576 },
        };
      });

    renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    fireEvent.click(within(dialog).getByRole("button", { name: "从文件导入" }));
    await within(dialog).findByText("big.txt");
    fireEvent.click(within(dialog).getByRole("button", { name: "导入" }));

    expect(
      await within(dialog).findByText("文件太大了，最大 1 MB。换一个小一点的文件。"),
    ).toBeTruthy();
  });

  it("http 订阅直接拒绝，不发请求", async () => {
    const bridge = makeBridge();
    renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" }),
      { target: { value: "http://sub.example/nodes" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    expect(
      await within(dialog).findByText("订阅地址要用 https，不能是 http。"),
    ).toBeTruthy();
    expect(bridge.nodeImportText).not.toHaveBeenCalled();
    expect(bridge.nodeImportUrl).not.toHaveBeenCalled();
  });
});

describe("手动填写段", () => {
  it("四项信息齐全后调 node_create，省略 configId，成功后关闭并提示进池", async () => {
    const bridge = makeBridge();
    const { onClose, onNotice } = renderDialog({ bridge });

    openManual();
    fillManual({ name: " 东京 01 ", server: " 203.0.113.9 ", password: "secret" });
    fireEvent.change(screen.getByRole("combobox", { name: "加密方式" }), {
      target: { value: "chacha20-ietf-poly1305" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    await waitFor(() =>
      expect(bridge.nodeCreate).toHaveBeenCalledWith({
        name: "东京 01",
        server: "203.0.113.9",
        port: 8388,
        method: "chacha20-ietf-poly1305",
        password: "secret",
      }),
    );
    expect(onNotice).toHaveBeenCalledWith({
      level: "info",
      text: "节点已加入节点池并绑定当前配置",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空提交逐字段报错，不发命令，焦点落在节点名", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(screen.getByText("填一个节点名，方便在列表里认出它。")).toBeTruthy();
    expect(screen.getByText("填服务器的地址。")).toBeTruthy();
    expect(screen.getByText("端口要填 1–65535 之间的整数。")).toBeTruthy();
    expect(screen.getByText("填连接密码。")).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("东京 01"),
    );
  });

  it("地址带协议、端口越界、密码过长都贴着字段报错", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({
      server: "https://203.0.113.9",
      port: "70000",
      password: "x".repeat(257),
    });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      screen.getByText("地址只填域名或 IP，不要带 https://。"),
    ).toBeTruthy();
    expect(screen.getByText("端口要填 1–65535 之间的整数。")).toBeTruthy();
    expect(screen.getByText("密码最多 256 个字符。")).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("地址粘成 host:port 时报错，提示端口填右侧端口栏", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({ server: "1.2.3.4:8388" });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      screen.getByText("地址里不要带端口，端口填在右边的端口栏。"),
    ).toBeTruthy();
    const field = screen.getByPlaceholderText("example.com 或 1.2.3.4");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("裸 IPv6 地址照常通过", async () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({ server: "2001:db8::1" });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    await waitFor(() =>
      expect(bridge.nodeCreate).toHaveBeenCalledWith(
        expect.objectContaining({ server: "2001:db8::1" }),
      ),
    );
  });

  it("普通域名与 IPv4 地址不受影响", async () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({ server: "example.com" });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    await waitFor(() =>
      expect(bridge.nodeCreate).toHaveBeenCalledWith(
        expect.objectContaining({ server: "example.com" }),
      ),
    );
  });

  it("加密方式是白名单下拉，默认 aes-256-gcm；密码不回显", () => {
    renderDialog();
    openManual();

    const select = screen.getByRole("combobox", {
      name: "加密方式",
    }) as HTMLSelectElement;
    expect(select.value).toBe("aes-256-gcm");
    expect(select.options).toHaveLength(12);

    const password = screen.getByPlaceholderText("连接密码") as HTMLInputElement;
    expect(password.type).toBe("password");
  });

  it("后端返回 unsupported_method 时错误落在加密方式", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeCreate: ReturnType<typeof vi.fn> }).nodeCreate =
      vi.fn(async () => {
        throw {
          code: "INVALID_ARGUMENT",
          message: "unsupported",
          details: { reason: "unsupported_method" },
        };
      });
    renderDialog({ bridge });

    openManual();
    fillManual();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      await screen.findByText("不支持这种加密方式，换一个再试。"),
    ).toBeTruthy();
  });

  it("切换分段不丢已填内容", () => {
    renderDialog();
    openManual();
    fillManual({ name: "保留我" });

    fireEvent.click(screen.getByRole("button", { name: "链接 / 订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));

    expect(
      (screen.getByPlaceholderText("东京 01") as HTMLInputElement).value,
    ).toBe("保留我");
  });
});

describe("弹层关闭、提交态与重开", () => {
  it("Esc、遮罩与关闭按钮都能关闭；提交中一律不关", async () => {
    const { bridge, onClose, container, rerenderOpen } = renderDialog();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(container.querySelector(".modal-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    let resolveCreate!: (value: unknown) => void;
    (bridge as unknown as { nodeCreate: ReturnType<typeof vi.fn> }).nodeCreate =
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );
    rerenderOpen(false);
    rerenderOpen(true);
    openManual();
    fillManual();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    const busyButton = (await screen.findByRole("button", {
      name: "正在添加…",
    })) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
    expect(
      (screen.getByPlaceholderText("东京 01") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);

    resolveCreate({
      node_id: "nd_1",
      name: "东京 01",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "manual",
      created_at: 0,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(4));
  });

  it("重新打开回到链接段并清空表单", () => {
    const { rerenderOpen } = renderDialog();
    openManual();
    fillManual({ name: "保留我" });

    rerenderOpen(false);
    rerenderOpen(true);

    expect(
      screen.getByRole("button", { name: "链接 / 订阅" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    expect(
      (screen.getByPlaceholderText("东京 01") as HTMLInputElement).value,
    ).toBe("");
  });

  it("后端 INVALID_ARGUMENT 用设计指定文案，不用通用句", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeCreate: ReturnType<typeof vi.fn> }).nodeCreate =
      vi.fn(async () => {
        throw {
          code: "INVALID_ARGUMENT",
          message: "",
          details: { reason: "invalid_argument" },
        };
      });
    renderDialog({ bridge });

    openManual();
    fillManual();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      await screen.findByText("没有添加成功，检查地址后再试。"),
    ).toBeTruthy();
    expect(screen.queryByText("参数不对，检查后重试。")).toBeNull();
  });

  it("地址按 UTF-8 字节限长，超长单独报「多贴了内容」", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({ server: "例".repeat(86) });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      screen.getByText("地址最多 253 个字符，检查一下有没有多贴了内容。"),
    ).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("地址含空白或斜杠仍按格式错误报", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    openManual();
    fillManual({ server: "203.0.113.9/32" });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(
      screen.getByText("地址只填域名或 IP，不要带 https://。"),
    ).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("手动段说明换成服务商后台口径", () => {
    renderDialog();
    openManual();

    expect(
      screen.getByText(
        "在服务商后台找到地址、端口、加密方式和密码；密码只保存在本机。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/文件里的节点密码不要外传/)).toBeNull();
  });
});

describe("切段与改输入：旧结果不残留", () => {
  it("改链接文本会清掉上一次的跳过原因", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeImportText: ReturnType<typeof vi.fn> }).nodeImportText =
      vi.fn(async () => ({
        imported: 0,
        skipped: [{ name: "旧节点", reason: "duplicate" }],
        nodes: [],
      }));
    renderDialog({ bridge });
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    const field = within(dialog).getByRole("textbox", {
      name: "节点链接或订阅地址",
    });

    fireEvent.change(field, { target: { value: "ss://a" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    expect(await within(dialog).findByText("旧节点：已有同名节点")).toBeTruthy();

    fireEvent.change(field, { target: { value: "ss://b" } });
    expect(within(dialog).queryByText("旧节点：已有同名节点")).toBeNull();
  });

  it("切换分段清掉两边的错误与结果", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });

    // 链接段：http 地址报错
    const dialog = screen.getByRole("dialog", { name: "添加节点" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" }),
      { target: { value: "http://sub.example/nodes" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    expect(
      within(dialog).getByText("订阅地址要用 https，不能是 http。"),
    ).toBeTruthy();

    // 手动段：空提交报错
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    expect(
      screen.queryByText("订阅地址要用 https，不能是 http。"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    expect(screen.getByText("填一个节点名，方便在列表里认出它。")).toBeTruthy();

    // 切回链接段：手动错误也清掉
    fireEvent.click(screen.getByRole("button", { name: "链接 / 订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    expect(
      screen.queryByText("填一个节点名，方便在列表里认出它。"),
    ).toBeNull();
  });

  it("加密方式下拉与 Host 的 SUPPORTED_METHODS 逐项一致", () => {
    renderDialog();
    openManual();

    const select = screen.getByRole("combobox", {
      name: "加密方式",
    }) as HTMLSelectElement;
    const block =
      /pub const SUPPORTED_METHODS: &\[&str\] = &?\[([\s\S]*?)\];/.exec(
        nodesSource,
      )?.[1] ?? "";
    const host = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    expect(host.length).toBeGreaterThan(0);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(host);
  });
});

describe("编辑态", () => {
  const MANUAL: NodeSummary = {
    node_id: "nd_1",
    name: "东京 01",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "manual",
    created_at: 0,
  };
  const SUBSCRIBED: NodeSummary = {
    ...MANUAL,
    node_id: "nd_2",
    name: "订阅 01",
    source: "url",
  };

  it("标题改为编辑节点，隐藏导入分段，预填字段且密码留空", () => {
    renderDialog({ editing: MANUAL });

    expect(screen.getByRole("dialog", { name: "编辑节点" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "链接 / 订阅" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从文件导入" })).toBeNull();
    expect(
      (screen.getByPlaceholderText("东京 01") as HTMLInputElement).value,
    ).toBe("东京 01");
    expect(
      (screen.getByPlaceholderText("example.com 或 1.2.3.4") as HTMLInputElement)
        .value,
    ).toBe("203.0.113.9");
    expect((screen.getByPlaceholderText("8388") as HTMLInputElement).value).toBe(
      "8388",
    );
    const password = screen.getByPlaceholderText(
      "不修改就留空",
    ) as HTMLInputElement;
    expect(password.value).toBe("");
  });

  it("手动节点保存：调 node_update，密码留空不传", async () => {
    const bridge = makeBridge();
    const { onNotice, onClose, onSaved } = renderDialog({ bridge, editing: MANUAL });

    fireEvent.change(screen.getByPlaceholderText("东京 01"), {
      target: { value: "东京 02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(bridge.nodeUpdate).toHaveBeenCalledWith({
        nodeId: "nd_1",
        name: "东京 02",
        server: "203.0.113.9",
        port: 8388,
        method: "aes-256-gcm",
      }),
    );
    expect(onNotice).toHaveBeenCalledWith({ level: "info", text: "已保存" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("订阅节点：连接参数四栏禁用，只改名能保存", async () => {
    const bridge = makeBridge();
    renderDialog({ bridge, editing: SUBSCRIBED });

    expect(
      (screen.getByPlaceholderText("example.com 或 1.2.3.4") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText("8388") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: "加密方式" }) as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText("不修改就留空") as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("东京 01"), {
      target: { value: "我的订阅" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(bridge.nodeUpdate).toHaveBeenCalledWith({
        nodeId: "nd_2",
        name: "我的订阅",
      }),
    );
  });

  it("改的是正在用的节点：提示已断开", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeUpdate: ReturnType<typeof vi.fn> }).nodeUpdate =
      vi.fn(async () => ({
        updated: true,
        wasCurrent: true,
        disconnected: true,
        paramsChanged: true,
        rebuilt: false,
      }));
    const { onNotice } = renderDialog({ bridge, editing: MANUAL });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "info",
        text: "已保存；已断开，重新连接后使用新设置",
      }),
    );
  });

  it("保存失败留在弹层并就地报错", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeUpdate: ReturnType<typeof vi.fn> }).nodeUpdate =
      vi.fn(async () => {
        throw {
          code: "CONFLICT",
          message: "已保存；这套配置正在切换连接，稍后重新连接即可用新设置",
          details: { reason: "switch_in_progress" },
        };
      });
    const { onClose } = renderDialog({ bridge, editing: MANUAL });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("编辑保存后的连接结果", () => {
  const NODE: NodeSummary = {
    node_id: "nd_1",
    name: "东京 01",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "manual",
    created_at: 0,
  };

  it("重建失败：用错误样式给 Host 的文案，不报「已保存」", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeUpdate: ReturnType<typeof vi.fn> }).nodeUpdate =
      vi.fn(async () => ({
        updated: true,
        wasCurrent: false,
        disconnected: false,
        paramsChanged: true,
        rebuilt: false,
        rebuildStatus: "failed",
        message: "新设置这次没能应用，已回到原来的连接；重新连接后就会用它。",
      }));
    const { onNotice } = renderDialog({ bridge, editing: NODE });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "error",
        text: "新设置这次没能应用，已回到原来的连接；重新连接后就会用它。",
      }),
    );
  });

  it("重建成功：提示已用新设置重新连接", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { nodeUpdate: ReturnType<typeof vi.fn> }).nodeUpdate =
      vi.fn(async () => ({
        updated: true,
        wasCurrent: false,
        disconnected: false,
        paramsChanged: true,
        rebuilt: true,
        rebuildStatus: "applied",
        message: null,
      }));
    const { onNotice } = renderDialog({ bridge, editing: NODE });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({
        level: "info",
        text: "已保存；已用新设置重新连接",
      }),
    );
  });
});
