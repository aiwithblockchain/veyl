#!/usr/bin/env node
// Stripe 充值对账 / 补账（运维脚本，不跑在 Worker 里）。
//
// 默认只读 + dry-run：只查 D1，打印差异，不写任何东西。
// 显式 --apply 才补记「已支付但账本缺行」的充值，补记用 ref_type='manual'，
// ref_id='stripe-reconcile:<topup_id>'，可重复执行，不会重复加钱。
//
// 检查三组不变量（对应 stripe-launch-runbook.md §4）：
//   1) paid topup     ↔ wallet_ledger（缺失 / 多余 / 重复入账）
//   2) payments       ↔ wallet_ledger（Stripe/渠道流水必须有对应入账）
//   3) accounts.balance ↔ 该账户最新一条账本行的 balance_after
//
// 用法：
//   node scripts/stripe-reconcile.mjs                     # 生产库，只读
//   node scripts/stripe-reconcile.mjs --env dev --local   # 本地 D1
//   node scripts/stripe-reconcile.mjs --json              # 机器可读
//   node scripts/stripe-reconcile.mjs --apply             # 补记缺失的账
//   node scripts/stripe-reconcile.mjs --paid-sessions ~/stripe-paid.txt --apply
//
// --paid-sessions 接受文件路径（每行一个 cs_…，忽略空行和 # 注释）或逗号分隔列表。
// 这是「Stripe Dashboard 显示已付、本地却还是 pending」的补账入口：脚本不会连 Stripe，
// 只信操作员从 Dashboard 导出并核对过的 session id。
//
// 退出码：0 无错误；1 有错误（含可补记项）；2 脚本/环境出错。

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cpRoot = join(repoRoot, "cloudflare", "control-plane");

const USAGE = `用法：node scripts/stripe-reconcile.mjs [选项]

  --env dev|prod          选开发库或生产库（默认 prod）
  --local                 查本地 D1（不给 wrangler 传 --remote）
  --persist-to <目录>     配合 --local：读指定本地 D1 目录（演练用，不动日常状态）
  --apply                 补记缺失的账（默认只读）
  --paid-sessions <输入>  已确认在 Stripe 侧付清的 session id：
                          文件路径（每行一个）或逗号分隔列表
  --since <时间>          对账起始时间，YYYY-MM-DD 或毫秒时间戳
                          （默认取最早一条 stripe_payment 账本行）
  --limit <条数>          单个查询最多取多少行（默认 5000）
  --json                  输出 JSON
  --help                  显示本说明`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    env: "prod",
    local: false,
    persistTo: null,
    apply: false,
    json: false,
    paidSessions: null,
    since: null,
    limit: 5000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--persist-to") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--persist-to 需要一个目录\n\n${USAGE}`);
      options.persistTo = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--env 需要一个值\n\n${USAGE}`);
      if (value !== "dev" && value !== "prod") fail(`未知环境 ${value}（只支持 dev / prod）`);
      options.env = value;
      index += 1;
    } else if (arg === "--paid-sessions") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--paid-sessions 需要一个值\n\n${USAGE}`);
      options.paidSessions = value;
      index += 1;
    } else if (arg === "--since") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--since 需要一个值\n\n${USAGE}`);
      options.since = parseSince(value);
      index += 1;
    } else if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--limit 需要一个值\n\n${USAGE}`);
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit <= 0) fail(`--limit 必须是正整数`);
      options.limit = limit;
      index += 1;
    } else {
      fail(`未知参数 ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

function parseSince(value) {
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) fail(`--since 时间戳不合法：${value}`);
    return ms;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`--since 需要 YYYY-MM-DD 或毫秒时间戳：${value}`);
  return ms;
}

/** 去掉 `//` 行注释再解析 wrangler.jsonc；字符串里的 `https://` 不能误删。 */
function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += char;
  }
  return output;
}

function databaseName(env) {
  const configPath = join(cpRoot, "wrangler.jsonc");
  if (!existsSync(configPath)) fail(`找不到 ${configPath}：脚本需要在 Veyl 仓库里运行`);
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  const databases = env === "dev" ? config.env?.dev?.d1_databases : config.d1_databases;
  const binding = (databases ?? []).find((entry) => entry.binding === "DB") ?? databases?.[0];
  if (!binding?.database_name) {
    fail(`wrangler.jsonc 里找不到 ${env === "dev" ? "env.dev" : "顶层"} 的 DB 绑定`);
  }
  return binding.database_name;
}

function wranglerBinary() {
  const local = join(cpRoot, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? local : "wrangler";
}

function parseWranglerOutput(stdout) {
  const text = stdout.trim();
  const attempts = [text];
  const arrayStart = text.indexOf("[");
  if (arrayStart > 0) attempts.push(text.slice(arrayStart));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // 换下一个截取方式
    }
  }
  return null;
}

let options;
let database;

/** 执行一条 SQL：返回 { rows, changes }。changes 在 D1 没给 meta 时为 null。 */
function runSql(sql) {
  const args = ["d1", "execute", database, "--json", "--yes", "--command", sql];
  if (options.env === "dev") args.push("--env", "dev");
  if (options.local) args.push("--local");
  else args.push("--remote");
  if (options.local && options.persistTo) args.push("--persist-to", options.persistTo);
  const result = spawnSync(wranglerBinary(), args, { cwd: cpRoot, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    fail("找不到 wrangler：请在仓库根目录执行，或先在 cloudflare/control-plane 下 npm install");
  }
  if (result.error) fail(`调用 wrangler 失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || (result.stdout || "").trim();
    fail(`wrangler d1 execute 失败（退出码 ${result.status}）：\n${detail}`);
  }
  const parsed = parseWranglerOutput(result.stdout);
  if (!parsed) fail(`读不懂 wrangler 的输出：\n${result.stdout.slice(0, 500)}`);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const rows = entries.flatMap((entry) => entry?.results ?? []);
  const changes = entries.reduce((total, entry) => {
    const value = entry?.meta?.changes;
    return Number.isFinite(value) ? total + Number(value) : total;
  }, 0);
  const hasChanges = entries.some((entry) => Number.isFinite(entry?.meta?.changes));
  return { rows, changes: hasChanges ? changes : null };
}

function query(sql) {
  return runSql(sql);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${label} 不是整数：${value}`);
  return String(number);
}

const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
const iso = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : "-");

function readPaidSessions(input) {
  const candidate = resolve(process.cwd(), input);
  const lines = existsSync(candidate)
    ? readFileSync(candidate, "utf8").split(/\r?\n/)
    : input.split(",");
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line, index, all) => all.indexOf(line) === index);
}

/** 补记用的确定性 id：同一个 topup 永远只对应一行，重跑不重复。 */
const ledgerIdFor = (topupId) => `led_reconcile_${topupId}`;
const manualRefFor = (topupId) => `stripe-reconcile:${topupId}`;

function collectFindings(paidSessions) {
  const findings = [];
  const limit = options.limit;

  // A1：paid topup 没有入账（stripe_payment 或本脚本补记的 manual 行都算已入账）。
  const a1 = query(
    `SELECT t.id, t.account_id, t.denomination_cents, t.paid_at, t.checkout_session_id ` +
      `FROM topups t ` +
      `WHERE t.status = 'paid' ` +
      `AND t.checkout_session_id LIKE 'cs\\_%' ESCAPE '\\' ` +
      `AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'stripe_payment' AND w.ref_id = t.id) ` +
      `AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'manual' AND w.ref_id = 'stripe-reconcile:' || t.id) ` +
      `LIMIT ${limit + 1}`,
  ).rows;
  for (const row of a1.slice(0, limit)) {
    findings.push({
      check: "A1",
      severity: "error",
      code: "paid_topup_without_ledger",
      topupId: row.id,
      accountId: row.account_id,
      amountCents: Number(row.denomination_cents),
      message: `充值单已 paid 但没有账本行：${row.id}（${money(row.denomination_cents)}，session=${row.checkout_session_id ?? "-"}）`,
      fixable: true,
      fixKind: "missing_credit",
      topup: row,
    });
  }
  if (a1.length > limit) {
    findings.push({ check: "A1", severity: "warn", code: "truncated", message: `结果超过 ${limit} 行，已截断；用 --limit 放大` });
  }

  // A2：stripe_payment 账本行没有对应的 paid topup（多余入账或状态没跟上）。
  const a2 = query(
    `SELECT w.id AS ledger_id, w.ref_id, w.account_id, w.amount_cents, w.created_at, ` +
      `t.id AS topup_id, t.status AS topup_status, t.denomination_cents ` +
      `FROM wallet_ledger w LEFT JOIN topups t ON t.id = w.ref_id ` +
      `WHERE w.ref_type = 'stripe_payment' AND (t.id IS NULL OR t.status <> 'paid') ` +
      `LIMIT ${limit + 1}`,
  ).rows;
  for (const row of a2.slice(0, limit)) {
    findings.push({
      check: "A2",
      severity: "error",
      code: row.topup_id ? "ledger_without_paid_topup" : "ledger_without_topup",
      topupId: row.topup_id ?? row.ref_id,
      accountId: row.account_id,
      amountCents: Number(row.amount_cents),
      message: row.topup_id
        ? `账本已入账但充值单状态是 ${row.topup_status}：${row.ref_id}（账本 ${row.ledger_id}，${money(row.amount_cents)}）`
        : `账本引用的充值单不存在：${row.ref_id}（账本 ${row.ledger_id}，${money(row.amount_cents)}）`,
      fixable: false,
    });
    if (row.topup_id && Number(row.denomination_cents) !== Number(row.amount_cents)) {
      findings.push({
        check: "A2",
        severity: "error",
        code: "ledger_amount_mismatch",
        topupId: row.topup_id,
        accountId: row.account_id,
        message: `入账金额 ${money(row.amount_cents)} 与充值单面额 ${money(row.denomination_cents)} 不一致：${row.ref_id}`,
        fixable: false,
      });
    }
  }
  if (a2.length > limit) {
    findings.push({ check: "A2", severity: "warn", code: "truncated", message: `结果超过 ${limit} 行，已截断；用 --limit 放大` });
  }

  // A3：同一充值单被入账两次（正常路径 + 人工补记 = 双记）。
  const a3 = query(
    `SELECT CASE WHEN w.ref_type = 'stripe_payment' THEN w.ref_id ` +
      `ELSE substr(w.ref_id, ${"stripe-reconcile:".length + 1}) END AS topup_id, ` +
      `COUNT(*) AS credits, SUM(w.amount_cents) AS total_cents ` +
      `FROM wallet_ledger w ` +
      `WHERE w.ref_type = 'stripe_payment' ` +
      `OR (w.ref_type = 'manual' AND w.ref_id LIKE 'stripe-reconcile:%') ` +
      `GROUP BY 1 HAVING COUNT(*) > 1 LIMIT ${limit + 1}`,
  ).rows;
  for (const row of a3.slice(0, limit)) {
    findings.push({
      check: "A3",
      severity: "error",
      code: "duplicate_credit",
      topupId: row.topup_id,
      amountCents: Number(row.total_cents),
      message: `同一充值单有 ${row.credits} 条入账，合计 ${money(row.total_cents)}：${row.topup_id}`,
      fixable: false,
    });
  }

  // 账本余额与账户余额（与 billing.ts 的 reconciliationDrift 同一条断言）。
  const drift = query(
    `SELECT a.id AS account_id, a.balance_cents AS balance, ` +
      `COALESCE((SELECT w.balance_after_cents FROM wallet_ledger w WHERE w.account_id = a.id ` +
      `ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1), 0) AS latest ` +
      `FROM accounts a ` +
      `WHERE a.balance_cents <> COALESCE((SELECT w.balance_after_cents FROM wallet_ledger w WHERE w.account_id = a.id ` +
      `ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1), 0) ` +
      `LIMIT ${limit + 1}`,
  ).rows;
  for (const row of drift.slice(0, limit)) {
    findings.push({
      check: "C",
      severity: "error",
      code: "balance_drift",
      accountId: row.account_id,
      message: `余额与最新账本行不一致：账户 ${row.account_id} 余额 ${money(row.balance)}，最新账本 ${money(row.latest)}`,
      fixable: false,
    });
  }
  if (drift.length > limit) {
    findings.push({ check: "C", severity: "warn", code: "truncated", message: `结果超过 ${limit} 行，已截断；用 --limit 放大` });
  }

  // B：payments ↔ ledger。since 默认取最早一条 stripe_payment 账本行，
  // 避免把 Dodo 时期的 payments 拉进来。
  let since = options.since;
  if (since == null) {
    const row = query(
      `SELECT MIN(created_at) AS since FROM wallet_ledger ` +
        `WHERE ref_type = 'stripe_payment' ` +
        `OR (ref_type = 'manual' AND ref_id LIKE 'stripe-reconcile:%')`,
    ).rows[0];
    since = row?.since == null ? null : Number(row.since);
  }

  let payments = [];
  let paidTopups = [];
  const creditRows = query(
    `SELECT CASE WHEN w.ref_type = 'stripe_payment' THEN w.ref_id ` +
      `ELSE substr(w.ref_id, ${"stripe-reconcile:".length + 1}) END AS topup_id, ` +
      `w.ref_type AS source, w.amount_cents, w.created_at FROM wallet_ledger w ` +
      `WHERE w.ref_type = 'stripe_payment' ` +
      `OR (w.ref_type = 'manual' AND w.ref_id LIKE 'stripe-reconcile:%') ` +
      `LIMIT ${limit + 1}`,
  ).rows;
  if (since != null) {
    payments = query(
      `SELECT id, account_id, amount_usd, currency, status, received_at FROM payments ` +
        `WHERE status = 'succeeded' AND received_at >= ${sqlNumber(since, "since")} ` +
        `ORDER BY received_at ASC LIMIT ${limit + 1}`,
    ).rows;
    paidTopups = query(
      `SELECT id, account_id, denomination_cents, paid_at, checkout_session_id FROM topups ` +
        `WHERE status = 'paid' LIMIT ${limit + 1}`,
    ).rows;
    if (payments.length > limit || paidTopups.length > limit) {
      findings.push({ check: "B", severity: "warn", code: "truncated", message: `结果超过 ${limit} 行，已截断；用 --limit 放大` });
      payments = payments.slice(0, limit);
      paidTopups = paidTopups.slice(0, limit);
    }
  }

  const creditsByTopup = new Map();
  const sourceByTopup = new Map();
  for (const row of creditRows.slice(0, limit)) {
    creditsByTopup.set(row.topup_id, (creditsByTopup.get(row.topup_id) ?? 0) + 1);
    if (!sourceByTopup.has(row.topup_id) || row.source === "manual") {
      sourceByTopup.set(row.topup_id, row.source);
    }
  }

  if (since != null) {
    const topupBySession = new Map();
    for (const row of paidTopups) {
      if (row.checkout_session_id) topupBySession.set(row.checkout_session_id, row);
    }
    const used = new Set();
    const attributed = new Set();

    for (const payment of payments) {
      let match = topupBySession.get(payment.id) ?? null;
      let how = "session";
      if (!match) {
        // 弱匹配：payment_intent 为 id 时本地没有直接外键，只能按账户 + 金额 + 24h 窗口归户。
        let best = null;
        let bestDiff = Infinity;
        for (const topup of paidTopups) {
          if (used.has(topup.id) || topup.account_id !== payment.account_id) continue;
          if (Number(topup.denomination_cents) !== Math.round(Number(payment.amount_usd) * 100)) continue;
          const diff = Math.abs(Number(topup.paid_at) - Number(payment.received_at));
          if (diff <= 24 * 3600 * 1000 && diff < bestDiff) {
            best = topup;
            bestDiff = diff;
          }
        }
        match = best;
        how = "weak";
      }
      if (!match) {
        findings.push({
          check: "B",
          severity: "warn",
          code: "payment_without_topup",
          accountId: payment.account_id,
          message: `付款流水找不到对应充值单：payments.id=${payment.id}（${money(Number(payment.amount_usd) * 100)}，${iso(payment.received_at)}）`,
          fixable: false,
        });
        continue;
      }
      used.add(match.id);
      attributed.add(match.id);
      if (!creditsByTopup.has(match.id)) {
        findings.push({
          check: "B",
          severity: "error",
          code: "payment_without_ledger",
          topupId: match.id,
          accountId: payment.account_id,
          message: `有付款流水但没有账本入账：topup=${match.id}（${how === "weak" ? "弱匹配" : "session 匹配"}，payments.id=${payment.id}）`,
          fixable: false,
        });
      }
    }

    for (const [topupId, count] of creditsByTopup) {
      if (attributed.has(topupId)) continue;
      if (count > 1) continue; // A3 已经报过重复入账
      // 人工补记本来就没有本地 payments 行（证据是 Stripe Dashboard），不再重复告警。
      if (sourceByTopup.get(topupId) === "manual") continue;
      findings.push({
        check: "B",
        severity: "warn",
        code: "ledger_without_payment",
        topupId,
        message: `有账本入账但没有可归户的付款流水：${topupId}（since=${iso(since)} 之后无匹配 payments）`,
        fixable: false,
      });
    }
  }

  // 操作员从 Stripe Dashboard 核对过的已付 session：本地 pending/failed 的，补账入口。
  const sessions = paidSessions ?? [];
  for (const sessionId of sessions) {
    const rows = query(
      `SELECT id, account_id, denomination_cents, status, paid_at, checkout_session_id ` +
        `FROM topups WHERE checkout_session_id = ${sqlString(sessionId)} LIMIT 1`,
    ).rows;
    const row = rows[0];
    if (!row) {
      findings.push({
        check: "D",
        severity: "error",
        code: "stripe_session_without_topup",
        message: `Stripe 已付 session 在本地找不到充值单：${sessionId}`,
        fixable: false,
      });
      continue;
    }
    if (row.status === "paid") continue;
    findings.push({
      check: "D",
      severity: "error",
      code: "stripe_paid_but_topup_not_paid",
      topupId: row.id,
      accountId: row.account_id,
      amountCents: Number(row.denomination_cents),
      message: `Stripe 已确认付款，本地充值单仍是 ${row.status}：${row.id}（${money(row.denomination_cents)}，session=${sessionId}）`,
      fixable: true,
      fixKind: "pending_after_stripe_paid",
      topup: row,
    });
  }

  return { findings, since };
}

/** 补记一条：mark paid（需要时）+ manual 账本行 + 余额。每一步都靠自己幂等。 */
function applyFix(fix) {
  const topup = fix.topup;
  const now = Date.now();
  const ledgerId = ledgerIdFor(topup.id);
  const refId = manualRefFor(topup.id);
  const amount = Number(topup.denomination_cents);
  const results = [];

  if (topup.status !== "paid") {
    const updated = runSql(
      `UPDATE topups SET status = 'paid', paid_at = ${now} WHERE id = ${sqlString(topup.id)} AND status <> 'paid'`,
    );
    results.push({ step: "mark_paid", changes: updated.changes });
  }

  const inserted = runSql(
    `INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) ` +
      `SELECT ${sqlString(ledgerId)}, a.id, 'topup', ${sqlNumber(amount, "amount")}, a.balance_cents + ${sqlNumber(amount, "amount")}, ` +
      `'manual', ${sqlString(refId)}, ${sqlString(`stripe-reconcile backfill for ${topup.id}`)}, ${now} ` +
      `FROM accounts a ` +
      `WHERE a.id = ${sqlString(topup.account_id)} ` +
      `AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.id = ${sqlString(ledgerId)}) ` +
      `AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'stripe_payment' AND w.ref_id = ${sqlString(topup.id)}) ` +
      `AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'manual' AND w.ref_id = ${sqlString(refId)})`,
  );
  results.push({ step: "ledger", changes: inserted.changes });

  const balance = runSql(
    `UPDATE accounts SET balance_cents = (SELECT balance_after_cents FROM wallet_ledger WHERE id = ${sqlString(ledgerId)}) ` +
      `WHERE id = ${sqlString(topup.account_id)} ` +
      `AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ${sqlString(ledgerId)}) ` +
      `AND balance_cents = (SELECT balance_after_cents - ${sqlNumber(amount, "amount")} FROM wallet_ledger WHERE id = ${sqlString(ledgerId)})`,
  );
  results.push({ step: "balance", changes: balance.changes });

  const check = query(
    `SELECT a.balance_cents AS balance, ` +
      `(SELECT w.balance_after_cents FROM wallet_ledger w WHERE w.account_id = a.id ` +
      `ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1) AS latest, ` +
      `EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ${sqlString(ledgerId)}) AS ours ` +
      `FROM accounts a WHERE a.id = ${sqlString(topup.account_id)} LIMIT 1`,
  ).rows[0];

  return {
    topupId: topup.id,
    accountId: topup.account_id,
    amountCents: amount,
    ledgerId,
    written: Boolean(check && Number(check.ours) === 1),
    consistent: Boolean(check && Number(check.balance) === Number(check.latest)),
    results,
  };
}

function textReport(report, applied, rechecked) {
  const lines = [];
  lines.push(`Stripe 对账 · ${options.local ? `本地 D1（${options.env} 配置）` : `远端 ${options.env === "dev" ? "开发库" : "生产库"}`}`);
  lines.push(`模式：${options.apply ? "APPLY（会写库）" : "只读 dry-run（加 --apply 才写）"}`);
  lines.push(`数据库：${database}`);
  lines.push(`payments 对账起点：${report.since == null ? "无 stripe_payment 账本行，跳过 payments 检查" : iso(report.since)}`);
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("没有发现差异。");
  } else {
    const issues = report.findings.filter((item) => item.severity === "error");
    const warnings = report.findings.filter((item) => item.severity === "warn");
    if (issues.length) {
      lines.push(`[错误 ${issues.length}]`);
      for (const item of issues) {
        lines.push(`  ${item.check} ${item.code}：${item.message}`);
        if (item.fixable) lines.push(`    → 可用 --apply 补记（manual ref: ${manualRefFor(item.topupId)}）`);
      }
      lines.push("");
    }
    if (warnings.length) {
      lines.push(`[警告 ${warnings.length}]`);
      for (const item of warnings) lines.push(`  ${item.check} ${item.code}：${item.message}`);
      lines.push("");
    }
  }
  if (applied.length) {
    lines.push("[本次补记]");
    for (const item of applied) {
      lines.push(
        `  ${item.topupId}：${item.written ? "已补记" : "未写入（账户不存在或已有入账）"}，` +
          `${item.consistent ? "余额与账本一致" : "余额与账本仍不一致，请人工核查"}（${money(item.amountCents)}）`,
      );
    }
    if (rechecked) lines.push("以上差异清单为补记后的复查结果。");
    lines.push("");
  }
  const errors = report.findings.filter((item) => item.severity === "error").length;
  const fixable = report.findings.filter((item) => item.fixable).length;
  lines.push(`汇总：错误 ${errors}，警告 ${report.findings.length - errors}，可补记 ${fixable}`);
  lines.push(errors > 0 ? "退出码 1（有待处理差异）" : "退出码 0");
  return lines.join("\n");
}

function main() {
  options = parseArgs(process.argv.slice(2));
  database = databaseName(options.env);

  const paidSessions = options.paidSessions ? readPaidSessions(options.paidSessions) : [];
  let report = collectFindings(paidSessions);
  let rechecked = false;

  const applied = [];
  if (options.apply) {
    // 同一 topup 可能同时命中 A1 与 D（D 先把它标成 paid），按 topup id 去重。
    const fixes = new Map();
    for (const item of report.findings) {
      if (!item.fixable) continue;
      if (!fixes.has(item.topupId)) fixes.set(item.topupId, item);
    }
    for (const fix of fixes.values()) applied.push(applyFix(fix));
    if (applied.length) {
      report = collectFindings(paidSessions);
      rechecked = true;
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          environment: options.env,
          local: options.local,
          database,
          apply: options.apply,
          since: report.since,
          findings: report.findings.map(({ topup, ...rest }) => rest),
          applied,
          summary: {
            errors: report.findings.filter((item) => item.severity === "error").length,
            warnings: report.findings.filter((item) => item.severity === "warn").length,
            fixable: report.findings.filter((item) => item.fixable).length,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(textReport(report, applied, rechecked));
  }

  const errors = report.findings.filter((item) => item.severity === "error");
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
