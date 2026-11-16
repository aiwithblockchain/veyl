import { describe, expect, it } from "vitest";
import { assertSqlMatchesSchema } from "./helpers/schemaGuard";

describe("schema guard", () => {
  it("拦下漏必填列的下单语句", () => {
    expect(() =>
      assertSqlMatchesSchema(
        "insert into orders (id, account_id, region, plan, amount_usd, hourly_usd, state, idempotency_key, created_at, expires_at) values (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)",
        ["o", "a", "sgp1", "s-1vcpu-1gb", 9, 0.0125, "k", 1, 2],
      ),
    ).toThrow(/amount_cents/);
  });

  it("拦下写错列名", () => {
    expect(() =>
      assertSqlMatchesSchema("update servers set paid_until_ms = ? where id = ?", [1, "srv_1"]),
    ).toThrow(/paid_until_ms/);
  });

  it("拦下绑定数与占位符不符", () => {
    expect(() =>
      assertSqlMatchesSchema("update servers set paid_until = ? where id = ?", [1]),
    ).toThrow(/绑定数不符/);
  });

  it("放行与基线一致的写法", () => {
    expect(() =>
      assertSqlMatchesSchema(
        "insert into orders (id, account_id, region, plan, amount_usd, amount_cents, hourly_usd, state, idempotency_key, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)",
        ["o", "a", "sgp1", "s-1vcpu-1gb", 9, 900, 0.0125, "k", 1, 2],
      ),
    ).not.toThrow();
  });
});
