// 运维只读票：用运维 worker 自己的 Ed25519 私钥签 EdDSA JWT。
// 签出来的票只用于 agent 的 get_status，不做任何写操作。

const encoder = new TextEncoder();

export interface OpsTicket {
  jwt: string;
  jti: string;
  exp: number;
}

export const TICKET_TTL_SECONDS = 3600;

function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uJson(value: unknown): string {
  return b64u(encoder.encode(JSON.stringify(value)));
}

/** jti 只需要唯一，不需要可猜。16 字节随机足够，且不带任何服务器信息。 */
export function newJti(seed: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  return `jti_${b64u(seed)}`;
}

async function importOpsKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") {
    throw new Error("OPS_TOKEN_SIGNING_JWK is not an Ed25519 private JWK");
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}

/**
 * claims 只有三个字段（agent 只认这三个）：server_id 绑定机器、jti 供审计、
 * exp 一小时。业务票的签名密钥完全不参与。
 */
export async function signOpsTicket(
  jwkJson: string,
  serverId: string,
  nowSeconds: number,
  jti: string = newJti(),
): Promise<OpsTicket> {
  const key = await importOpsKey(jwkJson);
  const exp = nowSeconds + TICKET_TTL_SECONDS;
  const header = b64uJson({ alg: "EdDSA", typ: "JWT" });
  const payload = b64uJson({ server_id: serverId, jti, exp });
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(`${header}.${payload}`)),
  );
  return { jwt: `${header}.${payload}.${b64u(signature)}`, jti, exp };
}

/**
 * 给运维直接粘贴的命令。信任锚是统一根证书 `veyl-root-cert.pem`，
 * 所以必须带 --cacert；body 是 agent 的 MCP get_status 调用。
 */
export function buildCurl(ip: string, port: number, jwt: string): string {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_status", arguments: {} },
  });
  return [
    "curl -sS --cacert veyl-root-cert.pem \\",
    "  -H 'content-type: application/json' \\",
    "  -H 'accept: application/json, text/event-stream' \\",
    `  -H 'authorization: Bearer ${jwt}' \\`,
    `  -d '${body}' \\`,
    `  https://${ip}:${port}/mcp`,
  ].join("\n");
}
