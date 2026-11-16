// 让测试替身受真实基线约束：每条写语句都要对得上 migrations/0001_schema.sql。
// 没有这层，替身手写的列映射会掩盖「线上撞 NOT NULL / 写错列 / 绑定数不符」这类错。

import schemaSql from "../../migrations/0001_schema.sql?raw";

interface TableShape {
  columns: Set<string>;
  required: Set<string>;
}

let cache: Map<string, TableShape> | null = null;

function schema(): Map<string, TableShape> {
  if (cache) return cache;
  const tables = new Map<string, TableShape>();
  for (const match of schemaSql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, name, body] = match;
    const columns = new Set<string>();
    const required = new Set<string>();
    for (const raw of body.split("\n")) {
      const line = raw.trim().replace(/,$/, "");
      if (!line) continue;
      const word = line.split(/\s+/)[0];
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(word)) continue;
      columns.add(word);
      const isPrimaryKey = /PRIMARY KEY/i.test(line);
      const notNull = /NOT NULL/i.test(line);
      const hasDefault = /\bDEFAULT\b/i.test(line);
      if (notNull && !hasDefault && !isPrimaryKey) required.add(word);
    }
    tables.set(name, { columns, required });
  }
  cache = tables;
  return tables;
}

/**
 * 写语句的静态校验。`sql` 已小写、空白已压缩。
 * 只在语句确实指向基线表时检查；未知表/未覆盖形态交给各分支自己抛错。
 */
export function assertSqlMatchesSchema(sql: string, args: unknown[]): void {
  const tables = schema();

  const insert = sql.match(/^insert (?:or ignore )?into (\w+) \(([^)]*)\)/);
  if (insert) {
    const [, table, list] = insert;
    const shape = tables.get(table);
    if (shape) {
      const columns = list.split(",").map((column) => column.trim());
      const unknown = columns.filter((column) => !shape.columns.has(column));
      if (unknown.length) {
        throw new Error(`SQL 写了 ${table} 不存在的列：${unknown.join(", ")} —— ${sql}`);
      }
      const missing = [...shape.required].filter((column) => !columns.includes(column));
      if (missing.length) {
        throw new Error(`SQL 没给 ${table} 的必填列：${missing.join(", ")} —— ${sql}`);
      }
    }
  }

  const update = sql.match(/^update (\w+) set (.*?)(?: where |$)/);
  if (update) {
    const shape = tables.get(update[1]);
    if (shape) {
      const assigned = [...update[2].matchAll(/(?<![\w.])(\w+) =/g)].map((pair) => pair[1]);
      const unknown = assigned.filter((column) => !shape.columns.has(column));
      if (unknown.length) {
        throw new Error(`SQL 更新了 ${update[1]} 不存在的列：${unknown.join(", ")} —— ${sql}`);
      }
    }
  }

  const placeholders = (sql.match(/\?/g) ?? []).length;
  if (placeholders !== args.length) {
    throw new Error(`绑定数不符：SQL 有 ${placeholders} 个占位符，传了 ${args.length} 个 —— ${sql}`);
  }
}
