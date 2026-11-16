// 钱包记账：唯一原语（设计 §4.7）。
//
// 所有钱的变动都走这里：充值入账、按月扣费、人工调整。规则只有三条——
// 1) 账本只追加，余额是账本的结果；
// 2) 先写账本、再改余额，两条在同一个 D1 batch 事务里；
// 3) 同一 (ref_type, ref_id) 只会成功记一次，重跑不重复记账。

import { randomId } from "./lib/crypto";

export type LedgerKind = "topup" | "charge" | "adjustment";

export interface WalletEnv {
  DB?: D1Database;
}

export interface LedgerInput {
  accountId: string;
  kind: LedgerKind;
  /** 正数入账（充值）、负数扣费（扣月费）。 */
  amountCents: number;
  refType: "dodo_payment" | "order" | "server_period" | "manual";
  refId: string;
  note?: string;
  /** 需要和记账同批完成的后续语句（续期、订单置 paid），必须用同一个 ledgerId 守卫。 */
  followUps?: (ledgerId: string) => D1PreparedStatement[];
}

export type LedgerResult =
  | { ok: true; ledgerId: string; balanceAfterCents: number }
  | { ok: false; reason: "insufficient" | "duplicate" | "unavailable" | "missing_account" };

/**
 * 记一笔账并同步改余额。
 *
 * 扣费金额必须带余额守卫；`followUps` 里的语句在账本行不存在时自然影响 0 行，
 * 所以「钱没扣成功就不该续期」由 SQL 自身保证，不依赖调用顺序。
 */
export async function recordLedgerEntry(
  env: WalletEnv,
  input: LedgerInput,
): Promise<LedgerResult> {
  const db = env.DB;
  if (!db) return { ok: false, reason: "unavailable" };

  const ledgerId = randomId("led_");
  const now = Date.now();
  const amount = Math.round(input.amountCents);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, reason: "insufficient" };
  const magnitude = Math.abs(amount);
  const isCredit = amount > 0;

  const insert = isCredit
    ? db
        .prepare(
          "INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
            "SELECT ?, a.id, ?, ?, a.balance_cents + ?, ?, ?, ?, ? FROM accounts a " +
            "WHERE a.id = ? AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = ? AND w.ref_id = ?)",
        )
        .bind(
          ledgerId,
          input.kind,
          amount,
          magnitude,
          input.refType,
          input.refId,
          input.note ?? null,
          now,
          input.accountId,
          input.refType,
          input.refId,
        )
    : db
        .prepare(
          "INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
            "SELECT ?, a.id, ?, ?, a.balance_cents - ?, ?, ?, ?, ? FROM accounts a " +
            "WHERE a.id = ? AND a.balance_cents >= ? " +
            "AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = ? AND w.ref_id = ?)",
        )
        .bind(
          ledgerId,
          input.kind,
          amount,
          magnitude,
          input.refType,
          input.refId,
          input.note ?? null,
          now,
          input.accountId,
          magnitude,
          input.refType,
          input.refId,
        );

  const applyBalance = db
    .prepare(
      "UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
    )
    .bind(amount, input.accountId, ledgerId);

  const statements = [insert, applyBalance, ...(input.followUps?.(ledgerId) ?? [])];

  try {
    await db.batch(statements);
  } catch (error) {
    // 唯一索引在并发下仍可能先被别人写入：当作「已经记过」处理，不重复记账。
    const existing = await db
      .prepare("SELECT id FROM wallet_ledger WHERE ref_type = ? AND ref_id = ?")
      .bind(input.refType, input.refId)
      .first<{ id: string }>();
    if (existing) return { ok: false, reason: "duplicate" };
    throw error;
  }

  const written = await db
    .prepare("SELECT balance_after_cents FROM wallet_ledger WHERE id = ?")
    .bind(ledgerId)
    .first<{ balance_after_cents: number }>();
  if (!written) {
    // 账本没写成：要么已记过（同 ref），要么余额不足，要么账户根本不存在。
    const existing = await db
      .prepare("SELECT id FROM wallet_ledger WHERE ref_type = ? AND ref_id = ?")
      .bind(input.refType, input.refId)
      .first<{ id: string }>();
    if (existing) return { ok: false, reason: "duplicate" };
    const account = await db
      .prepare("SELECT id FROM accounts WHERE id = ?")
      .bind(input.accountId)
      .first<{ id: string }>();
    return { ok: false, reason: account ? "insufficient" : "missing_account" };
  }

  return { ok: true, ledgerId, balanceAfterCents: Number(written.balance_after_cents) };
}

export async function balanceCents(env: WalletEnv, accountId: string): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const row = await db
    .prepare("SELECT balance_cents FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ balance_cents: number }>();
  return Number(row?.balance_cents ?? 0);
}

/** 对账：余额必须等于账本合计。返回不一致的账户，正常应永远为空。 */
export async function reconciliationDrift(
  env: WalletEnv,
): Promise<Array<{ accountId: string; balance: number; ledgerSum: number }>> {
  const db = env.DB;
  if (!db) return [];
  const rows = await db
    .prepare(
      "SELECT a.id AS account_id, a.balance_cents AS balance, " +
        "COALESCE((SELECT SUM(w.amount_cents) FROM wallet_ledger w WHERE w.account_id = a.id), 0) AS ledger_sum " +
        "FROM accounts a",
    )
    .all<{ account_id: string; balance: number; ledger_sum: number }>();
  return (rows.results ?? [])
    .filter((row) => Number(row.balance) !== Number(row.ledger_sum))
    .map((row) => ({
      accountId: row.account_id,
      balance: Number(row.balance),
      ledgerSum: Number(row.ledger_sum),
    }));
}
