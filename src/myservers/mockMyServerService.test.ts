/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { CONTINENT_LABELS } from "./labels";
import {
  MOCK_MY_SERVER_REGIONS,
  MockMyServerService,
} from "./mockMyServerService";

describe("套餐可售地区", () => {
  it("与 DO 目录一致：16 个地区、中文名", () => {
    expect(MOCK_MY_SERVER_REGIONS).toHaveLength(16);
    expect(MOCK_MY_SERVER_REGIONS[0]).toEqual({
      id: "sgp1",
      name: "新加坡 1",
      continent: "asia",
    });
  });

  it("不含已下线的旧地区；顺序稳定", () => {
    const ids = MOCK_MY_SERVER_REGIONS.map((region) => region.id);
    ["nrt", "lax", "gru", "bkk"].forEach((id) => expect(ids).not.toContain(id));
    expect(ids.slice(0, 4)).toEqual(["sgp1", "blr1", "nyc1", "nyc2"]);
    expect(ids[7]).toBe("tor1");
  });

  it("每个地区都有已知大陆分组", () => {
    MOCK_MY_SERVER_REGIONS.forEach((region) =>
      expect(CONTINENT_LABELS[region.continent]).toBeTruthy(),
    );
  });
});

describe("mock 目录套餐", () => {
  it("三档次序与价格和控制面一致", () => {
    const { plans } = new MockMyServerService().catalog();
    expect(plans).toEqual([
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
      {
        id: "s-1vcpu-2gb",
        label: "1 核 · 2 GB",
        hourly_usd: 0.01786,
        monthly_usd: 18,
        daily_price_cents: 60,
        transfer_gib: 2000,
      },
    ]);
  });
});

describe("mock 默认数据", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有存档时是空库，不预置演示服务器", () => {
    const { servers } = new MockMyServerService().list();
    expect(servers).toEqual([]);
  });

  it("账号默认未登录，钱包要求先登录", () => {
    const service = new MockMyServerService();
    expect(service.account()).toMatchObject({ logged_in: false, email: null });
    expect(() => service.wallet()).toThrow();
  });
});

describe("首次取凭据才落本地节点行", () => {
  const STORE_KEY = "veyl.mock.myServers";

  it("就绪后列表里仍为空，credentials() 落库后下一次列表才可见", () => {
    localStorage.clear();
    const started = Date.now() - 60_000;
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        servers: [
          {
            server_id: "srv_1",
            name: "新加坡 1 · DigitalOcean",
            region: "sgp1",
            plan: "s-1vcpu-1gb",
            state: "creating",
            created_at: new Date(started).toISOString(),
            ip: "45.76.10.20",
            port: null,
            node_id: null,
            local_node_id: null,
            hourly_usd: 0.00893,
            monthly_usd: 9,
            daily_price_cents: 30,
            transfer_gib: 1000,
            paid_until: null,
            billing_state: "pending",
            grace_ends_at: null,
            failure: null,
            started_at: started,
          },
        ],
        orders: [],
        next_id: 2,
        balance_cents: 0,
      }),
    );
    const service = new MockMyServerService();

    const ready = service.list().servers[0];
    expect(ready.state).toBe("healthy");
    // node_id 是控制面 id；本地节点行要等取凭据才落。
    expect(ready.node_id).toBe("node_srv_1");
    expect(ready.local_node_id).toBeNull();

    expect(service.credentials("srv_1").node_id).toBe("local_srv_1");
    expect(service.list().servers[0].local_node_id).toBe("local_srv_1");
  });
});

describe("建机余额门槛（日价 × 7）", () => {
  const STORE_KEY = "veyl.mock.myServers";
  const ACCOUNT_KEY = "veyl.mock.account";

  function seed(balanceCents: number) {
    localStorage.setItem(
      ACCOUNT_KEY,
      JSON.stringify({ logged_in: true, email: "a@b.co" }),
    );
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        servers: [],
        orders: [],
        next_id: 1,
        balance_cents: balanceCents,
      }),
    );
  }

  function setBalance(balanceCents: number) {
    const store = JSON.parse(localStorage.getItem(STORE_KEY) as string);
    store.balance_cents = balanceCents;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function order(service: MockMyServerService, key: string) {
    return service.create({
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      idempotencyKey: key,
    });
  }

  it("余额 6 天费用被拒：短差按 7 天门槛算", () => {
    // $0.30/天 × 7 = 210 分；200 分只够 6 天。
    seed(200);
    const service = new MockMyServerService();
    const created = order(service, "k1");

    let thrown: unknown = null;
    try {
      service.checkout(created.order_id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "PRECONDITION_FAILED",
      details: {
        reason: "insufficient_balance",
        required_cents: 210,
        shortfall_cents: 10,
        min_days: 7,
      },
    });
    // 拒绝时不扣钱。
    expect(service.wallet().balance_cents).toBe(200);
  });

  it("余额正好 7 天放行：只扣 1 天", () => {
    seed(200);
    const service = new MockMyServerService();
    const created = order(service, "k2");
    setBalance(210);

    const paid = service.checkout(created.order_id);
    // 2.39.0 起返回订单：server_id 写在订单上，没有扣费字段。
    expect(paid.order_id).toBe(created.order_id);
    expect(paid.state).toBe("provisioning");
    expect(paid.server_id).toBeTruthy();
    expect("charged_cents" in paid).toBe(false);
    // 余额仍只扣 1 天。
    expect(service.wallet().balance_cents).toBe(180);
  });
});
