/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServer } from "../agent/bridge";
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

afterEach(cleanup);

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

describe("左栏底部的在手机上使用", () => {
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
    expect(row?.textContent).toBe("在手机上使用");
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
