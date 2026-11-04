#!/usr/bin/env node
/**
 * 拉取并打包规则数据（批 3 前置）。
 *
 * 上游：
 *   https://github.com/SagerNet/sing-geosite  分支 rule-set
 *   https://github.com/SagerNet/sing-geoip    分支 rule-set
 *
 * 下载走 codeload.github.com 的 tarball（github.com 在部分网络下不可达），
 * commit / 日期通过 api.github.com 的分支头查询，记录进 manifest 与 SOURCE.txt。
 * 重试会重新解析 DNS 并轮换 A 记录；失败信息带域名、IP、状态码和耗时。
 *
 * 产物（默认写入 src-tauri/resources/rules/，目录内容不入 git）：
 *   veyl-rules-<version>.tar.zst   含 manifest.json / categories.json / geosite/ / geoip/
 *   LICENSE-geosite.txt
 *   LICENSE-geoip.txt
 *   LICENSE-GPL-3.0.txt（上游确实是 GPL-3.0 时）
 *   SOURCE.txt                     上游仓库、commit、抓取时间、条数、归档 sha256
 *
 * 用法：
 *   node scripts/rules/fetch-rules.mjs
 *   node scripts/rules/fetch-rules.mjs --version 2026-11-04.1
 *   node scripts/rules/fetch-rules.mjs --geosite-dir /tmp/sing-geosite --geoip-dir /tmp/sing-geoip
 *
 * 离线/CI 测试可以用 --geosite-dir / --geoip-dir 指向已经克隆好的目录。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RESOURCES_DIR = path.join(ROOT, "src-tauri", "resources", "rules");
const WORK_ROOT = path.join(ROOT, "build", "rules-work");
const CATEGORY_TEMPLATE = path.join(HERE, "categories.json");

const GEOSITE_REPO = "https://github.com/SagerNet/sing-geosite";
const GEOIP_REPO = "https://github.com/SagerNet/sing-geoip";
const GEOSITE_SLUG = "sing-geosite";
const GEOIP_SLUG = "sing-geoip";
const BRANCH = "rule-set";
const API_ROOT = "https://api.github.com";
const CODELOAD_ROOT = "https://codeload.github.com";
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const TARBALL_CONNECT_TIMEOUT_MS = 15_000;
const TARBALL_IDLE_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = {
    version: null,
    geositeDir: null,
    geoipDir: null,
    keepWork: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--version":
        args.version = argv[++i];
        break;
      case "--geosite-dir":
        args.geositeDir = path.resolve(argv[++i]);
        break;
      case "--geoip-dir":
        args.geoipDir = path.resolve(argv[++i]);
        break;
      case "--keep-work":
        args.keepWork = true;
        break;
      case "-h":
      case "--help":
        console.log(
          "用法：node scripts/rules/fetch-rules.mjs [--version <date.seq>] [--geosite-dir <dir>] [--geoip-dir <dir>] [--keep-work]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if ((args.geositeDir && !args.geoipDir) || (!args.geositeDir && args.geoipDir)) {
    throw new Error("--geosite-dir 与 --geoip-dir 必须同时提供");
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} 失败${stderr ? `：${stderr}` : ""}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 解析主机名。每次重试都重新解析，避免「同一个被封 IP 重试三次」。
 * 优先用 c-ares 直接查 A 记录（能拿到多个地址），失败再退回系统 lookup。
 */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 解析超时`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveHost(host) {
  let addresses = [];
  try {
    const v4 = await withTimeout(dns.promises.resolve4(host), 10_000, host);
    addresses = v4.map((address) => ({ address, family: 4 }));
  } catch {
    // c-ares 失败时退回系统解析（可能走 /etc/hosts 或系统缓存）。
  }
  if (addresses.length === 0) {
    try {
      addresses = await withTimeout(
        dns.promises.lookup(host, { all: true, verbatim: true }),
        10_000,
        host,
      );
    } catch (error) {
      throw new Error(
        `${host} DNS 解析失败：${error.code ?? error.message}`,
      );
    }
  }
  if (addresses.length === 0) {
    throw new Error(`${host} DNS 没有返回地址`);
  }
  return addresses;
}

function requestError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function describeAttempt(host, ip, code, status, elapsedMs) {
  return [
    host ? `host=${host}` : null,
    ip ? `ip=${ip}` : null,
    status != null ? `status=${status}` : null,
    code ? `code=${code}` : null,
    elapsedMs != null ? `elapsed=${elapsedMs}ms` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** 单次 HTTPS GET；由调用方给定这次要连的 IP。 */
async function httpsGetOnce(url, options) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw requestError(`${parsed.protocol} 不支持，只接受 HTTPS`, {
      host: parsed.hostname,
      retryable: false,
    });
  }

  const addresses = await resolveHost(parsed.hostname);
  const chosen = addresses[(options.attempt + options.hop - 1) % addresses.length];
  console.log(
    `[net] ${parsed.hostname} -> ${chosen.address} ` +
      `(attempt ${options.attempt}, hop ${options.hop})`,
  );

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers = {
      "User-Agent": "veyl-rules-fetch",
      ...(options.headers ?? {}),
      Host: parsed.host,
    };
    const req = https.request(
      {
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
        servername: parsed.hostname,
        agent: false,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions && lookupOptions.all) {
            callback(null, [chosen]);
          } else {
            callback(null, chosen.address, chosen.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          resolve({
            redirect: new URL(location, parsed).toString(),
            status,
            host: parsed.hostname,
            ip: chosen.address,
          });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            requestError(`HTTP ${status}`, {
              host: parsed.hostname,
              ip: chosen.address,
              status,
              retryable:
                status === 403 || status === 408 || status === 429 || status >= 500,
              elapsedMs: Date.now() - started,
            }),
          );
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            status,
            host: parsed.hostname,
            ip: chosen.address,
          }),
        );
        res.on("error", (error) =>
          reject(
            requestError(`读取响应失败：${error.message}`, {
              host: parsed.hostname,
              ip: chosen.address,
              status,
              code: error.code,
              retryable: true,
              elapsedMs: Date.now() - started,
            }),
          ),
        );
        res.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => {
          res.destroy(new Error(`读取超时 ${options.idleTimeoutMs ?? IDLE_TIMEOUT_MS}ms`));
        });
      },
    );

    req.setTimeout(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error(`连接超时 ${options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS}ms`));
    });
    req.on("error", (error) =>
      reject(
        requestError(`请求失败：${error.message}`, {
          host: parsed.hostname,
          ip: chosen.address,
          code: error.code ?? (error.message.includes("超时") ? "ETIMEDOUT" : undefined),
          retryable: true,
          elapsedMs: Date.now() - started,
        }),
      ),
    );
    req.end();
  });
}

/**
 * 带重试的 GET。每次重试都会重新解析 DNS；网络错误/超时/429/5xx 重试，
 * 其它 4xx 立即失败。错误信息带域名、IP、状态码和耗时。
 */
async function request(url, options = {}) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      let current = url;
      for (let hop = 0; hop < 6; hop += 1) {
        const result = await httpsGetOnce(current, {
          attempt,
          hop,
          headers: options.headers,
          connectTimeoutMs: options.connectTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
        });
        if (result.redirect) {
          current = result.redirect;
          continue;
        }
        console.log(
          `[net] ${result.host} <- ${result.ip} HTTP ${result.status} ` +
            `(attempt ${attempt})`,
        );
        return result.body;
      }
      throw requestError("重定向次数过多", {
        host: hostOf(url),
        retryable: false,
      });
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 3) break;
      console.warn(
        `[net] ${error.message}；重试 ${attempt + 1}/3（重新解析 DNS）`,
      );
      await sleep(attempt * 1000);
    }
  }

  const details = describeAttempt(
    lastError?.host,
    lastError?.ip,
    lastError?.code,
    lastError?.status,
    lastError?.elapsedMs,
  );
  throw new Error(
    `${details ? `${details} ` : ""}${lastError?.message ?? lastError}` +
      `（已尝试 ${attempts} 次）`,
  );
}

async function remoteCommit(repo) {
  const url = `${API_ROOT}/repos/SagerNet/${repo}/commits/${BRANCH}`;
  const body = await request(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`${hostOf(url)} 返回的不是合法 JSON`);
  }
  const sha = data?.sha;
  const date = data?.commit?.committer?.date ?? data?.commit?.author?.date;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${hostOf(url)} 没有返回分支 ${BRANCH} 的 commit sha`);
  }
  if (!date) {
    throw new Error(`${hostOf(url)} 返回的 commit 没有日期`);
  }
  return { sha, commit: sha.slice(0, 12), date };
}

async function downloadRuleSet(repo, name) {
  const meta = await remoteCommit(repo);
  const tarballUrl = `${CODELOAD_ROOT}/SagerNet/${repo}/tar.gz/${meta.sha}`;
  const workDir = path.join(WORK_ROOT, `${name}-${meta.commit}`);
  const archive = path.join(workDir, `${name}.tar.gz`);
  const extractDir = path.join(workDir, "src");

  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  console.log(`[rules] 下载 ${name}@${meta.commit}（codeload tarball）`);
  const bytes = await request(tarballUrl, {
    connectTimeoutMs: TARBALL_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: TARBALL_IDLE_TIMEOUT_MS,
  });
  await fsp.writeFile(archive, bytes);

  run("tar", ["-xzf", archive, "-C", extractDir]);

  const entries = await fsp.readdir(extractDir, { withFileTypes: true });
  const top = entries.find(
    (entry) =>
      entry.isDirectory() &&
      fs.existsSync(path.join(extractDir, entry.name, "LICENSE")),
  ) ?? entries.find((entry) => entry.isDirectory());
  if (!top) {
    throw new Error(`${hostOf(tarballUrl)} 解压后找不到仓库目录`);
  }

  return {
    dir: path.join(extractDir, top.name),
    repo,
    commit: meta.commit,
    sha: meta.sha,
    date: meta.date,
    tarballUrl,
    tarballBytes: bytes.length,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(repoDir, prefix, kind, stagingDir) {
  const items = [];
  const targetDir = path.join(stagingDir, kind);
  await fsp.mkdir(targetDir, { recursive: true });

  const entries = await fsp.readdir(repoDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(new RegExp(`^${prefix}-(.+)\\.srs$`));
    if (!match) continue;
    const tag = match[1];
    const source = path.join(repoDir, entry.name);
    const relative = path.join(kind, `${tag}.srs`);
    const target = path.join(stagingDir, relative);
    const bytes = await fsp.readFile(source);
    await fsp.writeFile(target, bytes);
    items.push({
      id: `${kind}-${tag}`,
      kind,
      file: relative.split(path.sep).join("/"),
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

function defaultVersion() {
  return `${new Date().toISOString().slice(0, 10)}.1`;
}

async function fetchRepoLicense(repo) {
  const url = `${API_ROOT}/repos/SagerNet/${repo}/license`;
  const body = await request(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`${hostOf(url)} 返回的不是合法 JSON`);
  }
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(`${hostOf(url)} 没有返回可用的 license 内容`);
  }
  const text = Buffer.from(
    data.content.replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
  if (!text.trim()) {
    throw new Error(`${hostOf(url)} 返回的 license 为空`);
  }
  return text;
}

async function copyLicenses(geosite, geoip, staging) {
  const results = [];
  for (const [kind, source] of [
    ["geosite", geosite],
    ["geoip", geoip],
  ]) {
    let text;
    if (source.repo) {
      text = await fetchRepoLicense(source.repo);
    } else {
      const license = path.join(source.dir, "LICENSE");
      if (!fs.existsSync(license)) {
        throw new Error(`${kind} 目录缺少 LICENSE：${license}`);
      }
      text = await fsp.readFile(license, "utf8");
      if (!text.trim()) {
        throw new Error(`${kind} 的 LICENSE 为空：${license}`);
      }
    }

    const name = `LICENSE-${kind}.txt`;
    await fsp.writeFile(path.join(staging, name), text);
    await fsp.writeFile(path.join(RESOURCES_DIR, name), text);
    results.push({
      kind,
      name,
      gpl: /GNU GENERAL PUBLIC LICENSE/i.test(text) || /GPL-?3/i.test(text),
    });
  }

  const gplLicense = results.find((item) => item.gpl);
  let gplName = null;
  if (gplLicense) {
    gplName = "LICENSE-GPL-3.0.txt";
    await fsp.copyFile(
      path.join(staging, gplLicense.name),
      path.join(staging, gplName),
    );
    await fsp.copyFile(
      path.join(RESOURCES_DIR, gplLicense.name),
      path.join(RESOURCES_DIR, gplName),
    );
  }
  return { files: results, gplName };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || defaultVersion();
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(version)) {
    throw new Error(`版本号必须是 <YYYY-MM-DD>.<序号>，收到：${version}`);
  }

  await fsp.mkdir(RESOURCES_DIR, { recursive: true });
  await fsp.mkdir(WORK_ROOT, { recursive: true });

  let geosite;
  let geoip;
  if (args.geositeDir) {
    geosite = { dir: args.geositeDir, repo: null, commit: "local", date: "local" };
    geoip = { dir: args.geoipDir, repo: null, commit: "local", date: "local" };
  } else {
    console.log("[rules] 从 codeload.github.com 拉取 sing-geosite / sing-geoip（rule-set 分支）");
    geosite = await downloadRuleSet(GEOSITE_SLUG, "sing-geosite");
    geoip = await downloadRuleSet(GEOIP_SLUG, "sing-geoip");
  }

  const staging = path.join(WORK_ROOT, `stage-${version}`);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });

  console.log("[rules] 收集 .srs");
  const geositeItems = await collect(geosite.dir, "geosite", "geosite", staging);
  const geoipItems = await collect(geoip.dir, "geoip", "geoip", staging);
  const items = [...geositeItems, ...geoipItems];
  if (geositeItems.length === 0 || geoipItems.length === 0) {
    throw new Error(
      `规则集数量异常：geosite=${geositeItems.length}，geoip=${geoipItems.length}。` +
        "请确认目录是 rule-set 分支且包含 geosite-*.srs / geoip-*.srs",
    );
  }

  const manifest = {
    schema: 1,
    version,
    source: {
      geosite_tag: `${BRANCH}@${geosite.commit}`,
      geoip_tag: `${BRANCH}@${geoip.commit}`,
      geosite_commit_date: geosite.date,
      geoip_commit_date: geoip.date,
      fetched_at: new Date().toISOString(),
    },
    items,
  };
  await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  const template = JSON.parse(await fsp.readFile(CATEGORY_TEMPLATE, "utf8"));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const categories = [];
  for (const category of template.categories) {
    for (const ruleSet of category.rule_sets) {
      if (!itemById.has(ruleSet)) {
        throw new Error(`分类 ${category.id} 引用了不存在的规则集：${ruleSet}`);
      }
    }
    const dnsClassifiable = category.rule_sets.some(
      (ruleSet) => itemById.get(ruleSet)?.kind === "geosite",
    );
    categories.push({
      id: category.id,
      name_zh: category.name_zh,
      name_en: category.name_en,
      description: category.description,
      // .srs 是二进制，推导不出底层域名条数；0 = 上游未提供计数。
      item_count: category.item_count ?? 0,
      rule_sets: category.rule_sets,
      dns_classifiable: dnsClassifiable,
    });
  }
  await fsp.writeFile(
    path.join(staging, "categories.json"),
    JSON.stringify({ schema: 1, version, categories }, null, 2),
  );

  const licenses = await copyLicenses(geosite, geoip, staging);
  const licenseEntries = [
    ...licenses.files.map((item) => item.name),
    ...(licenses.gplName ? [licenses.gplName] : []),
  ];

  const archiveName = `veyl-rules-${version}.tar.zst`;
  const archivePath = path.join(RESOURCES_DIR, archiveName);
  const tmpArchive = `${archivePath}.tmp-${process.pid}`;
  const uncompressedBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    `[rules] 打包 ${items.length} 个规则集（未压缩 ${(uncompressedBytes / 1024 / 1024).toFixed(2)} MiB）`,
  );
  run("tar", [
    "--zstd",
    "-cf",
    tmpArchive,
    "-C",
    staging,
    "manifest.json",
    "categories.json",
    "geosite",
    "geoip",
    ...licenseEntries,
  ]);
  const archivedFiles = run("tar", ["--zstd", "-tf", tmpArchive], {
    quiet: true,
  }).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const name of licenseEntries) {
    if (!archivedFiles.includes(name)) {
      throw new Error(`归档里缺少许可证文件：${name}`);
    }
  }
  await fsp.rename(tmpArchive, archivePath);
  const archiveBytes = await fsp.readFile(archivePath);
  const archiveSha = sha256(archiveBytes);

  const sourceText = [
    `version: ${version}`,
    `geosite: ${GEOSITE_REPO} branch=${BRANCH} commit=${geosite.commit} date=${geosite.date}`,
    `geoip:   ${GEOIP_REPO} branch=${BRANCH} commit=${geoip.commit} date=${geoip.date}`,
    ...(geosite.sha ? [`geosite_commit: ${geosite.sha}`, `geosite_tarball: ${geosite.tarballUrl}`] : []),
    ...(geoip.sha ? [`geoip_commit: ${geoip.sha}`, `geoip_tarball: ${geoip.tarballUrl}`] : []),
    `fetched_at: ${new Date().toISOString()}`,
    `items: ${items.length} (geosite=${geositeItems.length}, geoip=${geoipItems.length})`,
    `uncompressed_bytes: ${uncompressedBytes}`,
    `archive: ${archiveName}`,
    `archive_bytes: ${archiveBytes.length}`,
    `archive_sha256: ${archiveSha}`,
    `licenses: ${licenses.files.map((item) => `${item.kind}=${item.name}${item.gpl ? " (GPL)" : ""}`).join(", ")}${licenses.gplName ? `, gpl=${licenses.gplName}` : ""}`,
    "",
    "说明：manifest.items[].sha256 是每个 .srs 的内容校验；archive_sha256 是整个归档的供应链校验。",
    "categories.json 的 item_count 为 0 表示上游二进制不提供域名条数，不是分类为空。",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(RESOURCES_DIR, "SOURCE.txt"), sourceText);

  // 只保留最新归档，避免 resources 目录膨胀。
  for (const entry of await fsp.readdir(RESOURCES_DIR)) {
    if (entry.startsWith("veyl-rules-") && entry.endsWith(".tar.zst") && entry !== archiveName) {
      await fsp.rm(path.join(RESOURCES_DIR, entry));
    }
  }
  if (!args.keepWork) {
    await fsp.rm(staging, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        version,
        archive: path.relative(ROOT, archivePath),
        archive_bytes: archiveBytes.length,
        archive_sha256: archiveSha,
        geosite_items: geositeItems.length,
        geoip_items: geoipItems.length,
        uncompressed_bytes: uncompressedBytes,
        categories: categories.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[rules] 失败：${error.message}`);
  process.exit(1);
});
