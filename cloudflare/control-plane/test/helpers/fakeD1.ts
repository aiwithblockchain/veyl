// 测试用的最小 D1 替身：只实现 auth/orders/servers/payments 涉及的语句形态。
// 不是 SQL 引擎——遇到没覆盖的语句会抛错，避免测试悄悄走错分支。

import { assertSqlMatchesSchema } from "./schemaGuard";

type Row = Record<string, unknown>;

interface Stmt {
  sql: string;
  args: unknown[];
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

export class FakeD1 {
  private tables = {
    accounts: [] as Row[],
    devices: [] as Row[],
    refresh_tokens: [] as Row[],
    orders: [] as Row[],
    servers: [] as Row[],
    credentials: [] as Row[],
    audit_log: [] as Row[],
    idempotency_keys: [] as Row[],
    email_codes: [] as Row[],
    payments: [] as Row[],
    webhook_events: [] as Row[],
    unmatched_payments: [] as Row[],
    subscriptions: [] as Row[],
    wallet_ledger: [] as Row[],
    topups: [] as Row[],
    billing_cursor: [] as Row[],
    catalog_cache: [] as Row[],
  };
  private rateLimits = new Map<string, { window_start: number; count: number }>();
  /** 测试钩子：collectDue 结束（写计费游标）时触发，用来模拟「取到行之后被销毁」。 */
  onBillingCursor?: () => void;
  /** 测试钩子：写账本前触发，用来模拟「复查之后、记账之前进入销毁」。 */
  beforeWalletInsert?: () => void;
  /** 测试钩子：refresh 的条件更新前触发，用来模拟「读到未使用、更新时已被并发请求抢走」。 */
  beforeRefreshUse?: () => void;
  /** 测试钩子：激活语句执行前触发，用来模拟 sweep 在这段窗口里把机器销毁。 */
  beforeServerActivate?: () => void;
  /** 测试钩子：目录条件写回前触发，用来模拟「读到的版本已被别人覆盖」。 */
  beforeCatalogWrite?: () => void;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, { sql, args: [] });
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    // 真实 D1 的 batch 是原子的：整批语句之间不会被别的请求插进来。
    // 逐条 await 会让出微任务，反而把「并发 checkout」测成假并发，所以这里同步跑完。
    const results = statements.map((statement) => statement.run());
    return Promise.all(results);
  }

  exec(statement: Stmt): Row | null {
    const sql = normalise(statement.sql);
    const a = statement.args;
    if (/^(insert|update|delete)\b/.test(sql)) assertSqlMatchesSchema(sql, a);

    if (sql.startsWith("select payload, updated_at from catalog_cache")) {
      const row = this.tables.catalog_cache.find((entry) => entry.key === a[0]);
      return row ? { payload: row.payload, updated_at: row.updated_at } : null;
    }
    if (sql.startsWith("insert into catalog_cache")) {
      const existing = this.tables.catalog_cache.find((row) => row.key === a[0]);
      // 回源租约：只有旧租约过期（或没有）才能拿到。
      if (sql.includes("do update set updated_at = excluded.updated_at")) {
        if (!existing) {
          this.tables.catalog_cache.push({ key: a[0], payload: "", updated_at: Number(a[1]) });
        } else if (Number(existing.updated_at) <= Number(a[2])) {
          existing.updated_at = Number(a[1]);
        }
        return null;
      }
      if (existing) {
        existing.payload = a[1];
        existing.updated_at = Number(a[2]);
      } else {
        this.tables.catalog_cache.push({ key: a[0], payload: a[1], updated_at: Number(a[2]) });
      }
      return null;
    }
    if (sql.startsWith("delete from catalog_cache")) {
      this.tables.catalog_cache = this.tables.catalog_cache.filter(
        (row) => row.key !== a[0],
      );
      return null;
    }
    if (sql.startsWith("update catalog_cache set payload")) {
      // 条件更新：只有读到的版本还没被覆盖时才写。
      const row = this.tables.catalog_cache.find(
        (entry) => entry.key === a[2] && Number(entry.updated_at) === Number(a[3]),
      );
      if (row) {
        row.payload = a[0];
        row.updated_at = Number(a[1]);
      }
      return null;
    }
    if (sql.startsWith("select value from billing_cursor")) {
      const row = this.tables.billing_cursor.find((entry) => entry.id === a[0]);
      return row ? { value: row.value } : null;
    }
    if (sql.startsWith("insert or replace into billing_cursor")) {
      const row = this.tables.billing_cursor.find((entry) => entry.id === a[0]);
      if (row) row.value = a[1];
      else this.tables.billing_cursor.push({ id: a[0], value: a[1] });
      this.onBillingCursor?.();
      return null;
    }
    if (sql.startsWith("select window_start, count from rate_limits")) {
      const row = this.rateLimits.get(String(a[0]));
      return row ? { ...row } : null;
    }
    if (sql.startsWith("insert into rate_limits")) {
      this.rateLimits.set(String(a[0]), { window_start: Number(a[1]), count: 1 });
      return null;
    }
    if (sql.startsWith("insert or ignore into rate_limits")) {
      if (!this.rateLimits.has(String(a[0]))) {
        this.rateLimits.set(String(a[0]), { window_start: Number(a[1]), count: 1 });
      }
      return null;
    }
    if (sql.startsWith("update rate_limits set count = count + 1")) {
      // 守卫：窗口内且没到上限才 +1。
      const row = this.rateLimits.get(String(a[0]));
      if (row && row.window_start > Number(a[1]) && row.count < Number(a[2])) row.count += 1;
      return null;
    }
    if (sql.startsWith("update rate_limits set window_start")) {
      // 守卫：窗口已过期才重置。
      const row = this.rateLimits.get(String(a[1]));
      if (row && row.window_start <= Number(a[2])) {
        row.window_start = Number(a[0]);
        row.count = 1;
      }
      return null;
    }

    if (sql.startsWith("select * from devices where id")) {
      return this.tables.devices.find((d) => d.id === a[0]) ?? null;
    }
    if (sql.startsWith("update devices set last_seen_at")) {
      const device = this.tables.devices.find((d) => d.id === a[2]);
      if (device) {
        device.last_seen_at = a[0];
        device.app_version = a[1];
      }
      return null;
    }
    if (sql.startsWith("update devices set account_id")) {
      const device = this.tables.devices.find((d) => d.id === a[1]);
      if (device) device.account_id = a[0];
      return null;
    }
    if (sql.startsWith("insert or ignore into accounts")) {
      if (this.tables.accounts.some((row) => row.email === a[1])) return null;
      this.tables.accounts.push({
        id: a[0],
        kind: "email",
        email: a[1],
        status: "active",
        merged_into: null,
        created_at: a[2],
        balance_cents: 0,
      });
      return null;
    }
    if (sql.startsWith("insert into accounts")) {
      const withEmail = sql.includes("(id, kind, email");
      this.tables.accounts.push({
        id: a[0],
        kind: withEmail ? "email" : "device",
        email: withEmail ? a[1] : null,
        status: "active",
        merged_into: null,
        created_at: withEmail ? a[2] : a[1],
        balance_cents: 0,
      });
      return null;
    }
    if (sql.startsWith("insert into devices")) {
      this.tables.devices.push({
        id: a[0],
        account_id: a[1],
        secret_hash: a[2],
        platform: a[3],
        app_version: a[4],
        refresh_family: a[5],
        created_at: a[6],
        last_seen_at: a[7],
        revoked_at: null,
      });
      return null;
    }
    if (sql.startsWith("insert into audit_log")) {
      // action 是语句里的字面量，不是绑定参数：从 SQL 里取，不能按下标猜。
      const literal = /'([a-z_.]+)'/.exec(sql)?.[1];
      const withServer = sql.includes("server_id");
      this.tables.audit_log.push({
        at: a[0],
        account_id: a[1],
        ...(withServer ? { server_id: a[2] } : {}),
        action: literal ?? a[withServer ? 3 : 2],
        detail: a[a.length - 1],
      });
      return null;
    }

    if (sql.startsWith("insert into refresh_tokens")) {
      this.tables.refresh_tokens.push({
        hash: a[0],
        device_id: a[1],
        expires_at: a[2],
        created_at: a[3],
        used_at: null,
        revoked_at: null,
      });
      return null;
    }
    if (sql.startsWith("select * from refresh_tokens where hash")) {
      return this.tables.refresh_tokens.find((r) => r.hash === a[0]) ?? null;
    }
    if (sql.startsWith("update refresh_tokens set used_at")) {
      // 行为跟着 SQL 里的守卫走：没有 `used_at IS NULL` 的老写法就是无条件覆盖。
      const guarded = sql.includes("used_at is null");
      const row = this.tables.refresh_tokens.find((r) => r.hash === a[1]);
      if (row && (!guarded || (row.used_at == null && row.revoked_at == null))) {
        row.used_at = a[0];
      }
      return null;
    }
    if (sql.startsWith("update refresh_tokens set revoked_at")) {
      for (const row of this.tables.refresh_tokens) {
        if (row.device_id === a[1] && row.revoked_at === null) row.revoked_at = a[0];
      }
      return null;
    }

    if (sql.startsWith("select status, kind, merged_into from accounts")) {
      const account = this.tables.accounts.find((x) => x.id === a[0]);
      return account ? { status: account.status, kind: account.kind, merged_into: account.merged_into } : null;
    }
    if (sql.startsWith("select kind, email from accounts")) {
      const account = this.tables.accounts.find((x) => x.id === a[0]);
      return account ? { kind: account.kind, email: account.email } : null;
    }
    if (sql.startsWith("select email from accounts")) {
      const account = this.tables.accounts.find((x) => x.id === a[0]);
      return account ? { email: account.email } : null;
    }
    if (sql.startsWith("select id, kind from accounts where email")) {
      const account = this.tables.accounts.find((x) => x.email === a[0]);
      return account ? { id: account.id, kind: account.kind } : null;
    }
    if (sql.startsWith("select status from accounts")) {
      const account = this.tables.accounts.find((x) => x.id === a[0]);
      return account ? { status: account.status } : null;
    }
    if (sql.startsWith("update accounts set merged_into")) {
      const account = this.tables.accounts.find((x) => x.id === a[1]);
      if (account) {
        account.merged_into = a[0];
        account.status = "disabled";
      }
      return null;
    }

    if (sql.startsWith("select created_at from email_codes")) {
      const row = this.tables.email_codes.find((x) => x.email === a[0]);
      return row ? { created_at: row.created_at } : null;
    }
    if (sql.startsWith("select code_hash, expires_at, attempts from email_codes")) {
      const row = this.tables.email_codes.find((x) => x.email === a[0]);
      return row ? { code_hash: row.code_hash, expires_at: row.expires_at, attempts: row.attempts } : null;
    }
    if (sql.startsWith("insert into email_codes")) {
      const record = {
        email: a[0],
        code_hash: a[1],
        expires_at: a[2],
        attempts: 0,
        created_at: a[3],
        last_ip: a[4],
      };
      const index = this.tables.email_codes.findIndex((x) => x.email === a[0]);
      if (index >= 0) this.tables.email_codes[index] = record;
      else this.tables.email_codes.push(record);
      return null;
    }
    if (sql.startsWith("update email_codes set attempts")) {
      // 带守卫的计数：只加到上限为止；老写法（无守卫）仍然兼容。
      const row = this.tables.email_codes.find((x) => x.email === a[0]);
      if (row) {
        if (a.length === 1) row.attempts = Number(row.attempts) + 1;
        else if (Number(row.attempts) < Number(a[1]) && Number(row.expires_at) > Number(a[2])) {
          row.attempts = Number(row.attempts) + 1;
        }
      }
      return null;
    }
    if (sql.startsWith("select attempts from email_codes")) {
      const row = this.tables.email_codes.find((x) => x.email === a[0]);
      return row ? { attempts: row.attempts } : null;
    }
    if (sql.startsWith("delete from email_codes")) {
      const [email, hash, expiresAt, attempts] = a;
      // 带 code_hash 守卫的 DELETE 才是「消费验证码」；否则按邮箱全清。
      const guarded = sql.includes("code_hash = ?");
      this.tables.email_codes = this.tables.email_codes.filter((row) => {
        if (row.email !== email) return true;
        if (!guarded) return false;
        const matches =
          row.code_hash === hash &&
          Number(row.expires_at) > Number(expiresAt) &&
          Number(row.attempts) < Number(attempts);
        return !matches;
      });
      return null;
    }

    if (sql.startsWith("select request_hash, status, response")) {
      const row = this.tables.idempotency_keys.find(
        (r) => r.account_id === a[0] && r.endpoint === a[1] && r.key === a[2],
      );
      return row ? { ...row } : null;
    }
    if (sql.startsWith("insert or ignore into idempotency_keys")) {
      const exists = this.tables.idempotency_keys.some(
        (r) => r.account_id === a[0] && r.endpoint === a[1] && r.key === a[2],
      );
      if (!exists) {
        this.tables.idempotency_keys.push({
          account_id: a[0],
          endpoint: a[1],
          key: a[2],
          request_hash: a[3],
          status: 0,
          response: null,
          created_at: a[4],
        });
      }
      return null;
    }
    if (sql.startsWith("update idempotency_keys set created_at")) {
      const row = this.tables.idempotency_keys.find(
        (r) =>
          r.account_id === a[1] &&
          r.endpoint === a[2] &&
          r.key === a[3] &&
          r.status === 0 &&
          r.created_at === a[4],
      );
      if (row) row.created_at = a[0];
      return null;
    }
    if (sql.startsWith("insert into idempotency_keys")) {
      this.tables.idempotency_keys.push({
        account_id: a[0],
        endpoint: a[1],
        key: a[2],
        request_hash: a[3],
        status: 0,
        response: null,
        created_at: a[4],
      });
      return null;
    }
    if (sql.startsWith("update idempotency_keys set status")) {
      const row = this.tables.idempotency_keys.find(
        (r) => r.account_id === a[2] && r.endpoint === a[3] && r.key === a[4],
      );
      if (row) {
        row.status = a[0];
        row.response = a[1];
      }
      return null;
    }
    if (sql.startsWith("delete from idempotency_keys")) {
      this.tables.idempotency_keys = this.tables.idempotency_keys.filter(
        (r) => !(r.account_id === a[0] && r.endpoint === a[1] && r.key === a[2]),
      );
      return null;
    }

    if (sql.startsWith("select * from orders where id = ? and account_id")) {
      return this.tables.orders.find((o) => o.id === a[0] && o.account_id === a[1]) ?? null;
    }
    if (sql.startsWith("select state from orders where id")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      return row ? { state: row.state } : null;
    }
    if (sql.startsWith("select * from orders where id")) {
      return this.tables.orders.find((o) => o.id === a[0]) ?? null;
    }
    if (sql.startsWith("select id, amount_cents, paid_via from orders")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      return row
        ? { id: row.id, amount_cents: row.amount_cents, paid_via: row.paid_via ?? null }
        : null;
    }
    if (sql.startsWith("select id, account_id, amount_usd from orders")) {
      const row = this.tables.orders.find((o) =>
        sql.includes("checkout_session_id") ? o.checkout_session_id === a[0] : o.id === a[0],
      );
      return row ? { id: row.id, account_id: row.account_id, amount_usd: row.amount_usd } : null;
    }
    if (sql.startsWith("select id from orders where state = 'paid'")) {
      return null;
    }
    if (sql.startsWith("insert into orders")) {
      this.tables.orders.push({
        id: a[0],
        account_id: a[1],
        region: a[2],
        plan: a[3],
        amount_usd: a[4],
        amount_cents: a[5],
        hourly_usd: a[6],
        state: "pending_payment",
        idempotency_key: a[7],
        created_at: a[8],
        expires_at: a[9],
        paid_at: null,
        server_id: null,
        failure_code: null,
        failure_stage: null,
        checkout_session_id: null,
        checkout_url: null,
        paid_via: null,
      });
      return null;
    }
    if (sql.startsWith("update orders set account_id")) {
      for (const row of this.tables.orders) if (row.account_id === a[1]) row.account_id = a[0];
      return null;
    }
    if (sql.startsWith("update orders set state = 'cancelled'")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      if (row) row.state = "cancelled";
      return null;
    }
    if (sql.startsWith("update orders set state = 'awaiting_payment'")) {
      const row = this.tables.orders.find((o) => o.id === a[3]);
      if (row) {
        row.state = "awaiting_payment";
        row.checkout_session_id = a[0];
        row.checkout_url = a[1];
        row.paid_via = "dodo";
        row.expires_at = a[2];
      }
      return null;
    }
    if (sql.startsWith("update orders set state = 'payment_failed'")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      if (row && row.state === "awaiting_payment") row.state = "payment_failed";
      return null;
    }
    if (sql.startsWith("update orders set state = 'provisioning'")) {
      // 认领语句带「账本行存在」守卫：扣费没写成时订单不能进入 provisioning。
      if (sql.includes("exists (select 1 from wallet_ledger where id = ?)")) {
        const ledgerId = a[a.length - 1];
        if (!this.tables.wallet_ledger.some((entry) => entry.id === ledgerId)) return null;
      }
      const hasPendingGuard = sql.includes("and state = 'pending_payment'");
      const row = hasPendingGuard
        ? this.tables.orders.find((o) => o.id === a[2])
        : this.tables.orders.find((o) => o.id === a[0]);
      if (row) {
        row.state = "provisioning";
        if (hasPendingGuard) {
          row.paid_at = a[0];
          row.server_id = a[1];
          // 钱包结账的认领语句带 paid_via = 'wallet'，退款链路靠它判断钱从哪来。
          row.paid_via = "wallet";
        }
      }
      return null;
    }
    if (sql.startsWith("update orders set state = 'paid', failure_code")) {
      // 建机失败回退：已收款的订单退回 paid，等 Cron 重试。
      const row = this.tables.orders.find((o) => o.id === a[1]);
      if (row && (row.state === "paid" || row.state === "provisioning")) {
        row.state = "paid";
        row.failure_code = a[0];
        row.failure_stage = "creating";
      }
      return null;
    }
    if (sql.startsWith("update orders set state = 'paid'")) {
      const row = this.tables.orders.find((o) => o.id === a[1]);
      const allowed = ["pending_payment", "awaiting_payment", "payment_failed", "expired", "cancelled"];
      if (row && allowed.includes(String(row.state))) {
        row.state = "paid";
        row.paid_at = row.paid_at ?? a[0];
        row.paid_via = "dodo";
      }
      return null;
    }
    if (sql.startsWith("update orders set server_id")) {
      const row = this.tables.orders.find((o) => o.id === a[1]);
      if (row && row.server_id == null) row.server_id = a[0];
      return null;
    }
    if (sql.startsWith("update orders set state = 'ready'")) {
      const row = this.tables.orders.find((o) => o.id === a[0] && o.state === "provisioning");
      if (row) row.state = "ready";
      return null;
    }
    if (sql.startsWith("update orders set state = 'failed'")) {
      const row = this.tables.orders.find((o) => o.id === a[2]);
      if (row) {
        row.state = "failed";
        row.failure_code = a[0];
        row.failure_stage = a[1];
      }
      return null;
    }

    if (sql.startsWith("select coalesce(sum(daily_price_cents), 0) as total from servers")) {
      const total = this.tables.servers
        .filter((server) => server.account_id === a[0] && server.destroyed_at == null)
        .reduce((sum, server) => sum + Number(server.daily_price_cents ?? 0), 0);
      return { total };
    }
    if (sql.startsWith("select * from servers where enrollment_hash")) {
      return this.tables.servers.find((s) => s.enrollment_hash === a[0]) ?? null;
    }
    if (sql.startsWith("select id, account_id, order_id, region, plan, node_port from servers")) {
      const row = this.tables.servers.find((s) => s.order_id === a[0]);
      return row
        ? {
            id: row.id,
            account_id: row.account_id,
            order_id: row.order_id,
            region: row.region,
            plan: row.plan,
            node_port: row.node_port,
          }
        : null;
    }
    if (sql.startsWith("insert or ignore into servers")) {
      if (this.tables.servers.some((s) => s.order_id === a[2])) return null;
      this.tables.servers.push({
        id: a[0],
        account_id: a[1],
        order_id: a[2],
        provider: "digitalocean",
        provider_id: null,
        name: a[3],
        region: a[4],
        plan: a[5],
        hourly_usd: a[6],
        monthly_usd: a[7],
        state: "creating",
        node_port: a[8],
        ip: null,
        node_id: null,
        enrollment_hash: null,
        enrollment_expires_at: null,
        enrollment_used_at: null,
        firewall_id: null,
        created_at: a[9],
        updated_at: a[10],
        paid_until: a[11] ?? 0,
        billing_state: "active",
        daily_price_cents: a[12] ?? 0,
        billing_anchor_at: a[13] ?? a[9] ?? 0,
        transfer_gib: a[14] ?? 0,
        destroyed_at: null,
      });
      return null;
    }
    if (sql.startsWith("insert into servers")) {
      // 建机语句带「账本行存在」守卫：扣费没写成时不该多出一台机器。
      if (sql.includes("where exists (select 1 from wallet_ledger where id = ?)")) {
        const ledgerId = a[a.length - 1];
        if (!this.tables.wallet_ledger.some((entry) => entry.id === ledgerId)) return null;
      }
      this.tables.servers.push({
        id: a[0],
        account_id: a[1],
        order_id: a[2],
        provider: "digitalocean",
        provider_id: null,
        name: a[3],
        region: a[4],
        plan: a[5],
        hourly_usd: a[6],
        monthly_usd: a[7],
        state: "creating",
        node_port: a[8],
        ip: null,
        node_id: null,
        enrollment_hash: null,
        enrollment_expires_at: null,
        enrollment_used_at: null,
        firewall_id: null,
        created_at: a[9],
        updated_at: a[10],
        paid_until: a[11] ?? 0,
        billing_state: "active",
        daily_price_cents: a[12] ?? 0,
        billing_anchor_at: a[13] ?? a[9] ?? 0,
        transfer_gib: a[14] ?? 0,
        destroyed_at: null,
      });
      return null;
    }

    if (sql.startsWith("update servers set provider_id")) {
      const server = this.tables.servers.find((s) => s.id === a[5]);
      if (server) {
        server.provider_id = a[0];
        server.ip = a[1];
        server.state = "booting";
        server.enrollment_hash = a[2];
        server.enrollment_expires_at = a[3];
        server.updated_at = a[4];
      }
      return null;
    }
    if (sql.startsWith("update servers set state = 'error'")) {
      // bind(reason, now, id)：失败原因现在也落到 servers 行上。
      const server = this.tables.servers.find((s) => s.id === a[2]);
      if (server) {
        server.state = "error";
        server.failure_code = a[0];
      }
      return null;
    }
    if (sql.startsWith("update servers set failure_code")) {
      const server = this.tables.servers.find((s) => s.id === a[1]);
      if (server) server.failure_code = a[0];
      return null;
    }
    if (sql.startsWith("select * from servers where id")) {
      return this.tables.servers.find((s) => s.id === a[0] && s.account_id === a[1]) ?? null;
    }
    if (sql.startsWith("update servers set name")) {
      const guarded = sql.includes("destroyed_at is null");
      const server = this.tables.servers.find(
        (s) => s.id === a[2] && s.account_id === a[3],
      );
      if (
        server &&
        (!guarded ||
          (server.destroyed_at == null &&
            server.state !== "destroying" &&
            server.state !== "destroyed"))
      ) {
        server.name = a[0];
        server.updated_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("update servers set enrollment_used_at")) {
      // 原子消费：只有哈希对得上、还没用过的那一次能成功。
      const server = this.tables.servers.find((s) => s.id === a[2]);
      if (server && server.enrollment_hash === a[3] && server.enrollment_used_at == null) {
        server.enrollment_used_at = a[0];
        server.updated_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("insert into credentials")) {
      const serverId = a[0];
      const existing = this.tables.credentials.find((c) => c.server_id === serverId);
      const record = {
        server_id: serverId,
        key_version: a[1],
        iv: a[2],
        ciphertext: a[3],
        created_at: a[4],
        destroyed_at: null,
      };
      if (existing) Object.assign(existing, record);
      else this.tables.credentials.push(record);
      return null;
    }
    if (
      sql.startsWith("update servers set state = ?, installing_at") ||
      sql.startsWith("update servers set state = ?, verifying_at")
    ) {
      const column = sql.includes("verifying_at") ? "verifying_at" : "installing_at";
      const [state, at, updatedAt, id, from] = a;
      const server = this.tables.servers.find((s) => s.id === id);
      if (server && server.destroyed_at == null && server.state === from) {
        server.state = state;
        if (server[column] == null) server[column] = at;
        server.updated_at = updatedAt;
      }
      return null;
    }
    if (sql.startsWith("update servers set failure_stage")) {
      const server = this.tables.servers.find((s) => s.id === a[1]);
      if (server) server.failure_stage = a[0];
      return null;
    }
    if (sql.startsWith("update servers set state = 'active'")) {
      // 行为跟着 SQL 里的守卫走：带 `state IN (...)` 时只允许从这些阶段前进到 active。
      const guarded = sql.includes("state in ('booting', 'installing', 'verifying')");
      const allowed = ["booting", "installing", "verifying"];
      const server = this.tables.servers.find((s) => s.id === a[5]);
      if (
        server &&
        (!guarded ||
          (allowed.includes(String(server.state)) && server.destroyed_at == null))
      ) {
        server.state = "active";
        server.node_id = a[0];
        server.firewall_id = a[1];
        server.singbox_version = a[2];
        server.ready_at = a[3];
        server.updated_at = a[4];
      }
      return null;
    }
    if (sql.startsWith("update servers set state = 'destroying'")) {
      const server = this.tables.servers.find((s) => s.id === a[1]);
      if (server) {
        server.state = "destroying";
        server.updated_at = a[0];
      }
      return null;
    }
    if (sql.startsWith("update servers set state = 'destroyed'")) {
      const server = this.tables.servers.find((s) => s.id === a[4]);
      if (server) {
        server.state = "destroyed";
        server.destroyed_at = a[0];
        server.updated_at = a[1];
        server.failure_code = a[2] ?? null;
        // COALESCE(?, failure_stage)：没给阶段时保留原值。
        if (a[3] != null) server.failure_stage = a[3];
      }
      return null;
    }
    if (sql.startsWith("update servers set state = ?, updated_at")) {
      const server = this.tables.servers.find((s) => s.id === a[2]);
      if (server) {
        server.state = a[0];
        server.updated_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("update servers set account_id")) {
      for (const server of this.tables.servers) if (server.account_id === a[1]) server.account_id = a[0];
      return null;
    }
    if (sql.startsWith("update credentials set destroyed_at")) {
      for (const credential of this.tables.credentials) {
        if (credential.server_id === a[1]) credential.destroyed_at = a[0];
      }
      return null;
    }

    if (sql.startsWith("insert or ignore into payments")) {
      if (this.tables.payments.some((p) => p.id === a[0])) return null;
      this.tables.payments.push({
        id: a[0],
        order_id: a[1],
        subscription_id: a[2],
        account_id: a[3],
        amount_usd: a[4],
        currency: a[5],
        status: a[6],
        period_end: a[7],
        raw_digest: a[8],
        received_at: a[9],
      });
      return null;
    }
    if (sql.startsWith("insert or ignore into unmatched_payments")) {
      if (this.tables.unmatched_payments.some((p) => p.payment_id === a[0])) return null;
      this.tables.unmatched_payments.push({
        payment_id: a[0],
        email_hash: a[1],
        amount_usd: a[2],
        currency: a[3],
        reason: a[4],
        payload_hash: a[5],
        received_at: a[6],
        replayed_at: null,
      });
      return null;
    }
    if (sql.startsWith("insert into webhook_events")) {
      if (this.tables.webhook_events.some((e) => e.id === a[0])) return null;
      this.tables.webhook_events.push({
        id: a[0],
        kind: a[1],
        received_at: a[2],
        processed_at: null,
        order_id: null,
        payment_id: null,
        status: "received",
      });
      return null;
    }
    if (sql.startsWith("select status from webhook_events")) {
      const row = this.tables.webhook_events.find((e) => e.id === a[0]);
      return row ? { status: row.status } : null;
    }
    if (sql.startsWith("update webhook_events set status")) {
      const row = this.tables.webhook_events.find((e) => e.id === a[4]);
      if (row) {
        row.status = a[0];
        row.processed_at = a[1];
        row.order_id = a[2];
        row.payment_id = a[3];
      }
      return null;
    }

    if (sql.startsWith("select account_id from orders")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      return row ? { account_id: row.account_id } : null;
    }
    if (sql.startsWith("insert into subscriptions")) {
      const record = {
        id: a[0],
        account_id: a[1],
        order_id: a[2],
        server_id: a[3],
        product_id: a[4],
        status: a[5],
        current_period_end: a[6],
        cancel_at_period_end: a[7],
        created_at: a[8],
        updated_at: a[9],
        last_event_at: a[10],
        last_event_id: a[11],
      };
      const existing = this.tables.subscriptions.find((row) => row.id === a[0]);
      if (existing) {
        existing.status = a[5];
        existing.current_period_end = a[6] ?? existing.current_period_end;
        existing.cancel_at_period_end = a[7];
        existing.server_id = a[3] ?? existing.server_id;
        existing.updated_at = a[9];
        existing.last_event_at = a[10];
        existing.last_event_id = a[11];
      } else {
        this.tables.subscriptions.push(record);
      }
      return null;
    }
    if (sql.startsWith("select last_event_at, last_event_id from subscriptions")) {
      const row = this.tables.subscriptions.find((item) => item.id === a[0]);
      return row ? { last_event_at: row.last_event_at, last_event_id: row.last_event_id } : null;
    }
    if (sql.startsWith("update orders set subscription_id")) {
      const row = this.tables.orders.find((o) => o.id === a[1]);
      if (row && row.subscription_id == null) row.subscription_id = a[0];
      return null;
    }
    if (sql.startsWith("update servers set paid_until") && sql.includes("where order_id")) {
      for (const server of this.tables.servers) {
        if (server.order_id === a[1]) {
          const current = Number(server.paid_until ?? 0);
          server.paid_until = Math.max(current, Number(a[0]));
        }
      }
      return null;
    }


    if (sql.startsWith("insert or ignore into wallet_ledger")) {
      const [id, accountId, balanceAfter, refId, createdAt] = a;
      if (this.tables.wallet_ledger.some((w) => w.ref_type === "snapshot" && w.ref_id === refId)) {
        return null;
      }
      this.tables.wallet_ledger.push({
        id,
        account_id: accountId,
        kind: "snapshot",
        amount_cents: 0,
        balance_after_cents: Number(balanceAfter),
        ref_type: "snapshot",
        ref_id: refId,
        note: null,
        created_at: Number(createdAt),
      });
      return null;
    }
    if (sql.startsWith("select balance_after_cents from wallet_ledger where account_id")) {
      const rows = this.tables.wallet_ledger
        .filter((w) => w.account_id === a[0] && Number(w.created_at) <= Number(a[1]))
        .sort((x, y) => Number(x.created_at) - Number(y.created_at));
      const latest = rows.at(-1);
      return latest ? { balance_after_cents: latest.balance_after_cents } : null;
    }
    if (sql.startsWith("select id from wallet_ledger where ref_type = 'snapshot'")) {
      const row = this.tables.wallet_ledger.find(
        (w) => w.ref_type === "snapshot" && w.ref_id === a[0],
      );
      return row ? { id: row.id } : null;
    }
    if (sql.startsWith("delete from wallet_ledger where id in")) {
      const [accountId, cutoff, limit] = a;
      const victims = this.tables.wallet_ledger
        .filter(
          (w) =>
            w.account_id === accountId &&
            w.ref_type === "server_day" &&
            Number(w.created_at) <= Number(cutoff),
        )
        .slice(0, Number(limit));
      const ids = new Set(victims.map((w) => w.id));
      this.tables.wallet_ledger = this.tables.wallet_ledger.filter((w) => !ids.has(w.id));
      return null;
    }
    if (sql.startsWith("insert into wallet_ledger") && sql.includes("'server_refund'")) {
      const [ledgerId, amount, , refId, note, now, accountId] = a;
      if (this.tables.wallet_ledger.some((w) => w.ref_type === "server_refund" && w.ref_id === refId)) {
        return null;
      }
      const account = this.tables.accounts.find((row) => row.id === accountId);
      if (!account) return null;
      const balance = Number(account.balance_cents ?? 0);
      this.tables.wallet_ledger.push({
        id: ledgerId,
        account_id: accountId,
        kind: "adjustment",
        amount_cents: Number(amount),
        balance_after_cents: balance + Number(amount),
        ref_type: "server_refund",
        ref_id: refId,
        note,
        created_at: now,
      });
      return null;
    }
    if (sql.startsWith("insert into wallet_ledger")) {
      this.beforeWalletInsert?.();
      if (
        sql.includes("from servers where id = ? and destroyed_at is null and state not in") &&
        sql.includes("'destroying', 'destroyed'")
      ) {
        const server = this.tables.servers.find((row) => row.id === a[a.length - 1]);
        if (
          !server ||
          server.destroyed_at != null ||
          server.state === "destroying" ||
          server.state === "destroyed"
        ) {
          return null;
        }
      }
      const isDebit = sql.includes("a.balance_cents >= ?");
      // 建机门槛（§4.13）：门槛与扣减同一条 INSERT；守卫不成立时零行，和余额不足同路径。
      if (sql.includes("exists (select 1 from accounts where id = ? and balance_cents >= ?)")) {
        const guardAccountId = a[a.length - 2];
        const guardFloor = a[a.length - 1];
        const guarded = this.tables.accounts.find((row) => row.id === guardAccountId);
        if (!guarded || Number(guarded.balance_cents ?? 0) < Number(guardFloor)) return null;
      }
      const [ledgerId, kind, amount, magnitude, refType, refId, note, now, accountId] = a;
      const account = this.tables.accounts.find((row) => row.id === accountId);
      if (!account) return null;
      const balance = Number(account.balance_cents ?? 0);
      if (isDebit && balance < Number(magnitude)) return null;
      if (this.tables.wallet_ledger.some((w) => w.ref_type === refType && w.ref_id === refId)) return null;
      this.tables.wallet_ledger.push({
        id: ledgerId,
        account_id: accountId,
        kind,
        amount_cents: Number(amount),
        balance_after_cents: isDebit ? balance - Number(magnitude) : balance + Number(magnitude),
        ref_type: refType,
        ref_id: refId,
        note,
        created_at: now,
      });
      return null;
    }
    if (sql.startsWith("update accounts set balance_cents = balance_cents + ?")) {
      const account = this.tables.accounts.find((row) => row.id === a[1]);
      if (account && this.tables.wallet_ledger.some((w) => w.id === a[2])) {
        account.balance_cents = Number(account.balance_cents ?? 0) + Number(a[0]);
      }
      return null;
    }
    if (sql.startsWith("select balance_after_cents from wallet_ledger")) {
      const row = this.tables.wallet_ledger.find((w) => w.id === a[0]);
      return row ? { balance_after_cents: row.balance_after_cents } : null;
    }
    if (sql.startsWith("select id from wallet_ledger where ref_type")) {
      const row = this.tables.wallet_ledger.find((w) => w.ref_type === a[0] && w.ref_id === a[1]);
      return row ? { id: row.id } : null;
    }
    if (sql.startsWith("select id from accounts where id")) {
      const row = this.tables.accounts.find((account) => account.id === a[0]);
      return row ? { id: row.id } : null;
    }
    if (sql.startsWith("select balance_cents from accounts")) {
      const row = this.tables.accounts.find((x) => x.id === a[0]);
      return row ? { balance_cents: row.balance_cents } : null;
    }
    if (sql.startsWith("insert into topups")) {
      // 建单只带面额与 product_id，收银台会话随后 UPDATE 补上。
      this.tables.topups.push({
        id: a[0],
        account_id: a[1],
        denomination_cents: a[2],
        product_id: a[3],
        checkout_session_id: null,
        checkout_url: null,
        status: "pending",
        created_at: a[4],
        paid_at: null,
      });
      return null;
    }
    if (sql.startsWith("update topups set checkout_session_id")) {
      const row = this.tables.topups.find((t) => t.id === a[2]);
      if (row) {
        row.checkout_session_id = a[0];
        row.checkout_url = a[1];
      }
      return null;
    }
    if (sql.startsWith("update topups set status = ?")) {
      const row = this.tables.topups.find((t) => t.id === a[2]);
      if (row) {
        row.status = a[0];
        row.paid_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("update topups set status = 'failed'")) {
      const row = this.tables.topups.find((t) => t.id === a[0] && t.status === "pending");
      if (row) row.status = "failed";
      return null;
    }
    if (sql.startsWith("select id, account_id, denomination_cents from topups")) {
      const row = sql.includes("checkout_session_id")
        ? this.tables.topups.find((t) => t.checkout_session_id === a[0])
        : this.tables.topups.find((t) => t.id === a[0]);
      return row
        ? { id: row.id, account_id: row.account_id, denomination_cents: row.denomination_cents }
        : null;
    }
    if (sql.startsWith("update topups set status")) {
      const row = this.tables.topups.find((t) => t.id === a[1]);
      if (row && row.status !== "paid") {
        row.status = "paid";
        row.paid_at = a[0];
      }
      return null;
    }
    if (sql.startsWith("update servers set paid_until = ?, updated_at") && sql.includes("billing_state = 'expired'")) {
      const row = this.tables.servers.find((server) => server.id === a[2]);
      if (row && row.billing_state === "expired") row.paid_until = a[0];
      return null;
    }
    if (sql.startsWith("update servers set paid_until = ?, updated_at")) {
      const row = this.tables.servers.find((server) => server.id === a[2]);
      if (
        row &&
        Number(row.paid_until ?? 0) === Number(a[3]) &&
        this.tables.wallet_ledger.some((w) => w.id === a[4])
      ) {
        row.paid_until = a[0];
        row.updated_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("update servers set paid_until = max")) {
      const row = this.tables.servers.find((server) => server.id === a[2]);
      if (row && Number(row.paid_until ?? 0) === Number(a[3])) {
        row.paid_until = Math.max(Number(row.paid_until ?? 0), Number(a[0]));
        row.updated_at = a[1];
      }
      return null;
    }
    if (sql.startsWith("update servers set billing_state")) {
      const row = this.tables.servers.find((server) => server.id === a[2]);
      if (row) {
        row.billing_state = a[0];
        row.updated_at = a[1];
      }
      return null;
    }

    throw new Error(`FakeD1 未覆盖的语句：${statement.sql}`);
  }

  execAll(statement: Stmt): Row[] {
    const sql = normalise(statement.sql);
    const a = statement.args;
    if (sql.startsWith("select o.id as order_id, o.account_id, o.amount_cents, s.id as server_id")) {
      return this.tables.orders
        .filter((order) => order.state === "failed" && order.paid_via === "wallet")
        .flatMap((order) => {
          const server = this.tables.servers.find((row) => row.order_id === order.id);
          // 只扫 error：已销毁的机器走销毁退款，口径不同。
          if (!server || server.state !== "error") return [];
          const charged = this.tables.wallet_ledger.some(
            (entry) =>
              entry.ref_type === "order" && entry.ref_id === order.id && entry.kind === "charge",
          );
          const refunded = this.tables.wallet_ledger.some(
            (entry) => entry.ref_type === "server_refund" && entry.ref_id === server.id,
          );
          if (!charged || refunded) return [];
          const audits = this.tables.audit_log.filter((row) => row.server_id === server.id);
          const failures = audits.filter((row) => row.action === "provision.refund_failed").length;
          const abandonedAt = audits
            .filter((row) => row.action === "provision.refund_abandoned")
            .reduce((latest, row) => Math.max(latest, Number(row.at ?? 0)), 0);
          return [
            {
              order_id: order.id,
              account_id: order.account_id,
              amount_cents: order.amount_cents,
              server_id: server.id,
              failure_code: server.failure_code ?? null,
              created_at: Number(order.created_at ?? 0),
              failures,
              abandoned_at: abandonedAt > 0 ? abandonedAt : null,
            },
          ];
        })
        .sort((left, right) => Number(left.created_at) - Number(right.created_at))
        .slice(0, 50);
    }
    if (
      sql.startsWith("select * from servers where state ") &&
      sql.includes("enrollment_expires_at is not null")
    ) {
      // 过期仍停在 booting：按 (enrollment_expires_at, id) 游标升序分页。
      // 不看 enrollment_used_at：已回传但在 activate 前停住的同样要清。
      const [now, cursorExpires, , cursorId, limit] = a;
      // 行为跟着 SQL 走：只有查询里写了三态才扫 installing / verifying。
      const states = sql.includes("state in ('booting', 'installing', 'verifying')")
        ? ["booting", "installing", "verifying"]
        : ["booting"];
      return this.tables.servers
        .filter(
          (row) =>
            states.includes(String(row.state)) &&
            row.enrollment_expires_at != null &&
            Number(row.enrollment_expires_at) < Number(now) &&
            row.destroyed_at == null &&
            (Number(row.enrollment_expires_at) > Number(cursorExpires) ||
              (Number(row.enrollment_expires_at) === Number(cursorExpires) &&
                String(row.id) > String(cursorId))),
        )
        .sort(
          (x, y) =>
            Number(x.enrollment_expires_at) - Number(y.enrollment_expires_at) ||
            String(x.id).localeCompare(String(y.id)),
        )
        .slice(0, Number(limit));
    }
    if (
      sql.startsWith("select * from servers where account_id") &&
      sql.includes("state != 'destroyed'")
    ) {
      return this.tables.servers
        .filter((row) => row.account_id === a[0] && row.state !== "destroyed")
        .sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.startsWith("select s.id as server_id") && sql.includes("server_refund")) {
      // 钱去哪了：按账号一次聚合，扣费看 order 账本，退款看 server_refund 账本。
      return this.tables.servers
        .filter((server) => server.account_id === a[0])
        .map((server) => {
          const charged = this.tables.wallet_ledger
            .filter(
              (entry) =>
                entry.ref_type === "order" &&
                entry.ref_id === server.order_id &&
                entry.kind === "charge",
            )
            .reduce((sum, entry) => sum + Math.abs(Number(entry.amount_cents)), 0);
          const refunded = this.tables.wallet_ledger
            .filter((entry) => entry.ref_type === "server_refund" && entry.ref_id === server.id)
            .reduce((sum, entry) => sum + Number(entry.amount_cents), 0);
          return { server_id: server.id, charged_cents: charged, refunded_cents: refunded };
        });
    }
    if (sql.startsWith("select distinct account_id from wallet_ledger")) {
      const cutoff = Number(a[0]);
      const ids = [
        ...new Set(
          this.tables.wallet_ledger
            .filter((w) => w.ref_type === "server_day" && Number(w.created_at) <= cutoff)
            .map((w) => String(w.account_id)),
        ),
      ];
      return ids.slice(0, 200).map((id) => ({ account_id: id }));
    }
    if (sql.startsWith("select o.id from orders o left join servers s")) {
      return this.tables.orders
        .filter((order) => {
          if (!["paid", "provisioning"].includes(String(order.state))) return false;
          if (Number(order.created_at) >= Number(a[0])) return false;
          const server = this.tables.servers.find(
            (row) => row.order_id === order.id && row.destroyed_at == null,
          );
          return !server || server.provider_id == null || server.state === "error";
        })
        .slice(0, 5)
        .map((order) => ({ id: order.id }));
    }
    if (
      sql.startsWith(
        "select id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state from servers where account_id",
      )
    ) {
      return this.tables.servers
        .filter(
          (row) =>
            row.account_id === a[0] &&
            row.billing_state === "expired" &&
            row.destroyed_at == null &&
            row.provider_id != null,
        )
        .slice(0, 20)
        .map((row) => ({
          id: row.id,
          account_id: row.account_id,
          daily_price_cents: row.daily_price_cents ?? 0,
          billing_anchor_at: row.billing_anchor_at ?? 0,
          paid_until: row.paid_until ?? 0,
          billing_state: row.billing_state ?? "expired",
        }));
    }
    if (sql.startsWith("select id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state from servers")) {
      return this.tables.servers
        .filter((row) => {
          if (row.destroyed_at != null) return false;
          if (row.provider_id == null) return false;
          if (Number(row.paid_until ?? 0) <= 0) return false;
          if (row.billing_state === "expired") return false;
          if (!["booting", "installing", "verifying", "healthy", "active"].includes(String(row.state))) {
            return false;
          }
          if (String(row.id) <= String(a[1])) return false;
          return Number(row.paid_until ?? 0) <= Number(a[0]);
        })
        .sort((x, y) => String(x.id).localeCompare(String(y.id)))
        .slice(0, Number(a[2]))
        .map((row) => ({
          id: row.id,
          account_id: row.account_id,
          daily_price_cents: row.daily_price_cents ?? 0,
          billing_anchor_at: row.billing_anchor_at ?? 0,
          paid_until: row.paid_until ?? 0,
          billing_state: row.billing_state ?? "active",
        }));
    }
    if (sql.startsWith("select a.id as account_id")) {
      return this.tables.accounts.map((account) => {
        const rows = this.tables.wallet_ledger
          .map((row, index) => ({ row, index }))
          .filter((entry) => entry.row.account_id === account.id)
          .sort(
            (a, b) =>
              Number(a.row.created_at ?? 0) - Number(b.row.created_at ?? 0) || a.index - b.index,
          );
        const latest = rows.at(-1)?.row;
        return {
          account_id: account.id,
          balance: Number(account.balance_cents ?? 0),
          latest: Number(latest?.balance_after_cents ?? 0),
        };
      });
    }
    if (sql.startsWith("select node_port from servers")) {
      return this.tables.servers
        .filter((s) => s.account_id === a[0] && s.destroyed_at === null)
        .map((s) => ({ node_port: s.node_port }));
    }
    if (sql.startsWith("select id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state from servers")) {
      return this.tables.servers
        .filter((row) => {
          if (row.destroyed_at != null) return false;
          if (row.provider_id == null) return false;
          if (Number(row.paid_until ?? 0) <= 0) return false;
          if (row.billing_state === "expired") return false;
          if (!["booting", "installing", "verifying", "healthy", "active"].includes(String(row.state))) {
            return false;
          }
          if (String(row.id) <= String(a[1])) return false;
          return Number(row.paid_until ?? 0) <= Number(a[0]);
        })
        .sort((x, y) => String(x.id).localeCompare(String(y.id)))
        .slice(0, Number(a[2]))
        .map((row) => ({
          id: row.id,
          account_id: row.account_id,
          daily_price_cents: row.daily_price_cents ?? 0,
          billing_anchor_at: row.billing_anchor_at ?? 0,
          paid_until: row.paid_until ?? 0,
          billing_state: row.billing_state ?? "active",
        }));
    }
    if (sql.startsWith("select a.id as account_id")) {
      return this.tables.accounts.map((account) => {
        const rows = this.tables.wallet_ledger
          .map((row, index) => ({ row, index }))
          .filter((entry) => entry.row.account_id === account.id)
          .sort(
            (a, b) =>
              Number(a.row.created_at ?? 0) - Number(b.row.created_at ?? 0) || a.index - b.index,
          );
        const latest = rows.at(-1)?.row;
        return {
          account_id: account.id,
          balance: Number(account.balance_cents ?? 0),
          latest: Number(latest?.balance_after_cents ?? 0),
        };
      });
    }
    if (sql.startsWith("select id from orders where state = 'paid'")) {
      return this.tables.orders
        .filter((o) => o.state === "paid" && Number(o.created_at) < Number(a[0]))
        .map((o) => ({ id: o.id }));
    }
    return [];
  }

  rows(
    table:
      | "accounts"
      | "devices"
      | "refresh_tokens"
      | "orders"
      | "servers"
      | "credentials"
      | "audit_log"
      | "idempotency_keys"
      | "email_codes"
      | "payments"
      | "webhook_events"
      | "unmatched_payments"
      | "subscriptions"
      | "wallet_ledger"
      | "topups"
      | "catalog_cache",
  ): Row[] {
    return this.tables[table];
  }

  /** 限流窗口的只读快照，给 run() 算 `meta.changes` 用。 */
  rateLimit(key: string): { window_start: number; count: number } | undefined {
    return this.rateLimits.get(key);
  }
}

export class FakeStatement {
  constructor(
    private db: FakeD1,
    private statement: Stmt,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, { sql: this.statement.sql, args });
  }

  async first<T>(): Promise<T | null> {
    return this.db.exec(this.statement) as T | null;
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    // 结账认领带状态守卫：state 不对时 affected rows 为 0。
    // 真实 D1 靠 SQL 的 WHERE 判断，这里按同一语义给 changes。
    let changes = 1;
    const sql = this.statement.sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("update orders set state = 'provisioning'")) {
      const hasPendingGuard = sql.includes("and state = 'pending_payment'");
      const id = hasPendingGuard ? this.statement.args[2] : this.statement.args[0];
      const row = this.db.rows("orders").find((order) => order.id === id);
      const expected = hasPendingGuard ? "pending_payment" : "paid";
      changes = row && row.state === expected ? 1 : 0;
    } else if (sql.startsWith("update orders set state = 'paid', failure_code")) {
      const row = this.db.rows("orders").find((order) => order.id === this.statement.args[1]);
      changes = row && (row.state === "paid" || row.state === "provisioning") ? 1 : 0;
    } else if (sql.startsWith("update orders set state = 'paid'")) {
      const id = this.statement.args[1];
      const row = this.db.rows("orders").find((order) => order.id === id);
      const allowed = ["pending_payment", "awaiting_payment", "payment_failed", "expired", "cancelled"];
      changes = row && allowed.includes(String(row.state)) ? 1 : 0;
    } else if (sql.startsWith("update servers set enrollment_used_at")) {
      const row = this.db
        .rows("servers")
        .find((s) => s.id === this.statement.args[2]);
      changes =
        row &&
        row.enrollment_hash === this.statement.args[3] &&
        row.enrollment_used_at == null
          ? 1
          : 0;
    } else if (sql.startsWith("update servers set name")) {
      const guarded = sql.includes("destroyed_at is null");
      const server = this.db
        .rows("servers")
        .find(
          (s) =>
            s.id === this.statement.args[2] &&
            s.account_id === this.statement.args[3],
        );
      changes =
        server &&
        (!guarded ||
          (server.destroyed_at == null &&
            server.state !== "destroying" &&
            server.state !== "destroyed"))
          ? 1
          : 0;
    } else if (
      sql.startsWith("update servers set state = ?, installing_at") ||
      sql.startsWith("update servers set state = ?, verifying_at")
    ) {
      const [, , , id, from] = this.statement.args;
      const server = this.db.rows("servers").find((s) => s.id === id);
      changes =
        server && server.destroyed_at == null && server.state === from ? 1 : 0;
    } else if (sql.startsWith("update servers set state = 'active'")) {
      // 模拟 sweep 在消费 token 之后、激活之前把机器销毁。
      this.db.beforeServerActivate?.();
      const guarded = sql.includes("state in ('booting', 'installing', 'verifying')");
      const allowed = ["booting", "installing", "verifying"];
      const server = this.db
        .rows("servers")
        .find((s) => s.id === this.statement.args[5]);
      changes =
        server &&
        (!guarded || (allowed.includes(String(server.state)) && server.destroyed_at == null))
          ? 1
          : 0;
    } else if (sql.startsWith("update orders set state = 'ready'")) {
      const row = this.db
        .rows("orders")
        .find((o) => o.id === this.statement.args[0] && o.state === "provisioning");
      changes = row ? 1 : 0;
    } else if (sql.startsWith("insert into catalog_cache") && sql.includes("do update set updated_at = excluded.updated_at")) {
      const row = this.db
        .rows("catalog_cache")
        .find((entry) => entry.key === this.statement.args[0]);
      changes = !row || Number(row.updated_at) <= Number(this.statement.args[2]) ? 1 : 0;
    } else if (sql.startsWith("delete from catalog_cache")) {
      const before = this.db.rows("catalog_cache").length;
      this.db.exec(this.statement);
      return {
        success: true,
        meta: { changes: before - this.db.rows("catalog_cache").length },
      };
    } else if (sql.startsWith("update catalog_cache set payload")) {
      this.db.beforeCatalogWrite?.();
      const row = this.db
        .rows("catalog_cache")
        .find((entry) => entry.key === this.statement.args[2]);
      changes =
        row && Number(row.updated_at) === Number(this.statement.args[3]) ? 1 : 0;
    } else if (sql.startsWith("insert or ignore into rate_limits")) {
      const existed = this.db.rateLimit(String(this.statement.args[0])) !== undefined;
      this.db.exec(this.statement);
      return { success: true, meta: { changes: existed ? 0 : 1 } };
    } else if (sql.startsWith("update rate_limits set count = count + 1")) {
      const [key, cutoff, limit] = this.statement.args;
      const row = this.db.rateLimit(String(key));
      changes = row && row.window_start > Number(cutoff) && row.count < Number(limit) ? 1 : 0;
    } else if (sql.startsWith("update rate_limits set window_start")) {
      const [, key, cutoff] = this.statement.args;
      const row = this.db.rateLimit(String(key));
      changes = row && row.window_start <= Number(cutoff) ? 1 : 0;
    } else if (sql.startsWith("update refresh_tokens set used_at")) {
      // 模拟并发：读行之后、条件更新之前，另一个请求已经把这一行用掉。
      this.db.beforeRefreshUse?.();
      const guarded = sql.includes("used_at is null");
      const row = this.db
        .rows("refresh_tokens")
        .find((r) => r.hash === this.statement.args[1]);
      changes = row && (!guarded || (row.used_at == null && row.revoked_at == null)) ? 1 : 0;
    } else if (sql.startsWith("delete from email_codes")) {
      const before = this.db.rows("email_codes").length;
      this.db.exec(this.statement);
      return {
        success: true,
        meta: { changes: before - this.db.rows("email_codes").length },
      };
    } else if (sql.startsWith("update email_codes set attempts")) {
      const [email, max, expiresAt] = this.statement.args;
      const row = this.db.rows("email_codes").find((x) => x.email === email);
      changes = !row
        ? 0
        : this.statement.args.length === 1 ||
            (Number(row.attempts) < Number(max) && Number(row.expires_at) > Number(expiresAt))
          ? 1
          : 0;
    } else if (sql.startsWith("insert or ignore into")) {
      // 唯一键冲突时 SQLite 报 0 行；这里按插入前后行数判断。
      const counted = [
        "payments",
        "webhook_events",
        "unmatched_payments",
        "servers",
        "accounts",
        "idempotency_keys",
      ] as const;
      const before = counted.reduce((sum, table) => sum + this.db.rows(table).length, 0);
      this.db.exec(this.statement);
      const after = counted.reduce((sum, table) => sum + this.db.rows(table).length, 0);
      return { success: true, meta: { changes: after - before } };
    } else if (sql.startsWith("delete from wallet_ledger where id in")) {
      const [accountId, cutoff, limit] = this.statement.args;
      const count = this.db
        .rows("wallet_ledger")
        .filter(
          (w) =>
            w.account_id === accountId &&
            w.ref_type === "server_day" &&
            Number(w.created_at) <= Number(cutoff),
        )
        .slice(0, Number(limit)).length;
      this.db.exec(this.statement);
      return { success: true, meta: { changes: count } };
    } else if (sql.startsWith("update idempotency_keys set created_at")) {
      const [now, accountId, endpoint, key, createdAt] = this.statement.args;
      const row = this.db
        .rows("idempotency_keys")
        .find(
          (r) =>
            r.account_id === accountId &&
            r.endpoint === endpoint &&
            r.key === key &&
            r.status === 0 &&
            r.created_at === createdAt,
        );
      if (row) row.created_at = now;
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    this.db.exec(this.statement);
    return { success: true, meta: { changes } };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.execAll(this.statement) as T[] };
  }
}
