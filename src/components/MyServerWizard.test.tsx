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

describe("返回控件", () => {
  it("返回在标题上方独立一行、带箭头；创建在途时禁用", async () => {
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
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
        onBack={() => {}}
      />,
    );

    const head = document.querySelector(".myservers__wizard-head");
    const back = screen.getByRole("button", { name: "返回" });
    // 两行结构：返回是标题的上一行，标题因此回到内容列左边缘。
    expect(head?.firstElementChild).toBe(back);
    expect(back.nextElementSibling?.tagName).toBe("H4");
    expect(back.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy();
    expect((back as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.myServerCreate).toHaveBeenCalled());
    expect((back as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release({ server_id: "srv_1", order_id: "ord_1" });
      await created;
    });
    await waitFor(() =>
      expect((back as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("建机余额门槛（余额 ≥ 日价 × 7）", () => {
  function wizardBridge(
    balanceCents: number,
    checkout: ReturnType<typeof vi.fn> = vi.fn(async () => ({
      order_id: "ord_1",
      state: "paid" as const,
      charged_cents: 30,
      balance_after_cents: balanceCents - 30,
    })),
  ) {
    return {
      myServerWallet: vi.fn(async () => ({ balance_cents: balanceCents })),
      myServerCreate: vi.fn(async () => ({
        server_id: "srv_1",
        order_id: "ord_1",
      })),
      myServerCheckout: checkout,
    } as unknown as AgentBridge;
  }

  it("只有 6 天费用：不下单，原地提示还差多少并给去充值", async () => {
    // 默认档位 $0.30/天 → 门槛 210 分；180 分只够 6 天。
    const bridge = wizardBridge(180);
    const onTopUp = vi.fn();
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={onTopUp}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("余额不足，还差 $0.30。");
    expect(bridge.myServerCreate).not.toHaveBeenCalled();
    expect(bridge.myServerCheckout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "去充值" }));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("正好 7 天费用：允许下单并结账", async () => {
    const bridge = wizardBridge(210);
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(bridge.myServerCheckout).toHaveBeenCalledTimes(1));
    expect(bridge.myServerCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Host 回 insufficient_balance：用 details.shortfall_cents 拼文案并给去充值", async () => {
    const checkout = vi.fn(async () => {
      throw {
        code: "PRECONDITION_FAILED",
        message: "余额不足",
        retryable: true,
        details: {
          reason: "insufficient_balance",
          required_cents: 210,
          shortfall_cents: 210,
          min_days: 7,
        },
      };
    });
    const bridge = wizardBridge(1000, checkout);
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("余额不足，还差 $2.10。");
    expect(screen.getByRole("button", { name: "去充值" })).toBeTruthy();
  });
});

describe("余额不足错误的不同 details 形状", () => {
  function renderWithCheckout(details: Record<string, unknown>, balanceCents = 1000) {
    const checkout = vi.fn(async () => {
      throw {
        code: "PRECONDITION_FAILED",
        message: "余额不足",
        retryable: true,
        details,
      };
    });
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: balanceCents })),
      myServerCreate: vi.fn(async () => ({
        server_id: "srv_1",
        order_id: "ord_1",
      })),
      myServerCheckout: checkout,
    } as unknown as AgentBridge;
    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    return checkout;
  }

  it("旧形状只回 shortfall_cents：仍显示还差多少", async () => {
    await renderWithCheckout({
      reason: "insufficient_balance",
      shortfall_cents: 30,
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("余额不足，还差 $0.30。");
    expect(screen.getByRole("button", { name: "去充值" })).toBeTruthy();
  });

  it("只回 required_cents：用预检读到的余额补算短差", async () => {
    // 预检（余额 1000 ≥ 210）会放行，这里故意让 Host 的 required 高于余额，
    // 否则兜底分支永远走不到。
    await renderWithCheckout(
      { reason: "insufficient_balance", required_cents: 1030 },
      1000,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("余额不足，还差 $0.30。");
    expect(screen.getByRole("button", { name: "去充值" })).toBeTruthy();
  });
});
