/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import type { Category, NodeSummary } from "../agent/protocol";
import { NewConfigDialog } from "./NewConfigDialog";

afterEach(cleanup);

const CATEGORIES: Category[] = [
  {
    id: "chatgpt",
    name_zh: "ChatGPT",
    name_en: "ChatGPT",
    description: "对话",
    item_count: 1,
    rule_sets: ["openai"],
    dns_classifiable: true,
  },
  {
    id: "github",
    name_zh: "GitHub",
    name_en: "GitHub",
    description: "代码托管",
    item_count: 1,
    rule_sets: ["github"],
    dns_classifiable: true,
  },
];

function node(id: string, name = id): NodeSummary {
  return {
    node_id: id,
    name,
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "manual",
    created_at: Date.now(),
  };
}

function makeBridge(overrides: Partial<AgentBridge> = {}): AgentBridge {
  return {
    mode: "mock",
    categoryList: vi.fn(async () => ({ categories: CATEGORIES, total: CATEGORIES.length })),
    nodeImportText: vi.fn(async () => ({ imported: 0, skipped: [], nodes: [] })),
    nodeImportUrl: vi.fn(async () => ({ imported: 0, skipped: [], nodes: [] })),
    nodeCreate: vi.fn(async (input: { name: string }) => node(`n_${input.name}`, input.name)),
    ...overrides,
  } as unknown as AgentBridge;
}

interface RenderOptions {
  aiReady?: boolean;
  region?: string | null;
  configs?: { name: string }[];
  bridge?: AgentBridge;
  onCreate?: (input: ConfigCreateInput) => Promise<{ ok: boolean; message?: string }>;
  onAiAssist?: () => void;
  onNeedAiSetup?: () => void;
  onClose?: () => void;
  onCreated?: () => void;
}

function renderDialog(options: RenderOptions = {}) {
  const props = {
    bridge: options.bridge ?? makeBridge(),
    configs: (options.configs ?? []) as never,
    aiReady: options.aiReady ?? false,
    region: options.region === undefined ? "cn" : options.region,
    onClose: options.onClose ?? vi.fn(),
    onAiAssist: options.onAiAssist ?? vi.fn(),
    onNeedAiSetup: options.onNeedAiSetup ?? vi.fn(),
    onCreate: options.onCreate ?? vi.fn(async () => ({ ok: true })),
    onCreated: options.onCreated ?? vi.fn(),
  };
  render(<NewConfigDialog {...props} />);
  return props;
}

function enterManual() {
  fireEvent.click(screen.getByRole("button", { name: /我自己配置/ }));
}

function chooseSource(name: string | RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

describe("新建配置入口", () => {
  it("两张卡、焦点在第一张、没有实心主按钮", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /AI 协助/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /我自己配置/ })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /AI 协助/ }));
    expect(document.querySelector(".btn--primary")).toBeNull();
  });

  it("↑↓ 在两张卡之间移动焦点", () => {
    renderDialog();
    const ai = screen.getByRole("button", { name: /AI 协助/ });
    const manual = screen.getByRole("button", { name: /我自己配置/ });

    fireEvent.keyDown(ai, { key: "ArrowDown" });
    expect(document.activeElement).toBe(manual);

    fireEvent.keyDown(manual, { key: "ArrowUp" });
    expect(document.activeElement).toBe(ai);
  });

  it("Esc 关闭弹窗", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("已配好 AI：点卡片进入 AI 协助", () => {
    const { onAiAssist, onNeedAiSetup } = renderDialog({ aiReady: true });
    fireEvent.click(screen.getByRole("button", { name: /AI 协助/ }));
    expect(onAiAssist).toHaveBeenCalled();
    expect(onNeedAiSetup).not.toHaveBeenCalled();
  });

  it("未配 AI：卡片仍显示并直接进配置引导，不提示「先配置 AI」", () => {
    const { onAiAssist, onNeedAiSetup } = renderDialog({ aiReady: false });
    const card = screen.getByRole("button", { name: /AI 协助/ });
    expect(card.textContent).toContain("还没配置 AI");
    fireEvent.click(card);
    expect(onNeedAiSetup).toHaveBeenCalled();
    expect(onAiAssist).not.toHaveBeenCalled();
    expect(screen.queryByText(/先配置 AI/)).toBeNull();
    // 弹窗没关，两张卡还在。
    expect(screen.getByRole("button", { name: /我自己配置/ })).toBeTruthy();
  });

  it("手工表单可以返回入口", () => {
    renderDialog();
    enterManual();
    expect(screen.getByLabelText("名字")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(screen.getByRole("button", { name: /AI 协助/ })).toBeTruthy();
  });
});

describe("手工表单", () => {
  it("默认值直接提交：本地网站直连映射为 direct，测试节点走 source", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    const onCreated = vi.fn();
    renderDialog({ onCreate, onCreated });
    enterManual();

    expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe("我的配置");
    expect(
      (screen.getByRole("radio", { name: /本地网站直连/ }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      name: "我的配置",
      connectMode: "tun",
      routingMode: "direct",
      source: "seed",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("名字重复报在名字字段，不创建", () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ configs: [{ name: "我的配置" }], onCreate });
    enterManual();

    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "我的配置" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getByText("已经有一套叫这个名字的配置了。")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("节点名称为空、地址带 ss:// 时报在字段旁", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });
    enterManual();
    chooseSource("自己填");

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "ss://203.0.113.9" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getByText("填一个节点名称。")).toBeTruthy();
    expect(screen.getByText("只填地址，不要带 ss://。")).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("端口 70000 时不发命令", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });
    enterManual();
    chooseSource("自己填");

    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "70000" } });
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "203.0.113.9" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getByText("端口要填 1–65535 之间的整数。")).toBeTruthy();
    expect(bridge.nodeCreate).not.toHaveBeenCalled();
  });

  it("订阅地址不是 https 时停在字段，不发请求", () => {
    const bridge = makeBridge();
    renderDialog({ bridge });
    enterManual();
    chooseSource("订阅地址");

    fireEvent.change(screen.getByRole("textbox", { name: "订阅地址" }), {
      target: { value: "http://example.com/sub" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getByText("订阅地址要以 https:// 开头。")).toBeTruthy();
    expect(bridge.nodeImportUrl).not.toHaveBeenCalled();
  });

  it("粘贴两条 ss:// 按顺序绑定，配置仍然只建一套", async () => {
    const bridge = makeBridge({
      nodeImportText: vi.fn(async () => ({
        imported: 2,
        skipped: [],
        nodes: [node("n1", "东京"), node("n2", "大阪")],
      })),
    });
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ bridge, onCreate });
    enterManual();
    chooseSource(/粘贴分享链接/);

    fireEvent.change(screen.getByLabelText("粘贴分享链接"), {
      target: { value: "ss://a\nss://b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(bridge.nodeImportText).toHaveBeenCalledWith("ss://a\nss://b");
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeIds: ["n1", "n2"] }),
    );
  });

  it("node_create 失败时直接显示后端 message，不依赖 reason", async () => {
    const bridge = makeBridge({
      nodeCreate: vi.fn(async () => {
        throw { code: "INVALID_ARGUMENT", message: "服务器地址不合法" };
      }),
    });
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ bridge, onCreate });
    enterManual();
    chooseSource("自己填");

    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "203.0.113.9" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(screen.getByText("服务器地址不合法")).toBeTruthy());
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("先建节点再建配置；配置失败后重试复用已建节点", async () => {
    const bridge = makeBridge();
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "创建配置失败" })
      .mockResolvedValueOnce({ ok: true });
    renderDialog({ bridge, onCreate });
    enterManual();
    chooseSource("自己填");

    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "203.0.113.9" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(bridge.nodeCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("创建配置失败")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(bridge.nodeCreate).toHaveBeenCalledTimes(1);
    const second = onCreate.mock.calls[1][0] as ConfigCreateInput;
    expect(second.nodeIds).toEqual(["n_节点 1"]);
  });

  it("重试前改了节点字段：重新建节点，不复用旧 id", async () => {
    let created = 0;
    const nodeCreate = vi.fn(async (input: { name: string }) =>
      node(`n${++created}`, input.name),
    );
    const bridge = makeBridge({ nodeCreate });
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "创建配置失败" })
      .mockResolvedValueOnce({ ok: true });
    renderDialog({ bridge, onCreate });
    enterManual();
    chooseSource("自己填");

    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "203.0.113.9" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(nodeCreate).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));

    expect(nodeCreate).toHaveBeenCalledTimes(2);
    expect(nodeCreate.mock.calls[1][0]).toMatchObject({ server: "203.0.113.10" });
    expect((onCreate.mock.calls[1][0] as ConfigCreateInput).nodeIds).toEqual(["n2"]);
  });

  it("后端 duplicate_name 按 reason 报在名字字段", async () => {
    const onCreate = vi.fn(async () => ({
      ok: false,
      reason: "duplicate_name",
      message: "name exists",
    }));
    renderDialog({ onCreate });
    enterManual();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(screen.getByText("已经有一套叫这个名字的配置了。")).toBeTruthy(),
    );
    expect(screen.queryByText("name exists")).toBeNull();
  });

  it("只指定服务：展开多选，未选时不能创建", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ onCreate });
    enterManual();

    fireEvent.click(screen.getByRole("radio", { name: /只有我指定的服务/ }));
    expect(screen.getByLabelText("搜索服务")).toBeTruthy();
    const chatgpt = await screen.findByRole("button", { name: "ChatGPT" });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(screen.getByText("至少选一个服务。")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.click(chatgpt);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ routingMode: "proxy_selected", targets: ["chatgpt"] }),
    );
  });

  it("地区未知：说明不写「检测到 IP」，默认全部走 VPN，手选直连时提示做不到", () => {
    renderDialog({ region: null });
    enterManual();

    expect(screen.getByText(/没能识别你的地区/)).toBeTruthy();
    expect(screen.queryByText(/检测到你的 IP/)).toBeNull();
    expect(
      (screen.getByRole("radio", { name: /全部走 VPN/ }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /本地网站直连/ }));
    expect(
      screen.getByText("认不出你所在的地区，选这个的话所有网站都会走 VPN。"),
    ).toBeTruthy();
  });

  it("中国大陆：说明行用「你的电脑在中国大陆」，改选后也不再说「默认选了」", () => {
    renderDialog({ region: "cn" });
    enterManual();
    expect(screen.getByText(/你的电脑在中国大陆/)).toBeTruthy();
    expect(screen.getByText(/建议让国内网站直连/)).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: /本地网站直连/ }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /全部走 VPN/ }));
    expect(screen.getByText(/建议让国内网站直连/)).toBeTruthy();
    expect(screen.queryByText(/默认选了/)).toBeNull();
  });

  it("只展示 Shadowsocks 的能力边界", () => {
    renderDialog();
    enterManual();
    expect(screen.getByText("目前只支持 Shadowsocks 服务器。")).toBeTruthy();
    expect(screen.queryByText(/传输方式/)).toBeNull();
    expect(screen.queryByText(/SNI/)).toBeNull();
  });
});
