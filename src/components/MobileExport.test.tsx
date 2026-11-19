/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MobileExportData, MyServer } from "../agent/bridge";
import { MobileExport, hasReadyServer } from "./MobileExport";

const URL_WITH_TOKEN =
  "https://veyl:secret-token@veyl.dessage.xyz/v1/mobile/profile";

const DOWNLOAD_QR = "data:image/svg+xml;base64,PHN2Zy1kb3dubG9hZC8+";

const OK: MobileExportData = {
  state: "ok",
  url: URL_WITH_TOKEN,
  qr_data_url: "data:image/svg+xml;base64,PHN2Zy8+",
  node_count: 2,
  created_at: 1,
};

function makeBridge(
  get: () => Promise<MobileExportData>,
  rotate: () => Promise<MobileExportData> = get,
  clientsQr: () => Promise<{ qr_data_url: string }> = async () => ({
    qr_data_url: DOWNLOAD_QR,
  }),
) {
  return {
    openExternal: vi.fn(async () => {}),
    mobileExportGet: vi.fn(get),
    mobileExportRotate: vi.fn(rotate),
    mobileClientsQr: vi.fn(clientsQr),
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
  it("有可用服务器：显示二维码与复制，界面文本里没有链接令牌", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    expect(await within(dialog).findByRole("img", {
      name: "sing-box 导入二维码",
    })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "复制链接" })).toBeTruthy();
    expect(
      within(dialog).getByText("节点变化会自动更新，不用重扫。"),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("secret-token");
    expect(dialog.textContent).not.toContain("https://");
  });

  it("两个编号步骤与两个图注：编号对读屏隐藏", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });
    expect(
      within(dialog).getByRole("heading", { name: "安装客户端" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("heading", { name: "导入节点" }),
    ).toBeTruthy();
    const nums = Array.from(
      dialog.querySelectorAll<HTMLElement>(".mobile-export__step-num"),
    );
    expect(nums.map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(nums.every((node) => node.getAttribute("aria-hidden") === "true")).toBe(
      true,
    );
    expect(within(dialog).getByText("扫码下载")).toBeTruthy();
    expect(within(dialog).getByText("扫码导入")).toBeTruthy();
  });

  it("v1 的重复文案已删除", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);
    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });

    expect(
      within(dialog).queryByText(
        "Veyl 不提供手机客户端，用 sing-box 官方客户端。",
      ),
    ).toBeNull();
    expect(
      within(dialog).queryByText("Google Play、F-Droid 或 GitHub 任选。"),
    ).toBeNull();
    expect(within(dialog).queryByText("导入你的节点")).toBeNull();
    expect(within(dialog).queryByText("用手机扫码打开下载页")).toBeNull();
    expect(
      within(dialog).getByText("需要大陆以外的 Apple 账号。"),
    ).toBeTruthy();
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

    fireEvent.click(await within(dialog).findByRole("button", { name: "复制链接" }));

    expect(await within(dialog).findByText("已复制")).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(URL_WITH_TOKEN);
  });

  it("未登录：只有登录入口，没有复制与重新生成", async () => {
    const bridge = makeBridge(async () => ({ state: "login_required" }));
    const { dialog, onLogin } = setup(bridge);

    expect(await within(dialog).findByText("先登录。")).toBeTruthy();
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
      await within(dialog).findByText("二维码暂时生成不了。"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(
      await within(dialog).findByRole("img", { name: "sing-box 导入二维码" }),
    ).toBeTruthy();
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

  it("下载链接都指向官方客户端页，交给系统浏览器打开", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    const iphone = await within(dialog).findByRole("link", {
      name: "查看 sing-box 的 iPhone 安装说明",
    });
    expect(iphone.textContent).toContain("官方下载页");
    expect(iphone.getAttribute("href")).toBe(
      "https://sing-box.sagernet.org/clients/",
    );
    fireEvent.click(iphone);
    expect(bridge.openExternal).toHaveBeenCalledWith(
      "https://sing-box.sagernet.org/clients/",
    );
    expect(
      within(dialog).getByText("需要大陆以外的 Apple 账号。"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(
        "需要大陆以外的 Apple 账号。页内有 App Store 入口。",
      ),
    ).toBeNull();

    const android = within(dialog).getByRole("link", {
      name: "查看 sing-box 的 Android 安装说明",
    });
    expect(android.getAttribute("href")).toBe(
      "https://sing-box.sagernet.org/clients/",
    );
    fireEvent.click(android);
    expect(bridge.openExternal).toHaveBeenCalledTimes(2);
    expect(bridge.openExternal).toHaveBeenLastCalledWith(
      "https://sing-box.sagernet.org/clients/",
    );
  });

  it("下载码：图注在码上方，80 码区、读屏跳过", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    expect(await within(dialog).findByText("扫码下载")).toBeTruthy();
    const img =
      dialog.querySelector<HTMLImageElement>(".mobile-export__download-qr-img");
    expect(img?.getAttribute("src")).toBe(DOWNLOAD_QR);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.getAttribute("width")).toBe("80");
    expect(img?.getAttribute("height")).toBe("80");
    expect(dialog.querySelector(".mobile-export__download-qr-box")).toBeTruthy();
  });

  it("下载码与账户态无关：未登录也显示，步骤 1 与问 AI 也在", async () => {
    const bridge = makeBridge(async () => ({ state: "login_required" }));
    const { dialog } = setup(bridge);

    expect(await within(dialog).findByText("先登录。")).toBeTruthy();
    expect(
      dialog.querySelector(".mobile-export__download-qr-img"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("heading", { name: "安装客户端" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "不会操作？问 AI" }),
    ).toBeTruthy();
  });

  it("下载码读取失败：不留破图，只保留空位", async () => {
    const bridge = makeBridge(
      async () => OK,
      async () => OK,
      async () => {
        throw { code: "TIMEOUT", message: "超时" };
      },
    );
    const { dialog } = setup(bridge);

    await within(dialog).findByRole("img", { name: "sing-box 导入二维码" });
    expect(dialog.querySelector(".mobile-export__download-qr-box")).toBeTruthy();
    expect(dialog.querySelector(".mobile-export__download-qr-img")).toBeNull();
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
