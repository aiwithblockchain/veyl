# Agent 签发契约 v1

> 日期：2026-11-27
> 状态：**定稿，实现按此**。涉及控制面、agent 两侧，改契约要让两侧同时改。
> 相关：`agent/docs/certificates.md`（设计）、`agent/docs/agent-health.md` §5（运维票）

---

## 0. 三条不变量

1. **根私钥只在控制面的 Cloudflare secret 里**，不进仓库、不进日志、不下发给节点。
2. **叶证书的 SAN 由控制面构造**，CSR 里的 `subjectAltNames` 只用于拒绝，不用于签发。
3. **叶证书私钥只在节点本地**，控制面只签公钥，不代生成密钥。

---

## 1. enroll 携带 CSR

`POST /v1/agent/enroll`

```
Authorization: Bearer <一次性 enrollment token>
Content-Type: application/json

{ "csr": "<base64(DER)>" }
```

- `csr` **可选**。不带时行为不变（老 agent 继续自签），控制面不返回证书。
- `csr` 是 rcgen 输出的 DER，base64 标准编码，不转 PEM。
- 解析或验签失败一律 `400`，**不销毁实例**——装机的超时机制会收尾，不要因为一张坏 CSR 立刻删机器。

成功响应在现有字段之外新增两个（都可缺省）：

```json
{
  "ok": true,
  "server_id": "srv_...",
  "server_token": "agt_...",
  "desired": { "...": "不变" },
  "token_public_key": "...",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

`ca_pem` 返回的是**根证书**，不是节点自签的 CA。

---

## 2. enroll 之后的签发通道

`POST /v1/agent/cert`

```
Authorization: Bearer <server_token>        ← 长期有效，与上报流量同一把
Content-Type: application/json

{ "csr": "<base64(DER)>" }
```

成功：

```json
{
  "ok": true,
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_pem": "-----BEGIN CERTIFICATE-----\n...",
  "not_after": 1955000000          // unix 秒
}
```

失败：

| 状态 | `reason` | 含义 |
|---|---|---|
| 401 | `missing_token` / `unknown_token` | 没有票或票不认识 |
| 409 | `destroyed` | 这台已经销毁，不再签发 |
| 400 | `invalid_json` / `csr_invalid` | 请求体或 CSR 解析不了 |
| 400 | `csr_signature_invalid` | CSR 自签验不过 |
| 400 | `unsupported_key` | 不是 ECDSA P-256 |
| 403 | `san_rejected` | CSR 申请了未授权的名字，**写审计** |
| 429 | `rate_limited` | 同一台 5 分钟内超过 3 次签发 |
| 503 | `host_unavailable` | 这台还没有公网 IP；签出来的证书客户端用不了，不签 |
| 503 | `unavailable` / `root_missing` | 控制面自己没准备好 |

鉴权方式：用 `server_token` 的 SHA-256 查 `servers.server_token_hash`，只对未销毁的行签发。

`servers.ip` 为空时先按 `provider_id` 向 DO 补查一次；仍拿不到就返回 `host_unavailable`，**不能签一张只有 localhost 的叶证书**——那种证书装到节点上，客户端连不上，而 App 会靠指纹回落把症状吞掉。

限流：同一台 5 分钟最多 3 次，与 enroll 重放同一套计数。请求体上限 64 KB。

审计：`agent.cert.san_rejected`（拒签）与 `agent.cert.issued`（成功签发）各写一条。

---

## 3. 叶证书参数

| 项 | 值 |
|---|---|
| 有效期 | **2 年（730 天）** |
| 开始续期 | 剩余不足 **30 天** |
| 续期失败 | **每 6 小时重试**，不阻塞主循环，不退出进程 |
| 续期时的私钥 | **生成新密钥对**，不复用旧 key |
| SAN | `servers.ip` + `localhost` + `127.0.0.1`，去重 |
| subject | 固定 `CN=veyl-node-agent`，不采信 CSR 的 subject |
| 根证书 subject | 固定 `CN=Veyl Node Root CA`，**不得等于叶的 subject**——否则 `issuer == subject` 会让 agent 把根签的叶误判成存量自签 |
| 允许的 CSR SAN | 上述地址；其余一律 `403 san_rejected`，**包括无法识别的 GeneralName 类型** |
| 密钥类型 | ECDSA P-256，其余拒签 |
| 密钥用法 | 由控制面固定，不采信 CSR；`CA:FALSE`、`digitalSignature`、`keyEncipherment`、EKU `serverAuth` |
| `notBefore` | 签发时间回拨 5 分钟，抵消时钟差 |
| 序列号 | 16 字节随机正整数 |

**不做吊销**。2 年有效期 + 无吊销 = 泄露的叶证书最长可用 2 年，这是明确的取舍，见 `certificates.md` §5.1。

### 3.1 签发成功后要落库

控制面在签发成功时（enroll 或 `/v1/agent/cert`）把到期时间写进 `servers.cert_not_after`（unix 秒）：

```sql
ALTER TABLE servers ADD COLUMN cert_not_after INTEGER;
```

运维平台据此展示到期日，并判断续期是否卡住——续期正常的节点会在进入 30 天窗口后的几小时内把这个值跳到两年后。见 `docs/design/ops-platform-rollout.md` §9。

agent 本地也存一份，供 `get_status` 返回 `cert.not_after`，见 `agent/docs/agent-health.md` §3.5。

---

## 4. agent 侧的判据

签发成功后 agent 落四样东西：

| 文件 | 内容 |
|---|---|
| `leaf-cert.pem` / `leaf-key.pem` | 叶证书与私钥 |
| `ca-cert.pem` | 控制面返回的根证书，**覆盖原来自签 CA 的位置** |
| `leaf-meta.json` | `{ "root_fingerprint": "<sha256 hex>", "not_after": <unix 秒> }` |

「这本证书已经由统一根签发」的判据（三条同时满足）：

1. 叶证书与私钥都在且能解析；
2. SAN 标记文件的内容等于当前 host 列表；
3. `leaf-meta.json` 的 `root_fingerprint` 等于本地 `ca-cert.pem` 的 SHA-256。

**存量节点的迁移就挂在这条上**：老节点没有 `leaf-meta.json`，第一次运行新 agent 必然判定「需要换证书」，不需要控制面额外下发标记。

迁移与续期走同一条路径：

- 启动时判定需要换、且本地有 `server_token` → 生成新密钥对与 CSR，调 `POST /v1/agent/cert`，成功后落盘。TLS 由 `TlsAcceptorCache` 按指纹自动重载，不需要重启进程。
- **换不到时继续用磁盘上现存的证书服务**（存量节点是自签的，客户端本来就按控制面给的 CA / 指纹验它），每 6 小时重试。这不是本地兜底重签，只是继续用已有文件。
- 磁盘上没有可用证书、又换不到（冷节点 + 控制面不可达）：进程不退出，按退避重试，拿到证书之后才开始监听 32100。
- 续期：`not_after - now < 30 天` 时走同一路径，每次生成新的密钥对与 CSR。

CSR 里的 SAN 只放 `localhost`、`127.0.0.1` 和已知的公网 IP。**`static_hosts` 不进 CSR**——控制面不认识配置里的域名，放了会被 403。代价是「用域名访问节点」不在本版支持范围，今天所有客户端都用 IP。

切到统一根之后，上报里的 `ca_pem` 必须是根证书（`identity.ca_pem()` 读 `ca-cert.pem`），不能还是那张自签 CA。

**阻塞期间计量也一起停**：`ensure_leaf` 在主循环之前，拿不到证书就不会开始读计数器。方向是少算，不会多算——这是明知取舍，不是缺陷。

---

## 5. 运维票（与 `agent-health.md` §5 一致）

| 项 | 业务票 | 运维票 |
|---|---|---|
| 签名私钥 | 控制面 | 运维 worker |
| 有效期 | 60 秒 | 1 小时 |
| `jti` | 一次性，落盘消费 | **不消费** |
| 可调工具 | 全部 | 只有只读工具 |

- 能力由「哪把公钥验过」决定，**不用 `scope` claim**。
- `server_id` 两把钥匙都校验，运维票不能跨机器。
- 两把公钥在编译期断言不相等。

---

## 6. 验收清单

- [ ] 正常 CSR → 叶证书 `issuer` 等于根 `subject`，能用根公钥验签
- [ ] agent 实际生成的 CSR（`dns:localhost` + `ip:127.0.0.1` + `ip:<公网 IP>`）能签出来，不能被拒
- [ ] CSR 带 `SAN=accounts.google.com` → `403 san_rejected`，审计有记录
- [ ] CSR 带别的 IP → `403 san_rejected`
- [ ] RSA CSR → `400 unsupported_key`
- [ ] 篡改签名的 CSR → `400 csr_signature_invalid`
- [ ] 不带 CSR 的 enroll → 行为与今天完全一致
- [ ] 叶证书 `not_after` 约为签发后 730 天
- [ ] 同一台连续两次签发 → 公钥不同（每次续期换 key）

---

## 7. 参考实现

`cloudflare/control-plane/src/certs.ts` 已经写了签发逻辑并通过单元测试（`test/certs.test.ts`，8 条）。它可以作为控制面会话的起点，但不是契约的一部分——实现细节归会话，验收以上面的清单为准。
