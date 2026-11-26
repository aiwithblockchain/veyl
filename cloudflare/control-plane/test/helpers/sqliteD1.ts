// 真实 SQL 的 D1 替身：node:sqlite 内存库 + 全部迁移，用来验证清理语句本身，
// 而不是 fakeD1 里用 JS 重写一遍的谓词。只实现 billing 清理用到的四个方法。
//
// 与 D1 的差异只在「限流/事务粒度」这类平台行为；SQL 语法与语义直接用 SQLite。

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

/**
 * 运行时用 CJS require 取内置模块：Vitest 1.x 的 Vite 会把静态或动态 `node:sqlite`
 * 解析成包名 `sqlite` 再报 "Failed to load url sqlite"；require 不经过 Vite 的 ESM 解析。
 */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const nodeRequire = createRequire(import.meta.url);
  return nodeRequire("node:sqlite") as typeof import("node:sqlite");
}

/**
 * node:sqlite 在 Node 22 上需要 `--experimental-sqlite`，23.4 起才免 flag。
 * 根 `engines` 允许 Node 22，所以先探测：拿不到就跳过真实 SQL 用例，不让环境差异变成红。
 */
export function sqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/** test/helpers → ../../migrations（fileURLToPath 处理空格与 Windows 盘符）。 */
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

export class SqliteStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): SqliteStatement {
    // D1 文档：每条查询最多 100 个绑定参数。真实 D1 超限会直接报错；
    // 测试替身也拦下来，防止有人把清理批量调回 200 后清理静默失效。
    if (args.length > 100) {
      throw new Error(`D1 每条查询最多 100 个绑定参数，收到 ${args.length} 个`);
    }
    return new SqliteStatement(this.db, this.sql, args);
  }

  runSync(): { success: boolean; meta: { changes: number } } {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(info.changes) } };
  }

  async run() {
    return this.runSync();
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
}

export class SqliteD1 {
  constructor(private db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** 与 D1 一样整批原子：任一语句失败整批回滚。 */
  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  rows<T extends Row = Row>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }

  run(sql: string, ...args: unknown[]): void {
    this.db.prepare(sql).run(...args);
  }

  close(): void {
    this.db.close();
  }
}

/** 按文件名顺序应用 migrations/*.sql，返回内存库。 */
export async function openMigratedDb(): Promise<SqliteD1> {
  const { DatabaseSync: DatabaseSyncCtor } = await loadSqlite();
  const db = new DatabaseSyncCtor(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return new SqliteD1(db);
}
