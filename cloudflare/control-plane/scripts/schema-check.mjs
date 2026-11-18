#!/usr/bin/env node
// 部署前结构漂移检查：拿 `migrations/*.sql` 的期望结构比对 D1 的实际结构。
//
// 期望结构按文件名顺序叠加：CREATE TABLE 建表，ALTER TABLE ... ADD [COLUMN]
// 追加列（索引、外键不在检查范围）；DROP COLUMN 与其它 ALTER 形式会直接报错。
//
// 用法：
//   npm run schema:check                  # 生产库（顶层 d1_databases）
//   npm run schema:check -- --env dev     # 开发库
//   npm run schema:check -- --local       # 本地开发库（不带 --remote）
// 有缺失 → 退出码 1；迁移写错 → 退出码 2；多出的表/列只提示，不判失败。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法：node scripts/schema-check.mjs [--env dev|prod] [--local]

  --env dev|prod  选开发库或生产库（默认生产）
  --local         查本地 D1（不给 wrangler 传 --remote）`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { env: "prod", local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local") {
      options.local = true;
    } else if (arg === "--env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--env 需要一个值\n\n${USAGE}`);
      if (value !== "dev" && value !== "prod") {
        fail(`未知环境 ${value}（只支持 dev / prod）\n\n${USAGE}`);
      }
      options.env = value;
      index += 1;
    } else {
      fail(`未知参数 ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

/** 去掉 `//` 行注释再解析；字符串里的 `https://` 不能被误删。 */
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

/** 库名以 wrangler.jsonc 为准，避免脚本和部署配置各说各话。 */
function databaseName(env) {
  const configPath = join(root, "wrangler.jsonc");
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  const databases = env === "dev" ? config.env?.dev?.d1_databases : config.d1_databases;
  const binding = (databases ?? []).find((entry) => entry.binding === "DB") ?? databases?.[0];
  if (!binding?.database_name) {
    fail(`wrangler.jsonc 里找不到 ${env === "dev" ? "env.dev" : "顶层"} 的 DB 绑定`);
  }
  return binding.database_name;
}

const CONSTRAINT_WORDS = new Set(["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"]);

/** 迁移文件写错，或用了本脚本还解析不了的写法：立刻失败，不要静默放过。 */
export class MigrationError extends Error {}

/** 去掉 `--` 行注释与块注释；字符串字面量里的内容原样保留。 */
export function stripSqlComments(sql) {
  let output = "";
  let index = 0;
  let quote = null;
  while (index < sql.length) {
    const char = sql[index];
    if (quote) {
      output += char;
      if (quote === "[" ? char === "]" : char === quote) {
        if (quote !== "[" && sql[index + 1] === quote) {
          output += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      output += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") quote = char;
    output += char;
    index += 1;
  }
  return output;
}

/** 按顶层 `;` 切语句：括号内、字符串里的分号不算。 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    current += char;
    if (quote) {
      if (quote === "[" ? char === "]" : char === quote) {
        if (quote !== "[" && sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      statements.push(current.slice(0, -1));
      current = "";
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/** 按顶层逗号切列定义：`PRIMARY KEY (a, b)`、`CHECK (x IN ('a','b'))` 不能被切开。 */
function splitTopLevel(body) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    current += char;
    if (quote) {
      if (quote === "[" ? char === "]" : char === quote) {
        if (quote !== "[" && body[index + 1] === quote) {
          current += body[index + 1];
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(current.slice(0, -1));
      current = "";
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function unquote(identifier) {
  const text = identifier.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "`" && last === "`")) return text.slice(1, -1);
    if (first === "[" && last === "]") return text.slice(1, -1);
  }
  return text;
}

function columnName(definition) {
  const match = /^\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_]\w*))/.exec(definition);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * 按文件名顺序把迁移叠加成期望结构：CREATE TABLE 建表，ALTER TABLE ... ADD
 * 追加列。DROP 与其它 ALTER 形式解析不了，直接报 MigrationError（退出 2），
 * 免得「库比文件新/旧」被静默放过。
 */
export function parseMigrations(files) {
  const tables = new Map();
  const ordered = [...files].sort((left, right) => left.name.localeCompare(right.name));
  for (const file of ordered) {
    for (const raw of splitStatements(stripSqlComments(file.sql))) {
      const statement = raw.trim();
      if (!statement) continue;

      // 表重建（去掉 NOT NULL、改列顺序）是合法的迁移写法：
      // CREATE 新表 → INSERT ... SELECT → DROP 旧表 → RENAME。
      const drop = /^drop\s+table\s+(?:if\s+exists\s+)?([^\s;]+)/i.exec(statement);
      if (drop) {
        tables.delete(unquote(drop[1]).toLowerCase());
        continue;
      }

      const create = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/i.exec(statement);
      if (create) {
        const table = unquote(create[1]).toLowerCase();
        const open = statement.indexOf("(");
        const close = statement.lastIndexOf(")");
        if (open < 0 || close <= open) {
          throw new MigrationError(`${file.name}：CREATE TABLE ${table} 没有解析到列定义`);
        }
        const columns = tables.get(table) ?? new Set();
        for (const definition of splitTopLevel(statement.slice(open + 1, close))) {
          const name = columnName(definition);
          if (!name) {
            throw new MigrationError(
              `${file.name}：CREATE TABLE ${table} 有一列读不懂：「${definition.trim()}」`,
            );
          }
          if (CONSTRAINT_WORDS.has(name.toUpperCase())) continue;
          columns.add(name.toLowerCase());
        }
        tables.set(table, columns);
        continue;
      }

      const rename = /^alter\s+table\s+([^\s]+)\s+rename\s+to\s+([^\s;]+)/i.exec(statement);
      if (rename) {
        const from = unquote(rename[1]).toLowerCase();
        const to = unquote(rename[2]).toLowerCase();
        const moved = tables.get(from);
        if (!moved) {
          throw new MigrationError(`${file.name}：ALTER TABLE ${from} RENAME 指向不存在的表`);
        }
        tables.delete(from);
        tables.set(to, moved);
        continue;
      }

      const alter = /^alter\s+table\s+([^\s]+)\s+(\w+)/i.exec(statement);
      if (!alter) {
        // 白名单：索引不影响表结构；其它 CREATE/ALTER 解析不了，静默跳会漏表漏列。
        if (/^create\s+(?:unique\s+)?index\b/i.test(statement)) continue;
        if (/^(?:create|alter)\b/i.test(statement)) {
          throw new MigrationError(
            `${file.name}：看不懂这条语句（解析器只支持 CREATE TABLE / CREATE INDEX / ALTER ADD COLUMN）：` +
              `「${statement.trim().slice(0, 80)}」`,
          );
        }
        continue;
      }
      const table = unquote(alter[1]).toLowerCase();
      const action = alter[2].toUpperCase();
      if (action === "DROP") {
        throw new MigrationError(
          `${file.name}：不支持 ALTER TABLE ${table} DROP COLUMN（请重建表或改基线）`,
        );
      }
      if (action !== "ADD") {
        throw new MigrationError(
          `${file.name}：不支持的 ALTER TABLE 形式「${alter[2]}」（只认 ADD COLUMN），请调整迁移或解析器`,
        );
      }
      const rest = statement.slice(alter[0].length).trim().replace(/^column\s+/i, "");
      const name = columnName(rest);
      if (!name) throw new MigrationError(`${file.name}：ALTER TABLE ${table} ADD 后面没有列名`);
      const columns = tables.get(table);
      if (!columns) {
        throw new MigrationError(`${file.name}：ALTER TABLE 指向不存在的表 ${table}`);
      }
      columns.add(name.toLowerCase());
    }
  }
  return tables;
}

function expectedSchema() {
  const directory = join(root, "migrations");
  const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  if (names.length === 0) fail("migrations/ 下没有 .sql 文件");
  const files = names.map((name) => ({
    name,
    sql: readFileSync(join(directory, name), "utf8"),
  }));
  try {
    return parseMigrations(files);
  } catch (error) {
    if (error instanceof MigrationError) fail(error.message);
    throw error;
  }
}

function wranglerBinary() {
  const local = join(root, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? local : "wrangler";
}

// D1 的 HTTP 查询接口不允许 `sqlite_master JOIN pragma_table_info(...)`（SQLITE_AUTH），
// 但允许两者各自单独执行；所以先列表，再用 UNION ALL 一次取回所有表的列。
const TABLE_SQL =
  "SELECT name FROM sqlite_master " +
  "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
  "ORDER BY name";

/** Wrangler 自己的记账表：存在是正常的，不算「多出的表」。 */
const INTERNAL_TABLES = new Set(["_cf_kv", "d1_migrations"]);

/** D1 的 compound SELECT 上限很小：6 项就报 `too many terms in compound SELECT`。 */
const COMPOUND_LIMIT = 5;

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

function runQuery(options, database, sql) {
  const args = ["d1", "execute", database, "--json", "--command", sql];
  if (options.env === "dev") args.push("--env", "dev");
  if (!options.local) args.push("--remote");
  const result = spawnSync(wranglerBinary(), args, { cwd: root, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    fail("找不到 wrangler：请在 cloudflare/control-plane 下执行，或先 npm install");
  }
  if (result.error) fail(`调用 wrangler 失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || (result.stdout || "").trim();
    fail(`wrangler d1 execute 失败（退出码 ${result.status}）：\n${detail}`);
  }
  const parsed = parseWranglerOutput(result.stdout);
  if (!parsed) {
    fail(`读不懂 wrangler 的输出：\n${result.stdout.slice(0, 500)}`);
  }
  return Array.isArray(parsed)
    ? parsed.flatMap((entry) => entry?.results ?? [])
    : (parsed.results ?? []);
}

function actualSchema(options, database, expected) {
  const tables = runQuery(options, database, TABLE_SQL)
    .map((row) => String(row.name ?? "").toLowerCase())
    .filter((name) => /^\w+$/.test(name) && !INTERNAL_TABLES.has(name));
  const inspect = [...new Set([...expected.keys(), ...tables])];
  const columnsByTable = new Map();
  // D1 对 compound SELECT 的项数限制很小（6 项就报 too many terms），按 5 张表分批。
  for (let index = 0; index < inspect.length; index += COMPOUND_LIMIT) {
    const query = inspect
      .slice(index, index + COMPOUND_LIMIT)
      .map(
        (table) =>
          `SELECT '${table}' AS table_name, name AS column_name FROM pragma_table_info('${table}')`,
      )
      .join(" UNION ALL ");
    for (const row of runQuery(options, database, query)) {
      const table = String(row.table_name ?? "").toLowerCase();
      const column = String(row.column_name ?? "").toLowerCase();
      if (!table || !column) continue;
      const columns = columnsByTable.get(table) ?? new Set();
      columns.add(column);
      columnsByTable.set(table, columns);
    }
  }
  // 只存在于库里的表也要出现在结果里（空列集），否则「多出的表」看不出来。
  for (const table of tables) {
    if (!columnsByTable.has(table)) columnsByTable.set(table, new Set());
  }
  return columnsByTable;
}

function compare(expected, actual) {
  const missingTables = [];
  const missingColumns = [];
  for (const [table, columns] of expected) {
    const actualColumns = actual.get(table);
    if (!actualColumns) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!actualColumns.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  const extraTables = [...actual.keys()].filter((table) => !expected.has(table));
  const extraColumns = [];
  for (const [table, columns] of actual) {
    if (!expected.has(table)) continue;
    for (const column of columns) {
      if (!expected.get(table).has(column)) extraColumns.push(`${table}.${column}`);
    }
  }
  return { missingTables, missingColumns, extraTables, extraColumns };
}

function report(label, database, expected, result) {
  const expectedColumns = [...expected.values()].reduce((sum, columns) => sum + columns.size, 0);
  console.log(`\n=== ${label}：${database} ===`);
  console.log(`期望 ${expected.size} 张表 / ${expectedColumns} 列`);
  console.log(
    result.missingTables.length ? `缺失的表：${result.missingTables.join(", ")}` : "缺失的表：无",
  );
  console.log(
    result.missingColumns.length
      ? `缺失的列：${result.missingColumns.join(", ")}`
      : "缺失的列：无",
  );
  console.log(
    result.extraTables.length
      ? `多出的表（只提示）：${result.extraTables.join(", ")}`
      : "多出的表：无",
  );
  console.log(
    result.extraColumns.length
      ? `多出的列（只提示）：${result.extraColumns.join(", ")}`
      : "多出的列：无",
  );
  const drifted = result.missingTables.length > 0 || result.missingColumns.length > 0;
  console.log(drifted ? "结论：结构漂移，需要修库或补迁移。" : "结论：结构一致。");
  return drifted;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const expected = expectedSchema();
  const database = databaseName(options.env);
  const actual = actualSchema(options, database, expected);
  const result = compare(expected, actual);
  const label = `${options.env === "dev" ? "开发库" : "生产库"}（${options.local ? "本地" : "远程"}）`;
  const drifted = report(label, database, expected, result);
  process.exit(drifted ? 1 : 0);
}

// 直接运行才连库；被测试 import 时只导出解析函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
