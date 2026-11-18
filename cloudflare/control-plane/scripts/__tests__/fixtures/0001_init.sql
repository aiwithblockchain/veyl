-- 解析器 fixture：多行 CREATE + 单行多列 CREATE + 两种注释。
/* 块注释里的假表不能被算进去：
CREATE TABLE ghost (nope TEXT);
*/
CREATE TABLE servers (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'creating'
);
CREATE TABLE accounts (id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0);
