/** @vitest-environment jsdom */
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { Settings } from "./Settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

type Availability = "free" | "occupied" | "unavailable";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeBridge(
  setImpl: (
    port: number,
  ) => Promise<{ port: number; availability: Availability }> = async (port) => ({
    port,
    availability: "free",
  }),
) {
  const proxyPortSet = vi.fn(setImpl);
  const bridge = {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    proxyPortGet: vi.fn(async () => ({ port: 7890, defaultPort: 7890 })),
    proxyPortSet,
    llmProviderList: vi.fn(async () => ({ providers: [], activeProviderId: null })),
    getAppVersion: vi.fn(async () => "0.1.0"),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
  } as unknown as AgentBridge;
  return { bridge, proxyPortSet };
}

/** 用真实状态模拟 App：保存成功后设置页拿到的端口会变。 */
function Harness({
  bridge,
  initialPort = 7890,
  runtimeView = runtime(),
  connectMode = "system_proxy" as "tun" | "system_proxy" | null,
  onClose = () => {},
}: {
  bridge: AgentBridge;
  initialPort?: number;
  runtimeView?: RuntimeView;
  connectMode?: "tun" | "system_proxy" | null;
  onClose?: () => void;
}) {
  const [port, setPort] = useState(initialPort);
  const [open, setOpen] = useState(true);
  return (
    <Settings
      open={open}
      bridge={bridge}
      runtime={runtimeView}
      defaultProfile={null}
      connectMode={connectMode}
      proxyPort={port}
      onProxyPortSaved={(next) => {
        setPort(next);
        if (!open) setOpen(true);
      }}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      onNotice={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="network"
    />
  );
}

function renderHarness(options: Parameters<typeof Harness>[0]) {
  return render(<Harness {...options} />);
}

function input(): HTMLInputElement {
  return screen.getByLabelText("本地代理端口") as HTMLInputElement;
}

function beginEdit() {
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: /保存/ }));
}

describe("端口行默认态", () => {
  it("地址一直显示，右侧是复制与编辑，没有常驻输入框", () => {
    renderHarness({ bridge: makeBridge().bridge, initialPort: 7890 });
    expect(screen.getByText("127.0.0.1:7890")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(screen.queryByLabelText("本地代理端口")).toBeNull();
    expect(screen.getByText("别的软件要填代理地址时，填这个。")).toBeTruthy();
  });

  it("全部流量配置整行不显示：没有地址、复制与编辑", () => {
    renderHarness({
      bridge: makeBridge().bridge,
      connectMode: "tun",
    });
    expect(screen.queryByText("127.0.0.1:7890")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByText("别的软件要填代理地址时，填这个。")).toBeNull();
  });

  it("已连接代理模式复制的是地址行上的实际端口", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderHarness({
      bridge: makeBridge().bridge,
      initialPort: 7890,
      runtimeView: runtime({ state: "running", mixed_port: 2080 }),
    });

    expect(screen.getByText("127.0.0.1:2080")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("127.0.0.1:2080"));
  });

  it("已连接且本次端口顺延：两个数字都说清楚，只讲一句", () => {
    renderHarness({
      bridge: makeBridge().bridge,
      initialPort: 7890,
      runtimeView: runtime({
        state: "running",
        mixed_port: 8081,
        port_fallback: { requested: 7890, actual: 8081, reason: "occupied" },
      }),
    });
    expect(screen.getByText("127.0.0.1:8081")).toBeTruthy();
    expect(
      screen.getByText("保存的是 7890；现在用的是 8081，被别的软件占用了。"),
    ).toBeTruthy();
    expect(screen.queryByText(/下次连接生效/)).toBeNull();
  });

  it("已连接且端口一致：用系统代理已设好的说明", () => {
    renderHarness({
      bridge: makeBridge().bridge,
      initialPort: 7890,
      runtimeView: runtime({
        state: "running",
        mixed_port: 7890,
        system_proxy_enabled: true,
      }),
    });
    expect(
      screen.getByText("浏览器已经设好了；其它软件填这个地址。"),
    ).toBeTruthy();
  });
});

describe("端口行编辑态", () => {
  it("进入编辑：原位换成输入框，自动聚焦并全选端口号", () => {
    renderHarness({ bridge: makeBridge().bridge, initialPort: 7890 });
    beginEdit();

    const field = input();
    expect(field.value).toBe("7890");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(4);
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("编辑态保留说明句，下方行不因切换而位移", () => {
    renderHarness({ bridge: makeBridge().bridge, initialPort: 7890 });
    expect(screen.getByText("别的软件要填代理地址时，填这个。")).toBeTruthy();
    beginEdit();
    expect(screen.getByText("别的软件要填代理地址时，填这个。")).toBeTruthy();
  });

  it("Esc 只退出编辑，不关闭设置", () => {
    const onClose = vi.fn();
    renderHarness({ bridge: makeBridge().bridge, onClose });
    beginEdit();

    fireEvent.change(input(), { target: { value: "8081" } });
    fireEvent.keyDown(input(), { key: "Escape" });

    expect(screen.queryByLabelText("本地代理端口")).toBeNull();
    expect(screen.getByText("127.0.0.1:7890")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "编辑" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点取消放弃改动", () => {
    renderHarness({ bridge: makeBridge().bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByLabelText("本地代理端口")).toBeNull();
    expect(screen.getByText("127.0.0.1:7890")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "编辑" }),
    );
  });

  it("点当前行以外的地方：保持编辑态，输入不丢", () => {
    renderHarness({ bridge: makeBridge().bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });

    fireEvent.click(screen.getByText("添加节点"));

    expect(input().value).toBe("8081");
    expect(screen.getByRole("button", { name: /保存/ })).toBeTruthy();
  });

  it("不再失焦自动保存", () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    fireEvent.blur(input());

    expect(proxyPortSet).not.toHaveBeenCalled();
    expect(input().value).toBe("8081");
  });

  it("切换 tab 放弃未保存的改动", () => {
    renderHarness({ bridge: makeBridge().bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });

    fireEvent.click(screen.getByRole("tab", { name: "关于" }));
    fireEvent.click(screen.getByRole("tab", { name: "连接" }));

    expect(screen.queryByLabelText("本地代理端口")).toBeNull();
    expect(screen.getByText("127.0.0.1:7890")).toBeTruthy();
  });

  it("<1024 提示只在编辑态出现", () => {
    renderHarness({ bridge: makeBridge().bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "80" } });
    expect(
      screen.getByText("小于 1024 的端口通常要管理员权限，不建议用。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByText("小于 1024 的端口通常要管理员权限，不建议用。"),
    ).toBeNull();
  });
});

describe("端口保存", () => {
  it("校验失败不发请求，留在编辑态", () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderHarness({ bridge });
    beginEdit();

    for (const bad of ["", "0", "70000", "12.5", "abc"]) {
      fireEvent.change(input(), { target: { value: bad } });
      save();
      expect(screen.getByText("端口要填 1–65535 之间的整数。")).toBeTruthy();
      expect(screen.getByLabelText("本地代理端口")).toBeTruthy();
    }
    expect(proxyPortSet).not.toHaveBeenCalled();
  });

  it("点保存成功后退出编辑，地址更新", async () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(8081));
    await waitFor(() =>
      expect(screen.queryByLabelText("本地代理端口")).toBeNull(),
    );
    expect(screen.getByText("127.0.0.1:8081")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("已保存");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "编辑" }),
    );
  });

  it("输入框有真正的 label 与按提示变化的 aria-describedby", () => {
    renderHarness({ bridge: makeBridge().bridge });
    beginEdit();

    const field = screen.getByRole("textbox", { name: "本地代理端口" });
    expect(field.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(field, { target: { value: "80" } });
    expect(field.getAttribute("aria-describedby")).toBe(
      "settings-proxy-port-low",
    );

    fireEvent.change(field, { target: { value: "" } });
    save();
    expect(screen.getByRole("alert").textContent).toBe(
      "端口要填 1–65535 之间的整数。",
    );
    expect(field.getAttribute("aria-describedby")).toBe(
      "settings-proxy-port-error",
    );
  });

  it("输入框回车也能保存", async () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(8081));
  });

  it("保存中：按钮变文案、取消禁用、输入只读", async () => {
    const gate = deferred<{ port: number; availability: Availability }>();
    const { bridge } = makeBridge(() => gate.promise);
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    const saving = await screen.findByRole("button", { name: "保存中…" });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(input().readOnly).toBe(true);

    gate.resolve({ port: 8081, availability: "free" });
    await waitFor(() =>
      expect(screen.queryByLabelText("本地代理端口")).toBeNull(),
    );
  });

  it("已连接保存：提示下次连接生效，地址仍是当前实际端口", async () => {
    const { bridge } = makeBridge();
    renderHarness({
      bridge,
      initialPort: 7890,
      runtimeView: runtime({ state: "running", mixed_port: 2080 }),
    });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    expect(await screen.findByText("已保存，下次连接生效")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:2080")).toBeTruthy();
  });

  it("已连接且本次顺延时，保存新端口合成一句，不叠第二次", async () => {
    const { bridge } = makeBridge();
    renderHarness({
      bridge,
      initialPort: 7890,
      runtimeView: runtime({
        state: "running",
        mixed_port: 8080,
        port_fallback: { requested: 7890, actual: 8080, reason: "occupied" },
      }),
    });
    beginEdit();
    fireEvent.change(input(), { target: { value: "9000" } });
    save();

    expect(
      await screen.findByText(
        "这次连接用的是 8080（7890 被占用）；保存的是 9000，下次连接生效。",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(/下次连接生效/)).toHaveLength(1);
    expect(screen.getByText("127.0.0.1:8080")).toBeTruthy();
  });

  it("保存失败：留在编辑态，输入不丢，用后端 message", async () => {
    const { bridge } = makeBridge(async () => {
      throw { code: "INVALID_ARGUMENT", message: "端口被系统拒绝" };
    });
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    expect((await screen.findByRole("alert")).textContent).toBe("端口被系统拒绝");
    expect(input().value).toBe("8081");
  });

  it("保存失败没有 message：用兜底文案", async () => {
    const { bridge } = makeBridge(async () => {
      throw { code: "INTERNAL" };
    });
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    expect(
      await screen.findByText("没有保存，端口还是原来的。再试一次。"),
    ).toBeTruthy();
    expect(input().value).toBe("8081");
  });

  it("被占用：退出编辑后只在默认态提示", async () => {
    const { bridge } = makeBridge(async (port) => ({
      port,
      availability: "occupied",
    }));
    renderHarness({ bridge, initialPort: undefined });
    beginEdit();
    fireEvent.change(input(), { target: { value: "7891" } });
    save();

    expect(
      await screen.findByText("现在被别的软件占用，连接时会自动顺延。"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("本地代理端口")).toBeNull();
    expect(
      screen.queryByText("小于 1024 的端口通常要管理员权限，不建议用。"),
    ).toBeNull();
  });

  it("绑不上：只显示绑不上那句，不叠低端口提示", async () => {
    const { bridge } = makeBridge(async (port) => ({
      port,
      availability: "unavailable",
    }));
    renderHarness({ bridge, initialPort: 8080 });
    beginEdit();
    fireEvent.change(input(), { target: { value: "80" } });
    save();

    expect(
      await screen.findByText(
        "这台机器绑不了这个端口（需要管理员权限），连接时会自动顺延。",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("小于 1024 的端口通常要管理员权限，不建议用。"),
    ).toBeNull();
  });

  it("可用：不显示占用或权限提示", async () => {
    const { bridge } = makeBridge();
    renderHarness({ bridge });
    beginEdit();
    fireEvent.change(input(), { target: { value: "8081" } });
    save();

    await waitFor(() => expect(screen.getByText("已保存")).toBeTruthy());
    expect(screen.queryByText("现在被别的软件占用，连接时会自动顺延。")).toBeNull();
    expect(
      screen.queryByText(
        "这台机器绑不了这个端口（需要管理员权限），连接时会自动顺延。",
      ),
    ).toBeNull();
  });
});

describe("连接页其它行", () => {
  it("非编辑态按 Esc 仍然关闭设置", () => {
    const onClose = vi.fn();
    renderHarness({ bridge: makeBridge().bridge, onClose });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("删掉页内小标题与第一行的地址", async () => {
    renderHarness({ bridge: makeBridge().bridge });
    expect(
      document.querySelector(".settings-section__title"),
    ).toBeNull();
    const firstRow = document.querySelector(".settings-row") as HTMLElement;
    expect(within(firstRow).queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(within(firstRow).queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("免费节点摘要不再写「Veyl 提供的」", async () => {
    renderHarness({ bridge: makeBridge().bridge });
    const row = document.querySelector(".seed-refresh") as HTMLElement;
    expect(within(row).queryByText(/Veyl 提供的/)).toBeNull();
  });

  it("添加节点行不再写文件导入，弹层说明支持链接与订阅", async () => {
    renderHarness({ bridge: makeBridge().bridge });
    expect(screen.queryByText("导入不需要联网。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const dialog = await screen.findByRole("dialog", { name: "添加节点" });
    expect(
      within(dialog).getByText(
        "支持多行 ss:// 链接或 https 订阅地址；文件里的节点密码不要外传。",
      ),
    ).toBeTruthy();
  });
});
