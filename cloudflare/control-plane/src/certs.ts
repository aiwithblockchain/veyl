//! 控制面签发：把 agent 的 CSR 签成一张由统一根签发的叶证书。
//!
//! 唯一要记住的约束：**SAN 由这里构造，不采信 CSR**。根证书会被装进浏览器，
//! 对所有站点生效；如果签发权跟着 CSR 走，任何一台节点都能申请别的域名。
//! CSR 里的 subjectAltNames 只用来判断「有没有申请不该申请的东西」，不参与签发。

import "reflect-metadata";

import { AsnConvert } from "@peculiar/asn1-schema";
import { GeneralNames as AsnGeneralNames } from "@peculiar/asn1-x509";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  Extension,
  GeneralNames,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";

export type CertFailure =
  | "root_invalid"
  | "csr_invalid"
  | "csr_signature_invalid"
  | "unsupported_key"
  | "san_rejected"
  | "sign_failed";

export class CertError extends Error {
  readonly reason: CertFailure;
  /** `san_rejected` 时被拒的名字（`type:value`），供调用方写审计。 */
  readonly rejectedNames: string[];
  /** 额外进审计的结构化字段（名字条数这类无法用字符串表达的信息）。 */
  readonly auditDetail: Record<string, unknown>;

  constructor(
    reason: CertFailure,
    message: string,
    rejectedNames: string[] = [],
    auditDetail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CertError";
    this.reason = reason;
    this.rejectedNames = rejectedNames;
    this.auditDetail = auditDetail;
  }
}

export interface RootCa {
  certificate: X509Certificate;
  signingKey: CryptoKey;
}

export interface IssueLeafOptions {
  /** rcgen 输出的 DER，不做 PEM 转换。 */
  csrDer: Uint8Array;
  /** 这台机器的公网地址。只有这些地址会进叶证书。 */
  serverIps: string[];
  now?: Date;
  days?: number;
}

export interface IssuedLeaf {
  certPem: string;
  /** DER 的 SHA-256，小写十六进制——和 agent 侧 `leaf_fingerprint` 同格式。 */
  fingerprint: string;
  /** unix 秒。 */
  notAfter: number;
}

/** 叶证书固定带上的本机地址。与 agent 之前的自签叶证书保持一致。 */
const LOCAL_DNS = "localhost";
const LOCAL_IPV4 = "127.0.0.1";
/** 契约 §3：叶证书 2 年。续期窗口只有 30 天，签短了会频繁回源。 */
const DEFAULT_DAYS = 730;
/** 回拨一点起始时间，抵消节点与控制面的时钟差。 */
const NOT_BEFORE_SKEW_MS = 5 * 60_000;
/** `getExtension` 按 OID 匹配；库里的 `NAME` 是给人看的字符串，不能拿来查。 */
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
/** extensionRequest 属性：CSR 里的扩展都装在这里，库只读第一个属性。 */
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";

export function pemToDer(pem: string, label = "CERTIFICATE"): Uint8Array {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const start = pem.indexOf(begin);
  const stop = pem.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    throw new CertError("root_invalid", `缺少 ${begin} 块`);
  }
  const base64 = pem.slice(start + begin.length, stop).replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new CertError("root_invalid", "PEM base64 无法解码");
  }
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  return der;
}

export async function loadRoot(certPem: string, keyPem: string): Promise<RootCa> {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
  } catch {
    throw new CertError("root_invalid", "根证书无法解析");
  }

  const basic = certificate.getExtension(OID_BASIC_CONSTRAINTS);
  if (!basic || !new BasicConstraintsExtension(basic.rawData).ca) {
    throw new CertError("root_invalid", "根证书不是 CA");
  }

  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(keyPem, "PRIVATE KEY"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new CertError("root_invalid", "根私钥无法导入（只接受 PKCS#8 ECDSA P-256）");
  }

  // 配对校验：cert 与 key 混贴时若不查，会签出链不上的叶证书而控制面零报错。
  // 拿私钥签一段随机字节，再用根证书的公钥验回来。
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      certificate.publicKey.rawData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      challenge,
    );
    const paired = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      challenge,
    );
    if (!paired) throw new Error("signature mismatch");
  } catch {
    throw new CertError("root_invalid", "根私钥与根证书不配对");
  }

  return { certificate, signingKey };
}

export async function issueLeaf(root: RootCa, options: IssueLeafOptions): Promise<IssuedLeaf> {
  let csr: Pkcs10CertificateRequest;
  try {
    csr = new Pkcs10CertificateRequest(options.csrDer);
  } catch {
    throw new CertError("csr_invalid", "CSR 无法解析");
  }

  let signed = false;
  try {
    signed = await csr.verify();
  } catch {
    signed = false;
  }
  if (!signed) throw new CertError("csr_signature_invalid", "CSR 签名验不过");

  const algorithm = csr.publicKey.algorithm as { name?: string; namedCurve?: string };
  if (algorithm?.name !== "ECDSA" || algorithm.namedCurve !== "P-256") {
    throw new CertError("unsupported_key", "只接受 ECDSA P-256");
  }

  assertSanAllowed(csr, options.serverIps);

  const names = issuedNames(options.serverIps);
  const days = options.days ?? DEFAULT_DAYS;
  const now = options.now ?? new Date();
  const notBefore = new Date(now.getTime() - NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(now.getTime() + days * 86_400_000);

  let certificate: X509Certificate;
  try {
    certificate = await X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      // subject 固定：CSR 的 CN 可以写任意域名，不能让它跟着证书走。
      subject: "CN=veyl-node-agent",
      issuer: root.certificate.subjectName,
      notBefore,
      notAfter,
      publicKey: csr.publicKey,
      signingKey: root.signingKey,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(
          KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
          true,
        ),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], false),
        new SubjectAlternativeNameExtension([...names], false),
        await AuthorityKeyIdentifierExtension.create(root.certificate.publicKey),
      ],
    });
  } catch (error) {
    throw new CertError("sign_failed", `签发失败: ${String(error)}`);
  }

  return {
    certPem: certificate.toString("pem"),
    fingerprint: await fingerprintOf(certificate),
    notAfter: Math.floor(notAfter.getTime() / 1000),
  };
}

export async function fingerprintOf(certificate: X509Certificate): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", certificate.rawData));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * CSR 里只允许出现这台机器的地址和本机名。带了别的一律拒签——不是「忽略」，
 * 拒签才能留下审计，也才能在有人试探时被看见。
 */
export function assertSanAllowed(csr: Pkcs10CertificateRequest, serverIps: string[]): void {
  // 库只读第一个 extensionRequest 属性，第二个里的 SAN 完全不可见：多属性直接拒。
  let requests: readonly unknown[];
  try {
    requests = csr.getAttributes(OID_EXTENSION_REQUEST);
  } catch {
    // 退化成空数组是安全的：走的是同一份 attributes 列表，下面的 getExtensions
    // 会再次抛出同样的异常并归为 csr_invalid，到不了签发。
    requests = [];
  }
  if (requests.length > 1) {
    throw new CertError("san_rejected", "CSR 带了多个 extensionRequest 属性", [], {
      extension_request_attributes: requests.length,
    });
  }

  let extensions: Extension[];
  try {
    extensions = csr.getExtensions(OID_SAN);
  } catch {
    throw new CertError("csr_invalid", "SAN 扩展无法读取");
  }
  // 多条 SAN 扩展：只取第一条会让其余名字被静默忽略，直接当越权拒掉并留审计。
  if (extensions.length > 1) {
    throw new CertError("san_rejected", "CSR 带了多个 SAN 扩展", [], {
      san_extensions: extensions.length,
    });
  }
  if (extensions.length === 0) return;

  // 原始 DER 里的名字条数。`@peculiar/x509` 的 GeneralNames 逐条 `catch { continue }`，
  // 只数它认得的条目会把 otherName 之类当成「没申请」——必须和原始条数对齐。
  let rawCount: number;
  try {
    rawCount = AsnConvert.parse(extensions[0].value, AsnGeneralNames).length;
  } catch {
    throw new CertError("csr_invalid", "SAN 扩展无法解析");
  }
  if (rawCount === 0) throw new CertError("csr_invalid", "SAN 扩展为空");

  let items: readonly { type: string; value: string }[];
  try {
    items = new GeneralNames(extensions[0].value).items;
  } catch {
    // 扩展在、但内容读不懂：这是坏 CSR，不是越权申请。
    throw new CertError("csr_invalid", "SAN 扩展无法解析");
  }
  if (items.length !== rawCount) {
    // 有名字读不出来就等于「它申请了我们看不懂的东西」，按越权处理。
    throw new CertError(
      "san_rejected",
      `CSR 的 SAN 有 ${rawCount} 条，其中 ${items.length} 条无法识别`,
      [],
      { raw_names: rawCount, recognized_names: items.length },
    );
  }

  const allowedIps = new Set(serverIps.map(normalizeIp).filter((ip) => ip !== ""));
  // `127.0.0.1` 必须是允许的 **IP**：agent 的 `canonical_hosts()` 把它解析成 IpAddr 发 IP SAN。
  allowedIps.add(LOCAL_IPV4);
  const allowedDns = new Set<string>([LOCAL_DNS]);

  // 收集全部越权名字再拒：审计要能看见「它到底申请了什么」，只留第一条会误导。
  const rejected: string[] = [];
  for (const name of items) {
    if (name.type === "ip" && allowedIps.has(normalizeIp(name.value))) continue;
    if (name.type === "dns" && allowedDns.has(name.value.toLowerCase())) continue;
    rejected.push(`${name.type}:${name.value}`);
  }
  if (rejected.length > 0) {
    throw new CertError(
      "san_rejected",
      `CSR 申请了未授权的名字: ${rejected.join(", ")}`,
      rejected,
    );
  }
}

function issuedNames(serverIps: string[]): { type: "ip" | "dns"; value: string }[] {
  const ips = dedupe(serverIps.map(normalizeIp).filter((ip) => ip !== ""));
  const names: { type: "ip" | "dns"; value: string }[] = ips.map((ip) => ({
    type: "ip" as const,
    value: ip,
  }));
  names.push({ type: "dns", value: LOCAL_DNS }, { type: "ip", value: LOCAL_IPV4 });
  return names;
}

function normalizeIp(value: string): string {
  return value.trim().toLowerCase();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function randomSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 正数，且不为零。
  bytes[0] = (bytes[0] & 0x7f) || 1;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
