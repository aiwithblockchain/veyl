import type {
  BillingLedger,
  BillingLedgerEntry,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerCreateInput,
  MyServerCredentialNode,
  MyServerEvent,
  MyServerEventCode,
  MyServerEvents,
  MyServerFailure,
  MyServerLoginTicket,
  MyServerList,
  MyServerOrder,
  MyServerPlan,
  MyServerRebuildResult,
  MyServerRegion,
  MyServerSshCredentials,
  MyServerState,
  MyServerTopup,
  MyServerTrafficState,
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
    session_expires_at: account.logged_in
      ? new Date(Date.now() + 30 * 86_400_000).toISOString()
      : null,
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
          servers: (parsed.servers as StoredServer[]).map(withTrafficDefaults),
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

const GIB = 1024 ** 3;

/** 本周期清零点：下个 UTC 月 1 日 00:00（契约 2.78.0）。 */
function nextTrafficResetAt(now = Date.now()): string {
  const date = new Date(now);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  ).toISOString();
}

/** 释放窗口的天数：与控制面 `traffic_cycle.ts` 的 `RELEASE_DAYS` 一致（§4.1）。 */
const RELEASE_DAYS = 28;

/** 当天释放的额度（字节）：`min(月额度, 月额度 / 28)`，与控制面同口径。 */
function releasedBytes(transferGib: number): number {
  const monthly = Math.round(Math.max(0, transferGib) * GIB);
  if (monthly <= 0) return 0;
  return Math.min(monthly, Math.floor(monthly / RELEASE_DAYS));
}

/**
 * demo 用流量样例：ok / near / over / 额度未知 / 流量超支停机各一台。
 * 第三段（界面）照这五台验渲染，不必自己造数；`state` 与 `used`、`limit`
 * 按 §8 的口径自洽（near ≥ 80%、over 严格超出、unpaid 是已停机墓碑）。
 */
const TRAFFIC_SAMPLES: Array<{
  server_id: string;
  name: string;
  region: string;
  /** 月额度（GiB）；0 = 额度未知。 */
  transfer_gib: number;
  used: number;
  state: MyServerTrafficState;
  /** 流量超支停机：列表里以墓碑行保留。 */
  tombstone?: { code: string; message: string };
}> = [
  {
    server_id: "srv_traffic_ok",
    name: "流量充足 · 新加坡 1",
    region: "sgp1",
    transfer_gib: DEFAULT_PLAN.transfer_gib,
    used: 6 * GIB,
    state: "ok",
  },
  {
    server_id: "srv_traffic_near",
    name: "接近额度 · 纽约 1",
    region: "nyc1",
    transfer_gib: DEFAULT_PLAN.transfer_gib,
    used: 29 * GIB,
    state: "near",
  },
  {
    server_id: "srv_traffic_over",
    name: "已超额度 · 旧金山 2",
    region: "sfo2",
    transfer_gib: DEFAULT_PLAN.transfer_gib,
    used: 37 * GIB,
    state: "over",
  },
  {
    server_id: "srv_traffic_unknown",
    name: "额度未知 · 班加罗尔 1",
    region: "blr1",
    transfer_gib: 0,
    used: 512 * 1024 ** 2,
    state: "ok",
  },
  {
    server_id: "srv_traffic_unpaid",
    name: "流量超支停机 · 旧金山 3",
    region: "sfo3",
    transfer_gib: DEFAULT_PLAN.transfer_gib,
    used: 42 * GIB,
    state: "unpaid",
    tombstone: { code: "traffic_overage", message: "流量超支，余额不足已停机" },
  },
];

/** 控制面保留的两类停机墓碑（与 servers.ts 的列表过滤一致）。 */
const TOMBSTONE_CODES = new Set(["billing_unpaid", "traffic_overage"]);

/** 旧存档没有四个流量字段：补齐默认值，界面与账号池都拿不到 undefined。 */
function withTrafficDefaults(server: StoredServer): StoredServer {
  return {
    ...server,
    traffic_used_bytes: Number.isFinite(server.traffic_used_bytes)
      ? server.traffic_used_bytes
      : 0,
    traffic_limit_bytes: Number.isFinite(server.traffic_limit_bytes)
      ? server.traffic_limit_bytes
      : 0,
    traffic_reset_at:
      typeof server.traffic_reset_at === "string" ? server.traffic_reset_at : "",
    traffic_state: server.traffic_state ?? "ok",
  };
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

  list(): MyServerList {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    advance(store);
    const servers = store.servers
      // 控制面只保留两种停机墓碑；手动销毁的行不再出现。
      .filter(
        (server) =>
          server.state !== "destroyed" ||
          (server.failure !== null &&
            TOMBSTONE_CODES.has(server.failure.code)),
      )
      .map(copyServer);
    return {
      servers,
      // 账号池（2.79.0）：对列表推导之前的全量机器求和——手动销毁的行也在
      // 这个周期里占着已释放额度，池子必须包含列表里看不到的那些。
      traffic_pool: {
        usedBytes: store.servers.reduce(
          (sum, server) => sum + server.traffic_used_bytes,
          0,
        ),
        limitBytes: store.servers.reduce(
          (sum, server) => sum + server.traffic_limit_bytes,
          0,
        ),
      },
    };
  }

  /**
   * demo：造五台流量样例（ok / near / over / 额度未知 / 流量超支停机）。
   * 验收：控制台 `window.dispatchEvent(new Event("veyl:seed-traffic"))` 后刷新。
   */
  seedTrafficDemo(): MyServer[] {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    const now = Date.now();
    TRAFFIC_SAMPLES.forEach((sample, index) => {
      if (store.servers.some((server) => server.server_id === sample.server_id)) {
        return;
      }
      const destroyed = sample.tombstone !== undefined;
      store.servers.push({
        server_id: sample.server_id,
        name: sample.name,
        region: sample.region,
        plan: DEFAULT_PLAN.id,
        state: destroyed ? "destroyed" : "healthy",
        created_at: new Date(now - 12 * 3_600_000).toISOString(),
        ip: `203.0.113.${20 + index}`,
        port: destroyed ? null : 8388,
        node_id: `nd_${sample.server_id}`,
        local_node_id: null,
        hourly_usd: DEFAULT_PLAN.hourly_usd,
        monthly_usd: DEFAULT_PLAN.monthly_usd,
        daily_price_cents: DEFAULT_PLAN.daily_price_cents,
        transfer_gib: sample.transfer_gib,
        traffic_used_bytes: sample.used,
        traffic_limit_bytes: releasedBytes(sample.transfer_gib),
        traffic_reset_at: nextTrafficResetAt(now),
        traffic_state: sample.state,
        paid_until: new Date(destroyed ? now : now + 86_400_000).toISOString(),
        billing_state: destroyed ? "expired" : "active",
        grace_ends_at: null,
        failure: sample.tombstone
          ? {
              stage: "active",
              code: sample.tombstone.code,
              message: sample.tombstone.message,
              retryable: false,
            }
          : null,
        started_at: now,
      });
    });
    writeStore(store);
    return this.list().servers;
  }

  /**
   * demo：造一台「余额不足停机」的墓碑，`local_node_id` 指向给定节点。
   * 验收：控制台 `window.dispatchEvent(new Event("veyl:seed-tombstone"))` 后刷新。
   */
  seedBillingTombstone(localNodeId: string, name: string): MyServer {
    const store = readStore();
    const now = Date.now();
    const server: StoredServer = {
      server_id: `srv_tomb_${now}`,
      name,
      region: "sgp1",
      plan: DEFAULT_PLAN.id,
      state: "destroyed",
      created_at: new Date(now - 86_400_000).toISOString(),
      ip: "203.0.113.77",
      port: null,
      node_id: `nd_tomb_${now}`,
      local_node_id: localNodeId,
      hourly_usd: DEFAULT_PLAN.hourly_usd,
      monthly_usd: DEFAULT_PLAN.monthly_usd,
      daily_price_cents: DEFAULT_PLAN.daily_price_cents,
      paid_until: new Date(now).toISOString(),
      billing_state: "expired",
      grace_ends_at: null,
      transfer_gib: DEFAULT_PLAN.transfer_gib,
      traffic_used_bytes: 0,
      traffic_limit_bytes: releasedBytes(DEFAULT_PLAN.transfer_gib),
      traffic_reset_at: nextTrafficResetAt(now),
      traffic_state: "ok",
      failure: {
        stage: "active",
        code: "billing_unpaid",
        message: "余额不足，已停机删除",
        retryable: false,
      },
      started_at: now,
    };
    store.servers.push(server);
    writeStore(store);
    return copyServer(server);
  }

  /** 用户删掉墓碑留下的节点：这一行以后不再出现（控制面 dismiss 的本地等价物）。 */
  dismissByNode(nodeId: string): void {
    const store = readStore();
    const before = store.servers.length;
    store.servers = store.servers.filter(
      (server) =>
        !(server.state === "destroyed" && server.local_node_id === nodeId),
    );
    if (store.servers.length !== before) writeStore(store);
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

  /**
   * 创建记录（mock）：由服务器行的时间戳与状态拼出，形状与控制面一致。
   * 正常机器 5 条；失败机器另有失败、销毁、退款三条，并给一次折叠次数。
   */
  events(serverId: string): MyServerEvents {
    const server = this.get(serverId);
    const started = Date.parse(server.created_at);
    const base = Number.isFinite(started) ? started : Date.now() - 5 * 60_000;
    const minute = 60_000;
    const at = (iso: string | null | undefined, fallback: number): number => {
      const parsed = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const events: MyServerEvent[] = [];
    const push = (
      when: number,
      code: MyServerEventCode,
      extra: Partial<MyServerEvent> = {},
    ) => {
      events.push({ at: when, code, ...extra });
    };

    push(base, "order.confirmed");
    push(base + 1000, "machine.created");
    if (server.state !== "creating") {
      push(at(server.installing_at, base + minute), "install.started");
    }
    if (
      server.state === "verifying" ||
      server.state === "healthy" ||
      server.state === "active"
    ) {
      push(at(server.verifying_at, base + 2 * minute), "verify.started");
    }
    if (server.state === "healthy" || server.state === "active") {
      push(at(server.ready_at, base + 3 * minute), "activated", {
        version: "1.14.4",
      });
    }
    if (server.state === "destroyed") {
      push(base + 4 * minute, "destroyed", {
        reason:
          server.failure?.code === "billing_unpaid"
            ? "billing_unpaid"
            : "install_failed",
      });
      push(base + 4 * minute, "refunded", {
        amount_cents: server.daily_price_cents,
      });
    }
    if (server.failure && server.state === "error") {
      const stage = server.failure.stage;
      const code: MyServerEventCode =
        stage === "installing"
          ? "install.failed"
          : stage === "verifying"
            ? "check.failed"
            : "create.failed";
      push(base + 4 * minute, code, stage === "installing" ? { count: 2 } : {});
      push(base + 4 * minute, "destroyed", { reason: "install_failed" });
      push(base + 4 * minute, "refunded", {
        amount_cents: server.daily_price_cents,
      });
    }

    events.sort((a, b) => b.at - a.at);
    return { events, has_more: false };
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
      traffic_used_bytes: 0,
      traffic_limit_bytes: releasedBytes(plan.transfer_gib),
      traffic_reset_at: nextTrafficResetAt(),
      traffic_state: "ok",
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

  /**
   * 近 N 天账单样例：20 笔、覆盖五类，既有 null 机器也有正负金额。
   * `totals` 与控制面同一口径（充值只算 topup、扣费算所有负数），所以与逐行求和一致；
   * 样例 20 笔，`truncated` 恒为 false。
   */
  billingLedger(days?: number): BillingLedger {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    if (!readAccount().logged_in) {
      loginError("UNAUTHENTICATED", "需要先登录。", "auth_required", true);
    }
    // 越界与省略都落到 30：控制面也是这么回落的。
    const windowDays =
      days !== undefined && Number.isInteger(days) && days >= 1 && days <= 30
        ? days
        : 30;
    const now = Date.now();
    const sgp = {
      id: "srv_mock_sgp",
      name: "新加坡 1",
      plan: "s-1vcpu-1gb",
      region: "sgp1",
    };
    const nyc = {
      id: "srv_mock_nyc",
      name: "纽约 1",
      plan: "s-1vcpu-512mb-10gb",
      region: "nyc1",
    };
    const sfo = {
      id: "srv_mock_sfo",
      name: "旧金山 2",
      plan: "s-1vcpu-2gb",
      region: "sfo2",
    };
    const rows: Array<
      [
        BillingLedgerEntry["kind"],
        number,
        BillingLedgerEntry["server"],
        string | null,
      ]
    > = [
      ["topup", 1200, null, "充值"],
      ["machine_day", -20, sgp, null],
      ["machine_day", -20, sgp, null],
      ["traffic", -15, sgp, null],
      ["machine_day", -20, nyc, null],
      ["machine_day", -20, nyc, null],
      ["traffic", -45, nyc, null],
      ["refund", 200, nyc, "流量超支退回"],
      ["machine_day", -30, sfo, null],
      ["machine_day", -30, sfo, null],
      ["traffic", -120, sfo, null],
      ["other", 300, null, "活动赠额"],
      ["topup", 2400, null, "充值"],
      ["machine_day", -20, sgp, null],
      ["machine_day", -20, sgp, null],
      ["traffic", -10, sgp, null],
      ["machine_day", -20, nyc, null],
      ["refund", 50, sgp, "重复扣费退回"],
      ["other", -80, null, "人工调账"],
      ["machine_day", -20, nyc, null],
    ];
    const entries: BillingLedgerEntry[] = rows.map(
      ([kind, amount, server, note], index) => ({
        id: `wl_mock_${String(index + 1).padStart(2, "0")}`,
        kind,
        amount_cents: amount,
        at: now - index * 3_600_000,
        server,
        note,
      }),
    );
    return {
      balance_cents: readStore().balance_cents,
      currency: "USD",
      window_days: windowDays,
      truncated: false,
      totals: {
        topup_cents: entries
          .filter((entry) => entry.kind === "topup")
          .reduce((sum, entry) => sum + entry.amount_cents, 0),
        charge_cents: entries
          .filter((entry) => entry.amount_cents < 0)
          .reduce((sum, entry) => sum - entry.amount_cents, 0),
      },
      entries,
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
