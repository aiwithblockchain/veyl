// 把一份本地种子 JSON 发布进 D1 `seed_payload`（design/seed-publishing.md §4）。
//
// 用法（vite-node 在 control-plane 的 node_modules 里）：
//   cd cloudflare/control-plane
//   npm run seed:publish -- --input scripts/seed/private_seeds.json --prod --dry-run
//   npm run seed:publish -- --input scripts/seed/private_seeds.json --prod
//   npm run seed:publish -- --input scripts/seed/private_seeds.json --dev
//   npm run seed:publish -- --input scripts/seed/private_seeds.json --local
//
// 远程写生产必须显式 --prod；--dev 写开发库；--local 只写本地 D1（可与 --dev 组合）。
// 输入路径按仓库根目录解析；文件必须在仓库外或已被 .gitignore 忽略。
// 日志与回读只打印版本 / 哈希 / 节点数，不打印密码。
//
// 不在 control-plane 的 tsconfig 覆盖范围内（只覆盖 src 与 test），所以带 Node 内置模块。

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  seedBody,
  sha256Hex,
  validateSeedNode,
  type Seed,
  type SeedNode,
} from "../../cloudflare/control-plane/src/seed";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTROL_PLANE = join(ROOT, "cloudflare/control-plane");

export const DATABASES = {
  prod: "veyl-control-plane",
  dev: "veyl-control-plane-dev-4",
} as const;

export type PublishOptions = {
  input: string;
  environment: "prod" | "dev";
  local: boolean;
  dryRun: boolean;
  updatedBy: string;
  /** 只允许空表首发：显式版本；表里已有行时传它直接报错。 */
  version: number | null;
  /** 只允许空表首发：显式 updated_at（原样写入，必须能解析）。 */
  updatedAt: string | null;
};

const USAGE = `用法：npm run seed:publish -- --input <path> [--prod | --dev | --local] [--dry-run] [--by <name>]
            [--version <n> --updated-at <ISO>（仅空表首发）]

  --input <path>  种子 JSON，形如 { "nodes": [ … ] }（按仓库根目录解析；必须在仓库外或已 gitignore）
  --prod          写远程生产库（默认不写；远程操作必须显式指定）
  --dev           写远程开发库 veyl-control-plane-dev-4
  --local         写本地 D1（wrangler --local），不碰远程
  --dry-run       只打印将要写入的版本 / 时间 / 哈希，不写库
  --by <name>     写入 updated_by 的标签，默认当前系统用户
  --version / --updated-at  仅当目标表没有任何行时可用；首发用它保持正文与旧常量字节一致`;

export function parseArgs(argv: string[]): PublishOptions {
  let input: string | undefined;
  let prod = false;
  let dev = false;
  let local = false;
  let dryRun = false;
  let updatedBy = process.env.USER || "unknown";
  let version: number | null = null;
  let updatedAt: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--input 需要一个路径\n\n${USAGE}`);
      input = value;
      index += 1;
    } else if (arg === "--prod") {
      prod = true;
    } else if (arg === "--dev") {
      dev = true;
    } else if (arg === "--local") {
      local = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--by") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--by 需要一个标签\n\n${USAGE}`);
      updatedBy = value;
      index += 1;
    } else if (arg === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--version 需要一个整数\n\n${USAGE}`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--version 必须是正整数，收到 ${value}`);
      }
      version = parsed;
      index += 1;
    } else if (arg === "--updated-at") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--updated-at 需要一个 ISO 时间\n\n${USAGE}`);
      if (Number.isNaN(Date.parse(value))) {
        throw new Error("--updated-at 不是可解析的 ISO 8601 时间");
      }
      // 原样保留：首发要与旧常量逐字节一致，不能被重新序列化成 .000Z。
      updatedAt = value.trim();
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    } else {
      throw new Error(`未知参数 ${arg}\n\n${USAGE}`);
    }
  }
  if (!input) throw new Error(`缺少 --input\n\n${USAGE}`);
  if (prod && dev) throw new Error("--prod 与 --dev 不能同时使用");
  // 远程写生产必须显式 --prod：忘加 --dev 不再会直接打到生产库。
  if (!local && !dev && !prod) {
    throw new Error("远程写生产库需要显式 --prod；开发库用 --dev，本地用 --local");
  }
  return {
    input,
    environment: dev ? "dev" : "prod",
    local,
    dryRun,
    updatedBy,
    version,
    updatedAt,
  };
}

export type SkippedNode = { index: number; problem: string };

/** 逐台校验输入；非法项只记序号与原因（不记内容，避免把密码写进日志）。 */
export function collectNodes(raw: unknown): { nodes: SeedNode[]; skipped: SkippedNode[] } {
  if (typeof raw !== "object" || raw === null) {
    throw new Error('输入 JSON 必须是 { "nodes": [ … ] }');
  }
  const list = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(list)) {
    throw new Error('输入 JSON 必须是 { "nodes": [ … ] }');
  }
  const nodes: SeedNode[] = [];
  const skipped: SkippedNode[] = [];
  list.forEach((item, index) => {
    const result = validateSeedNode(item);
    if ("node" in result) nodes.push(result.node);
    else skipped.push({ index, problem: result.problem });
  });
  if (nodes.length === 0) {
    throw new Error("没有任何可用节点（全部为空或校验失败），已中止");
  }
  return { nodes, skipped };
}

/** 版本由脚本生成：无行从 1 开始，否则当前 + 1。 */
export function nextVersion(current: number | null): number {
  return (current ?? 0) + 1;
}

/**
 * 本次要写的版本与时间。
 *
 * `--version` / `--updated-at` 只用于空表首发（保持正文与旧常量逐字节一致）；
 * 表里已有行时传它们直接报错，避免把版本写倒退。
 */
export function resolveRelease(
  current: number | null,
  options: Pick<PublishOptions, "version" | "updatedAt">,
  now: string,
): { version: number; updatedAt: string } {
  const hasRow = current !== null;
  if (hasRow && (options.version !== null || options.updatedAt !== null)) {
    throw new Error(
      "目标表已有数据：版本由脚本递增，--version / --updated-at 只用于空表首发",
    );
  }
  return {
    version: hasRow ? nextVersion(current) : options.version ?? 1,
    updatedAt: hasRow ? now : options.updatedAt ?? now,
  };
}

/** SQLite 字符串字面量：单引号双写；NUL 直接拒绝。 */
export function sqlText(value: string): string {
  if (value.includes("\u0000")) throw new Error("字符串里不允许 NUL");
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 单行 upsert。`WHERE excluded.version > seed_payload.version` 是第二道闸：
 * 版本不递增时 `changes = 0`，脚本据此中止（第一道是脚本自己算的 +1）。
 */
export function upsertSql(
  seed: Seed,
  body: string,
  hash: string,
  updatedBy: string,
  storedAt: number,
): string {
  return `INSERT INTO seed_payload (id, version, updated_at, body, content_sha256, updated_by, stored_at)
VALUES (1, ${seed.version}, ${sqlText(seed.updated_at)}, ${sqlText(body)}, ${sqlText(hash)}, ${sqlText(updatedBy)}, ${storedAt})
ON CONFLICT(id) DO UPDATE SET
  version = excluded.version,
  updated_at = excluded.updated_at,
  body = excluded.body,
  content_sha256 = excluded.content_sha256,
  updated_by = excluded.updated_by,
  stored_at = excluded.stored_at
WHERE excluded.version > seed_payload.version;
`;
}

/** 输入文件必须在仓库外或已被 gitignore；仓库内的私密文件不能被误提交。 */
export function assertInputAllowed(inputPath: string): void {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(ROOT, inputPath);
  const rel = relative(ROOT, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return;
  const ignored = spawnSync("git", ["check-ignore", "-q", rel], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (ignored.status !== 0) {
    throw new Error(
      `输入文件在仓库内且未被忽略：${rel}\n把它放到仓库外，或在 .gitignore 里忽略它`,
    );
  }
}

type WranglerResult = { stdout: string };

/** 只保留几句关键行；SQL 正文、含密码的行与超长行都不进错误输出。 */
function safeFailureLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/insert into seed_payload|values \(1,|password/i.test(line))
    .slice(0, 4)
    .map((line) => line.slice(0, 240));
}

function runWrangler(options: PublishOptions, tail: string[]): WranglerResult {
  const database = DATABASES[options.environment];
  const args = [
    "wrangler",
    "d1",
    "execute",
    database,
    options.local ? "--local" : "--remote",
  ];
  if (options.environment === "dev") args.push("--env", "dev");
  args.push(...tail);
  const result = spawnSync("npx", args, {
    cwd: CONTROL_PLANE,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`;
    const stdout = `${result.stdout ?? ""}`;
    if (/no such table/i.test(stderr) || /no such table/i.test(stdout)) {
      throw new Error(
        `D1 里没有 seed_payload 表：先应用 migrations/0019_seed_payload.sql（${database}）`,
      );
    }
    const lines = safeFailureLines(stderr || stdout);
    throw new Error(
      `wrangler 执行失败（退出码 ${result.status}）${lines.length ? `：\n${lines.join("\n")}` : ""}`,
    );
  }
  return { stdout: `${result.stdout ?? ""}` };
}

function parseWranglerJson(stdout: string): Array<Record<string, unknown>> {
  const start = stdout.indexOf("[");
  if (start < 0) {
    throw new Error("wrangler 没有返回可解析的 JSON（输出已隐藏，避免带出正文）");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("wrangler 返回的 JSON 无法解析（输出已隐藏，避免带出正文）");
  }
  if (!Array.isArray(parsed)) throw new Error("wrangler 返回的 JSON 不是数组");
  return parsed as Array<Record<string, unknown>>;
}

function readVersion(options: PublishOptions): number | null {
  const { stdout } = runWrangler(options, [
    "--json",
    "--command",
    "SELECT version FROM seed_payload WHERE id = 1",
  ]);
  const entries = parseWranglerJson(stdout);
  const rows = (entries[0]?.results ?? []) as Array<{ version?: number }>;
  if (rows.length === 0) return null;
  const version = Number(rows[0]?.version);
  if (!Number.isFinite(version)) throw new Error("读到的 version 不是数字");
  return version;
}

function executeSql(options: PublishOptions, sql: string): number | null {
  const dir = mkdtempSync(join(tmpdir(), "veyl-seed-"));
  const file = join(dir, "seed.sql");
  try {
    writeFileSync(file, sql, { mode: 0o600 });
    chmodSync(file, 0o600);
    const { stdout } = runWrangler(options, ["--json", "--file", file]);
    // 本地 wrangler 的 `--file --json` 输出不带 meta.changes；拿不到就返回 null，
    // 以回读结果为准（回读能同时覆盖「版本没递增」和「写入后被人覆盖」）。
    let total = 0;
    let seen = false;
    for (const entry of parseWranglerJson(stdout)) {
      const meta = entry.meta as { changes?: number } | undefined;
      if (typeof meta?.changes === "number") {
        total += meta.changes;
        seen = true;
      }
    }
    return seen ? total : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readBack(options: PublishOptions): {
  version: number;
  hash: string;
  body: string;
} {
  const { stdout } = runWrangler(options, [
    "--json",
    "--command",
    "SELECT version, content_sha256, body FROM seed_payload WHERE id = 1",
  ]);
  const entries = parseWranglerJson(stdout);
  const rows = (entries[0]?.results ?? []) as Array<{
    version?: number;
    content_sha256?: string;
    body?: string;
  }>;
  if (rows.length === 0) throw new Error("回读不到刚写入的 seed_payload 行");
  return {
    version: Number(rows[0]?.version),
    hash: `${rows[0]?.content_sha256 ?? ""}`,
    body: `${rows[0]?.body ?? ""}`,
  };
}

/** 只打印元数据；绝不打印 body（含密码）。 */
export function summaryLines(
  options: PublishOptions,
  seed: Seed,
  hash: string,
  skipped: SkippedNode[],
): string[] {
  const database = DATABASES[options.environment];
  const target = options.local ? "local" : "remote";
  return [
    `目标：${target} ${options.environment}（${database}）`,
    `版本：${seed.version}（${seed.updated_at}）`,
    `节点：${seed.nodes.length} 个${
      skipped.length ? `，跳过 ${skipped.length} 个（${skipped
        .map((item) => `#${item.index}:${item.problem}`)
        .join(", ")}）` : ""
    }`,
    `正文 sha256：${hash}`,
    `updated_by：${options.updatedBy}`,
  ];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertInputAllowed(options.input);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(ROOT, options.input), "utf8")) as unknown;
  } catch {
    // 不把解析器的原文抛出来：它可能带出输入片段（含密码）。
    throw new Error(`输入文件不是合法 JSON：${options.input}`);
  }
  const { nodes, skipped } = collectNodes(raw);

  const current = readVersion(options);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const release = resolveRelease(current, options, now);
  const seed: Seed = {
    version: release.version,
    updated_at: release.updatedAt,
    nodes,
  };
  const body = seedBody(seed);
  const hash = await sha256Hex(body);

  for (const line of summaryLines(options, seed, hash, skipped)) console.log(line);
  if (options.dryRun) {
    console.log("--dry-run：没有写库。");
    return;
  }

  const sql = upsertSql(seed, body, hash, options.updatedBy, Date.now());
  const changes = executeSql(options, sql);
  const stored = readBack(options);
  if (
    stored.version !== release.version ||
    stored.hash !== hash ||
    stored.body !== body
  ) {
    const reason =
      changes === 0
        ? "版本没有递增（D1 里已有同版本或更高版本），已中止；重新生成版本后再试"
        : "回读校验失败";
    throw new Error(
      `${reason}：期望 v${release.version} / ${hash}，实际 v${stored.version} / ${stored.hash}`,
    );
  }
  console.log("已写入并回读校验通过。");
}

if (!process.env.VITEST) {
  main().catch((error) => {
    console.error(`发布失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
