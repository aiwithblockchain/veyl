-- 边界写法：字符串里的分号不能被当语句结束，括号内的逗号不能被当列分隔。
CREATE TABLE edges (
  note TEXT DEFAULT ';',
  flag TEXT,
  CHECK (flag IN ('x', 'y'))
);
