import type {
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerCreateInput,
  MyServerCredentialNode,
  MyServerFailure,
  MyServerLoginTicket,
  MyServerOrder,
  MyServerPlan,
  MyServerRebuildResult,
  MyServerRegion,
  MyServerSshCredentials,
  MyServerState,
  MyServerTopup,
  MyServerWallet,
} from "../agent/bridge";

/** 编排的四个阶段；界面按这个顺序画进度。 */
export const MY_SERVER_PHASES: MyServerState[] = [
  "creating",
  "booting",
  "installing",
  "verifying",
];

const REGIONS: MyServerRegion[] = [
  { id: "sgp1", name: "新加坡 1", continent: "asia" },
  { id: "blr1", name: "班加罗尔 1", continent: "asia" },
  { id: "nyc1", name: "纽约 1", continent: "north_america" },
  { id: "nyc2", name: "纽约 2", continent: "north_america" },
  { id: "nyc3", name: "纽约 3", continent: "north_america" },
  { id: "sfo2", name: "旧金山 2", continent: "north_america" },
  { id: "sfo3", name: "旧金山 3", continent: "north_america" },
  { id: "tor1", name: "多伦多 1", continent: "north_america" },
  { id: "atl1", name: "亚特兰大 1", continent: "north_america" },
  { id: "ric1", name: "里士满 1", continent: "north_america" },
  { id: "mkc1", name: "堪萨斯城 1", continent: "north_america" },
  { id: "mem1", name: "孟菲斯 1", continent: "north_america" },
  { id: "ams3", name: "阿姆斯特丹 3", continent: "europe" },
  { id: "fra1", name: "法兰克福 1", continent: "europe" },
  { id: "lon1", name: "伦敦 1", continent: "europe" },
  { id: "syd1", name: "悉尼 1", continent: "oceania" },
];

/** 和控制面一致的三档；中间一档是默认推荐。 */
const PLANS: MyServerPlan[] = [
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
];

const DEFAULT_PLAN = PLANS[1];

const PROVIDER = "DigitalOcean";

const STORE_KEY = "veyl.mock.myServers";
const FAIL_KEY = "veyl.mock.myServers.fail";
const DOWN_KEY = "veyl.mock.myServers.providerDown";
const ACCOUNT_KEY = "veyl.mock.account";

/** 内部固定值；mock 不发邮件，也不在任何界面上提示这个验证码。 */
const MOCK_LOGIN_CODE = "123456";
const TOPUP_CENTS = [1000, 2000, 5000, 10_000];

const PHASE_MS: Record<string, number> = {
  creating: 700,
  booting: 900,
  installing: 900,
  verifying: 700,
};

interface StoredServer extends MyServer {
  started_at: number;
  idempotency_key?: string;
}

interface Store {
  servers: StoredServer[];
  orders: MyServerOrder[];
  next_id: number;
  /** mock 余额（USD 分）；默认 0，走一遍充值再买机。 */
  balance_cents: number;
}

function readFlag(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface StoredAccount {
  logged_in: boolean;
  email: string | null;
}

/** mock 账户默认未登录；登录后才请求列表与钱包。 */
function readAccount(): StoredAccount {
  try {
    const raw = readFlag(ACCOUNT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredAccount>;
      if (typeof parsed.logged_in === "boolean") {
        return {
          logged_in: parsed.logged_in,
          email: typeof parsed.email === "string" ? parsed.email : null,
        };
      }
    }
  } catch {
    // 坏数据按未登录处理。
  }
  return { logged_in: false, email: null };
}

function writeAccount(account: StoredAccount): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    // 存不了就只活在这次会话里。
  }
}

function accountView(): MyServerAccount {
  const account = readAccount();
  return {
    logged_in: account.logged_in,
    email: account.logged_in ? account.email : null,
    account_id: "acct_mock",
    device_id: "dev_mock",
    account_kind: account.logged_in ? "email" : "device",
  };
}

function loginError(
  code: string,
  message: string,
  reason: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): never {
  throw { code, message, details: { reason, ...extra }, retryable };
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(parsed.servers) && Array.isArray(parsed.orders)) {
        return {
          servers: parsed.servers as StoredServer[],
          orders: parsed.orders as MyServerOrder[],
          next_id: typeof parsed.next_id === "number" ? parsed.next_id : 1,
          balance_cents:
            typeof parsed.balance_cents === "number" && parsed.balance_cents >= 0
              ? parsed.balance_cents
              : 0,
        };
      }
    }
  } catch {
    // 坏数据按空库处理。
  }
  return { servers: [], orders: [], next_id: 1, balance_cents: 0 };
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 存不了就只活在这次会话里。
  }
}

function copyServer(server: StoredServer): MyServer {
  const { started_at: _started, idempotency_key: _key, ...rest } = server;
  return { ...rest, failure: rest.failure ? { ...rest.failure } : null };
}

function failStage(): string | null {
  return readFlag(FAIL_KEY);
}

function failureFor(stage: MyServerState): MyServerFailure {
  const title =
    stage === "booting"
      ? "机器开机超时。"
      : stage === "installing"
        ? "服务端没装好。"
        : "服务端连不上。";
  return {
    stage,
    code: stage === "booting" ? "boot_timeout" : `${stage}_failed`,
    message: `${title}这台还在，但没有可用节点。点「重新建一台」再试一次。`,
    retryable: true,
  };
}

function errorAt(stage: MyServerState): MyServerFailure {
  return failureFor(stage);
}

/** 读取时按经过的时间推进状态，不后台跑定时器。 */
function advance(store: Store): void {
  const now = Date.now();
  for (const server of store.servers) {
    if (!MY_SERVER_PHASES.includes(server.state)) continue;
    let elapsed = now - server.started_at;
    let index = MY_SERVER_PHASES.indexOf(server.state);
    while (index < MY_SERVER_PHASES.length) {
      const phase = MY_SERVER_PHASES[index];
      const duration = PHASE_MS[phase] ?? 800;
      if (elapsed < duration) break;
      elapsed -= duration;
      const failKey =
        phase === "booting" ? "boot" : phase === "installing" ? "install" : phase === "verifying" ? "verify" : null;
      if (failKey && failStage() === failKey) {
        server.state = "error";
        server.failure = errorAt(phase);
        server.node_id = null;
        server.local_node_id = null;
        break;
      }
      index += 1;
      if (index >= MY_SERVER_PHASES.length) {
        server.state = "healthy";
        server.failure = null;
        server.node_id = `node_${server.server_id}`;
        server.port = server.port ?? 8388;
        // 就绪后才扣第一天：mock 在这里把待开通转成已开通。
        if (server.billing_state === "pending") {
          server.billing_state = "active";
          server.paid_until = new Date(now + 86_400_000).toISOString();
        }
        server.ready_at ??= new Date(now).toISOString();
        break;
      }
      server.state = MY_SERVER_PHASES[index];
      server.failure = null;
      if (server.state !== "creating") server.port = server.port ?? 8388;
    }
  }
  // 订单跟随它建出来的实例。
  for (const order of store.orders) {
    if (!order.server_id) continue;
    if (order.state !== "provisioning" && order.state !== "paid") continue;
    const server = store.servers.find((item) => item.server_id === order.server_id);
    if (!server) continue;
    if (server.state === "healthy" || server.state === "active") {
      order.state = "ready";
    } else if (server.state === "error") {
      order.state = "failed";
      order.failure = server.failure
        ? {
            code: server.failure.code,
            message: server.failure.message,
            retryable: true,
          }
        : null;
    } else {
      order.state = "provisioning";
    }
  }
  writeStore(store);
}

function providerDown(): never {
  throw {
    code: "UPSTREAM_ERROR",
    message: "暂时连不上服务器服务，稍后再试；没有产生服务器。",
    details: { reason: "provider_unavailable" },
    retryable: true,
  };
}

export class MockMyServerService {
  catalog(): MyServerCatalog {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    return {
      regions: REGIONS.map((region) => ({ ...region })),
      plans: PLANS.map((plan) => ({ ...plan })),
      currency: "USD",
      updated_at: new Date().toISOString(),
    };
  }

  list(): { servers: MyServer[] } {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    advance(store);
    return {
      servers: store.servers
        .filter((server) => server.state !== "destroyed")
        .map(copyServer),
    };
  }

  get(serverId: string): MyServer {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    advance(store);
    const server = store.servers.find((item) => item.server_id === serverId);
    if (!server) {
      throw {
        code: "NOT_FOUND",
        message: "这台服务器已不存在。重新买一台，或改用其它节点。",
        details: { reason: "server_gone" },
      };
    }
    return copyServer(server);
  }

  rename(serverId: string, name: string): MyServer {
    const store = readStore();
    const server = store.servers.find((item) => item.server_id === serverId);
    if (!server) {
      throw {
        code: "NOT_FOUND",
        message: "这台服务器已不存在。",
        details: { reason: "server_gone" },
      };
    }
    server.name = name.trim();
    writeStore(store);
    return copyServer(server);
  }

  create(input: MyServerCreateInput): MyServerOrder {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const region = REGIONS.find((item) => item.id === input.region);
    if (!region) {
      throw {
        code: "PRECONDITION_FAILED",
        message: "这个地区暂时没货。换一个地区或稍后再试。",
        details: { reason: "region_unavailable" },
        retryable: true,
      };
    }
    const store = readStore();
    const plan = PLANS.find((item) => item.id === input.plan) ?? DEFAULT_PLAN;
    const existing = store.orders.find(
      (order) =>
        (order as MyServerOrder & { idempotency_key?: string }).idempotency_key ===
        input.idempotencyKey,
    );
    if (existing) return { ...existing };
    if (failStage() === "create") {
      throw {
        code: "UPSTREAM_ERROR",
        message: "服务器没建起来。这笔订单已结束，没有产生服务器；换一个地区或重新下单。",
        details: { reason: "instance_create_failed" },
        retryable: true,
      };
    }
    const order: MyServerOrder & { idempotency_key?: string } = {
      order_id: `ord_${store.next_id++}`,
      state: "pending_payment",
      region: region.id,
      plan: plan.id,
      amount_usd: plan.monthly_usd,
      created_at: new Date().toISOString(),
      expires_at: null,
      server_id: null,
      failure: null,
      idempotency_key: input.idempotencyKey,
    };
    store.orders.push(order);
    writeStore(store);
    return { ...order };
  }

  orderGet(orderId: string): MyServerOrder {
    const store = readStore();
    const order = store.orders.find((item) => item.order_id === orderId);
    if (!order) {
      throw { code: "NOT_FOUND", message: "这笔订单不存在了，重新下一单。" };
    }
    return { ...order };
  }

  /** 结账返回订单（2.39.0）：server_id 写在订单上，不再返回 charged_cents。 */
  checkout(orderId: string): MyServerOrder {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    const order = store.orders.find((item) => item.order_id === orderId);
    if (!order) {
      throw { code: "NOT_FOUND", message: "这笔订单不存在了，重新下一单。" };
    }
    if (order.state !== "pending_payment") {
      // 已付过的订单重复结账：不再扣钱。
      return { ...order };
    }
    const region = REGIONS.find((item) => item.id === order.region) ?? REGIONS[0];
    const plan = PLANS.find((item) => item.id === order.plan) ?? DEFAULT_PLAN;
    const priceCents = plan.daily_price_cents;
    // 建机门槛：余额 ≥ 日价 × 7；实际仍只扣 1 天（login-and-payment.md §4.1）。
    const requiredCents = priceCents * 7;
    if (store.balance_cents < requiredCents) {
      throw {
        code: "PRECONDITION_FAILED",
        message: "余额不足以支付一周的费用。",
        details: {
          reason: "insufficient_balance",
          required_cents: requiredCents,
          shortfall_cents: requiredCents - store.balance_cents,
          min_days: 7,
        },
        retryable: true,
      };
    }
    store.balance_cents -= priceCents;
    const id = `srv_${store.next_id++}`;
    const server: StoredServer = {
      server_id: id,
      name: `${region.name} · ${PROVIDER}`,
      region: region.id,
      plan: plan.id,
      state: "creating",
      created_at: new Date().toISOString(),
      ip: `45.76.${40 + store.next_id}.${80 + store.next_id}`,
      port: null,
      node_id: null,
      local_node_id: null,
      hourly_usd: plan.hourly_usd,
      monthly_usd: plan.monthly_usd,
      daily_price_cents: plan.daily_price_cents,
      transfer_gib: plan.transfer_gib,
      paid_until: null,
      billing_state: "pending",
      grace_ends_at: null,
      failure: null,
      started_at: Date.now(),
    };
    store.servers.push(server);
    order.state = "provisioning";
    order.server_id = id;
    writeStore(store);
    return { ...order };
  }

  account(): MyServerAccount {
    return accountView();
  }

  loginStart(email: string): MyServerLoginTicket {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      loginError("PRECONDITION_FAILED", "邮箱格式不对。", "email_invalid", false);
    }
    return { sent: true, cooldown_seconds: 60 };
  }

  loginVerify(email: string, code: string): MyServerAccount {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    if (code.trim() !== MOCK_LOGIN_CODE) {
      loginError(
        "PRECONDITION_FAILED",
        "验证码不对。",
        "code_invalid",
        true,
        { attempts_remaining: 2 },
      );
    }
    writeAccount({ logged_in: true, email: email.trim() });
    return accountView();
  }

  logout(): MyServerAccount {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    writeAccount({ logged_in: false, email: null });
    return accountView();
  }

  wallet(): MyServerWallet {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    if (!readAccount().logged_in) {
      loginError("UNAUTHENTICATED", "需要先登录。", "auth_required", true);
    }
    const store = readStore();
    return {
      balance_cents: store.balance_cents,
      currency: "USD",
      denominations_cents: [...TOPUP_CENTS],
      updated_at: new Date().toISOString(),
    };
  }

  topup(denominationCents: number): MyServerTopup {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    if (!readAccount().logged_in) {
      loginError("UNAUTHENTICATED", "需要先登录。", "auth_required", true);
    }
    if (!TOPUP_CENTS.includes(denominationCents)) {
      loginError(
        "PRECONDITION_FAILED",
        "这个充值档位不存在。",
        "invalid_denomination",
        false,
      );
    }
    const store = readStore();
    store.balance_cents += denominationCents;
    writeStore(store);
    // mock 通道直接入账，没有收银台。
    return {
      topup_id: `topup_${Date.now()}`,
      checkout_url: null,
      denomination_cents: denominationCents,
    };
  }

  cancelOrder(orderId: string): MyServerOrder {
    const store = readStore();
    const order = store.orders.find((item) => item.order_id === orderId);
    if (!order) {
      throw { code: "NOT_FOUND", message: "这笔订单不存在了。" };
    }
    if (order.state === "cancelled") return { ...order };
    if (order.server_id) {
      store.servers = store.servers.filter(
        (server) => server.server_id !== order.server_id,
      );
    }
    order.state = "cancelled";
    order.server_id = null;
    writeStore(store);
    return { ...order };
  }

  rebuild(serverId: string, confirm: boolean): MyServerRebuildResult {
    if (!confirm) {
      throw { code: "INVALID_ARGUMENT", message: "需要先确认再重建。" };
    }
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    advance(store);
    const old = store.servers.find((item) => item.server_id === serverId);
    if (!old) {
      throw {
        code: "NOT_FOUND",
        message: "这台服务器已不存在。",
        details: { reason: "server_gone" },
      };
    }
    const id = `srv_${store.next_id++}`;
    const region = REGIONS.find((item) => item.id === old.region) ?? REGIONS[0];
    store.servers = store.servers.filter((item) => item.server_id !== serverId);
    store.servers.push({
      ...old,
      server_id: id,
      name: `${region.name} · ${PROVIDER}`,
      state: "creating",
      created_at: new Date().toISOString(),
      ip: `45.76.${50 + store.next_id}.${90 + store.next_id}`,
      port: null,
      node_id: null,
      local_node_id: null,
      paid_until: null,
      billing_state: "pending",
      grace_ends_at: null,
      failure: null,
      started_at: Date.now(),
    });
    writeStore(store);
    return { newServerId: id, state: "creating" };
  }

  destroy(serverId: string, confirm: boolean): MyServer {
    if (!confirm) {
      throw { code: "INVALID_ARGUMENT", message: "需要先确认再销毁。" };
    }
    const store = readStore();
    advance(store);
    const server = store.servers.find((item) => item.server_id === serverId);
    if (!server) {
      throw {
        code: "NOT_FOUND",
        message: "这台服务器已不存在。",
        details: { reason: "server_gone" },
      };
    }
    const destroyed: MyServer = {
      ...copyServer(server),
      state: "destroyed",
      node_id: null,
      local_node_id: null,
    };
    store.servers = store.servers.filter((item) => item.server_id !== serverId);
    writeStore(store);
    return destroyed;
  }

  credentials(serverId: string): MyServerCredentialNode {
    const server = this.get(serverId);
    if (server.state !== "healthy" && server.state !== "active") {
      throw {
        code: "PRECONDITION_FAILED",
        message: "这台服务器还没装好，暂时拿不到凭据。",
      };
    }
    // 与真机一致：取凭据时本地才落节点行，下一次 list() 才看得到 local_node_id。
    const store = readStore();
    advance(store);
    const stored = store.servers.find((item) => item.server_id === serverId);
    if (stored) {
      stored.local_node_id = `local_${server.server_id}`;
      writeStore(store);
    }
    return {
      server_id: server.server_id,
      // 本地节点 id 与控制面的 nd_ 不同：模拟 Host 落库后返回的 nodes.id。
      node_id: `local_${server.server_id}`,
      name: `${server.name.split(" · ")[0]} 01`,
      host: server.ip ?? "127.0.0.1",
      port: server.port ?? 8388,
      method: "aes-256-gcm",
    };
  }

  sshCredentials(serverId: string): MyServerSshCredentials {
    const server = this.get(serverId);
    return {
      host: server.ip ?? "127.0.0.1",
      port: 22,
      username: "veyl",
      auth_type: "password",
      password: "veyl-demo-2026",
      public_key: null,
      updated_at: new Date().toISOString(),
    };
  }
}

export const MOCK_MY_SERVER_REGIONS = REGIONS;
