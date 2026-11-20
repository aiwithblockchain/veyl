/**
 * `wrangler.jsonc` 的 `define` 注入：顶层包是 Live 收银台，`env.dev` 是 Test。
 *
 * 用它而不是运行期的 `env.ENVIRONMENT`：地址在编译期就定死，另一个环境的域名
 * 根本不会被打进这个包（验收方式是 dry-run 后 grep 产物）。
 */
declare const __DODO_API_BASE__: string;
