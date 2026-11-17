/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServerCatalog } from "../agent/bridge";
import { MyServerWizard } from "./MyServerWizard";

const CATALOG: MyServerCatalog = {
  regions: [
    { id: "sgp1", name: "新加坡 1", continent: "asia" },
    { id: "fra1", name: "法兰克福 1", continent: "europe" },
  ],
  plans: [
    {
      id: "s-1vcpu-512mb-10gb",
      label: "1 核 · 512 MB",
      hourly_usd: 0.00595,
      monthly_usd: 6,
      daily_price_cents: 20,
      transfer_gib: 500,
    },
    {
      id: "s-1vcpu-1gb",
      label: "1 核 · 1 GB",
      hourly_usd: 0.00893,
      monthly_usd: 9,
      daily_price_cents: 30,
      transfer_gib: 1000,
    },
  ],
  currency: "USD",
  updated_at: new Date(0).toISOString(),
};

function makeBridge(): AgentBridge {
  return {
    myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
  } as unknown as AgentBridge;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("新建节点舞台的 AI 选择", () => {
  it("应用地区与规格并高亮 1.5 秒，不触发创建", async () => {
    vi.useFakeTimers();
    const create = vi.fn();
    const bridge = { ...makeBridge(), myServerCreate: create } as unknown as AgentBridge;
    const base = {
      bridge,
      catalog: CATALOG,
      onOrdered: () => {},
      onEnsureIdentity: async () => true,
      onTopUp: () => {},
    };
    const { container, rerender } = render(<MyServerWizard {...base} />);

    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: "fra1", plan: "s-1vcpu-1gb", nonce: 1 }}
      />,
    );

    await act(async () => {});
    const wizard = container.querySelector(".myservers__wizard");
    expect(wizard?.classList.contains("is-pointed")).toBe(true);
    const fra = screen.getByRole("radio", { name: "法兰克福 1" });
    expect(fra.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("radio", { name: /1 核 · 1 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(create).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(wizard?.classList.contains("is-pointed")).toBe(false);
  });

  it("带上次选择进来时恢复地区与规格", () => {
    render(
      <MyServerWizard
        bridge={makeBridge()}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
        initialSelection={{ region: "fra1", plan: "s-1vcpu-1gb" }}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "法兰克福 1" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /1 核 · 1 GB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("点了创建之后返回锁住，调用结束才松开", async () => {
    let release: (value: { server_id: string; order_id: string }) => void =
      () => {};
    const created = new Promise<{ server_id: string; order_id: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(() => created),
      myServerCheckout: vi.fn(async () => ({
        charged_cents: 30,
        balance_after_cents: 970,
      })),
    } as unknown as AgentBridge;
    const onBack = vi.fn();
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    const back = screen.getByRole("button", { name: "返回" });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(back);
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      release({ server_id: "srv_1", order_id: "ord_1" });
      await created;
    });
    await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("stage-select：null 不覆盖，只改请求的字段，同值不高亮", async () => {
    vi.useFakeTimers();
    const applied = vi.fn();
    const base = {
      bridge: makeBridge(),
      catalog: CATALOG,
      onOrdered: () => {},
      onEnsureIdentity: async () => true,
      onTopUp: () => {},
      onSelectionApplied: applied,
      initialSelection: { region: "sgp1", plan: "s-1vcpu-1gb" },
    };
    const { container, rerender } = render(<MyServerWizard {...base} />);
    const pointed = () =>
      container
        .querySelector(".myservers__wizard")
        ?.classList.contains("is-pointed");

    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: null, plan: "s-1vcpu-512mb-10gb", nonce: 1 }}
      />,
    );
    await act(async () => {});
    expect(
      screen
        .getByRole("radio", { name: "新加坡 1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /1 核 · 512 MB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(applied).toHaveBeenLastCalledWith({
      region: "sgp1",
      plan: "s-1vcpu-512mb-10gb",
    });
    expect(pointed()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(pointed()).toBe(false);

    // 同值再发一次：成功不等于一定高亮。
    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: null, plan: "s-1vcpu-512mb-10gb", nonce: 2 }}
      />,
    );
    await act(async () => {});
    expect(pointed()).toBe(false);

    // 只请求地区：规格保持上一次的值。
    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: "fra1", plan: null, nonce: 3 }}
      />,
    );
    await act(async () => {});
    expect(
      screen
        .getByRole("radio", { name: "法兰克福 1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /1 核 · 512 MB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("手动改过选择后，事件仍以事件为准覆盖并高亮", async () => {
    const base = {
      bridge: makeBridge(),
      catalog: CATALOG,
      onOrdered: () => {},
      onEnsureIdentity: async () => true,
      onTopUp: () => {},
      initialSelection: { region: "sgp1", plan: "s-1vcpu-1gb" },
    };
    const { container, rerender } = render(<MyServerWizard {...base} />);
    fireEvent.click(screen.getByRole("radio", { name: "法兰克福 1" }));
    fireEvent.click(screen.getByRole("radio", { name: /1 核 · 512 MB/ }));

    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: "sgp1", plan: "s-1vcpu-1gb", nonce: 1 }}
      />,
    );
    await act(async () => {});
    expect(
      screen
        .getByRole("radio", { name: "新加坡 1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /1 核 · 1 GB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container
        .querySelector(".myservers__wizard")
        ?.classList.contains("is-pointed"),
    ).toBe(true);
  });

  it("创建中收到 stage-select 整条忽略，结束后也不补跳", async () => {
    let release: (value: { server_id: string; order_id: string }) => void =
      () => {};
    const created = new Promise<{ server_id: string; order_id: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(() => created),
      myServerCheckout: vi.fn(async () => ({
        charged_cents: 30,
        balance_after_cents: 970,
      })),
    } as unknown as AgentBridge;
    const base = {
      bridge,
      catalog: CATALOG,
      onOrdered: () => {},
      onEnsureIdentity: async () => true,
      onTopUp: () => {},
      initialSelection: { region: "sgp1", plan: "s-1vcpu-1gb" },
    };
    const { rerender } = render(<MyServerWizard {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.myServerCreate).toHaveBeenCalled());

    rerender(
      <MyServerWizard
        {...base}
        aiSelection={{ region: "fra1", plan: "s-1vcpu-512mb-10gb", nonce: 9 }}
      />,
    );
    await act(async () => {});
    expect(
      screen
        .getByRole("radio", { name: "法兰克福 1" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    await act(async () => {
      release({ server_id: "srv_1", order_id: "ord_1" });
      await created;
    });
    await waitFor(() => expect(bridge.myServerCheckout).toHaveBeenCalled());
    expect(
      screen
        .getByRole("radio", { name: "法兰克福 1" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("新建节点的幂等键", () => {
  function bridgeWith(create: ReturnType<typeof vi.fn>) {
    return {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: create,
      myServerCheckout: vi.fn(async () => ({
        charged_cents: 30,
        balance_after_cents: 970,
      })),
    } as unknown as AgentBridge;
  }

  it("超时重试复用同一把幂等键", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({
        code: "TIMEOUT",
        message: "请求超时。",
        retryable: true,
        details: { reason: "timeout" },
      })
      .mockResolvedValue({ server_id: "srv_1", order_id: "ord_1" });
    render(
      <MyServerWizard
        bridge={bridgeWith(create)}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0].idempotencyKey).toBe(
      create.mock.calls[1][0].idempotencyKey,
    );
  });

  it("换了套餐再下单换新键", async () => {
    const create = vi.fn(
      async (_input: { idempotencyKey: string }) => ({
        server_id: "srv_1",
        order_id: "ord_1",
      }),
    );
    render(
      <MyServerWizard
        bridge={bridgeWith(create)}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("radio", { name: /1 核 · 512 MB/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0].idempotencyKey).not.toBe(
      create.mock.calls[1][0].idempotencyKey,
    );
  });
});
