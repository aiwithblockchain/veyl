/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServer, MyServerCatalog } from "../agent/bridge";
import { MyServersRail } from "./MyServersRail";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 2 · Vultr",
    region: "nrt1",
    plan: "s-1vcpu-1gb",
    state: "active",
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
  vi.useRealTimers();
});

const CATALOG: MyServerCatalog = {
  regions: [],
  plans: [
    {
      id: "big",
      label: "2 GB",
      hourly_usd: 0.02,
      monthly_usd: 18,
      daily_price_cents: 200,
      transfer_gib: 2000,
    },
    {
      id: "small",
      label: "1 GB",
      hourly_usd: 0.01,
      monthly_usd: 9,
      daily_price_cents: 100,
      transfer_gib: 1000,
    },
    {
      id: "no_region",
      label: "无地区",
      hourly_usd: 0.01,
      monthly_usd: 6,
      daily_price_cents: 50,
      transfer_gib: 500,
      regions: [],
    },
  ],
  currency: "USD",
  updated_at: new Date(0).toISOString(),
};

function renderCta(
  over: {
    servers?: MyServer[];
    catalog?: MyServerCatalog | null;
    signedIn?: boolean;
    accountError?: boolean;
    catalogError?: boolean;
    compact?: boolean;
    trialHint?: string | null;
    loading?: boolean;
    error?: string | null;
    onNew?: () => void;
  } = {},
) {
  const { servers = [server()], ...rest } = over;
  return render(
    <MyServersRail
      servers={servers}
      selectedId={null}
      loading={false}
      catalog={CATALOG}
      onSelect={() => {}}
      onNew={() => {}}
      {...rest}
    />,
  );
}

describe("左栏底部的「新建节点」入口", () => {
  it("有服务器：实心主按钮，点击调用 onNew", () => {
    const onNew = vi.fn();
    const { container } = renderCta({ onNew });
    const cta = container.querySelector<HTMLButtonElement>(".rail-build");
    expect(cta).not.toBeNull();
    expect(cta?.className).toContain("btn");
    expect(cta?.className).toContain("btn--primary");
    expect(cta?.textContent).toContain("新建节点");
    // 整块一个按钮：内部没有嵌套的可点元素。
    expect(cta?.querySelector("a, button")).toBeNull();
    fireEvent.click(cta as HTMLButtonElement);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("有服务器：试用行在上、入口在下", () => {
    const { container } = renderCta({
      trialHint: "还有 2 个免费节点可用，6 天后到期。",
    });
    const hint = container.querySelector(".myservers__trial-hint--rail");
    const cta = container.querySelector(".rail-build");
    expect(hint).not.toBeNull();
    expect(cta).not.toBeNull();
    expect(hint?.nextElementSibling).toBe(cta);
  });

  it("已登录零台：不渲染入口（中间空态已有主按钮）", () => {
    const { container } = renderCta({ servers: [] });
    expect(container.querySelector(".myservers__trial-hint--rail")).toBeNull();
    expect(container.querySelector(".rail-build")).toBeNull();
  });

  it("未登录：不渲染服务器行与入口，只留一行提示", () => {
    const { container } = renderCta({ servers: [], signedIn: false });
    expect(container.querySelector(".rail-server")).toBeNull();
    expect(container.textContent).toContain("登录后这里会列出你的服务器。");
    expect(container.querySelector(".rail-build")).toBeNull();
  });

  it("未登录且控制面不可达：只显示「连不上」，同样没有入口", () => {
    for (const props of [{ accountError: true }, { catalogError: true }]) {
      const { container, unmount } = render(
        <MyServersRail
          servers={[]}
          selectedId={null}
          loading={false}
          signedIn={false}
          catalog={CATALOG}
          {...props}
          onSelect={() => {}}
          onNew={() => {}}
        />,
      );
      expect(container.textContent).toContain("连不上服务器，稍后再试");
      expect(container.querySelector(".rail-build")).toBeNull();
      unmount();
    }
  });

  it("列表加载中 / 读取失败：入口不出现", () => {
    const loadingView = renderCta({ loading: true });
    expect(loadingView.container.querySelector(".rail-build")).toBeNull();
    loadingView.unmount();

    const errorView = renderCta({ error: "连不上服务器，稍后再试" });
    expect(errorView.container.querySelector(".rail-build")).toBeNull();
  });

  it("compact（抽屉）形态：左栏不出现入口", () => {
    const { container } = renderCta({ compact: true });
    expect(container.querySelector(".rail-build")).toBeNull();
  });
});

function renderRail(servers: MyServer[]) {
  const { container } = render(
    <MyServersRail
      servers={servers}
      selectedId={null}
      loading={false}
      onSelect={() => {}}
      onNew={() => {}}
    />,
  );
  const row = container.querySelector(".rail-server");
  return {
    container,
    ledClass: row?.querySelector(".led")?.className ?? "",
    meta: row?.querySelector(".rail-server__meta")?.textContent ?? "",
  };
}

describe("服务器列表左栏", () => {
  it("未登录且控制面不可达（账户或目录）：给「连不上」而不是登录提示", () => {
    for (const props of [{ accountError: true }, { catalogError: true }]) {
      const { container, unmount } = render(
        <MyServersRail
          servers={[]}
          selectedId={null}
          loading={false}
          signedIn={false}
          {...props}
          onSelect={() => {}}
          onNew={() => {}}
        />,
      );
      expect(container.textContent).toContain("连不上服务器，稍后再试");
      expect(container.textContent).not.toContain("登录后这里会列出你的服务器。");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      unmount();
    }
  });

  it("已登录但控制面不可达：仍显示已有服务器行", () => {
    const { container } = render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        accountError
        catalogError
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(container.querySelector(".rail-server")).not.toBeNull();
    expect(container.textContent).not.toContain("连不上服务器，稍后再试");
  });

  it("已登录零台且控制面不可达：左栏不写「连不上」，留给中间区", () => {
    const { container } = render(
      <MyServersRail
        servers={[]}
        selectedId={null}
        loading={false}
        accountError
        catalogError
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(container.textContent).not.toContain("连不上服务器，稍后再试");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // 仍保留标题行：左栏不是空白。
    expect(container.textContent).toContain("我的服务器");
  });

  it("日价用等宽数字：金额套 .num，「/天」在数字之外", () => {
    const { container } = render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const meta = container.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("$0.30/天");
    expect(meta?.querySelector(".num")?.textContent).toBe("$0.30");
  });

  it("active 但欠费：点变 is-warn，状态词写「已欠费」", () => {
    const { ledClass, meta } = renderRail([server({ billing_state: "past_due" })]);
    expect(ledClass).toContain("is-warn");
    expect(meta).toContain("已欠费");
  });

  it("停用：点变 is-warn，状态词写「已停用」", () => {
    const { ledClass, meta } = renderRail([server({ billing_state: "expired" })]);
    expect(ledClass).toContain("is-warn");
    expect(meta).toContain("已停用");
  });

  it("进行中的机器不受欠费覆盖：仍是中性点与阶段词", () => {
    const { ledClass, meta } = renderRail([
      server({ state: "installing", billing_state: "pending" }),
    ]);
    expect(ledClass).toContain("is-idle");
    expect(meta).toContain("安装中");
    expect(meta).not.toContain("已欠费");
  });
});

describe("进行中行的计时", () => {
  it("显示从 created_at 起算的总用时，并随时间前进；整张列表只用一个时钟", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 23, 10, 0, 0) });
    const created_at = new Date(2026, 10, 23, 9, 55, 14).toISOString();
    const { container } = renderRail([
      server({ server_id: "a", state: "installing", created_at }),
      server({ server_id: "b", state: "creating", created_at }),
    ]);

    const meta = container.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("安装中 4:46 · nrt1");
    const timer = meta?.querySelector(".num");
    expect(timer?.textContent).toBe("4:46");
    // 计时不进按钮的无障碍名。
    expect(timer?.getAttribute("aria-hidden")).toBe("true");
    // 进行中的行不写「开通中」，也不报日价。
    expect(meta?.textContent).not.toContain("开通中");
    expect(meta?.textContent).not.toContain("$");
    // 两台进行中：仍只有一个每秒时钟。
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    const timers = [...container.querySelectorAll(".rail-server__meta .num")];
    expect(timers[0]?.textContent).toBe("6:01");
    expect(timers[1]?.textContent).toBe("6:01");
  });

  it("created_at 无效时不显示计时", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 23, 10, 0, 0) });
    const { container } = renderRail([
      server({ state: "installing", created_at: "not-a-date" }),
    ]);

    const meta = container.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("安装中");
    expect(meta?.querySelector(".num")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("左栏底部的在其它设备上使用", () => {
  function renderWithMobile(over: {
    showMobile?: boolean;
    compact?: boolean;
    loading?: boolean;
    error?: string | null;
    disabled?: boolean;
    onMobile?: (trigger: HTMLElement) => void;
  }) {
    return render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={over.loading ?? false}
        error={over.error ?? null}
        compact={over.compact ?? false}
        disabled={over.disabled ?? false}
        showMobile={over.showMobile ?? true}
        onMobile={over.onMobile}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
  }

  it("出现时是可点按钮，带 aria-haspopup，点击把触发行交给 App", () => {
    const onMobile = vi.fn();
    const { container } = renderWithMobile({ onMobile });

    const row = container.querySelector<HTMLButtonElement>(".rail__action-row");
    expect(row).toBeTruthy();
    expect(row?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row?.textContent).toBe("在其它设备上使用");
    row?.click();
    expect(onMobile).toHaveBeenCalledTimes(1);
    expect(onMobile.mock.calls[0][0]).toBe(row);
  });

  it("抽屉模式不出现：「新建节点」已在抽屉里", () => {
    const { container } = renderWithMobile({
      compact: true,
      onMobile: () => {},
    });
    expect(container.querySelector(".rail__action-row")).toBeNull();
  });

  it("列表加载中或读取失败时不出现", () => {
    expect(
      renderWithMobile({ loading: true, onMobile: () => {} }).container.querySelector(
        ".rail__action-row",
      ),
    ).toBeNull();
    cleanup();
    expect(
      renderWithMobile({ error: "down", onMobile: () => {} }).container.querySelector(
        ".rail__action-row",
      ),
    ).toBeNull();
  });

  it("向导锁定时保留但禁用", () => {
    const { container } = renderWithMobile({
      disabled: true,
      onMobile: () => {},
    });
    const row = container.querySelector<HTMLButtonElement>(".rail__action-row");
    expect(row?.disabled).toBe(true);
  });
});
