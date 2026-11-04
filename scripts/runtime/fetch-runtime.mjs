#!/usr/bin/env node
// 取 sing-box 运行时：下载 → 校验 → 解压 → lipo 成 universal → 放进 resources/runtime/。
//
// 用法：
//   node scripts/runtime/fetch-runtime.mjs
//
// 为什么需要这一步：TUN 的特权 helper **只执行随包分发的那一份**。
// 用户目录里、从网上下载的二进制以 root 执行，是提权漏洞（见 docs/tun-privilege.md §1）。
//
// 下载为什么不直接走 github.com：部分网络下 github.com 不可达，但
// api.github.com 与 release-assets.githubusercontent.com 可达。这里先从
// api.github.com 取 release asset 的 API 地址，再带 Accept: octet-stream 下载；
// 重试会重新解析 DNS 并轮换 A 记录；失败信息带域名、IP、状态码和耗时。
// 产物哈希仍以 runtime-manifest.json 里的 sha256 为准。
//
// 产物：src-tauri/resources/runtime/sing-box
//       它的 sha256 由 src-tauri/build.rs 在构建时算出来，编进 helper。

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(ROOT, "src-tauri/assets/runtime-manifest.json");
const OUT_DIR = join(ROOT, "src-tauri/resources/runtime");
const OUT = join(OUT_DIR, "sing-box");
const ARCHES = ["arm64", "x86_64"];
const API_ROOT = "https://api.github.com";
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const ASSET_CONNECT_TIMEOUT_MS = 15_000;
const ASSET_IDLE_TIMEOUT_MS = 60_000;

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function fail(message) {
  console.error(`[runtime] ${message}`);
  process.exit(1);
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
    // c-ares 失败时退回系统解析。
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
      "User-Agent": "veyl-runtime-fetch",
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

        if (options.sinkPath) {
          const sink = createWriteStream(options.sinkPath, { mode: 0o600 });
          pipeline(res, sink)
            .then(() =>
              resolve({
                status,
                host: parsed.hostname,
                ip: chosen.address,
                elapsedMs: Date.now() - started,
              }),
            )
            .catch((error) =>
              reject(
                requestError(`写入下载文件失败：${error.message}`, {
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

/** 流式下载到文件：同样每次重试重新解析 DNS，失败时清掉半截文件。 */
async function requestToFile(url, dest, options = {}) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      rmSync(dest, { force: true });
      let current = url;
      for (let hop = 0; hop < 6; hop += 1) {
        const result = await httpsGetOnce(current, {
          attempt,
          hop,
          headers: options.headers,
          connectTimeoutMs: options.connectTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          sinkPath: dest,
        });
        if (result.redirect) {
          current = result.redirect;
          continue;
        }
        console.log(
          `[net] ${result.host} <- ${result.ip} HTTP ${result.status} ` +
            `(attempt ${attempt})`,
        );
        return;
      }
      throw requestError("重定向次数过多", {
        host: hostOf(url),
        retryable: false,
      });
    } catch (error) {
      lastError = error;
      rmSync(dest, { force: true });
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

/** 错误信息里只留 host + path，避免将来带 token 的 URL 泄漏到日志。 */
function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

/** 从 manifest 的 github.com release URL 解析 owner/repo/tag/asset。 */
function parseReleaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`runtime-manifest 里的下载地址不合法：${redactUrl(raw)}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const download = parts.indexOf("download");
  if (download < 2 || download + 2 >= parts.length) {
    fail(`无法从 artifact.url 解析 tag/asset：${redactUrl(raw)}`);
  }
  return {
    owner: parts[0],
    repo: parts[1],
    tag: decodeURIComponent(parts[download + 1]),
    asset: decodeURIComponent(parts[parts.length - 1]),
  };
}

const releaseCache = new Map();

async function releaseAssets(owner, repo, tag) {
  const key = `${owner}/${repo}@${tag}`;
  if (releaseCache.has(key)) return releaseCache.get(key);
  const url = `${API_ROOT}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const body = await request(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    fail(`${hostOf(url)} 返回的不是合法 JSON`);
  }
  if (!Array.isArray(data?.assets)) {
    fail(`${hostOf(url)} 返回的 release 没有 assets`);
  }
  releaseCache.set(key, data.assets);
  return data.assets;
}

async function downloadAsset(release, archivePath) {
  const parsed = parseReleaseUrl(release.artifact.url);
  const assets = await releaseAssets(parsed.owner, parsed.repo, parsed.tag);
  const asset = assets.find((item) => item.name === parsed.asset);
  if (!asset) {
    fail(`api.github.com 的 ${parsed.tag} release 里找不到 ${parsed.asset}`);
  }
  if (!asset.url) {
    fail(`api.github.com 返回的 asset 没有下载地址：${parsed.asset}`);
  }

  console.log(`[runtime] 下载 ${release.arch}: ${parsed.asset}（via api.github.com）`);
  try {
    await requestToFile(asset.url, archivePath, {
      headers: { Accept: "application/octet-stream" },
      connectTimeoutMs: ASSET_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: ASSET_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    // api.github.com 通常 302 到 release-assets.githubusercontent.com；
    // 两个域名都点名，构建机上才知道该查哪一段网络。
    fail(
      `下载 ${parsed.asset} 失败：api.github.com 返回了 asset 地址，` +
        `但下载请求失败（重定向目标通常为 release-assets.githubusercontent.com）：${error.message}`,
    );
  }
  const actualSize = statSync(archivePath).size;
  if (actualSize !== release.artifact.size) {
    fail(
      `${parsed.asset} 大小不符：manifest ${release.artifact.size}，实际 ${actualSize}`,
    );
  }

  const actual = await sha256File(archivePath);
  if (actual !== release.artifact.sha256) {
    fail(
      `${release.arch} 的压缩包哈希不符\n  期望 ${release.artifact.sha256}\n  实际 ${actual}`,
    );
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const releases = manifest.releases.filter((item) => item.platform === "darwin");

const picks = [];
for (const arch of ARCHES) {
  const release = releases.find((item) => item.arch === arch);
  if (!release) fail(`manifest 里没有 darwin/${arch} 的发布记录`);
  picks.push(release);
}

// 版本必须一致，否则 lipo 出来的东西两半不是同一个东西。
const versions = new Set(picks.map((item) => item.upstream_version));
if (versions.size !== 1) fail(`darwin 两个架构的版本不一致：${[...versions].join(", ")}`);
const version = picks[0].upstream_version;

mkdirSync(OUT_DIR, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "veyl-runtime-"));

try {
  const binaries = [];
  for (const release of picks) {
    const archive = join(work, release.upstream_asset);
    await downloadAsset(release, archive);

    const extractDir = join(work, release.arch);
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extractDir], { stdio: "inherit" });

    const binary = join(extractDir, release.upstream_asset.replace(/\.tar\.gz$/, ""), "sing-box");
    if (!statSync(binary, { throwIfNoEntry: false })) fail(`解压后找不到 ${binary}`);
    binaries.push(binary);
  }

  console.log("[runtime] lipo 成 universal");
  const tmpOut = `${OUT}.tmp-${process.pid}`;
  const tmpManifest = `${MANIFEST}.tmp-${process.pid}`;
  try {
    rmSync(tmpOut, { force: true });
    execFileSync("lipo", ["-create", ...binaries, "-output", tmpOut], {
      stdio: "inherit",
    });
    chmodSync(tmpOut, 0o755);

    const archs = execFileSync("lipo", ["-archs", tmpOut], {
      encoding: "utf8",
    }).trim();
    const archSet = new Set(archs.split(/\s+/).filter(Boolean));
    if (!archSet.has("x86_64") || !archSet.has("arm64")) {
      throw new Error(`lipo 产物架构不完整：${archs}`);
    }

    const versionResult = spawnSync(tmpOut, ["version"], { encoding: "utf8" });
    const versionText = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`.trim();
    if (versionResult.status !== 0) {
      throw new Error(`产物 version 退出码 ${versionResult.status}：${versionText}`);
    }
    if (!versionText.includes(version)) {
      throw new Error(`产物版本不匹配：期望 ${version}，实际 ${versionText}`);
    }

    const size = statSync(tmpOut).size;
    const finalSha = await sha256File(tmpOut);
    renameSync(tmpOut, OUT);

    const universal = {
      version,
      archs: ["x86_64", "arm64"],
      sha256: finalSha,
      size,
      generated_at: new Date().toISOString(),
      artifacts: picks.map((release) => ({
        arch: release.arch,
        upstream_asset: release.upstream_asset,
        sha256: release.artifact.sha256,
        size: release.artifact.size,
      })),
    };
    writeFileSync(
      tmpManifest,
      `${JSON.stringify({ ...manifest, universal }, null, 2)}\n`,
    );
    renameSync(tmpManifest, MANIFEST);

    console.log(`[runtime] 完成：${OUT}`);
    console.log(`[runtime] 版本 ${version} · ${(size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[runtime] 架构 ${archs}`);
    console.log(`[runtime] sha256 ${finalSha}（已写入 runtime-manifest.json）`);
    console.log("[runtime] 这个哈希由 build.rs 在构建时重新计算并编进 helper，不需要手工同步。");
  } catch (error) {
    rmSync(tmpOut, { force: true });
    rmSync(tmpManifest, { force: true });
    fail(error.message);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
