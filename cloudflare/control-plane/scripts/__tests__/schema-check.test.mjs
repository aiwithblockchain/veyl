import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MigrationError, parseMigrations } from "../schema-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => ({
  name,
  sql: readFileSync(join(here, "fixtures", name), "utf8"),
});

/** 表名 → 排序后的列名，断言起来直白。 */
function schema(files) {
  return Object.fromEntries(
    [...parseMigrations(files)].map(([table, columns]) => [table, [...columns].sort()]),
  );
}

describe("parseMigrations", () => {
  it("多行 CREATE TABLE 读全列，块注释里的假表不算", () => {
    const tables = schema([fixture("0001_init.sql")]);
    expect(tables.servers).toEqual(["account_id", "id", "state"]);
    expect(tables.ghost).toBeUndefined();
  });

  it("单行 CREATE TABLE、一行多列都要读到", () => {
    const tables = schema([fixture("0001_init.sql")]);
    expect(tables.accounts).toEqual(["balance_cents", "id"]);
  });

  it("按文件名顺序应用 ALTER TABLE ... ADD COLUMN", () => {
    // 故意倒序传入：期望结构必须先 0001 后 0002，否则 ALTER 会指向不存在的表。
    const tables = schema([fixture("0002_add_column.sql"), fixture("0001_init.sql")]);
    expect(tables.servers).toEqual(["account_id", "id", "state", "transfer_gib"]);
    expect(tables.accounts).toEqual(["balance_cents", "id", "note"]);
  });

  it("ALTER 指向不存在的表直接报错", () => {
    expect(() =>
      parseMigrations([{ name: "0001_x.sql", sql: "ALTER TABLE nope ADD c TEXT;" }]),
    ).toThrow(MigrationError);
  });

  it("ALTER ... DROP COLUMN 不支持，直接报错", () => {
    expect(() =>
      parseMigrations([
        { name: "0001_x.sql", sql: "CREATE TABLE t (a TEXT); ALTER TABLE t DROP COLUMN a;" },
      ]),
    ).toThrow(/DROP COLUMN/);
  });

  it("字符串里的分号与括号内的逗号都不影响切分", () => {
    const tables = schema([fixture("0003_quoting.sql")]);
    expect(tables.edges).toEqual(["flag", "note"]);
  });

  it("CREATE 里有一列读不懂就报错，带表名与原文", () => {
    expect(() =>
      parseMigrations([{ name: "0001_x.sql", sql: "CREATE TABLE t (a TEXT, , b TEXT);" }]),
    ).toThrow(/CREATE TABLE t 有一列读不懂/);
  });

  it("表重建（CREATE 新表 → DROP 旧表 → RENAME）按最终表名校验", () => {
    const tables = schema([
      {
        name: "0001_x.sql",
        sql:
          "CREATE TABLE t (a TEXT); CREATE TABLE t_new (a TEXT, b TEXT); " +
          "INSERT INTO t_new SELECT a, NULL FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t;",
      },
    ]);
    expect(tables.t).toEqual(["a", "b"]);
    expect(tables.t_new).toBeUndefined();
  });

  it("不支持的 ALTER 形式直接报错并说明是哪种", () => {
    expect(() =>
      parseMigrations([
        { name: "0001_x.sql", sql: "CREATE TABLE t (a TEXT); ALTER TABLE t NOOP x;" },
      ]),
    ).toThrow(/不支持的 ALTER TABLE 形式「NOOP」/);
  });

  it("CREATE INDEX 放行，CREATE VIEW 这类解析不了的 CREATE 直接报错", () => {
    expect(() =>
      parseMigrations([
        {
          name: "0001_x.sql",
          sql: "CREATE TABLE t (a TEXT); CREATE UNIQUE INDEX t_a ON t(a);",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      parseMigrations([{ name: "0001_x.sql", sql: "CREATE VIEW v AS SELECT 1;" }]),
    ).toThrow(/解析器只支持 CREATE TABLE \/ CREATE INDEX \/ ALTER ADD COLUMN/);
  });

  it("行注释不会吞掉同一行的列，注释符在字符串里也不算", () => {
    const tables = schema([
      {
        name: "0001_x.sql",
        sql: "CREATE TABLE t (\n  a TEXT, -- 说明\n  b TEXT DEFAULT '--not-a-comment'\n);",
      },
    ]);
    expect(tables.t).toEqual(["a", "b"]);
  });
});
