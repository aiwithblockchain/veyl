import type {
  MyServer,
  MyServerCatalog,
  MyServerCreateInput,
  MyServerCredentials,
  MyServerFailure,
  MyServerOrder,
  MyServerPlan,
  MyServerRebuildResult,
  MyServerRegion,
  MyServerSshCredentials,
  MyServerState,
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
    monthly_usd: 4,
  },
  {
    id: "s-1vcpu-1gb",
    label: "1 核 · 1 GB",
    hourly_usd: 0.00893,
    monthly_usd: 6,
  },
  {
    id: "s-1vcpu-2gb",
    label: "1 核 · 2 GB",
    hourly_usd: 0.01786,
    monthly_usd: 12,
  },
];

const DEFAULT_PLAN = PLANS[1];

const PROVIDER = "DigitalOcean";

const STORE_KEY = "veyl.mock.myServers";
const FAIL_KEY = "veyl.mock.myServers.fail";
const SEED_KEY = "veyl.mock.myServers.seed";
const DOWN_KEY = "veyl.mock.myServers.providerDown";

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
}

function readFlag(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
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
        };
      }
    }
  } catch {
    // 坏数据按空库处理，不阻塞演示。
  }
  return seedStore();
}

/** 没配 seed 时的默认四台：可用、安装中、出错、可用，方便直接看效果。 */
const DEFAULT_SERVERS: Array<{ region: string; state: MyServerState }> = [
  { region: "sgp1", state: "healthy" },
  { region: "nyc1", state: "installing" },
  { region: "fra1", state: "error" },
  { region: "tor1", state: "healthy" },
];

/** 默认演示数据里正在建的那台先停 30 秒，方便看清进度；之后照常推进。 */
const DEMO_HOLD_MS = 30_000;

/** 没有存档时按 `veyl.mock.myServers.seed` 造一批任意状态的服务器。 */
function seedStore(): Store {
  const store: Store = { servers: [], orders: [], next_id: 1 };
  const seed = readFlag(SEED_KEY);
  const isDefault = seed === null;
  const states: MyServerState[] = isDefault
    ? DEFAULT_SERVERS.map((item) => item.state)
    : (seed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean) as MyServerState[]);
  const regionIds = isDefault ? DEFAULT_SERVERS.map((item) => item.region) : null;
  states.forEach((state, index) => {
    const region = regionIds
      ? (REGIONS.find((item) => item.id === regionIds[index]) ?? REGIONS[0])
      : REGIONS[index % REGIONS.length];
    const id = `srv_seed_${index + 1}`;
    store.servers.push({
      server_id: id,
      name: `${region.name} · ${PROVIDER}`,
      region: region.id,
      plan: DEFAULT_PLAN.id,
      state,
      created_at: new Date(Date.now() - 60_000 * (index + 1)).toISOString(),
      ip: `45.76.${20 + index}.${100 + index}`,
      port: state === "creating" || state === "booting" ? null : 8388,
      node_id:
        state === "healthy" || state === "active" ? `node_${id}` : null,
      hourly_usd: DEFAULT_PLAN.hourly_usd,
      monthly_usd: DEFAULT_PLAN.monthly_usd,
      failure:
        state === "error"
          ? {
              stage: "installing",
              code: "install_failed",
              message: failureFor("installing").message,
              retryable: true,
            }
          : null,
      // 正在建的从当前阶段起算，打开界面时能看到进度；可用的没有起始时刻。
      started_at: MY_SERVER_PHASES.includes(state)
        ? Date.now() + (isDefault ? DEMO_HOLD_MS : 0)
        : Date.now() - 60_000,
    });
  });
  return store;
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
        break;
      }
      index += 1;
      if (index >= MY_SERVER_PHASES.length) {
        server.state = "healthy";
        server.failure = null;
        server.node_id = `node_${server.server_id}`;
        server.port = server.port ?? 8388;
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

  checkout(orderId: string): MyServerOrder {
    if (readFlag(DOWN_KEY) === "1") providerDown();
    const store = readStore();
    const order = store.orders.find((item) => item.order_id === orderId);
    if (!order) {
      throw { code: "NOT_FOUND", message: "这笔订单不存在了，重新下一单。" };
    }
    if (order.state !== "pending_payment") return { ...order };
    const region = REGIONS.find((item) => item.id === order.region) ?? REGIONS[0];
    const plan = PLANS.find((item) => item.id === order.plan) ?? DEFAULT_PLAN;
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
      hourly_usd: plan.hourly_usd,
      monthly_usd: plan.monthly_usd,
      failure: null,
      started_at: Date.now(),
    };
    store.servers.push(server);
    order.state = "provisioning";
    order.server_id = id;
    writeStore(store);
    return { ...order };
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
    };
    store.servers = store.servers.filter((item) => item.server_id !== serverId);
    writeStore(store);
    return destroyed;
  }

  credentials(serverId: string): MyServerCredentials {
    const server = this.get(serverId);
    if (!server.node_id) {
      throw {
        code: "PRECONDITION_FAILED",
        message: "这台服务器还没装好，暂时拿不到凭据。",
      };
    }
    const payload = JSON.stringify({
      server_id: server.server_id,
      node_id: server.node_id,
      host: server.ip,
      port: server.port,
    });
    return {
      payload: btoa(payload),
      signature: `mock-${server.server_id}-signature`,
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
