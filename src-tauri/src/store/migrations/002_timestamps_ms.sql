-- D-06：把所有时间列统一为毫秒。
--
-- 旧版本的 `runtime_versions.installed_at` 写的是秒级时间戳（10 位），
-- 与其它表的毫秒（13 位）混用，跨表比较会静默出错。
--
-- 下界保护：`installed_at < 1e11` 才乘 1000。已经迁到毫秒的值（>1e11）
-- 不会被二次放大，所以这段 SQL 重复执行也是安全的。

UPDATE runtime_versions
   SET installed_at = installed_at * 1000
 WHERE installed_at > 0
   AND installed_at < 100000000000;
