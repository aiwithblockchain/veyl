/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
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
  } as unknown as AgentBridge;
}

function renderDialog(over: { bridge?: AgentBridge } = {}) {
  const bridge = over.bridge ?? makeBridge();
  const onClose = vi.fn();
  const onNotice = vi.fn();
  render(
    <NodeImportDialog
      open
      bridge={bridge}
      onClose={onClose}
      onNotice={onNotice}
    />,
  );
  return { bridge, onClose, onNotice };
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
      text: "节点已加入节点池",
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
