// 基础编码与密码学工具：设备令牌、JWT 签名、凭据加密。
// 只用 Web Crypto，不引第三方库（Workers 运行时与 Node 测试环境都自带）。

export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 形如 `dev_xxx` / `srv_xxx` 的标识；前缀只用于人眼区分，不参与校验。 */
export function randomId(prefix: string, size = 16): string {
  return `${prefix}${b64u(randomBytes(size))}`;
}

export async function sha256B64u(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64u(new Uint8Array(digest));
}

export interface AccessClaims {
  sub: string;
  did: string;
  iat: number;
  exp: number;
  jti: string;
}

const encoder = new TextEncoder();

function jsonPart(value: unknown): string {
  return b64u(encoder.encode(JSON.stringify(value)));
}

async function ed25519Key(jwkJson: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  // 验签只认 x（公钥）；签名用 d。同一个 JWK 去掉 d 即可当公钥导入。
  const material: JsonWebKey = usage === "sign" ? jwk : { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey("jwk", material, { name: "Ed25519" }, false, [
    usage === "sign" ? "sign" : "verify",
  ]);
}

export async function signAccessToken(jwkJson: string, claims: AccessClaims): Promise<string> {
  const header = jsonPart({ alg: "EdDSA", typ: "JWT" });
  const payload = jsonPart(claims);
  const data = encoder.encode(`${header}.${payload}`);
  const key = await ed25519Key(jwkJson, "sign");
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, data);
  return `${header}.${payload}.${b64u(new Uint8Array(signature))}`;
}

export async function verifyAccessToken(
  jwkJson: string,
  token: string,
  now = Date.now(),
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const key = await ed25519Key(jwkJson, "verify");
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromB64u(signature),
      encoder.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as AccessClaims;
    if (typeof claims.sub !== "string" || typeof claims.did !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

/** 对任意字节做分离式签名（凭据下发用），返回 base64url。 */
export async function signDetached(jwkJson: string, data: string): Promise<string> {
  const key = await ed25519Key(jwkJson, "sign");
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(data));
  return b64u(new Uint8Array(signature));
}

export interface SealedSecret {
  iv: string;
  ciphertext: string;
}

export async function sealSecret(keyB64: string, plaintext: string): Promise<SealedSecret> {
  const key = await crypto.subtle.importKey("raw", fromB64u(keyB64), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return { iv: b64u(iv), ciphertext: b64u(new Uint8Array(ciphertext)) };
}

export async function openSecret(
  keyB64: string,
  sealed: SealedSecret,
): Promise<string | null> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64u(keyB64), { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64u(sealed.iv) },
      key,
      fromB64u(sealed.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
