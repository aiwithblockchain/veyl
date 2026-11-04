#!/usr/bin/env node
/**
 * 拉取并打包规则数据（批 3 前置）。
 *
 * 上游：
 *   https://github.com/SagerNet/sing-geosite  分支 rule-set
 *   https://github.com/SagerNet/sing-geoip    分支 rule-set
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
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RESOURCES_DIR = path.join(ROOT, "src-tauri", "resources", "rules");
const WORK_ROOT = path.join(ROOT, "build", "rules-work");
const CATEGORY_TEMPLATE = path.join(HERE, "categories.json");

const GEOSITE_REPO = "https://github.com/SagerNet/sing-geosite.git";
const GEOIP_REPO = "https://github.com/SagerNet/sing-geoip.git";
const BRANCH = "rule-set";

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

function gitMeta(dir) {
  const commit = run("git", ["-C", dir, "rev-parse", "--short=12", "HEAD"], { quiet: true }).stdout.trim();
  const date = run("git", ["-C", dir, "log", "-1", "--format=%cI"], { quiet: true }).stdout.trim();
  return { commit, date };
}

async function cloneRuleSet(repo, name) {
  const dir = path.join(WORK_ROOT, name);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", BRANCH, "--single-branch", repo, dir]);
  const meta = gitMeta(dir);
  return { dir, ...meta };
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

async function copyLicenses(geositeDir, geoipDir) {
  const results = [];
  for (const [kind, dir] of [
    ["geosite", geositeDir],
    ["geoip", geoipDir],
  ]) {
    const license = path.join(dir, "LICENSE");
    if (!fs.existsSync(license)) {
      results.push({ kind, file: null, gpl: false });
      continue;
    }
    const text = await fsp.readFile(license, "utf8");
    const gpl = /GNU GENERAL PUBLIC LICENSE/i.test(text) || /GPL-?3/i.test(text);
    const target = path.join(RESOURCES_DIR, `LICENSE-${kind}.txt`);
    await fsp.writeFile(target, text);
    results.push({ kind, file: target, gpl });
  }
  const gplLicense = results.find((item) => item.gpl);
  if (gplLicense) {
    await fsp.copyFile(gplLicense.file, path.join(RESOURCES_DIR, "LICENSE-GPL-3.0.txt"));
  }
  return results;
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
    geosite = { dir: args.geositeDir, commit: "local", date: "local" };
    geoip = { dir: args.geoipDir, commit: "local", date: "local" };
  } else {
    console.log("[rules] 克隆 sing-geosite / sing-geoip（rule-set 分支，浅克隆）");
    geosite = await cloneRuleSet(GEOSITE_REPO, "sing-geosite");
    geoip = await cloneRuleSet(GEOIP_REPO, "sing-geoip");
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
  ]);
  await fsp.rename(tmpArchive, archivePath);
  const archiveBytes = await fsp.readFile(archivePath);
  const archiveSha = sha256(archiveBytes);

  const licenses = await copyLicenses(geosite.dir, geoip.dir);
  const sourceText = [
    `version: ${version}`,
    `geosite: ${GEOSITE_REPO} branch=${BRANCH} commit=${geosite.commit} date=${geosite.date}`,
    `geoip:   ${GEOIP_REPO} branch=${BRANCH} commit=${geoip.commit} date=${geoip.date}`,
    `fetched_at: ${new Date().toISOString()}`,
    `items: ${items.length} (geosite=${geositeItems.length}, geoip=${geoipItems.length})`,
    `uncompressed_bytes: ${uncompressedBytes}`,
    `archive: ${archiveName}`,
    `archive_bytes: ${archiveBytes.length}`,
    `archive_sha256: ${archiveSha}`,
    `licenses: ${licenses.map((item) => `${item.kind}=${item.file ? path.basename(item.file) : "missing"}${item.gpl ? " (GPL)" : ""}`).join(", ")}`,
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
