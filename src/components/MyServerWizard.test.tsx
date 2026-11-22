/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServerCatalog, MyServerOrder } from "../agent/bridge";
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
    myServerCatalog: vi.fn(async () => CATALOG),
  } as unknown as AgentBridge;
}

/** 结账从 2.39.0 起返回订单：server_id 写在订单上，没有扣费字段。 */
function order(over: Partial<MyServerOrder> = {}): MyServerOrder {
  return {
    order_id: "ord_1",
    state: "provisioning",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    amount_usd: 9,
    created_at: new Date(0).toISOString(),
    expires_at: null,
    server_id: "srv_1",
    failure: null,
    ...over,
  };
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
      myServerCheckout: vi.fn(async () => order()),
      myServerCatalog: vi.fn(async () => CATALOG),
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
      myServerCheckout: vi.fn(async () => order()),
      myServerCatalog: vi.fn(async () => CATALOG),
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
      myServerCheckout: vi.fn(async () => order()),
      myServerCatalog: vi.fn(async () => CATALOG),
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
      myServerCheckout: vi.fn(async () => order()),
      myServerCatalog: vi.fn(async () => CATALOG),
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
    checkout: ReturnType<typeof vi.fn> = vi.fn(async () => order()),
  ) {
    return {
      myServerWallet: vi.fn(async () => ({ balance_cents: balanceCents })),
      // 创建只回订单，服务器行要到结账成功之后才有：失败时没有 id 可跳。
      myServerCreate: vi.fn(async () => ({
        server_id: null,
        order_id: "ord_1",
      })),
      myServerCheckout: checkout,
      myServerCatalog: vi.fn(async () => CATALOG),
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
        server_id: null,
        order_id: "ord_1",
      })),
      myServerCheckout: checkout,
      myServerCatalog: vi.fn(async () => CATALOG),
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

describe("档位按地区过滤", () => {
  const LIMITED: MyServerCatalog = {
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
        regions: ["sgp1", "fra1"],
      },
      {
        id: "s-1vcpu-1gb",
        label: "1 核 · 1 GB",
        hourly_usd: 0.00893,
        monthly_usd: 9,
        daily_price_cents: 30,
        transfer_gib: 1000,
        regions: ["fra1"],
      },
      {
        id: "s-1vcpu-2gb",
        label: "1 核 · 2 GB",
        hourly_usd: 0.01786,
        monthly_usd: 18,
        daily_price_cents: 60,
        transfer_gib: 2000,
        regions: ["sgp1", "fra1"],
      },
    ],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  };

  function renderWizard(
    initialSelection: { region: string; plan: string },
    catalog: MyServerCatalog = LIMITED,
  ) {
    return render(
      <MyServerWizard
        bridge={makeBridge()}
        catalog={catalog}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
        initialSelection={initialSelection}
      />,
    );
  }

  const planCard = (label: RegExp) =>
    screen.getByRole("radio", { name: label }) as HTMLButtonElement;
  const createButton = () =>
    screen.getByRole("button", { name: "创建" }) as HTMLButtonElement;

  it("新加坡不提供 1 GB：该档位禁用并注明，创建按钮禁用并就地说明", () => {
    renderWizard({ region: "sgp1", plan: "s-1vcpu-1gb" });

    const oneGb = planCard(/1 核 · 1 GB/);
    expect(oneGb.disabled).toBe(true);
    expect(oneGb.textContent).toContain("不可用");
    expect(oneGb.getAttribute("aria-label")).toBe(
      "1 核 · 1 GB：该地区不提供这个档位",
    );
    expect(planCard(/1 核 · 512 MB/).disabled).toBe(false);
    expect(planCard(/1 核 · 2 GB/).disabled).toBe(false);
    // 只有地区这一条事实说明，档位区不再重复一句。
    expect(
      screen.getAllByText(
        "只显示当前可开通的地区，DigitalOcean 的可用性会随时变化。",
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(/灰掉的档位/)).toBeNull();
    expect(screen.queryByText(/灰掉的地区/)).toBeNull();

    expect(createButton().disabled).toBe(true);
    expect(
      screen.getByText("这个地区不提供该档位，换一个档位或地区。"),
    ).toBeTruthy();
  });

  it("切到法兰克福后同一档位恢复，说明消失", () => {
    renderWizard({ region: "sgp1", plan: "s-1vcpu-1gb" });
    expect(createButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /法兰克福 1/ }));

    expect(planCard(/1 核 · 1 GB/).disabled).toBe(false);
    expect(planCard(/1 核 · 1 GB/).textContent).not.toContain("不可用");
    expect(screen.queryByText(/灰掉的档位/)).toBeNull();
    expect(
      screen.queryByText("这个地区不提供该档位，换一个档位或地区。"),
    ).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it("只渲染有可用档位的地区；整组没有就整组不渲染", () => {
    const catalog: MyServerCatalog = {
      regions: [
        { id: "sgp1", name: "新加坡 1", continent: "asia" },
        { id: "fra1", name: "法兰克福 1", continent: "europe" },
        { id: "ams3", name: "阿姆斯特丹 3", continent: "europe" },
        { id: "jnb1", name: "约翰内斯堡 1", continent: "africa" },
      ],
      plans: LIMITED.plans,
      currency: "USD",
      updated_at: new Date(0).toISOString(),
    };
    renderWizard({ region: "sgp1", plan: "s-1vcpu-512mb-10gb" }, catalog);

    // 没有档位的地区根本不渲染，而不是渲染成禁用。
    expect(screen.queryByRole("radio", { name: /阿姆斯特丹 3/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /约翰内斯堡 1/ })).toBeNull();
    // 一个可用地区都没有的大洲，整组标题也不渲染。
    expect(screen.queryByText("非洲")).toBeNull();
    expect(screen.getByText("欧洲")).toBeTruthy();
    expect(screen.getByText("亚洲")).toBeTruthy();
    expect(screen.queryByText("暂不可用")).toBeNull();
  });

  it("旧控制面没有 plan.regions：不拦截，只留 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWizard({ region: "sgp1", plan: "s-1vcpu-1gb" }, CATALOG);

    expect(planCard(/1 核 · 1 GB/).disabled).toBe(false);
    expect(screen.queryByText("不可用")).toBeNull();
    expect(screen.queryByText(/灰掉的/)).toBeNull();
    expect(createButton().disabled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plan.regions"));
  });
});

describe("地区没有任何可用档位", () => {
  const AMS = { id: "ams3", name: "阿姆斯特丹 3", continent: "europe" as const };
  const PLAN_512 = {
    id: "s-1vcpu-512mb-10gb",
    label: "1 核 · 512 MB",
    hourly_usd: 0.00595,
    monthly_usd: 6,
    daily_price_cents: 20,
    transfer_gib: 500,
  };
  const PLAN_2GB = {
    id: "s-1vcpu-2gb",
    label: "1 核 · 2 GB",
    hourly_usd: 0.01786,
    monthly_usd: 18,
    daily_price_cents: 60,
    transfer_gib: 2000,
  };

  function renderWith(catalog: MyServerCatalog, region: string, plan: string) {
    return render(
      <MyServerWizard
        bridge={makeBridge()}
        catalog={catalog}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
        initialSelection={{ region, plan }}
      />,
    );
  }

  it("没有任何可用档位的地区不渲染，默认选中落到可用地区", () => {
    const catalog: MyServerCatalog = {
      // 不可用的地区排在最前面，默认选中也不能落在它身上。
      regions: [AMS, ...CATALOG.regions],
      plans: [
        { ...PLAN_512, regions: ["sgp1", "fra1"] },
        { ...PLAN_2GB, regions: ["sgp1", "fra1"] },
      ],
      currency: "USD",
      updated_at: new Date(0).toISOString(),
    };
    renderWith(catalog, "ams3", "s-1vcpu-512mb-10gb");

    expect(screen.queryByRole("radio", { name: /阿姆斯特丹 3/ })).toBeNull();
    expect(screen.queryByText("暂不可用")).toBeNull();
    expect(screen.queryByText(/灰掉的地区/)).toBeNull();
    const sgp = screen.getByRole("radio", {
      name: /新加坡 1/,
    }) as HTMLButtonElement;
    expect(sgp.getAttribute("aria-checked")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("所有地区都不可用：顶部一句话，不摆灰卡片，创建禁用", () => {
    const catalog: MyServerCatalog = {
      regions: CATALOG.regions,
      plans: [
        { ...PLAN_512, regions: ["tyo"] },
        { ...PLAN_2GB, regions: ["tyo"] },
      ],
      currency: "USD",
      updated_at: new Date(0).toISOString(),
    };
    renderWith(catalog, "sgp1", "s-1vcpu-512mb-10gb");

    expect(screen.getByText("暂时没有可用的地区")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText(/灰掉的/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // 系统行不参与地区/档位过滤，仍然显示。
    expect(screen.getByText("Ubuntu 24.04 LTS")).toBeTruthy();
  });
});

describe("打开向导时回源目录", () => {
  function renderWithBridge(bridge: AgentBridge) {
    return render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );
  }

  it("打开时用 fresh 取一次目录，不靠 5 分钟缓存", async () => {
    const fetchCatalog = vi.fn(async () => CATALOG);
    const bridge = {
      ...makeBridge(),
      myServerCatalog: fetchCatalog,
    } as unknown as AgentBridge;

    renderWithBridge(bridge);

    await waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));
    expect(fetchCatalog).toHaveBeenCalledWith(true);
  });

  it("目录请求失败：空态提示刷新页面，创建禁用，不渲染旧地区", async () => {
    const fetchCatalog = vi.fn(async () => {
      throw { code: "UPSTREAM_ERROR", message: "目录读不到。", retryable: true };
    });
    const bridge = {
      ...makeBridge(),
      myServerCatalog: fetchCatalog,
    } as unknown as AgentBridge;

    renderWithBridge(bridge);

    expect(
      await screen.findByText("暂时读不到可用地区和档位。关掉这个向导再打开，重试一次。"),
    ).toBeTruthy();
    // 不给页内重试按钮。
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    // 旧缓存里的地区一个都不能露出来。
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText("新加坡 1")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledWith(true);
  });
});

describe("向导底部计费说明", () => {
  it("写明开通后才开始计费，不是下单即扣", async () => {
    render(
      <MyServerWizard
        bridge={makeBridge()}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    expect(
      await screen.findByText("开通后开始计费，每天续扣；余额不足会提示充值。"),
    ).toBeTruthy();
  });

  it("地区选择下方提醒线路决定能不能连上，且只出现一次", async () => {
    render(
      <MyServerWizard
        bridge={makeBridge()}
        catalog={CATALOG}
        onOrdered={() => {}}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    expect(
      await screen.findAllByText(/取决于你当前的网络到那个地区的线路/),
    ).toHaveLength(1);
  });
});

describe("结账返回订单（2.39.0）", () => {
  it("只按订单形状也能完成下单，界面不再展示扣费金额", async () => {
    const onOrdered = vi.fn();
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(async () => ({
        order_id: "ord_1",
        server_id: null,
      })),
      myServerCheckout: vi.fn(async () => order({ state: "provisioning" })),
      myServerCatalog: vi.fn(async () => CATALOG),
    } as unknown as AgentBridge;

    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={onOrdered}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    await waitFor(() => expect(onOrdered).toHaveBeenCalledWith("srv_1"));
    // 旧的「已扣 $X，余额 $Y」不再出现（地区下方的连通性提醒提到「已扣」，
    // 但那是费用不退的说明，不是扣费金额）。
    expect(screen.queryByText(/已扣\s*\$|余额 \$/)).toBeNull();
  });

  it("结账失败：按原有错误提示停下，不当作已下单", async () => {
    const onOrdered = vi.fn();
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(async () => ({
        order_id: "ord_1",
        server_id: null,
      })),
      myServerCheckout: vi.fn(async () => {
        throw {
          code: "UPSTREAM_ERROR",
          retryable: true,
        };
      }),
      myServerCatalog: vi.fn(async () => CATALOG),
    } as unknown as AgentBridge;

    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={onOrdered}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(
      await screen.findByText(/服务器服务暂时不可用/),
    ).toBeTruthy();
    expect(onOrdered).not.toHaveBeenCalled();
  });
});

describe("下单失败后的去向", () => {
  it("结账失败、订单已写回服务器 id：按订单反查后去那台失败服务器", async () => {
    const onOrdered = vi.fn();
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      // 真实形态：create 只回订单，服务器 id 在结账时才写回。
      myServerCreate: vi.fn(async () => ({
        order_id: "ord_1",
        server_id: null,
      })),
      myServerCheckout: vi.fn(async () => {
        throw {
          code: "UPSTREAM_ERROR",
          message: "服务器没装好。",
          details: { reason: "firewall_failed" },
          retryable: true,
        };
      }),
      myServerOrderGet: vi.fn(async () =>
        order({ order_id: "ord_1", server_id: "srv_x", state: "failed" }),
      ),
      myServerList: vi.fn(async () => ({ servers: [] })),
      myServerCatalog: vi.fn(async () => CATALOG),
    } as unknown as AgentBridge;

    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={onOrdered}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    // 服务器行已经建出来了：走和成功一样的路径，选中那台失败机器。
    await waitFor(() => expect(onOrdered).toHaveBeenCalledWith("srv_x"));
    // 错误不再留在向导里，失败详情由「我的服务器」承接。
    expect(screen.queryByText("服务器没装好。")).toBeNull();
  });

  it("结账余额不足、订单和列表都没有服务器：停在向导就地报错", async () => {
    const onOrdered = vi.fn();
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(async () => ({
        order_id: "ord_1",
        server_id: null,
      })),
      myServerCheckout: vi.fn(async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "余额不足",
          details: { reason: "insufficient_balance", shortfall_cents: 500 },
          retryable: true,
        };
      }),
      myServerOrderGet: vi.fn(async () =>
        order({ order_id: "ord_1", server_id: null, state: "pending_payment" }),
      ),
      myServerList: vi.fn(async () => ({ servers: [] })),
      myServerCatalog: vi.fn(async () => CATALOG),
    } as unknown as AgentBridge;

    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={onOrdered}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("余额不足，还差 $5.00。");
    expect(onOrdered).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
  });

  it("create 自己失败：停在向导就地报错，不跳服务器详情", async () => {
    const onOrdered = vi.fn();
    const bridge = {
      myServerWallet: vi.fn(async () => ({ balance_cents: 1000 })),
      myServerCreate: vi.fn(async () => {
        throw { code: "UPSTREAM_ERROR", retryable: true };
      }),
      myServerCheckout: vi.fn(),
      myServerCatalog: vi.fn(async () => CATALOG),
    } as unknown as AgentBridge;

    render(
      <MyServerWizard
        bridge={bridge}
        catalog={CATALOG}
        onOrdered={onOrdered}
        onEnsureIdentity={async () => true}
        onTopUp={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByText(/服务器服务暂时不可用/)).toBeTruthy();
    expect(onOrdered).not.toHaveBeenCalled();
    // 仍在向导里，可以再点「创建」。
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
  });
});
