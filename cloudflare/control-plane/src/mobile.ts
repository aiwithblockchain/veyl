// 手机端导出（mobile-export-technical.md §1–§3）：
// 账户级远程配置令牌的创建 / 轮换，以及给 sing-box 官方客户端的 profile 生成。
// 令牌只存哈希（查找）与 AES-GCM 密文（回显）；日志、审计、错误体都不出现令牌。

import { authenticate, bumpRateLimit, isResponse } from "./auth";
import { b64u, openSecret, randomBytes, sealSecret, sha256B64u } from "./lib/crypto";
import { apiError, json } from "./lib/http";

export interface MobileEnv {
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
  MOBILE_TOKEN_ENC_KEY?: string;
  CREDENTIAL_ENC_KEY?: string;
}

const TOKEN_PREFIX = "mp_";
const KEY_VERSION = 1;
const RATE_WINDOW_MS = 3600_000;
const TOKEN_CREATE_LIMIT = 10;
const TOKEN_ROTATE_LIMIT = 10;
const PROFILE_LIMIT = 30;
const PROFILE_BAD_LIMIT = 60;
/** 手机每 ~60 分钟拉一次：5 分钟内重复请求不再写 D1。 */
const LAST_USED_THROTTLE_MS = 5 * 60_000;
const BASIC_REALM = 'Basic realm="veyl", charset="UTF-8"';
/** 当前 enroll 只写这一种，别的值说明数据异常，跳过这台。 */
const SS_METHOD = "aes-256-gcm";

interface StoredToken {
  token_hash: string;
  iv: string;
  ciphertext: string;
  created_at: number;
  rotated_at: number | null;
}

interface TokenAccountRow {
  account_id: string;
  status: string;
  merged_into: string | null;
}

interface NodeRow {
  id: string;
  name: string;
  created_at: number;
  ip: string | null;
  iv: string;
  ciphertext: string;
}

interface ShadowsocksOutbound {
  type: "shadowsocks";
  tag: string;
  server: string;
  server_port: number;
  method: string;
  password: string;
}

function changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

function newToken(): string {
  return `${TOKEN_PREFIX}${b64u(randomBytes(32))}`;
}

function missingKey(): Response {
  return noStore(
    apiError("INTERNAL", "手机导出暂时不可用", {
      retryable: true,
      status: 503,
      reason: "mobile_key_missing",
    }),
  );
}

/** 401 必须带 WWW-Authenticate：客户端靠它决定要不要重新携带 Basic。 */
function unauthorized(reason: string): Response {
  return json(
    {
      code: "UNAUTHENTICATED",
      message: "链接无效或已重新生成",
      retryable: false,
      details: { reason },
      request_id: "",
    },
    401,
    {
      "WWW-Authenticate": BASIC_REALM,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  );
}

function profileRateLimited(): Response {
  return json(
    {
      code: "RATE_LIMITED",
      message: "刷新太频繁，稍后再试",
      retryable: true,
      details: {},
      request_id: "",
    },
    429,
    {
      "Retry-After": "3600",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  );
}

/** 只取 Basic 密码；用户名固定协议里写 `veyl`，服务端按设计忽略。 */
function basicPassword(header: string | null): string | null {
  if (!header) return null;
  const match = /^basic\s+/i.exec(header);
  if (!match) return null;
  const encoded = header.slice(match[0].length).trim();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const password = decoded.slice(separator + 1);
  return password === "" ? null : password;
}

async function readStoredToken(db: D1Database, accountId: string): Promise<StoredToken | null> {
  return db
    .prepare(
      "SELECT token_hash, iv, ciphertext, created_at, rotated_at FROM mobile_tokens WHERE account_id = ?",
    )
    .bind(accountId)
    .first<StoredToken>();
}

/** 既有的行解不开时不静默轮换：静默轮换会把已经扫码的手机踢下线。 */
function corruptToken(): Response {
  return apiError("INTERNAL", "令牌读取失败，请重新生成", {
    reason: "mobile_token_corrupt",
  });
}

async function createToken(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;

  const key = env.MOBILE_TOKEN_ENC_KEY;
  if (!key) return missingKey();
  if (identity.kind !== "email") {
    return apiError("PRECONDITION_FAILED", "请先用邮箱登录", { reason: "login_required" });
  }
  if (
    !(await bumpRateLimit(env.DB, `mobile-token:${identity.accountId}`, TOKEN_CREATE_LIMIT, RATE_WINDOW_MS))
  ) {
    return apiError("RATE_LIMITED", "操作太频繁，稍后再试", { retryable: true });
  }

  const now = Date.now();
  const candidate = newToken();
  const sealed = await sealSecret(key, candidate);
  const hash = await sha256B64u(candidate);

  // 并发安全：两个桌面首次打开时只有一个 INSERT 生效，两边都读回库里实际那条。
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO mobile_tokens (account_id, token_hash, key_version, iv, ciphertext, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(identity.accountId, hash, KEY_VERSION, sealed.iv, sealed.ciphertext, now)
    .run();
  const created = changes(inserted) === 1;

  const row = await readStoredToken(env.DB, identity.accountId);
  if (!row) {
    return noStore(
      apiError("INTERNAL", "令牌创建失败", {
        retryable: true,
        status: 503,
        reason: "mobile_token_missing",
      }),
    );
  }
  const token = await openSecret(key, row);
  if (!token) return corruptToken();

  await env.DB.prepare(
    "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'mobile.token_create', ?)",
  )
    .bind(now, identity.accountId, JSON.stringify({ created }))
    .run();

  return json({ token, created_at: Number(row.created_at), rotated_at: row.rotated_at ?? null });
}

async function rotateToken(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;

  const key = env.MOBILE_TOKEN_ENC_KEY;
  if (!key) return missingKey();
  if (identity.kind !== "email") {
    return apiError("PRECONDITION_FAILED", "请先用邮箱登录", { reason: "login_required" });
  }
  if (
    !(await bumpRateLimit(
      env.DB,
      `mobile-token-rotate:${identity.accountId}`,
      TOKEN_ROTATE_LIMIT,
      RATE_WINDOW_MS,
    ))
  ) {
    return apiError("RATE_LIMITED", "操作太频繁，稍后再试", { retryable: true });
  }

  const previous = await env.DB.prepare("SELECT created_at FROM mobile_tokens WHERE account_id = ?")
    .bind(identity.accountId)
    .first<{ created_at: number }>();

  const now = Date.now();
  const candidate = newToken();
  const sealed = await sealSecret(key, candidate);
  const hash = await sha256B64u(candidate);

  // 单行原子覆盖：旧哈希在同一条语句里消失，下次拉取立即 401。
  const updated = await env.DB.prepare(
    "UPDATE mobile_tokens SET token_hash = ?, iv = ?, ciphertext = ?, created_at = ?, rotated_at = ?, " +
      "last_used_at = NULL WHERE account_id = ?",
  )
    .bind(hash, sealed.iv, sealed.ciphertext, now, now, identity.accountId)
    .run();
  if (changes(updated) !== 1) {
    // 轮换发生在从未创建过令牌的账户上（例如库被重建过）：补一条，语义与创建一致。
    await env.DB.prepare(
      "INSERT OR IGNORE INTO mobile_tokens " +
        "(account_id, token_hash, key_version, iv, ciphertext, created_at, rotated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(identity.accountId, hash, KEY_VERSION, sealed.iv, sealed.ciphertext, now, now)
      .run();
  }

  const row = await readStoredToken(env.DB, identity.accountId);
  if (!row) {
    return noStore(
      apiError("INTERNAL", "令牌创建失败", {
        retryable: true,
        status: 503,
        reason: "mobile_token_missing",
      }),
    );
  }
  const token = await openSecret(key, row);
  if (!token) return corruptToken();

  await env.DB.prepare(
    "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'mobile.token_rotate', ?)",
  )
    .bind(
      now,
      identity.accountId,
      JSON.stringify({ previous_created_at: previous ? Number(previous.created_at) : null }),
    )
    .run();

  return json({ token, created_at: Number(row.created_at), rotated_at: row.rotated_at ?? now });
}

/// 模板与客户端的保留名：节点名撞上它们会让整份配置被拒（sing-box 重复 tag、mihomo 内建策略组）。
const RESERVED_TAGS: ReadonlySet<string> = new Set([
  "proxy",
  "direct",
  "veyl",
  "reject",
  "pass",
  "global",
  "reject-drop",
  "compatible",
  "match",
  "final",
]);

/** 重名按出现顺序追加 ` (2)`、` (3)`，并避开模板内建名；三种格式共用这一套。 */
function uniqueTag(name: string, used: Set<string>): string {
  // 名字为空时仍要给出合法 tag，否则整份配置会因空标签被客户端拒绝。
  const base = name.trim() || "节点";
  const taken = (candidate: string) =>
    used.has(candidate) || RESERVED_TAGS.has(candidate.toLowerCase());
  if (!taken(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function configResponse(config: unknown): Response {
  // 裸 sing-box 配置，不是 `{data:...}` 信封：官方客户端直接解析 body。
  return new Response(JSON.stringify(config, null, 2), {
    status: 200,
    headers: profileHeaders("application/json; charset=utf-8"),
  });
}

interface CredentialSecret {
  host?: string;
  port?: number;
  password?: string;
  method?: string;
}

export interface ExportedNode {
  tag: string;
  host: string;
  port: number;
  password: string;
}

interface LoadedProfile {
  /**
   * 查询命中且凭据有效的行数（JOIN 已排除缺失 / 已销毁的凭据）。
   * 为 0 时按「没有可用服务器」返回 200 空态——服务器还在但凭据没了同样不算故障，
   * 已销毁的服务器本就该从导出里消失。这是口径，不是 bug。
   */
  queried: number;
  nodes: ExportedNode[];
}

/**
 * 三种格式共用：Basic 认证、账户状态、共享限流预算、last_used_at 节流、
 * 节点查询与命名去重。失败时直接返回错误信封。
 */
async function loadProfileNodes(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<LoadedProfile | Response> {
  if (!env.MOBILE_TOKEN_ENC_KEY) return missingKey();
  const credentialKey = env.CREDENTIAL_ENC_KEY;
  if (!credentialKey) {
    return noStore(
      apiError("INTERNAL", "手机导出暂时不可用", {
        retryable: true,
        status: 503,
        reason: "credential_key_missing",
      }),
    );
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const password = basicPassword(request.headers.get("authorization"));
  if (!password) {
    if (!(await bumpRateLimit(env.DB, `mobile-profile-bad:${ip}`, PROFILE_BAD_LIMIT, RATE_WINDOW_MS))) {
      return profileRateLimited();
    }
    return unauthorized("basic_missing");
  }

  const hash = await sha256B64u(password);
  const row = await env.DB.prepare(
    "SELECT mt.account_id AS account_id, a.status AS status, a.merged_into AS merged_into " +
      "FROM mobile_tokens mt JOIN accounts a ON a.id = mt.account_id WHERE mt.token_hash = ?",
  )
    .bind(hash)
    .first<TokenAccountRow>();

  if (!row) {
    // 令牌无效按 IP 限流：只挡扫端点与刷日志，不暴露令牌是否存在。
    if (!(await bumpRateLimit(env.DB, `mobile-profile-bad:${ip}`, PROFILE_BAD_LIMIT, RATE_WINDOW_MS))) {
      return profileRateLimited();
    }
    return unauthorized("token_invalid");
  }
  if (row.merged_into) {
    return noStore(apiError("FORBIDDEN", "账户已合并", { reason: "account_merged" }));
  }
  if (row.status !== "active") {
    return noStore(apiError("FORBIDDEN", "账户已被停用", { reason: "account_blocked" }));
  }
  if (
    !(await bumpRateLimit(
      env.DB,
      `mobile-profile:${row.account_id}`,
      PROFILE_LIMIT,
      RATE_WINDOW_MS,
    ))
  ) {
    return profileRateLimited();
  }

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE mobile_tokens SET last_used_at = ? WHERE account_id = ? " +
      "AND (last_used_at IS NULL OR last_used_at < ?)",
  )
    .bind(now, row.account_id, now - LAST_USED_THROTTLE_MS)
    .run();

  const nodes = await env.DB.prepare(
    "SELECT s.id AS id, s.name AS name, s.created_at AS created_at, s.ip AS ip, " +
      "c.iv AS iv, c.ciphertext AS ciphertext " +
      "FROM servers s JOIN credentials c ON c.server_id = s.id AND c.destroyed_at IS NULL " +
      "WHERE s.account_id = ? AND s.state IN ('active', 'healthy') AND s.node_id IS NOT NULL " +
      "AND s.destroyed_at IS NULL ORDER BY s.created_at ASC, s.id ASC",
  )
    .bind(row.account_id)
    .all<NodeRow>();

  const exported: ExportedNode[] = [];
  const usedTags = new Set<string>();
  let skipped = 0;

  for (const node of nodes.results) {
    const opened = await openSecret(credentialKey, node);
    if (!opened) {
      skipped += 1;
      continue;
    }
    let secret: CredentialSecret;
    try {
      secret = JSON.parse(opened) as CredentialSecret;
    } catch {
      skipped += 1;
      continue;
    }
    if (secret.method !== SS_METHOD) {
      skipped += 1;
      continue;
    }
    const host = (secret.host ?? "").trim() || (node.ip ?? "").trim();
    if (!host || typeof secret.port !== "number" || !secret.password) {
      skipped += 1;
      continue;
    }
    exported.push({
      tag: uniqueTag(node.name, usedTags),
      host,
      port: secret.port,
      password: secret.password,
    });
  }

  if (skipped > 0) {
    // 只记数量与账户前 8 位：节点地址、凭据、令牌都不进日志。
    console.warn(`[mobile] profile_skipped count=${skipped} account=${row.account_id.slice(0, 8)}`);
  }

  return { queried: nodes.results.length, nodes: exported };
}

/** 查到了服务器却一台都导不出来：控制面/凭据故障，不能伪装成「没有节点」。 */
function unavailableProfile(): Response {
  return noStore(
    apiError("INTERNAL", "手机配置暂时无法生成", {
      retryable: true,
      status: 503,
      reason: "mobile_profile_unavailable",
    }),
  );
}

function profileHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

/** 错误响应也不允许缓存：与成功、401、429 保持同一套头。 */
function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

/** JSON 双引号标量就是合法的 YAML 双引号标量；但 JSON.stringify 不管 U+2028/U+2029 与 NEL/DEL。 */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // NEL 在 YAML 1.1 是换行符，DEL 是控制字符；留在双引号标量里会被部分解析器当成断行/非法。
    .replace(/\u0085/g, "\\u0085")
    .replace(/\u007f/g, "\\u007f");
}

/** 最小 Clash 配置：节点、select 组、国内分流 rule-provider 与兜底规则（§3.7.3）。 */
function clashYaml(nodes: ExportedNode[], origin: string): string {
  const lines: string[] = [];
  if (nodes.length === 0) {
    lines.push("proxies: []");
    lines.push("proxy-groups: []");
  } else {
    lines.push("proxies:");
    for (const node of nodes) {
      lines.push(`  - name: ${yamlScalar(node.tag)}`);
      lines.push("    type: ss");
      lines.push(`    server: ${yamlScalar(node.host)}`);
      lines.push(`    port: ${node.port}`);
      lines.push(`    cipher: ${SS_METHOD}`);
      lines.push(`    password: ${yamlScalar(node.password)}`);
      lines.push("    udp: true");
    }
    lines.push("proxy-groups:");
    lines.push(`  - name: ${yamlScalar("Veyl")}`);
    lines.push("    type: select");
    lines.push("    proxies:");
    for (const node of nodes) {
      lines.push(`      - ${yamlScalar(node.tag)}`);
    }
    // 国内分流用我们自己托管的 .mrs（mihomo MRS 格式），不依赖客户端从 GitHub 拉 geodata。
    lines.push("rule-providers:");
    lines.push("  cn-domain:");
    lines.push("    type: http");
    lines.push("    behavior: domain");
    lines.push("    format: mrs");
    lines.push(`    url: ${yamlScalar(`${origin}/rules/geosite-cn.mrs`)}`);
    lines.push(`    path: ${yamlScalar("./providers/cn-domain.mrs")}`);
    lines.push("    interval: 86400");
    lines.push("  cn-ip:");
    lines.push("    type: http");
    lines.push("    behavior: ipcidr");
    lines.push("    format: mrs");
    lines.push(`    url: ${yamlScalar(`${origin}/rules/geoip-cn.mrs`)}`);
    lines.push(`    path: ${yamlScalar("./providers/cn-ip.mrs")}`);
    lines.push("    interval: 86400");
  }
  lines.push("rules:");
  if (nodes.length > 0) {
    // 为什么不给 Clash 配 `dns`：`DOMAIN-SUFFIX`/`RULE-SET` 按域名或 IP 匹配，域名规则发生在解析之前，
    // DNS 走境外也照样直连；dns 块只会覆盖用户在 CMFA 里自己设的 DNS，并多出「policy 写错整块失效」
    // 的故障面。（sing-box 侧必须配，因为 geoip-cn 要匹配解析后的 IP。）
    // 不用 GEOIP：mihomo 的 geodata 默认从 GitHub 拉，拉不到时规则落空、全部流量照旧走代理且界面无异常。
    // provider 初始化失败时 mihomo 也只记日志：最后那条 `DOMAIN-SUFFIX,cn,DIRECT` 是兜底，保证至少
    // 不比没有 provider 时更差，所以它必须留在 RULE-SET 之后。
    lines.push(`  - ${yamlScalar("RULE-SET,cn-domain,DIRECT")}`);
    lines.push(`  - ${yamlScalar("RULE-SET,cn-ip,DIRECT")}`);
    lines.push(`  - ${yamlScalar("DOMAIN-SUFFIX,cn,DIRECT")}`);
  }
  lines.push(`  - ${yamlScalar(nodes.length === 0 ? "MATCH,DIRECT" : "MATCH,Veyl")}`);
  return `${lines.join("\n")}\n`;
}

/** RFC 3986 percent-encode：只保留 unreserved，空格是 %20 不是 +。 */
function percentEncode(value: string): string {
  let output = "";
  for (const byte of new TextEncoder().encode(value)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    output += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return output;
}

/** IPv6 必须加方括号再拼端口。 */
function sip002Host(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function ssLink(node: ExportedNode): string {
  const userinfo = b64u(new TextEncoder().encode(`${SS_METHOD}:${node.password}`));
  return `ss://${userinfo}@${sip002Host(node.host)}:${node.port}#${percentEncode(node.tag)}`;
}

/** SIP002，每节点一行；空态是 0 字节。 */
function ssList(nodes: ExportedNode[]): string {
  return nodes.length === 0 ? "" : `${nodes.map(ssLink).join("\n")}\n`;
}

/** 规则集与 profile 同一 origin；不写 download_detour（1.14 已废弃，1.16 移除）。 */
function cnRuleSets(origin: string) {
  return [
    {
      tag: "geosite-cn",
      type: "remote",
      format: "binary",
      url: `${origin}/rules/geosite-cn.srs`,
      update_interval: "7d",
    },
    {
      tag: "geoip-cn",
      type: "remote",
      format: "binary",
      url: `${origin}/rules/geoip-cn.srs`,
      update_interval: "7d",
    },
  ];
}

async function singboxProfile(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<Response> {
  const loaded = await loadProfileNodes(request, env);
  if (isResponse(loaded)) return loaded;

  if (loaded.nodes.length === 0) {
    if (loaded.queried > 0) return unavailableProfile();
    // 真的没有可用服务器：零节点必须是合法配置而不是 4xx，否则客户端会保留旧节点。
    return configResponse({
      log: { level: "warn" },
      outbounds: [{ type: "direct", tag: "direct" }],
      route: { final: "direct" },
    });
  }

  return configResponse(singboxConfig(loaded.nodes, new URL(request.url).origin));
}

/** 非零节点的 profile。抽成纯函数：运行期测试把这份配置交给真实内核启动。 */
export function singboxConfig(nodes: ExportedNode[], origin: string): unknown {
  const outbounds: ShadowsocksOutbound[] = nodes.map((node) => ({
    type: "shadowsocks",
    tag: node.tag,
    server: node.host,
    server_port: node.port,
    method: SS_METHOD,
    password: node.password,
  }));

  return {
    log: { level: "warn" },
    // 手机 DNS 常指向 LAN 路由器；没有这条，DNS 查询会被 final=proxy 送进隧道发往服务端内网。
    // DoH 走 proxy 出网，不用 UDP 53（避开运营商对非标端口 UDP 的限制）。
    // 国内域名走国内 DNS：否则解析出海外 IP，下面的 geoip-cn 规则永远不会命中。
    dns: {
      servers: [
        { type: "https", tag: "dns", server: "1.1.1.1", detour: "proxy" },
        // 不能写 `detour: "direct"`：空配置的 direct 出站不允许被显式 detour，
        // 1.14 启动即 FATAL（`detour to an empty direct outbound makes no sense`）。不写就是直连。
        { type: "udp", tag: "dns-cn", server: "223.5.5.5" },
      ],
      rules: [{ rule_set: ["geosite-cn"], server: "dns-cn" }],
      final: "dns",
    },
    // Apple / SFA 只在配置声明 TUN 入站时才创建系统隧道；auto_route 必须为真，
    // 否则客户端不会设置 NE/VpnService 的路由与 MTU（VPN 会显示已连接但没有流量）。
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.18.0.1/30", "fdfe:dcba:9876::1/126"],
        // stack 不能省：默认值下 Apple 平台的 TCP 走内核 NAT，握手不完成（桌面端同源结论）。
        stack: "gvisor",
        mtu: 9000,
        dns_mode: "hijack",
        dns_address: ["172.18.0.2", "fdfe:dcba:9876::2"],
        auto_route: true,
      },
    ],
    outbounds: [
      ...outbounds,
      {
        type: "selector",
        tag: "proxy",
        outbounds: outbounds.map((outbound) => outbound.tag),
        default: outbounds[0].tag,
      },
      { type: "direct", tag: "direct" },
    ],
    route: {
      final: "proxy",
      // TUN 入站 + 代理出站必须打开：否则出站 socket 不绑定物理网卡，会被路由回隧道。
      auto_detect_interface: true,
      // 1.14 起 remote rule_set 的域名 URL 必须有域名解析器，缺了整份配置被内核拒绝。
      // 作用域仅限内核自己拨号时的域名解析（规则集 URL、出站服务器域名），**不是**用户流量的 DNS；
      // 用户域名解析仍由 dns.rules + dns.final 决定。我们节点地址是 IP，所以实际只影响规则集 URL 那一次。
      // 用直连的国内 DNS，避免规则集下载依赖尚未建立的代理。
      default_domain_resolver: "dns-cn",
      rule_set: cnRuleSets(origin),
      // 顺序不可变：sniff 必须在 hijack-dns 之前，否则 `protocol: "dns"` 永不命中，
      // DNS 查询会被 final=proxy 原样送进隧道（桌面端同源规则，静默失效不报错）。
      // 国内域名 / 国内 IP 直连，其余仍走 proxy。
      rules: [
        { action: "sniff", sniffer: ["http", "tls", "quic", "dns"], timeout: "300ms" },
        { protocol: "dns", action: "hijack-dns" },
        // 国内 DNS 的查询必须直连：只靠 geoip-cn 可能不命中，查询就会经节点出去、拿到海外视角的解析结果。
        { ip_cidr: ["223.5.5.5/32"], action: "route", outbound: "direct" },
        { rule_set: ["geosite-cn", "geoip-cn"], action: "route", outbound: "direct" },
        { ip_is_private: true, action: "route", outbound: "direct" },
      ],
    },
  };
}

async function clashProfile(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<Response> {
  const loaded = await loadProfileNodes(request, env);
  if (isResponse(loaded)) return loaded;
  if (loaded.nodes.length === 0 && loaded.queried > 0) return unavailableProfile();
  return new Response(clashYaml(loaded.nodes, new URL(request.url).origin), {
    status: 200,
    headers: profileHeaders("text/yaml; charset=utf-8"),
  });
}

async function ssProfile(
  request: Request,
  env: MobileEnv & { DB: D1Database },
): Promise<Response> {
  const loaded = await loadProfileNodes(request, env);
  if (isResponse(loaded)) return loaded;
  if (loaded.nodes.length === 0 && loaded.queried > 0) return unavailableProfile();
  return new Response(ssList(loaded.nodes), {
    status: 200,
    headers: profileHeaders("text/plain; charset=utf-8"),
  });
}

export async function handleMobile(
  request: Request,
  env: MobileEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "mobile") return null;

  const post = request.method === "POST";
  const profileFormat =
    parts[2] === "profile" && request.method === "GET"
      ? parts.length === 3
        ? "singbox"
        : parts.length === 4 && (parts[3] === "clash" || parts[3] === "ss")
          ? parts[3]
          : null
      : null;
  const matched =
    (parts.length === 3 && parts[2] === "token" && post) ||
    (parts.length === 4 && parts[2] === "token" && parts[3] === "rotate" && post) ||
    profileFormat !== null;
  if (!matched) return null;

  if (!env.DB) {
    return noStore(
      apiError("INTERNAL", "服务还没准备好", {
        retryable: true,
        status: 503,
        reason: "db_unavailable",
      }),
    );
  }
  const ready: MobileEnv & { DB: D1Database } = { ...env, DB: env.DB };

  if (profileFormat === "clash") return clashProfile(request, ready);
  if (profileFormat === "ss") return ssProfile(request, ready);
  if (profileFormat === "singbox") return singboxProfile(request, ready);
  if (parts.length === 4) return rotateToken(request, ready);
  return createToken(request, ready);
}
