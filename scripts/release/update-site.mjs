#!/usr/bin/env node
//
// 用法：
//   node scripts/release/update-site.mjs 1.2.3
//
// 只重写 cloudflare/edge/public/index.html 里
// <!-- releases:start --> … <!-- releases:end --> 之间的下载区，
// 版本号、产物直链、按钮文案一次整块生成。
//
// 硬规则：
//   - 入参必须是 x.y.z；标记块缺失或版本号不合法直接非零退出。
//   - 幂等：同一版本重复执行不改文件。
//   - 不自动部署，只打印下一步命令。
//
// 正式版本号以 package.json / src-tauri/tauri.conf.json 为准（当前 1.0.0）。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = join(ROOT, "cloudflare/edge/public/index.html");
const START = "<!-- releases:start -->";
const END = "<!-- releases:end -->";
const RELEASES = "https://github.com/aiwithblockchain/veyl/releases";

function fail(message) {
  console.error(`update-site: ${message}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) fail("缺少版本号。用法：node scripts/release/update-site.mjs <x.y.z>");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`版本号必须是 x.y.z 形式，收到「${version}」。`);
}

// 页面直链必须指向真实存在的 tag：入参要和仓库里的版本号一致。
function repoVersion(file) {
  const data = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  return data.version;
}
const pkgVersion = repoVersion("package.json");
const tauriVersion = repoVersion("src-tauri/tauri.conf.json");
if (version !== pkgVersion || version !== tauriVersion) {
  fail(
    `版本号与仓库不一致：入参 ${version}；package.json ${pkgVersion}；` +
      `src-tauri/tauri.conf.json ${tauriVersion}。先把版本号改一致。`,
  );
}

function row({ name, label, meta, ext }) {
  const artifact = `${RELEASES}/download/v${version}/Veyl-${version}.${ext}`;
  return [
    `        <div class="dl__row">`,
    `          <div>`,
    `            <div class="dl__name">${name}</div>`,
    `            <div class="dl__meta">v${version} · ${meta}</div>`,
    `          </div>`,
    `          <div class="dl__action">`,
    `            <a class="btn" href="${artifact}" aria-label="${label}">`,
    `              下载 <span class="arrow" aria-hidden="true">↗</span>`,
    `            </a>`,
    `            <a class="dl__alt" href="${RELEASES}">所有版本 ↗</a>`,
    `          </div>`,
    `        </div>`,
  ].join("\n");
}

const block = [
  START,
  row({
    name: "macOS",
    label: "下载 macOS 版",
    meta: "Apple Silicon 与 Intel 通用 · DMG",
    ext: "dmg",
  }),
  row({
    name: "Windows",
    label: "下载 Windows 版",
    meta: "Windows 10 / 11 · x64 · MSI",
    ext: "msi",
  }),
  `        ${END}`,
].join("\n");

const source = readFileSync(SITE, "utf8");
const startAt = source.indexOf(START);
const endAt = source.indexOf(END);
if (startAt === -1 || endAt === -1 || endAt < startAt) {
  fail(`在 ${SITE} 里找不到 ${START} … ${END} 标记块。`);
}

const next = source.slice(0, startAt) + block + source.slice(endAt + END.length);
if (next === source) {
  console.log(`下载区已经是 v${version}，文件未改动。`);
} else {
  writeFileSync(SITE, next);
  console.log(`下载区已更新到 v${version}。`);
}
console.log(`下一步（先确认再部署）：`);
console.log(
  `  1) 确认 GitHub 上 v${version} 的 release 已发布（不是草稿），` +
    `且 Veyl-${version}.dmg 与 Veyl-${version}.msi 两个产物都在；`,
);
console.log(`  2) cd cloudflare/edge && npm run deploy`);
console.log("草稿未发布时直链必然 404，脚本跑完不等于能下载。");
