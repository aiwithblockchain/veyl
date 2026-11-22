# tls-probe — 验证 rmcp / claurst 的 MCP HTTPS 信任方式

standalone Rust 小程序，回答一个问题：**claurst 的 MCP 客户端能不能信任节点 agent 的自签证书，能不能做指纹 pin？**

它复刻 claurst 的传输构造，并用真实的 HTTPS MCP server 跑四组对照：

| # | 模式 | 期望 |
|---|---|---|
| 1 | `StreamableHttpClientTransport::from_config`（claurst 的写法） | 失败（自签证书不受信） |
| 2 | 自定义 reqwest client + `add_root_certificate(CA)` | 成功 |
| 3 | 自定义 rustls verifier，校验 leaf 证书 SHA-256 | 成功 |
| 4 | 同 3，但指纹错误 | 失败 |

## 前置

- Rust（stable）
- `openssl` 在 `PATH` 里（需要支持 `-addext`；OpenSSL 3/4 均可）。可用 `OPENSSL=/path/to/openssl` 覆盖。
- 不需要改 `src-tauri` 或 claurst 子模块。依赖版本与 `src-tauri/Cargo.lock` 对齐：`rmcp = 1.8.0`、`reqwest = 0.13`。

## 一条命令跑完

```bash
cd scripts/dev/tls-probe
cargo run -- run-all
```

会在 `target/tls-probe-certs/` 生成一次性 CA + server 证书，起一个 HTTPS MCP server（只有 `initialize` / `tools/list` / `tools/call`），然后跑四组检查。全部符合预期时退出码为 0。

期望输出（节选）：

```
TLS diagnostics (raw GET):
  default:   ... invalid peer certificate: UnknownIssuer
  root:      HTTP 405 Method Not Allowed
  pin ok:    HTTP 405 Method Not Allowed
  pin wrong: ... certificate pin mismatch: got 3300...d08f, expected cc00...d08f

1. default (rmcp from_config, no custom trust)     FAIL
2. custom root CA (add_root_certificate)           OK    tools=["rotate_credentials"]
3. fingerprint pin (correct SHA-256)               OK    tools=["rotate_credentials"]
4. fingerprint pin (wrong SHA-256)                 FAIL
```

`HTTP 405` 是正常的：诊断用 GET 打 MCP 端点，TLS 已通过，只是 MCP 只接受 POST。

## 分开跑

```bash
# 1. 生成证书，打印 leaf SHA-256
cargo run -- gen-certs --out target/tls-probe-certs

# 2. 起 HTTPS MCP server
cargo run -- server \
  --cert target/tls-probe-certs/server-cert.pem \
  --key  target/tls-probe-certs/server-key.pem \
  --addr 127.0.0.1:8443

# 3. 另一个终端：按模式连接
cargo run -- probe --url https://127.0.0.1:8443/mcp --mode default
cargo run -- probe --url https://127.0.0.1:8443/mcp --mode root \
  --ca target/tls-probe-certs/ca-cert.pem
cargo run -- probe --url https://127.0.0.1:8443/mcp --mode pin \
  --ca target/tls-probe-certs/ca-cert.pem \
  --fingerprint <leaf-sha256>
```

## 为什么是 standalone

claurst 的 crate 用 `workspace = true` 继承依赖，直接把它们当 path 依赖拉进一个独立 crate 会解析失败。所以这里直接用同版本的 `rmcp`（以及它用的 `reqwest`）复刻 claurst `RmcpClientBackend::connect_http` 的那一行：

```rust
// claurst: src-tauri/claurst/src-rust/crates/mcp/src/rmcp_backend.rs:153
let transport = StreamableHttpClientTransport::from_config(transport_config);
```

第 1 组就是这一行；第 2–4 组换成 rmcp 暴露的注入入口：

```rust
let transport = StreamableHttpClientTransport::with_client(custom_reqwest_client, config);
```

结论：**rmcp 支持注入；claurst 的 `McpClient::connect` 没有暴露这个入口。**

## 证书是怎么造的

`openssl` 生成一个一次性 CA，再签一张 SAN 为 `IP:127.0.0.1, DNS:localhost` 的服务器证书。私钥只落在 `target/`（已 gitignore），不会提交。
