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
const SS_QR = "data:image/svg+xml;base64,PHN2Zy1zcy8+";
const CLIENT_QR = "data:image/svg+xml;base64,PHN2Zy1jbGllbnQvPg==";

const CLIENT_URLS: Record<MobileClientId, string> = {
  singbox: "https://sing-box.sagernet.org/clients/",
  shadowrocket: "https://apps.apple.com/us/app/shadowrocket/id932747118",
  hiddify: "https://github.com/hiddify/hiddify-app",
  cmfa: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases",
};

const APP_NAMES = [
  "sing-box",
  "Shadowrocket",
  "Clash Meta for Android",
  "Hiddify",
  "我的 App 不在列表里",
];

const ROW_NOTE = "用它只能全部走节点，国内网站也会绕道。";

const OK: MobileExportData = {
  state: "ok",
  node_count: 2,
  created_at: 1,
  formats: [
    { format: "singbox", url: SINGBOX_URL, qr_data_url: SINGBOX_QR },
    { format: "clash", url: CLASH_URL, qr_data_url: CLASH_QR },
    { format: "ss", url: SS_URL, qr_data_url: SS_QR },
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

function row(dialog: HTMLElement, name: string) {
  return within(dialog).getByRole("button", {
    name: new RegExp(`^${name}`),
  });
}

/** 渲染结果里所有用户能读到的文字：可见文本 + alt / title / aria-label。 */
function readableText(dialog: HTMLElement): string {
  const parts: string[] = [dialog.textContent ?? ""];
  dialog.querySelectorAll("*").forEach((el) => {
    for (const attr of ["alt", "title", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value) parts.push(value);
    }
  });
  // App 自己的产品名允许出现；去掉它再查「Clash」这一格式词。
  return parts.join("\n").replaceAll("Clash Meta for Android", "");
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
  delete (Element.prototype as unknown as Record<string, unknown>)
    .scrollIntoView;
});

describe("在手机上使用：按 App 分类", () => {
  it("默认一行都不展开：五行顺序、引导句与归属句", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    expect(
      within(dialog).getByText("选你手机上用的 App，还没有就先装一个。"),
    ).toBeTruthy();
    const names = Array.from(
      dialog.querySelectorAll(".mobile-export__app-name"),
    ).map((node) => node.textContent);
    expect(names).toEqual(APP_NAMES);
    expect(dialog.querySelectorAll(".mobile-export__panel")).toHaveLength(0);
    expect(
      within(dialog).getByText("这些 App 不是我们开发的，Veyl 只提供节点。"),
    ).toBeTruthy();

    await waitFor(() => expect(bridge.mobileExportGet).toHaveBeenCalled());
  });

  it("点行只展开该行：换行自动收起，同一行再点收起", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "Shadowrocket"));
    expect(row(dialog, "Shadowrocket").getAttribute("aria-expanded")).toBe(
      "true",
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("img", { name: "导入二维码" }).getAttribute(
          "src",
        ),
      ).toBe(SS_QR),
    );

    fireEvent.click(row(dialog, "Hiddify"));
    expect(
      dialog.querySelectorAll(".mobile-export__panel"),
    ).toHaveLength(1);
    expect(row(dialog, "Shadowrocket").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("img", { name: "导入二维码" }).getAttribute(
          "src",
        ),
      ).toBe(SINGBOX_QR),
    );

    fireEvent.click(row(dialog, "Hiddify"));
    expect(dialog.querySelectorAll(".mobile-export__panel")).toHaveLength(0);
  });

  it("展开靠下的行：把该行标题滚到滚动区顶部", async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scroll,
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "Hiddify"));
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith({ block: "start" }),
    );
  });

  it("Shadowrocket 用 ss 数据：二维码与复制目标都是它", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "Shadowrocket"));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("img", { name: "导入二维码" }).getAttribute(
          "src",
        ),
      ).toBe(SS_QR),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "复制链接" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SS_URL);
  });

  it("「只能全部走节点」只在 Shadowrocket 行出现，且在导入块之外", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    for (const name of [
      "sing-box",
      "Clash Meta for Android",
      "Hiddify",
      "我的 App 不在列表里",
    ]) {
      fireEvent.click(row(dialog, name));
      expect(within(dialog).queryByText(ROW_NOTE)).toBeNull();
    }

    fireEvent.click(row(dialog, "Shadowrocket"));
    expect(await within(dialog).findByText(ROW_NOTE)).toBeTruthy();
    const panel = dialog.querySelector<HTMLElement>(
      ".mobile-export__panel",
    ) as HTMLElement;
    expect(panel.textContent).toContain(ROW_NOTE);
    expect(
      panel.querySelector(".mobile-export__import")?.textContent,
    ).not.toContain(ROW_NOTE);
  });

  it("「只能全部走节点」与码的状态无关：五态下都在", async () => {
    const cases: Array<[string, () => Promise<MobileExportData>, string]> = [
      ["未登录", async () => ({ state: "login_required" }), "先登录。"],
      [
        "无服务器",
        async () => ({ state: "no_ready_server" }),
        "手机端只能导出你自己创建的付费节点。免费和试用节点不包含。",
      ],
      [
        "失败",
        async () => {
          throw { code: "TIMEOUT", message: "超时" };
        },
        "暂时生成不了。",
      ],
      ["读取中", () => new Promise<MobileExportData>(() => {}), "正在读取节点…"],
      ["就绪", async () => OK, "链接相当于密码，别转发。"],
    ];

    for (const [label, get, marker] of cases) {
      const bridge = makeBridge(get);
      const { dialog } = setup(bridge);
      fireEvent.click(row(dialog, "Shadowrocket"));
      expect(await within(dialog).findByText(marker), label).toBeTruthy();
      expect(within(dialog).getByText(ROW_NOTE), label).toBeTruthy();
      cleanup();
    }
  });

  it("展开后是两个编号步骤：① 先下载、② 再导入，标题带 App 名", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    const titles = Array.from(
      dialog.querySelectorAll(".mobile-export__step-title"),
    );
    expect(titles).toHaveLength(2);
    expect(titles[0]?.textContent).toContain("还没有 App？先下载");
    expect(titles[1]?.textContent).toContain("用 sing-box 扫码导入");
    const numbers = titles.map(
      (title) => title.querySelector(".mobile-export__step-num")?.textContent,
    );
    expect(numbers).toEqual(["1", "2"]);
    for (const title of titles) {
      expect(
        title.querySelector(".mobile-export__step-num")?.getAttribute(
          "aria-hidden",
        ),
      ).toBe("true");
    }

    for (const name of [
      "Shadowrocket",
      "Clash Meta for Android",
      "Hiddify",
    ]) {
      fireEvent.click(row(dialog, name));
      const next = dialog.querySelectorAll(".mobile-export__step-title");
      expect(next[1]?.textContent).toContain(`用 ${name} 扫码导入`);
    }
  });

  it("导入块：200 导入码 + 复制 / 重新生成，安全句在码正下方", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    const img = await within(dialog).findByRole("img", {
      name: "导入二维码",
    });
    expect(img.getAttribute("alt")).toBe("导入二维码");
    expect(img.getAttribute("width")).toBe("200");
    expect(img.getAttribute("height")).toBe("200");
    expect(
      within(dialog).getByRole("button", { name: "复制链接" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "重新生成" }),
    ).toBeTruthy();

    const step = img.closest(".mobile-export__step") as HTMLElement;
    const security = step.querySelector(".mobile-export__security");
    expect(security?.textContent).toBe("链接相当于密码，别转发。");
    // 图注紧跟导入块，且不在右列里。
    expect(
      security?.previousElementSibling?.classList.contains(
        "mobile-export__import",
      ),
    ).toBe(true);
    expect(
      step.querySelector(".mobile-export__side")?.contains(security as Node),
    ).toBe(false);
  });

  it("① 是紧凑行：码左、标题与下载链接在右", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    await within(dialog).findByRole("img", { name: "导入二维码" });
    const compact = dialog.querySelector(
      ".mobile-export__step--compact",
    ) as HTMLElement;
    expect(compact).toBeTruthy();
    expect(compact.querySelector(".mobile-export__download-qr")).toBeTruthy();
    expect(compact.querySelector(".mobile-export__qr")).toBeNull();
    const copy = compact.querySelector(
      ".mobile-export__step-copy",
    ) as HTMLElement;
    expect(copy.querySelector(".mobile-export__step-title")?.textContent).toContain(
      "还没有 App？先下载",
    );
    expect(
      within(copy).getByRole("link", { name: /打开下载页/ }),
    ).toBeTruthy();
  });

  it("下载码 104、白卡 128：码本身可扫，卡只留静区", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "Clash Meta for Android"));
    await waitFor(() => {
      const img = dialog.querySelector<HTMLImageElement>(
        ".mobile-export__download-qr-img",
      );
      expect(img?.getAttribute("src")).toBe(CLIENT_QR);
    });
    const img = dialog.querySelector<HTMLImageElement>(
      ".mobile-export__download-qr-img",
    );
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.getAttribute("width")).toBe("104");
    expect(img?.getAttribute("height")).toBe("104");
    expect(dialog.querySelector(".mobile-export__download-qr")).toBeTruthy();
    expect(
      within(dialog).getByRole("heading", { name: "还没有 App？先下载" }),
    ).toBeTruthy();

    const link = within(dialog).getByRole("link", { name: /打开下载页/ });
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(CLIENT_URLS.cmfa),
    );
    fireEvent.click(link);
    expect(bridge.openExternal).toHaveBeenCalledWith(CLIENT_URLS.cmfa);
  });

  it("渐隐只在可滚动且未到底时出现", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    await within(dialog).findByRole("img", { name: "导入二维码" });
    const body = dialog.querySelector(
      ".mobile-export__body",
    ) as HTMLElement;
    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(body, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });

    fireEvent.scroll(body);
    expect(dialog.querySelector(".mobile-export__fade")).toBeTruthy();

    body.scrollTop = 600;
    fireEvent.scroll(body);
    expect(dialog.querySelector(".mobile-export__fade")).toBeNull();

    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      value: 300,
    });
    body.scrollTop = 0;
    fireEvent.scroll(body);
    expect(dialog.querySelector(".mobile-export__fade")).toBeNull();
  });

  it("页脚常驻：归属句与问 AI 都在滚动区之外", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    const importImg = await within(dialog).findByRole("img", {
      name: "导入二维码",
    });

    const footer = dialog.querySelector<HTMLElement>(
      ".mobile-export__footer",
    ) as HTMLElement;
    const body = dialog.querySelector<HTMLElement>(
      ".mobile-export__body",
    ) as HTMLElement;
    expect(footer).toBeTruthy();
    expect(body.contains(footer)).toBe(false);
    expect(footer.contains(importImg)).toBe(false);
    expect(footer.textContent).toContain(
      "这些 App 不是我们开发的，Veyl 只提供节点。",
    );
    expect(
      within(footer).getByRole("button", { name: "不会操作？问 AI" }),
    ).toBeTruthy();
  });

  it("sing-box 带推荐标签：纯文本、只有一行、不可聚焦", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    const badges = dialog.querySelectorAll(".mobile-export__badge");
    expect(badges).toHaveLength(1);
    expect(row(dialog, "sing-box").contains(badges[0] as Node)).toBe(true);
    const badge = badges[0] as HTMLElement;
    expect(badge.tagName).toBe("SPAN");
    expect(badge.getAttribute("role")).toBeNull();
    expect(badge.getAttribute("tabindex")).toBeNull();
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    expect(focusables).not.toContain(badge);
  });

  it("兜底行：只有一句说明，不放按钮，也没有下载入口", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "我的 App 不在列表里"));
    const panel = dialog.querySelector<HTMLElement>(
      ".mobile-export__panel",
    ) as HTMLElement;
    expect(panel.textContent).toContain(
      "上面每一行点开都有下载入口；节点是同一份，换 App 不会丢。",
    );
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
    expect(within(panel).queryByRole("link")).toBeNull();
    expect(within(panel).queryByRole("img")).toBeNull();
    expect(bridge.mobileClientsQr).not.toHaveBeenCalled();
  });

  it("格式词不出现在任何可见文本、alt、title、aria-label 里", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);
    const forbidden = ["格式", "Clash", "ss://", "Mihomo", "订阅", "分流", "YAML"];

    const check = () => {
      const text = readableText(dialog);
      for (const word of forbidden) expect(text).not.toContain(word);
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("https://");
    };

    check();
    for (const name of APP_NAMES) {
      fireEvent.click(row(dialog, name));
      check();
    }
  });

  it("Esc：先收展开行，再关弹层", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onClose } = setup(bridge);

    fireEvent.click(row(dialog, "Hiddify"));
    expect(dialog.querySelectorAll(".mobile-export__panel")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog.querySelectorAll(".mobile-export__panel")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未登录：行仍可展开，面板给登录入口，下载块照常", async () => {
    const bridge = makeBridge(async () => ({ state: "login_required" }));
    const { dialog, onLogin } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    expect(await within(dialog).findByText("先登录。")).toBeTruthy();
    expect(
      within(dialog).getByText("登录后可以把自己的节点导入手机。"),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("img", { name: "导入二维码" })).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: /复制/ }),
    ).toBeNull();
    expect(within(dialog).getByRole("link", { name: /打开下载页/ })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));
    expect(onLogin).toHaveBeenCalled();
  });

  it("没有可用付费服务器：① 照常，② 只给说明与「去创建服务器」", async () => {
    const bridge = makeBridge(async () => ({ state: "no_ready_server" }));
    const { dialog, onGoServers } = setup(bridge);

    fireEvent.click(row(dialog, "Hiddify"));
    expect(
      await within(dialog).findByText(
        "手机端只能导出你自己创建的付费节点。免费和试用节点不包含。",
      ),
    ).toBeTruthy();
    // ① 装 App 与服务器状态无关：下载码与链接照常。
    expect(
      within(dialog).getByRole("heading", { name: "还没有 App？先下载" }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /打开下载页/ })).toBeTruthy();
    // ② 不出现空码位、骨架、复制或重新生成。
    expect(dialog.querySelector(".mobile-export__qr")).toBeNull();
    expect(dialog.querySelector(".mobile-export__qr-skeleton")).toBeNull();
    expect(
      within(dialog).queryByRole("img", { name: "导入二维码" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: /复制/ }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "重新生成" }),
    ).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "去创建服务器" }),
    );
    expect(onGoServers).toHaveBeenCalled();
  });

  it("该行读取中：160 骨架 + 播报", async () => {
    let resolve!: (value: MobileExportData) => void;
    const bridge = makeBridge(
      () =>
        new Promise<MobileExportData>((done) => {
          resolve = done;
        }),
    );
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    expect(dialog.querySelector(".mobile-export__qr")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(within(dialog).getByText("正在读取节点…")).toBeTruthy();

    resolve(OK);
    expect(
      await within(dialog).findByRole("img", { name: "导入二维码" }),
    ).toBeTruthy();
  });

  it("某行失败不影响其他行：只该行显示重试", async () => {
    const onlySingbox: MobileExportData = {
      state: "ok",
      node_count: 1,
      created_at: 1,
      formats: [
        { format: "singbox", url: SINGBOX_URL, qr_data_url: SINGBOX_QR },
      ],
    };
    const bridge = makeBridge(async () => onlySingbox);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "Shadowrocket"));
    expect(
      await within(dialog).findByText("暂时生成不了。"),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /打开下载页/ })).toBeTruthy();

    fireEvent.click(row(dialog, "Hiddify"));
    expect(
      await within(dialog).findByRole("img", { name: "导入二维码" }),
    ).toBeTruthy();
  });

  it("全局失败：给重试，再成功就显示二维码", async () => {
    const get = vi
      .fn<() => Promise<MobileExportData>>()
      .mockRejectedValueOnce({ code: "TIMEOUT", message: "超时" })
      .mockResolvedValueOnce(OK);
    const bridge = makeBridge(get);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    expect(
      await within(dialog).findByText("暂时生成不了。"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(
      await within(dialog).findByRole("img", { name: "导入二维码" }),
    ).toBeTruthy();
  });

  it("Tab 顺序：关闭 → 行 →（展开时）复制 → 重新生成 → 下载页 → … → 问 AI", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    await within(dialog).findByRole("img", { name: "导入二维码" });

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    expect(focusables[0]?.getAttribute("aria-label")).toBe("关闭");
    expect(focusables[focusables.length - 1]?.textContent).toBe(
      "不会操作？问 AI",
    );

    const index = (needle: HTMLElement) => focusables.indexOf(needle);
    const copy = within(dialog).getByRole("button", { name: "复制链接" });
    const rotate = within(dialog).getByRole("button", { name: "重新生成" });
    const download = within(dialog).getByRole("link", { name: /打开下载页/ });
    expect(index(download)).toBe(2);
    expect(index(copy)).toBe(3);
    expect(index(rotate)).toBe(4);
    expect(index(row(dialog, "Shadowrocket"))).toBe(5);
  });

  it("底部问 AI：点击交给 App", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onAskAi } = setup(bridge);
    await waitFor(() => expect(bridge.mobileExportGet).toHaveBeenCalled());

    fireEvent.click(
      within(dialog).getByRole("button", { name: "不会操作？问 AI" }),
    );
    expect(onAskAi).toHaveBeenCalledTimes(1);
  });

  it("复制成功：同一位置变「已复制」", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
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

    fireEvent.click(row(dialog, "sing-box"));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "复制链接" }),
    );

    expect(await within(dialog).findByText("复制失败")).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).not.toContain("secret-token");
  });

  it("重新生成：就地确认，初始焦点在取消，Esc 只取消确认", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog, onClose } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "重新生成" }),
    );
    expect(
      within(dialog).getByText(
        "重新生成后，手机上所有 App 的旧配置下次更新时失效。",
      ),
    ).toBeTruthy();
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    const confirm = within(dialog).getByRole("button", { name: "重新生成" });
    expect(confirm.className).toContain("btn--danger-ghost");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(dialog).queryByRole("button", { name: "取消" })).toBeNull();
    expect(dialog.querySelectorAll(".mobile-export__panel")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.mobileExportRotate).not.toHaveBeenCalled();
  });

  it("确认重新生成：调用命令并说明作用域是「所有 App」", async () => {
    const bridge = makeBridge(async () => OK);
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "重新生成" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));

    await waitFor(() =>
      expect(bridge.mobileExportRotate).toHaveBeenCalledTimes(1),
    );
    expect(
      await within(dialog).findByText(
        "已重新生成；手机上所有 App 的旧配置下次更新时失效。",
      ),
    ).toBeTruthy();
  });

  it("重新生成失败：旧码还在，只提示这次没成功", async () => {
    const bridge = makeBridge(async () => OK, async () => {
      throw { code: "TIMEOUT", message: "超时" };
    });
    const { dialog } = setup(bridge);

    fireEvent.click(row(dialog, "sing-box"));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "重新生成" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));

    expect(
      await within(dialog).findByText("没能重新生成。旧链接还在，稍后再试。"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("img", { name: "导入二维码" }).getAttribute(
        "src",
      ),
    ).toBe(SINGBOX_QR);
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

    for (const [name, id] of [
      ["sing-box", "singbox"],
      ["Shadowrocket", "shadowrocket"],
      ["Clash Meta for Android", "cmfa"],
      ["Hiddify", "hiddify"],
    ] as const) {
      fireEvent.click(row(dialog, name));
      const link = await within(dialog).findByRole("link", {
        name: /打开下载页/,
      });
      const expected = await reference.mobileClientsQr?.(id);
      expect(link.getAttribute("href")).toBe(expected?.url);
    }
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
