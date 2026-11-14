// 测试用的最小 D1 替身：只实现 auth/orders/servers 涉及的语句形态。
// 不是 SQL 引擎——遇到没覆盖的语句会抛错，避免测试悄悄走错分支。

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
  };
  private rateLimits = new Map<string, { window_start: number; count: number }>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, { sql, args: [] });
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    for (const statement of statements) await statement.run();
    return [];
  }

  exec(statement: Stmt): Row | null {
    const sql = normalise(statement.sql);
    const a = statement.args;

    if (sql.startsWith("select window_start, count from rate_limits")) {
      const row = this.rateLimits.get(String(a[0]));
      return row ? { ...row } : null;
    }
    if (sql.startsWith("insert into rate_limits")) {
      this.rateLimits.set(String(a[0]), { window_start: Number(a[1]), count: 1 });
      return null;
    }
    if (sql.startsWith("update rate_limits set count = count + 1")) {
      const row = this.rateLimits.get(String(a[0]));
      if (row) row.count += 1;
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
    if (sql.startsWith("insert into accounts")) {
      this.tables.accounts.push({
        id: a[0],
        kind: "device",
        status: "active",
        merged_into: null,
        created_at: a[1],
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
      this.tables.audit_log.push({ at: a[0], account_id: a[1], action: a[2], detail: a[3] });
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
      const row = this.tables.refresh_tokens.find((r) => r.hash === a[1]);
      if (row) row.used_at = a[0];
      return null;
    }
    if (sql.startsWith("update refresh_tokens set revoked_at")) {
      for (const row of this.tables.refresh_tokens) {
        if (row.device_id === a[1] && row.revoked_at === null) row.revoked_at = a[0];
      }
      return null;
    }

    if (sql.startsWith("select status from accounts")) {
      const account = this.tables.accounts.find((x) => x.id === a[0]);
      return account ? { status: account.status } : null;
    }

    if (sql.startsWith("select request_hash, status, response from idempotency_keys")) {
      const row = this.tables.idempotency_keys.find(
        (r) => r.account_id === a[0] && r.endpoint === a[1] && r.key === a[2],
      );
      return row ? { ...row } : null;
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

    if (sql.startsWith("select * from orders where id")) {
      return this.tables.orders.find((o) => o.id === a[0] && o.account_id === a[1]) ?? null;
    }
    if (sql.startsWith("insert into orders")) {
      this.tables.orders.push({
        id: a[0],
        account_id: a[1],
        region: a[2],
        plan: a[3],
        amount_usd: a[4],
        hourly_usd: a[5],
        state: "pending_payment",
        idempotency_key: a[6],
        created_at: a[7],
        expires_at: a[8],
        paid_at: null,
        server_id: null,
        failure_code: null,
        failure_stage: null,
      });
      return null;
    }
    if (sql.startsWith("update orders set state = 'cancelled'")) {
      const row = this.tables.orders.find((o) => o.id === a[0]);
      if (row) row.state = "cancelled";
      return null;
    }
    if (sql.startsWith("update orders set state = 'provisioning'")) {
      const row = this.tables.orders.find((o) => o.id === a[2]);
      if (row) {
        row.state = "provisioning";
        row.paid_at = a[0];
        row.server_id = a[1];
      }
      return null;
    }
    if (sql.startsWith("insert into servers")) {
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
      const server = this.tables.servers.find((s) => s.id === a[1]);
      if (server) server.state = "error";
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

    throw new Error(`FakeD1 未覆盖的语句：${statement.sql}`);
  }

  execAll(statement: Stmt): Row[] {
    const sql = normalise(statement.sql);
    const a = statement.args;
    if (sql.startsWith("select node_port from servers")) {
      return this.tables.servers
        .filter((s) => s.account_id === a[0] && s.destroyed_at === null)
        .map((s) => ({ node_port: s.node_port }));
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
      | "idempotency_keys",
  ): Row[] {
    return this.tables[table];
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

  async run(): Promise<{ success: boolean }> {
    this.db.exec(this.statement);
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.execAll(this.statement) as T[] };
  }
}
