/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridge,
  MobileClientId,
  MobileExportData,
  MyServer,
} from "../agent/bridge";
import { MockAgentBridge } from "../agent/mockAgent";
import { MobileExport, hasReadyServer } from "./MobileExport";

const SINGBOX_URL =
  "https://veyl:secret-token@veyl.dessage.xyz/v1/mobile/profile";
const CLASH_URL = `${SINGBOX_URL}/clash`;
const SS_URL = `${SINGBOX_URL}/ss`;
const SINGBOX_QR = "data:image/svg+xml;base64,PHN2Zy1zaW5nYm94Lz4=";
const CLASH_QR = "data:image/svg+xml;base64,PHN2Zy1jbGFzaC8+";
const CLIENT_QR = "data:image/svg+xml;base64,PHN2Zy1jbGllbnQvPg==";

const CLIENT_URLS: Record<MobileClientId, string> = {
  singbox: "https://sing-box.sagernet.org/clients/",
  hiddify: "https://hiddify.com",
  cmfa: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases",
};

const OK: MobileExportData = {
  state: "ok",
  node_count: 2,
  created_at: 1,
  formats: [
    { format: "singbox", url: SINGBOX_URL, qr_data_url: SINGBOX_QR },
    { format: "clash", url: CLASH_URL, qr_data_url: CLASH_QR },
    { format: "ss", url: SS_URL, qr_data_url: null },
  ],
};

function makeBridge(
  get: () => Promise<MobileExportData>,
  rotate: () => Promise<MobileExportData> = get,
  clients: (
    client: MobileClientId,
  ) => Promise<{ url: string; qr_data_url: string }> = async (client) => ({
    url: CLIENT_URLS[client],
    qr_data_url: CLIENT_QR,
  }),
) {
  return {
    openExternal: vi.fn(async () => {}),
    mobileExportGet: vi.fn(get),
    mobileExportRotate: vi.fn(rotate),
    mobileClientsQr: vi.fn(clients),
  } as unknown as AgentBridge & {
    openExternal: ReturnType<typeof vi.fn>;
    mobileExportGet: ReturnType<typeof vi.fn>;
    mobileExportRotate: ReturnType<typeof vi.fn>;
    mobileClientsQr: ReturnType<typeof vi.fn>;
  };
}

function setup(bridge: AgentBridge) {
  const onClose = vi.fn();
  const onLogin = vi.fn();
  const onGoServers = vi.fn();
  const onAskAi = vi.fn();
  render(
    <MobileExport
      bridge={bridge}
      onClose={onClose}
      onLogin={onLogin}
      onGoServers={onGoServers}
      onAskAi={onAskAi}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "在手机上使用" });
  return { dialog, onClose, onLogin, onGoServers, onAskAi };
}

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 1 号",
    region: "nrt1",
    plan: "s-1vcpu-1gb",
    state: "healthy",
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("在手机上使用：弹层", () => {
  it("导入为主：两段切换器、导入码与复制，ss 不出现在界面", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    const img = await within(dialog).findByRole("img", {
      name: "sing-box 导入二维码",
    });
    expect(img.getAttribute("alt")).toBe("sing-box 导入二维码");
    expect(within(dialog).getByRole("button", { name: "复制链接" })).toBeTruthy();
    expect(
      within(dialog).getByRole("heading", { name: "导入节点" }),
    ).toBeTruthy();
    const formats = within(dialog).getByRole("group", { name: "导入格式" });
    const formatButtons = within(formats).getAllByRole("button");
    expect(formatButtons.map((button) => button.textContent)).toEqual([
      "sing-box",
      "Clash",
    ]);
    expect(within(formats).queryByText("ss://")).toBeNull();
    expect(dialog.textContent).not.toContain("ss://");
    expect(dialog.textContent).not.toContain("secret-token");
    expect(dialog.textContent).not.toContain("https://");
  });

  it("切换格式：二维码与复制目标同时换，切回不重复请求", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clash" }));

    expect(
      within(dialog).getByRole("img", { name: "Clash 导入二维码" }),
    ).toBeTruthy();
    expect(within(dialog).getByText("已切到 Clash 格式。")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "复制链接" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CLASH_URL);

    fireEvent.click(within(dialog).getByRole("button", { name: "sing-box" }));
    expect(
      within(dialog).getByRole("img", { name: "sing-box 导入二维码" }),
    ).toBeTruthy();
    expect(bridge.mobileExportGet).toHaveBeenCalledTimes(1);
  });

  it("客户端三行与归属说明", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    expect(
      within(dialog).getByRole("heading", { name: "还没有客户端？" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("客户端不是我们开发的，Veyl 只提供节点。"),
    ).toBeTruthy();
    const rows = dialog.querySelectorAll(".mobile-export__client-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain(
      "iOS（大陆以外 Apple 账号）/ Android · sing-box",
    );
    expect(rows[1]?.textContent).toContain("iOS / Android · sing-box / Clash");
    expect(rows[2]?.textContent).toContain("Android · Clash 格式");
  });

  it("点行：展开下载码并切到它吃的格式，同时只开一行", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Clash Meta for Android/ }),
    );
    expect(
      await within(dialog).findByRole("img", { name: "Clash 导入二维码" }),
    ).toBeTruthy();
    expect(within(dialog).getByText("已切到 Clash 格式。")).toBeTruthy();
    await waitFor(() =>
      expect(
        dialog
          .querySelector<HTMLImageElement>(".mobile-export__client-qr-img")
          ?.getAttribute("src"),
      ).toBe(CLIENT_QR),
    );
    const panelImg =
      dialog.querySelector<HTMLImageElement>(".mobile-export__client-qr-img");
    expect(panelImg?.getAttribute("alt")).toBe("");
    expect(panelImg?.getAttribute("aria-hidden")).toBe("true");
    expect(
      dialog.querySelectorAll(".mobile-export__client-panel"),
    ).toHaveLength(1);

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Hiddify/ }),
    );
    expect(
      within(dialog).getByRole("img", { name: "sing-box 导入二维码" }),
    ).toBeTruthy();
    expect(
      dialog.querySelectorAll(".mobile-export__client-panel"),
    ).toHaveLength(1);
    expect(bridge.mobileClientsQr).toHaveBeenCalledWith("cmfa");
    expect(bridge.mobileClientsQr).toHaveBeenCalledWith("hiddify");
  });

  it("展开行的下载页链接：打开系统浏览器", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Clash Meta for Android/ }),
    );
    const link = within(dialog).getByRole("link", { name: /打开下载页/ });
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(CLIENT_URLS.cmfa),
    );
    fireEvent.click(link);
    expect(bridge.openExternal).toHaveBeenCalledWith(CLIENT_URLS.cmfa);
  });

  it("Esc：先收二级面板，再关弹层", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onClose } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Hiddify/ }),
    );
    expect(
      dialog.querySelectorAll(".mobile-export__client-panel"),
    ).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      dialog.querySelectorAll(".mobile-export__client-panel"),
    ).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("客户端兜底 URL 与 bridge 返回一致，防止两边常量漂移", async () => {
    // 载入失败时面板只能用组件里的兜底 URL；它必须与 Host / mock 的固定映射相同。
    const reference = new MockAgentBridge();
    const bridge = makeBridge(
      async () => OK,
      async () => OK,
      async () => {
        throw { code: "TIMEOUT", message: "超时" };
      },
    );
    const { dialog } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    for (const [name, id] of [
      ["sing-box 官方", "singbox"],
      ["Hiddify", "hiddify"],
      ["Clash Meta for Android", "cmfa"],
    ] as const) {
      fireEvent.click(
        within(dialog).getByRole("button", { name: new RegExp(name) }),
      );
      const link = within(dialog).getByRole("link", { name: /打开下载页/ });
      const expected = await reference.mobileClientsQr?.(id);
      expect(link.getAttribute("href")).toBe(expected?.url);
    }
  });

  it("底部问 AI：点击交给 App，Tab 顺序以它为最后一站", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onAskAi } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    const ask = within(dialog).getByRole("button", {
      name: "不会操作？问 AI",
    });
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    expect(focusables[0]?.getAttribute("aria-label")).toBe("关闭");
    expect(focusables[focusables.length - 1]).toBe(ask);
    expect(
      focusables.filter((node) =>
        node.classList.contains("mobile-export__client-row"),
      ),
    ).toHaveLength(3);

    fireEvent.click(ask);
    expect(onAskAi).toHaveBeenCalledTimes(1);
  });

  it("复制成功：同一位置变「已复制」", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "复制链接" }),
    );

    expect(await within(dialog).findByText("已复制")).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SINGBOX_URL);
  });

  it("复制失败：原位提示，且不让令牌留在 DOM 里", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "复制链接" }),
    );

    expect(await within(dialog).findByText("复制失败")).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).not.toContain("secret-token");
  });

  it("未登录：切换器可用，只有登录入口", async () => {
    const bridge = makeBridge(async () => ({ state: "login_required" }));
    const { dialog, onLogin } = setup(bridge);

    expect(await within(dialog).findByText("先登录。")).toBeTruthy();
    expect(
      within(dialog).getByRole("group", { name: "导入格式" }),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /复制/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /重新生成/ })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));
    expect(onLogin).toHaveBeenCalled();
  });

  it("没有可用服务器：给「去我的服务器」", async () => {
    const bridge = makeBridge(async () => ({ state: "no_ready_server" }));
    const { dialog, onGoServers } = setup(bridge);

    expect(await within(dialog).findByText("还没有可用的服务器。")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "去我的服务器" }),
    );
    expect(onGoServers).toHaveBeenCalled();
  });

  it("生成失败：给重试，再成功就显示二维码", async () => {
    const get = vi
      .fn<() => Promise<MobileExportData>>()
      .mockRejectedValueOnce({ code: "TIMEOUT", message: "超时" })
      .mockResolvedValueOnce(OK);
    const bridge = makeBridge(get);
    const { dialog } = setup(bridge);

    expect(
      await within(dialog).findByText("这个格式暂时生成不了。"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(
      await within(dialog).findByRole("img", { name: "sing-box 导入二维码" }),
    ).toBeTruthy();
  });

  it("某个格式缺失：只影响该格式", async () => {
    const onlySingbox: MobileExportData = {
      state: "ok",
      node_count: 1,
      created_at: 1,
      formats: [
        { format: "singbox", url: SINGBOX_URL, qr_data_url: SINGBOX_QR },
        { format: "ss", url: SS_URL, qr_data_url: null },
      ],
    };
    const bridge = makeBridge(async () => onlySingbox);
    const { dialog } = setup(bridge);

    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clash" }));

    expect(
      within(dialog).getByText("这个格式暂时生成不了。"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("img", { name: "Clash 导入二维码" }),
    ).toBeNull();
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("重新生成：就地确认，初始焦点在取消，Esc 只取消确认", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onClose } = setup(bridge);

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "重新生成" }),
    );
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    const confirm = within(dialog).getByRole("button", { name: "重新生成" });
    expect(confirm.className).toContain("btn--danger-ghost");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(dialog).queryByRole("button", { name: "取消" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.mobileExportRotate).not.toHaveBeenCalled();
  });

  it("确认重新生成：调用命令并给出失效说明", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "重新生成" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));

    await waitFor(() =>
      expect(bridge.mobileExportRotate).toHaveBeenCalledTimes(1),
    );
    expect(
      await within(dialog).findByText(
        "已重新生成；手机上的旧配置下次更新时失效。",
      ),
    ).toBeTruthy();
  });
});

describe("左栏快捷行的出现条件", () => {
  it("只有 healthy / active 且已关联节点算就绪", () => {
    expect(hasReadyServer([server({ state: "healthy" })])).toBe(true);
    expect(hasReadyServer([server({ state: "active" })])).toBe(true);
    expect(hasReadyServer([server({ state: "healthy", node_id: null })])).toBe(
      false,
    );
    expect(hasReadyServer([server({ state: "installing" })])).toBe(false);
    expect(hasReadyServer([server({ state: "error" })])).toBe(false);
    expect(hasReadyServer([server({ state: "destroyed" })])).toBe(false);
    expect(hasReadyServer([])).toBe(false);
  });

  it("健康检查失败但 node_id 还在：不算就绪，左栏入口不出现", () => {
    const failed = server({ state: "error", node_id: "nd_1" });
    expect(hasReadyServer([failed])).toBe(false);
  });
});
