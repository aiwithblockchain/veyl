import "reflect-metadata";

import { readFileSync } from "node:fs";

import { AsnConvert } from "@peculiar/asn1-schema";
import {
  GeneralName as AsnGeneralName,
  GeneralNames as AsnGeneralNames,
  OtherName,
} from "@peculiar/asn1-x509";
import {
  BasicConstraintsExtension,
  Extension,
  GeneralNames,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { describe, expect, it } from "vitest";

import {
  assertSanAllowed,
  CertError,
  fingerprintOf,
  issueLeaf,
  loadRoot,
  type RootCa,
} from "../src/certs";

const SERVER_IP = "203.0.113.7";

/** 真实 agent（rcgen 0.14）生成的 CSR，由 `agent/testdata/` 固化；公网 IP 与上面一致。 */
const REAL_CSR_DER = new Uint8Array(
  readFileSync(new URL("../../../agent/testdata/agent-rcgen-csr.der", import.meta.url)),
);
const REAL_CSR_B64 = readFileSync(
  new URL("../../../agent/testdata/agent-rcgen-csr.b64", import.meta.url),
  "utf8",
).trim();

async function newKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

async function newRoot(): Promise<{ root: RootCa; certPem: string; keyPem: string }> {
  const keys = await newKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Veyl Test Root",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_650 * 86_400_000),
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });
  const keyPem = toPem(
    (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
  return {
    root: { certificate, signingKey: keys.privateKey },
    certPem: certificate.toString("pem"),
    keyPem,
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
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: "CN=veyl-node-agent",
    keys: await newKeys(),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [new SubjectAlternativeNameExtension(sans)],
  });
  return new Uint8Array(csr.rawData);
}

/** 直接塞原始扩展的 CSR：用来造真实 agent 不会发、但库会静默跳过的形态。 */
async function newCsrWith(extensions: Extension[]): Promise<Uint8Array> {
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: "CN=veyl-node-agent",
    keys: await newKeys(),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions,
  });
  return new Uint8Array(csr.rawData);
}

/** 一个合法 IP + 一个 otherName：@peculiar/x509 只认前者，后者会被逐条跳过。 */
function sanWithUnknownName(ip: string): Extension {
  const names = new AsnGeneralNames();
  names.push(new AsnGeneralName({ iPAddress: ip }));
  names.push(
    new AsnGeneralName({
      otherName: new OtherName({ typeId: "1.2.3.4", value: new Uint8Array([0x05, 0x00]).buffer }),
    }),
  );
  return new Extension("2.5.29.17", false, AsnConvert.serialize(names));
}

function toPem(der: ArrayBuffer, label: string): string {
  let binary = "";
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function sanOf(certificate: X509Certificate): { type: string; value: string }[] {
  const extension = certificate.getExtension("2.5.29.17");
  if (!extension) return [];
  return new SubjectAlternativeNameExtension(extension.rawData).names.toJSON();
}

describe("issueLeaf", () => {
  it("用根签发，SAN 由控制面构造", async () => {
    const { root } = await newRoot();
    const before = Date.now();
    const leaf = await issueLeaf(root, {
      csrDer: await newCsr([
        { type: "ip", value: SERVER_IP },
        { type: "dns", value: "localhost" },
      ]),
      serverIps: [SERVER_IP],
    });

    const certificate = new X509Certificate(leaf.certPem);
    expect(certificate.issuer).toBe(root.certificate.subject);
    expect(certificate.subject).toBe("CN=veyl-node-agent");
    expect(await certificate.verify({ publicKey: root.certificate.publicKey })).toBe(true);

    expect(sanOf(certificate)).toEqual(
      expect.arrayContaining([
        { type: "ip", value: SERVER_IP },
        { type: "ip", value: "127.0.0.1" },
        { type: "dns", value: "localhost" },
      ]),
    );
    // 控制面自己拼的名字，不会多也不会少。
    expect(sanOf(certificate)).toHaveLength(3);

    expect(leaf.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(leaf.fingerprint).toBe(await fingerprintOf(certificate));

    const twoYears = 730 * 86_400_000;
    const notAfterMs = leaf.notAfter * 1000;
    expect(notAfterMs - before).toBeGreaterThan(twoYears - 60_000);
    expect(notAfterMs - before).toBeLessThan(twoYears + 60_000);
  });

  it("CSR 申请了别的域名就拒签", async () => {
    const { root } = await newRoot();
    const csrDer = await newCsr([
      { type: "ip", value: SERVER_IP },
      { type: "dns", value: "accounts.google.com" },
    ]);

    await expect(issueLeaf(root, { csrDer, serverIps: [SERVER_IP] })).rejects.toMatchObject({
      name: "CertError",
      reason: "san_rejected",
    });
  });

  it("CSR 申请了别的 IP 也拒签", async () => {
    const { root } = await newRoot();
    const csrDer = await newCsr([{ type: "ip", value: "198.51.100.9" }]);

    await expect(issueLeaf(root, { csrDer, serverIps: [SERVER_IP] })).rejects.toMatchObject({
      reason: "san_rejected",
    });
  });

  it("接受 agent 实际发送的三条 SAN：localhost + 127.0.0.1 + 公网 IP", async () => {
    // agent/src/cert.rs 的 canonical_hosts() 把 127.0.0.1 解析成 IpAddr，发的是 IP SAN；
    // 这里按它的真实形态来，防止控制面把本机 IP 当越权域名拒掉。
    const { root } = await newRoot();
    const csrDer = await newCsr([
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
      { type: "ip", value: SERVER_IP },
    ]);

    const leaf = await issueLeaf(root, { csrDer, serverIps: [SERVER_IP] });
    const certificate = new X509Certificate(leaf.certPem);
    expect(sanOf(certificate)).toEqual(
      expect.arrayContaining([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
        { type: "ip", value: SERVER_IP },
      ]),
    );
  });

  it("真实 rcgen CSR（固化 fixture）能签出来，且 SAN 真的被校验过", async () => {
    // 这只 CSR 由真实 agent 的 rcgen 产出，不是测试自己拼的。
    const decoded = Array.from(atob(REAL_CSR_B64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(Array.from(REAL_CSR_DER));

    const csr = new Pkcs10CertificateRequest(REAL_CSR_DER);

    // 只断言叶证书的 SAN 证明不了 CSR 被检查过：叶 SAN 是控制面用 `issuedNames`
    // 自己拼的，就算 `getExtensions` 返回空、校验提前 return，叶上也照样是这三条。
    const sanExtensions = csr.getExtensions("2.5.29.17");
    expect(sanExtensions).toHaveLength(1);
    expect(new GeneralNames(sanExtensions[0].value).items).toHaveLength(3);

    // 最关键的一条：不给这台机器的 IP 时，CSR 里那个公网 IP 必须被拒。
    // 如果 SAN 根本没被读到，这里就不会抛。
    try {
      assertSanAllowed(csr, []);
      expect.unreachable("空 serverIps 下 CSR 里的公网 IP 必须被拒");
    } catch (error) {
      expect(error).toMatchObject({
        reason: "san_rejected",
        rejectedNames: [`ip:${SERVER_IP}`],
      });
    }

    // 给了正确 IP 就放行，并真的签出由根签发的叶证书。
    expect(() => assertSanAllowed(csr, [SERVER_IP])).not.toThrow();
    const { root } = await newRoot();
    const leaf = await issueLeaf(root, { csrDer: REAL_CSR_DER, serverIps: [SERVER_IP] });
    const certificate = new X509Certificate(leaf.certPem);
    expect(certificate.issuer).toBe(root.certificate.subject);
    expect(await certificate.verify({ publicKey: root.certificate.publicKey })).toBe(true);
    expect(certificate.subject).toBe("CN=veyl-node-agent");
    expect(sanOf(certificate)).toEqual(
      expect.arrayContaining([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
        { type: "ip", value: SERVER_IP },
      ]),
    );
  });

  it("没有 SAN 扩展的 CSR 照样签，SAN 全由控制面构造", async () => {
    // SAN 本来就不采信 CSR：不带 SAN 是合法请求，必须放行。这条守住 `assertSanAllowed`
    // 的早退——若有人为了堵「静默跳过」删掉它，这里会变成 400。
    const csrDer = await newCsrWith([]);
    expect(new Pkcs10CertificateRequest(csrDer).getExtensions("2.5.29.17")).toHaveLength(0);

    const { root } = await newRoot();
    const leaf = await issueLeaf(root, { csrDer, serverIps: [SERVER_IP] });
    const certificate = new X509Certificate(leaf.certPem);
    expect(sanOf(certificate)).toEqual([
      { type: "ip", value: SERVER_IP },
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
    ]);
  });

  it("SAN 里混了无法识别的 GeneralName：按越权拒签，不能静默跳过", async () => {
    const { root } = await newRoot();
    const csrDer = await newCsrWith([sanWithUnknownName(SERVER_IP)]);

    try {
      await issueLeaf(root, { csrDer, serverIps: [SERVER_IP] });
      expect.unreachable("otherName 必须被拒");
    } catch (error) {
      expect(error).toBeInstanceOf(CertError);
      expect(error).toMatchObject({
        reason: "san_rejected",
        auditDetail: { raw_names: 2, recognized_names: 1 },
      });
    }
  });

  it("多个 extensionRequest 属性：按越权拒签（库只读第一个属性）", () => {
    const fake = {
      getAttributes: (oid: string) =>
        oid === "1.2.840.113549.1.9.14" ? [{}, {}] : [],
      getExtensions: () => [],
    } as unknown as Pkcs10CertificateRequest;

    try {
      assertSanAllowed(fake, [SERVER_IP]);
      expect.unreachable("多个 extensionRequest 必须被拒");
    } catch (error) {
      expect(error).toMatchObject({
        reason: "san_rejected",
        auditDetail: { extension_request_attributes: 2 },
      });
    }
  });

  it("只接受 ECDSA P-256", async () => {
    const { root } = await newRoot();
    const csrDer = await newCsr([{ type: "ip", value: SERVER_IP }], "RSA");

    await expect(issueLeaf(root, { csrDer, serverIps: [SERVER_IP] })).rejects.toMatchObject({
      reason: "unsupported_key",
    });
  });

  it("CSR 签名被改过就拒签", async () => {
    const { root } = await newRoot();
    const csrDer = await newCsr([{ type: "ip", value: SERVER_IP }]);
    const tampered = csrDer.slice();
    tampered[tampered.length - 1] ^= 0xff;

    await expect(issueLeaf(root, { csrDer: tampered, serverIps: [SERVER_IP] })).rejects.toBeInstanceOf(
      CertError,
    );
  });
});

describe("loadRoot", () => {
  it("从 PEM 读回根证书与私钥", async () => {
    const { certPem, keyPem } = await newRoot();
    const root = await loadRoot(certPem, keyPem);
    expect(root.certificate.subject).toBe("CN=Veyl Test Root");
    expect(root.signingKey.algorithm.name).toBe("ECDSA");
  });

  it("拒绝不是 CA 的证书", async () => {
    const keys = await newKeys();
    const leaf = await X509CertificateGenerator.createSelfSigned({
      serialNumber: "02",
      name: "CN=Not A CA",
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 86_400_000),
      keys,
    });
    const keyPem = toPem(
      (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
      "PRIVATE KEY",
    );

    await expect(loadRoot(leaf.toString("pem"), keyPem)).rejects.toMatchObject({
      reason: "root_invalid",
    });
  });

  it("证书与私钥不配对就拒绝（混贴 secret 会签出链不上的叶证书）", async () => {
    const a = await newRoot();
    const b = await newRoot();

    await expect(loadRoot(a.certPem, b.keyPem)).rejects.toMatchObject({
      reason: "root_invalid",
    });
  });
});

// Pkcs10CertificateRequest 在测试里只用来确认生成的 CSR 本身可读，避免测试自己就坏掉。
describe("fixture sanity", () => {
  it("生成的 CSR 能被独立解析", async () => {
    const csr = new Pkcs10CertificateRequest(await newCsr([{ type: "ip", value: SERVER_IP }]));
    expect(csr.subject).toBe("CN=veyl-node-agent");
    expect(await csr.verify()).toBe(true);
  });
});
