#!/usr/bin/env node
/**
 * 校验规则数据归档（构建期 / 发布期）。
 *
 * 做三件事：
 *   1. 逐条比对 manifest.items[].sha256 与 bytes
 *   2. 校验 categories.json 引用的规则集都在 manifest 里
 *   3. 比对 SOURCE.txt 记录的归档 sha256（供应链校验）
 *
 * 用法：
 *   node scripts/rules/verify-rules.mjs
 *   node scripts/rules/verify-rules.mjs --required   # 没有归档直接失败
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
const VERIFY_DIR = path.join(ROOT, "build", "rules-verify");

function parseArgs(argv) {
  const args = { required: false };
  for (const arg of argv) {
    if (arg === "--required") args.required = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("用法：node scripts/rules/verify-rules.mjs [--required]");
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function findArchive() {
  if (!fs.existsSync(RESOURCES_DIR)) return null;
  const entries = (await fsp.readdir(RESOURCES_DIR))
    .filter((name) => name.startsWith("veyl-rules-") && name.endsWith(".tar.zst"))
    .sort();
  if (entries.length === 0) return null;
  return path.join(RESOURCES_DIR, entries[entries.length - 1]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const archive = await findArchive();
  if (!archive) {
    if (args.required) throw new Error("src-tauri/resources/rules/ 下没有 veyl-rules-*.tar.zst");
    console.log("[rules] 没有规则归档，跳过校验（开发环境可接受）");
    return;
  }

  const archiveBytes = await fsp.readFile(archive);
  const archiveSha = sha256(archiveBytes);
  const source = await fsp.readFile(path.join(RESOURCES_DIR, "SOURCE.txt"), "utf8");
  const recorded = source.match(/^archive_sha256:\s*([0-9a-f]{64})$/m)?.[1];
  if (!recorded) throw new Error("SOURCE.txt 缺少 archive_sha256");
  if (recorded !== archiveSha) {
    throw new Error(`归档 sha256 不匹配：记录 ${recorded}，实际 ${archiveSha}`);
  }

  await fsp.rm(VERIFY_DIR, { recursive: true, force: true });
  await fsp.mkdir(VERIFY_DIR, { recursive: true });
  run("tar", ["--zstd", "-xf", archive, "-C", VERIFY_DIR]);

  const manifest = JSON.parse(await fsp.readFile(path.join(VERIFY_DIR, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new Error("manifest.items 为空");
  }

  for (const name of ["LICENSE-geosite.txt", "LICENSE-geoip.txt"]) {
    const text = await fsp.readFile(path.join(VERIFY_DIR, name), "utf8");
    if (!text.trim()) throw new Error(`归档缺少许可证或内容为空：${name}`);
  }

  let totalBytes = 0;
  const ids = new Set();
  for (const item of manifest.items) {
    if (ids.has(item.id)) throw new Error(`manifest 里 id 重复：${item.id}`);
    ids.add(item.id);
    const file = path.join(VERIFY_DIR, item.file);
    const bytes = await fsp.readFile(file);
    if (bytes.length !== item.bytes) {
      throw new Error(`${item.id} 大小不匹配：manifest ${item.bytes}，实际 ${bytes.length}`);
    }
    const actual = sha256(bytes);
    if (actual !== item.sha256) {
      throw new Error(`${item.id} sha256 不匹配：manifest ${item.sha256}，实际 ${actual}`);
    }
    totalBytes += bytes.length;
  }

  const categories = JSON.parse(
    await fsp.readFile(path.join(VERIFY_DIR, "categories.json"), "utf8"),
  );
  for (const category of categories.categories ?? []) {
    for (const ruleSet of category.rule_sets ?? []) {
      if (!ids.has(ruleSet)) {
        throw new Error(`分类 ${category.id} 引用了不存在的规则集：${ruleSet}`);
      }
    }
  }

  await fsp.rm(VERIFY_DIR, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        archive: path.relative(ROOT, archive),
        archive_bytes: archiveBytes.length,
        archive_sha256: archiveSha,
        version: manifest.version,
        items: manifest.items.length,
        categories: categories.categories?.length ?? 0,
        uncompressed_bytes: totalBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[rules] 校验失败：${error.message}`);
  process.exit(1);
});
