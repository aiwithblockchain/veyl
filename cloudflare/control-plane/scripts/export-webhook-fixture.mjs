#!/usr/bin/env node
// 把 dev 环境捕获的 Dodo 回调样本导出成回归 fixture。
//
//   npm run export:webhook-fixture
//
// 只连 dev（--env dev）。样本在捕获时已经脱敏（签名头 ***、id/邮箱/金额/元数据换成占位值），
// 这里只做搬运，不再接触生产库。没有样本时正常退出，不报错——等下次 dev 充值自然产生。
//
// 产出：test/fixtures/dodo-webhook-<captured_at 的 UTC 日期>.json
//   { captured_at, source, kind, headers, raw_body }

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures");

const SQL =
  "SELECT id, kind, received_at, headers, body FROM webhook_samples ORDER BY received_at DESC LIMIT 1";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", "--env", "dev", "--remote", "--json", "--command", SQL],
  { cwd: root, encoding: "utf8" },
);

if (result.status !== 0) {
  fail(`读取 dev D1 失败：\n${result.stderr || result.stdout}`);
}

// wrangler 可能在 JSON 前打印提示；从第一个 `[` 开始解析。
const text = result.stdout ?? "";
const start = text.indexOf("[");
if (start < 0) fail(`wrangler 没有返回 JSON：\n${text}`);
let payload;
try {
  payload = JSON.parse(text.slice(start));
} catch (error) {
  fail(`解析 wrangler 输出失败：${error.message}\n${text}`);
}

const rows = payload?.[0]?.results ?? [];
if (rows.length === 0) {
  console.log("dev 还没有捕获到 Dodo 回调样本；等下一次 dev 充值后再跑一次。");
  process.exit(0);
}

const row = rows[0];
let headers;
let body;
try {
  headers = JSON.parse(row.headers);
  body = JSON.parse(row.body);
} catch (error) {
  fail(`样本不是合法 JSON：${error.message}`);
}

const capturedAt = new Date(Number(row.received_at)).toISOString();
const date = capturedAt.slice(0, 10);
const file = join(fixtures, `dodo-webhook-${date}.json`);
mkdirSync(fixtures, { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify(
    {
      captured_at: capturedAt,
      source: "dev",
      kind: row.kind,
      headers,
      raw_body: body,
    },
    null,
    2,
  )}\n`,
);
console.log(`已导出 ${join("test", "fixtures", `dodo-webhook-${date}.json`)}（kind=${row.kind}）`);
