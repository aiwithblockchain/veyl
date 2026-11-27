import "reflect-metadata";

import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256B64u } from "../src/lib/crypto";
import { handleServers } from "../src/servers";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_cert0000000000000000";
const SERVER = "srv_cert000000000000000";
const ENROLL_TOKEN = "enr_cert000000000000";
const SERVER_TOKEN = "agt_cert000000000000";
const SERVER_IP = "203.0.113.7";
const ENC_KEY = "A".repeat(43);
const DAY_MS = 86_400_000;

interface TestRoot {
  certPem: string;
  keyPem: string;
  certificate: X509Certificate;
}

async function newKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

function toPem(der: ArrayBuffer, label: string): string {
  let binary = "";
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function newRoot(): Promise<TestRoot> {
  const keys = await newKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Veyl Test Root",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_650 * DAY_MS),
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });
  return {
    certPem: certificate.toString("pem"),
    keyPem: toPem(
      (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
      "PRIVATE KEY",
    ),
    certificate,
  };
}

async function newCsr(
  sans: { type: "ip" | "dns"; value: string }[],
  algorithm: "EC" | "RSA" = "EC",
): Promise<Uint8Array> {
  if (algorithm === "RSA") {
    const keys = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: "CN=veyl-node-agent",
      keys,
      signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      extensions: [new SubjectAlternativeNameExtension(sans)],
    });
    return new Uint8Array(csr.rawData);
  }
  return new Uint8Array(
    (
      await Pkcs10CertificateRequestGenerator.create({
        name: "CN=veyl-node-agent",
        keys: await newKeys(),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new SubjectAlternativeNameExtension(sans)],
      })
    ).rawData,
  );
}

function b64(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 直接指定扩展的 CSR：用来构造畸形 / 重复 SAN 这类真实 agent 不会发的东西。 */
async function customCsr(
  extensions: Extension[],
  name = "CN=veyl-node-agent",
): Promise<Uint8Array> {
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name,
    keys: await newKeys(),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions,
  });
  return new Uint8Array(csr.rawData);
}

/** 一个不是 GeneralNames 的 SAN 扩展值（DER OCTET STRING）。 */
function malformedSan(): Extension {
  return new Extension("2.5.29.17", false, new Uint8Array([0x04, 0x01, 0xff]).buffer);
}

function sanOf(certificate: X509Certificate): { type: string; value: string }[] {
  const extension = certificate.getExtension("2.5.29.17");
  if (!extension) return [];
  return new SubjectAlternativeNameExtension(extension.rawData).names.toJSON();
}

function seedServer(db: FakeD1, state = "booting") {
  db.rows("servers").push({
    id: SERVER,
    account_id: ACCOUNT,
    order_id: "ord_cert",
    provider: "digitalocean",
    provider_id: "4242",
    name: "证书测试",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    state,
    node_port: 30412,
    ip: SERVER_IP,
    node_id: null,
    enrollment_hash: null,
    enrollment_expires_at: null,
    enrollment_used_at: null,
    firewall_id: null,
    server_token_hash: null,
    control_port: null,
    cert_fingerprint: null,
    ca_pem: null,
    last_seen_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    destroyed_at: null,
  });
}

async function envFor(db: FakeD1, root: TestRoot | null) {
  const agentJwk = JSON.stringify(
    await crypto.subtle.exportKey(
      "jwk",
      (
        (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
          "sign",
          "verify",
        ])) as CryptoKeyPair
      ).privateKey,
    ),
  );
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    DO_API_TOKEN: "do-token",
    CREDENTIAL_ENC_KEY: ENC_KEY,
    AGENT_TOKEN_SIGNING_JWK: agentJwk,
    AGENT_TOKEN_KEY_ID: "agent-test",
    SING_BOX_VERSION: "1.14.4",
    SING_BOX_SHA256: "b".repeat(64),
    SING_BOX_DOWNLOAD_URL: "https://control.example.com/sing-box.tar.gz",
    ...(root ? { ROOT_CA_CERT_PEM: root.certPem, ROOT_CA_KEY_PEM: root.keyPem } : {}),
  };
}

async function seedEnrollment(db: FakeD1) {
  Object.assign(db.rows("servers")[0], {
    enrollment_hash: await sha256B64u(ENROLL_TOKEN),
    enrollment_expires_at: Date.now() + 60_000,
  });
}

function enrollRequest(csr?: string) {
  return new Request("https://example.com/v1/agent/enroll", {
    method: "POST",
    headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
    ...(csr === undefined ? {} : { body: JSON.stringify({ csr }) }),
  });
}

function certRequest(body: unknown, token = SERVER_TOKEN) {
  return new Request("https://example.com/v1/agent/cert", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedAgentToken(db: FakeD1): Promise<string> {
  db.rows("servers")[0].server_token_hash = await sha256B64u(SERVER_TOKEN);
  return SERVER_TOKEN;
}

async function publicKeyDer(certificate: X509Certificate): Promise<string> {
  // `certificate.publicKey` 是 @peculiar/x509 的 PublicKey 包装，不是 CryptoKey；
  // SPKI DER 直接取 rawData，正好用来比较两把公钥。
  return b64(new Uint8Array(certificate.publicKey.rawData));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("契约 §6：enroll 携带 CSR", () => {
  it("正常 CSR 签出由根签发的叶证书，SAN 由控制面构造", async () => {
    const db = new FakeD1();
    const root = await newRoot();
    const env = await envFor(db, root);
    seedServer(db);
    await seedEnrollment(db);
    const before = Date.now();

    const csr = await newCsr([
      { type: "ip", value: SERVER_IP },
      { type: "dns", value: "localhost" },
    ]);
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      cert_pem: string;
      ca_pem: string;
      server_token: string;
    };

    expect(body.ca_pem).toBe(root.certPem);
    const leaf = new X509Certificate(body.cert_pem);
    expect(leaf.issuer).toBe(root.certificate.subject);
    expect(await leaf.verify({ publicKey: root.certificate.publicKey })).toBe(true);
    expect(sanOf(leaf)).toEqual(
      expect.arrayContaining([
        { type: "ip", value: SERVER_IP },
        { type: "ip", value: "127.0.0.1" },
        { type: "dns", value: "localhost" },
      ]),
    );
    expect(sanOf(leaf)).toHaveLength(3);

    // 到期时间约 730 天，并写进 servers.cert_not_after（unix 秒）。
    const notAfterMs = leaf.notAfter.getTime();
    expect(notAfterMs - before).toBeGreaterThan(730 * DAY_MS - 60_000);
    expect(notAfterMs - before).toBeLessThan(730 * DAY_MS + 60_000);
    expect(db.rows("servers")[0].cert_not_after).toBe(Math.floor(notAfterMs / 1000));
  });

  it("不带 CSR 的 enroll 行为与今天一致，不返回证书", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const res = await handleServers(enrollRequest(), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.server_token).toBeTruthy();
    expect("cert_pem" in body).toBe(false);
    expect("ca_pem" in body).toBe(false);
    expect(db.rows("servers")[0].cert_not_after ?? null).toBeNull();
  });

  it("空对象 {} 按没带 CSR 处理（老 agent 语义）", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const res = await handleServers(
      new Request("https://example.com/v1/agent/enroll", {
        method: "POST",
        headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
        body: "{}",
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect("cert_pem" in ((await res!.json()) as Record<string, unknown>)).toBe(false);
  });

  it("请求体是 null / 数字 / 数组：400 invalid_json，不消费 token", async () => {
    for (const raw of ["null", "123", "[]", '"csr"']) {
      const db = new FakeD1();
      const env = await envFor(db, await newRoot());
      seedServer(db);
      await seedEnrollment(db);

      const res = await handleServers(
        new Request("https://example.com/v1/agent/enroll", {
          method: "POST",
          headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
          body: raw,
        }),
        env as never,
      );
      expect(res?.status, raw).toBe(400);
      expect(await res!.json(), raw).toMatchObject({ reason: "invalid_json" });
      expect(db.rows("servers")[0].enrollment_used_at, raw).toBeNull();
    }
  });

  it("CSR 带 SAN=accounts.google.com：403 san_rejected，写审计，不销毁也不消费 token", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const csr = await newCsr([
      { type: "ip", value: SERVER_IP },
      { type: "dns", value: "accounts.google.com" },
    ]);
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ ok: false, reason: "san_rejected" });

    const audit = db.rows("audit_log").find((row) => row.action === "agent.cert.san_rejected");
    expect(audit).toBeTruthy();
    expect(JSON.parse(String(audit!.detail))).toMatchObject({
      requested: ["dns:accounts.google.com"],
    });
    const server = db.rows("servers")[0];
    expect(server.destroyed_at).toBeNull();
    expect(server.enrollment_used_at).toBeNull();
    expect(server.state).toBe("booting");
  });

  it("CSR 带别的 IP：403 san_rejected", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const csr = await newCsr([{ type: "ip", value: "198.51.100.9" }]);
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "san_rejected" });
  });

  it("RSA CSR：400 unsupported_key", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const csr = await newCsr([{ type: "ip", value: SERVER_IP }], "RSA");
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "unsupported_key" });
    expect(db.rows("servers")[0].enrollment_used_at).toBeNull();
  });

  it("篡改签名的 CSR：400 csr_signature_invalid", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    csr[csr.length - 1] ^= 0xff;
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "csr_signature_invalid" });
  });

  it("根证书没配：503 root_missing，不消费 token", async () => {
    const db = new FakeD1();
    const env = await envFor(db, null);
    seedServer(db);
    await seedEnrollment(db);

    const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const res = await handleServers(enrollRequest(b64(csr)), env as never);
    expect(res?.status).toBe(503);
    expect(await res!.json()).toMatchObject({ reason: "root_missing" });
    expect(db.rows("servers")[0].enrollment_used_at).toBeNull();
  });

  it("enroll 重放带 CSR 也返回证书，并刷新 cert_not_after", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    const firstCsr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const first = await handleServers(enrollRequest(b64(firstCsr)), env as never);
    expect(first?.status).toBe(200);
    const firstCert = new X509Certificate(
      ((await first!.json()) as { cert_pem: string }).cert_pem,
    );

    const replayCsr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const replay = await handleServers(enrollRequest(b64(replayCsr)), env as never);
    expect(replay?.status).toBe(200);
    const replayBody = (await replay!.json()) as { cert_pem: string };
    const replayCert = new X509Certificate(replayBody.cert_pem);

    expect(await publicKeyDer(replayCert)).not.toBe(await publicKeyDer(firstCert));
    expect(db.rows("servers")[0].cert_not_after).toBe(
      Math.floor(replayCert.notAfter.getTime() / 1000),
    );
  });

  it("IP 变更后重放：SAN 跟随 row.ip，不用凭据里的旧 host", async () => {
    const db = new FakeD1();
    const env = await envFor(db, await newRoot());
    seedServer(db);
    await seedEnrollment(db);

    // 首次 enroll 写入凭据，host 是旧 IP。
    const first = await handleServers(
      enrollRequest(b64(await newCsr([{ type: "ip", value: SERVER_IP }]))),
      env as never,
    );
    expect(first?.status).toBe(200);
    expect(db.rows("credentials")[0]).toBeTruthy();

    db.rows("servers")[0].ip = "198.51.100.7";
    const replay = await handleServers(
      enrollRequest(b64(await newCsr([{ type: "ip", value: "198.51.100.7" }]))),
      env as never,
    );
    expect(replay?.status).toBe(200);
    const leaf = new X509Certificate(
      ((await replay!.json()) as { cert_pem: string }).cert_pem,
    );
    expect(sanOf(leaf)).toContainEqual({ type: "ip", value: "198.51.100.7" });
    expect(sanOf(leaf)).not.toContainEqual({ type: "ip", value: SERVER_IP });
  });
});

describe("契约 §6：POST /v1/agent/cert", () => {
  async function certEnv(options: { destroyed?: boolean; withRoot?: boolean } = {}) {
    const db = new FakeD1();
    const env = await envFor(db, options.withRoot === false ? null : await newRoot());
    seedServer(db, "active");
    db.rows("servers")[0].enrollment_used_at = Date.now();
    if (options.destroyed) db.rows("servers")[0].destroyed_at = Date.now();
    await seedAgentToken(db);
    return { db, env };
  }

  it("正常签发：返回叶证书、根证书与 not_after，并写 cert_not_after", async () => {
    const { db, env } = await certEnv();
    const before = Date.now();
    // agent 实际的 SAN 形态：127.0.0.1 是按 IpAddr 发的 IP SAN，不是 DNS 名。
    const csr = await newCsr([
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
      { type: "ip", value: SERVER_IP },
    ]);

    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      ok: boolean;
      cert_pem: string;
      ca_pem: string;
      not_after: number;
    };
    expect(body.ok).toBe(true);
    const leaf = new X509Certificate(body.cert_pem);
    expect(leaf.issuer).toBe(new X509Certificate(body.ca_pem).subject);
    expect(await leaf.verify({ publicKey: new X509Certificate(body.ca_pem).publicKey })).toBe(
      true,
    );
    expect(body.not_after).toBe(Math.floor(leaf.notAfter.getTime() / 1000));
    expect(body.not_after * 1000 - before).toBeGreaterThan(730 * DAY_MS - 60_000);
    expect(body.not_after * 1000 - before).toBeLessThan(730 * DAY_MS + 60_000);
    expect(db.rows("servers")[0].cert_not_after).toBe(body.not_after);

    // 成功签发要留审计：只放 not_after 与指纹，不放 PEM。
    const audit = db.rows("audit_log").find((row) => row.action === "agent.cert.issued");
    expect(audit).toBeTruthy();
    const detail = JSON.parse(String(audit!.detail)) as Record<string, unknown>;
    expect(detail).toMatchObject({
      not_after: body.not_after,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(detail)).not.toContain("BEGIN CERTIFICATE");
  });

  it("同一台连续两次签发：公钥不同（每次续期换 key）", async () => {
    const { env } = await certEnv();
    const first = (await (
      await handleServers(certRequest({ csr: b64(await newCsr([{ type: "ip", value: SERVER_IP }])) }), env as never)
    )!.json()) as { cert_pem: string };
    const second = (await (
      await handleServers(certRequest({ csr: b64(await newCsr([{ type: "ip", value: SERVER_IP }])) }), env as never)
    )!.json()) as { cert_pem: string };

    const firstKey = await publicKeyDer(new X509Certificate(first.cert_pem));
    const secondKey = await publicKeyDer(new X509Certificate(second.cert_pem));
    expect(secondKey).not.toBe(firstKey);
  });

  it("CSR 带 SAN=accounts.google.com：403，写审计", async () => {
    const { db, env } = await certEnv();
    const csr = await newCsr([
      { type: "ip", value: SERVER_IP },
      { type: "dns", value: "accounts.google.com" },
    ]);

    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "san_rejected" });
    expect(db.rows("audit_log").some((row) => row.action === "agent.cert.san_rejected")).toBe(
      true,
    );
  });

  it("CSR 带别的 IP：403 san_rejected", async () => {
    const { env } = await certEnv();
    const csr = await newCsr([{ type: "ip", value: "198.51.100.9" }]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "san_rejected" });
  });

  it("RSA CSR：400 unsupported_key", async () => {
    const { env } = await certEnv();
    const csr = await newCsr([{ type: "ip", value: SERVER_IP }], "RSA");
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "unsupported_key" });
  });

  it("篡改签名的 CSR：400 csr_signature_invalid", async () => {
    const { env } = await certEnv();
    const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    csr[csr.length - 1] ^= 0xff;
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "csr_signature_invalid" });
  });

  it("鉴权与请求体错误：401 / 409 / 400", async () => {
    const { db, env } = await certEnv();
    const csr = b64(await newCsr([{ type: "ip", value: SERVER_IP }]));

    const noToken = new Request("https://example.com/v1/agent/cert", { method: "POST" });
    expect((await handleServers(noToken, env as never))!.status).toBe(401);
    expect(
      await (await handleServers(certRequest({ csr }, "agt_unknown"), env as never))!.json(),
    ).toMatchObject({ reason: "unknown_token" });
    expect(
      await (await handleServers(certRequest("{not json"), env as never))!.json(),
    ).toMatchObject({ reason: "invalid_json" });
    expect(
      await (await handleServers(certRequest({}), env as never))!.json(),
    ).toMatchObject({ reason: "csr_invalid" });

    db.rows("servers")[0].destroyed_at = Date.now();
    const destroyed = await handleServers(certRequest({ csr }), env as never);
    expect(destroyed!.status).toBe(409);
    expect(await destroyed!.json()).toMatchObject({ reason: "destroyed" });
  });

  it("根证书没配：503 root_missing", async () => {
    const { env } = await certEnv({ withRoot: false });
    const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(503);
    expect(await res!.json()).toMatchObject({ reason: "root_missing" });
  });

  it("SAN 扩展无法解析：400 csr_invalid，不是 503", async () => {
    const { env } = await certEnv();
    const csr = await customCsr([malformedSan()]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "csr_invalid" });
  });

  it("SAN 扩展存在但为空：拒签，不静默跳过", async () => {
    const { env } = await certEnv();
    const csr = await customCsr([new SubjectAlternativeNameExtension([])]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "csr_invalid" });
  });

  it("两个 SAN 扩展：403 san_rejected，写审计", async () => {
    const { db, env } = await certEnv();
    const csr = await customCsr([
      new SubjectAlternativeNameExtension([{ type: "ip", value: SERVER_IP }]),
      new SubjectAlternativeNameExtension([{ type: "ip", value: SERVER_IP }]),
    ]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "san_rejected" });
    const audit = db.rows("audit_log").find((row) => row.action === "agent.cert.san_rejected");
    expect(audit).toBeTruthy();
    expect(JSON.parse(String(audit!.detail))).toMatchObject({ san_extensions: 2 });
  });

  it("subject 固定为 CN=veyl-node-agent，不跟 CSR 的 CN 走", async () => {
    const { env } = await certEnv();
    const csr = await customCsr(
      [new SubjectAlternativeNameExtension([{ type: "ip", value: SERVER_IP }])],
      "CN=accounts.google.com",
    );
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(200);
    const leaf = new X509Certificate(((await res!.json()) as { cert_pem: string }).cert_pem);
    expect(leaf.subject).toBe("CN=veyl-node-agent");
  });

  it("同一台 5 分钟内第 4 次签发：429 rate_limited", async () => {
    const { env } = await certEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
      const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
      statuses.push(res!.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it("请求体超过 64 KB：400 invalid_json", async () => {
    const { env } = await certEnv();
    const res = await handleServers(
      certRequest({ csr: "A".repeat(70 * 1024) }),
      env as never,
    );
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "invalid_json" });
  });

  it("IP 还没回填：向 DO 补查后用补查到的地址签，并写回 servers.ip", async () => {
    const { db, env } = await certEnv();
    db.rows("servers")[0].ip = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              droplet: {
                id: 4242,
                status: "active",
                networks: { v4: [{ ip_address: "198.51.100.7", type: "public" }] },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const csr = await newCsr([{ type: "ip", value: "198.51.100.7" }]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(200);
    const leaf = new X509Certificate(((await res!.json()) as { cert_pem: string }).cert_pem);
    expect(sanOf(leaf)).toContainEqual({ type: "ip", value: "198.51.100.7" });
    expect(db.rows("servers")[0].ip).toBe("198.51.100.7");
  });

  it("IP 为空且补查不到：503 host_unavailable，不静默签 localhost-only 证书", async () => {
    const { db, env } = await certEnv();
    db.rows("servers")[0].ip = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "not_found" }), { status: 404 })),
    );

    const csr = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const res = await handleServers(certRequest({ csr: b64(csr) }), env as never);
    expect(res?.status).toBe(503);
    expect(await res!.json()).toMatchObject({ reason: "host_unavailable" });
    expect(db.rows("servers")[0].cert_not_after ?? null).toBeNull();
  });
});
