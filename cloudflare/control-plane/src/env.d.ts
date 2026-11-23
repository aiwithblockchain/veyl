/**
 * 回调样本捕获开关：顶层包是 `"0"`，`env.dev` 是 `"1"`。生产包里连捕获代码
 * 和 `webhook_samples` 这条 SQL 都不存在（配合 `minify` 的常量折叠）。
 */
declare const __WEBHOOK_SAMPLE__: "0" | "1";
