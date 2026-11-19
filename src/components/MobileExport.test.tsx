/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MobileExportData, MyServer } from "../agent/bridge";
import { MobileExport, hasReadyServer } from "./MobileExport";

const URL_WITH_TOKEN =
  "https://veyl:secret-token@veyl.dessage.xyz/v1/mobile/profile";

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
) {
  return {
    openExternal: vi.fn(async () => {}),
    mobileExportGet: vi.fn(get),
    mobileExportRotate: vi.fn(rotate),
  } as unknown as AgentBridge & {
    openExternal: ReturnType<typeof vi.fn>;
    mobileExportGet: ReturnType<typeof vi.fn>;
    mobileExportRotate: ReturnType<typeof vi.fn>;
  };
}

function setup(bridge: AgentBridge) {
  const onClose = vi.fn();
  const onLogin = vi.fn();
  const onGoServers = vi.fn();
  render(
    <MobileExport
      bridge={bridge}
      onClose={onClose}
      onLogin={onLogin}
      onGoServers={onGoServers}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "在手机上使用" });
  return { dialog, onClose, onLogin, onGoServers };
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

    const img = await within(dialog).findByRole("img", {
      name: "sing-box 导入二维码",
    });
    expect(img.getAttribute("alt")).toBe("sing-box 导入二维码");
    expect(within(dialog).getByRole("button", { name: "复制链接" })).toBeTruthy();
    expect(within(dialog).getByText("你的节点")).toBeTruthy();
    expect(dialog.textContent).not.toContain("secret-token");
    expect(dialog.textContent).not.toContain("https://");
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

  it("下载链接交给系统浏览器，不用应用内导航", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    const link = await within(dialog).findByRole("link", {
      name: "在 App Store 打开 sing-box",
    });
    fireEvent.click(link);
    expect(bridge.openExternal).toHaveBeenCalledWith(
      "https://apps.apple.com/app/sing-box-mt/id6785326793",
    );
    const android = within(dialog).getByRole("link", {
      name: "打开 sing-box 官方下载页",
    });
    fireEvent.click(android);
    expect(bridge.openExternal).toHaveBeenCalledWith(
      "https://sing-box.sagernet.org/clients/",
    );
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
});
