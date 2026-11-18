# 迁移规则

1. 迁移只追加：已 applied 的编号（含 0001）内容冻结，不修改 / 重命名 / 删除；任何 schema 改动新建下一个编号。
2. 新库只用 `migrations apply` 建；不手工建表、不从 dump 恢复。
3. 生产库禁止手工 DDL；紧急补列必须当天回填成编号迁移，并登记动过哪些库。
4. `schema:check` 是合并门禁：缺表 / 缺列即失败；失败按「重建该库」处理，不逐列手补。
5. 2026-11-18：0001 曾被原地修订，dev/prod 已对齐并逐表逐列校验，后人勿假定它从未变过。
6. 新增列必须带 DEFAULT（D1/SQLite 的 ADD COLUMN 限制），编号连续。

## 怎么跑

在 `cloudflare/control-plane` 下执行：

```bash
# 生产库（默认远程）
npm run schema:check

# 开发库
npm run schema:check -- --env dev

# 本地 D1
npm run schema:check -- --local
```

远程检查需要先 `wrangler login`，且账号对两个 D1 库有访问权限。
