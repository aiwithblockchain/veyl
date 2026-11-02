#!/usr/bin/env node
// 契约一致性检查。CI 里放在单测之前跑，防止「改名后静默失效」这类问题。
//
// 用法：node tests/contracts/check-contracts.mjs
// 退出码：0 全部通过；1 有不符合项。
//
// 检查项：
//   1. AGENT_EVENTS 的取值与 docs/contracts/events.md §1 事件总表一致
//   2. AGENT_EVENTS 的每个取值都被 src/state/chatStore.ts 的 switch 覆盖
//   3. RuntimeStatus / RuntimeSnapshot 的序列化字段不含 clash_addr（契约 runtime.md §11）

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const results = [];
function check(name, fn, opts = {}) {
  try {
    const problems = fn() || [];
    results.push({ name, problems, advisory: !!opts.advisory });
  } catch (err) {
    results.push({ name, problems: [`检查本身出错：${err.message}`], advisory: !!opts.advisory });
  }
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// 递归加载剧本（含 errors/ 子目录），并给每条打上来源文件名
function loadScenarios(dir) {
  const out = [];
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".json")) {
        const s = JSON.parse(readFileSync(p, "utf8"));
        s.__file = p.slice(ROOT.length + 1);
        out.push(s);
      }
    }
  }
  if (existsSync(dir)) walk(dir);
  return out;
}

// --- 1 & 2：事件名 ---

function contractEventNames() {
  const md = read("docs/contracts/events.md");
  const names = [];
  for (const m of md.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9-]+)`\s*\|/gm)) names.push(m[1]);
  if (names.length === 0) throw new Error("未能从 docs/contracts/events.md 的事件总表解析出任何事件名");
  return names;
}

function codeEventEntries() {
  const ts = read("src/agent/protocol.ts");
  const block = ts.match(/export const AGENT_EVENTS\s*=\s*\{([\s\S]*?)\}\s*as const;/);
  if (!block) throw new Error("未在 src/agent/protocol.ts 找到 AGENT_EVENTS 定义");
  const entries = [];
  for (const m of block[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) entries.push({ key: m[1], value: m[2] });
  if (entries.length === 0) throw new Error("AGENT_EVENTS 为空");
  return entries;
}

check("事件名与 docs/contracts/events.md 一致", () => {
  const contract = new Set(contractEventNames());
  const code = codeEventEntries();
  const codeValues = new Set(code.map((e) => e.value));
  const problems = [];
  for (const n of contract) if (!codeValues.has(n)) problems.push(`契约有、代码没有：${n}`);
  for (const n of codeValues) if (!contract.has(n)) problems.push(`代码有、契约没有：${n}`);
  return problems;
});

check("AGENT_EVENTS 全部被 chatStore 的 switch 覆盖", () => {
  const store = read("src/state/chatStore.ts");
  const entries = codeEventEntries();
  const byKey = new Map(entries.map((e) => [e.key, e.value]));

  const literalCases = new Set();
  for (const m of store.matchAll(/case\s+"([^"]+)"\s*:/g)) literalCases.add(m[1]);

  const constantCases = new Set();
  for (const m of store.matchAll(/case\s+AGENT_EVENTS\.(\w+)\s*:/g)) {
    const v = byKey.get(m[1]);
    if (v) constantCases.add(v);
    else constantCases.add(`<未知键 AGENT_EVENTS.${m[1]}>`);
  }

  const problems = [];
  for (const { key, value } of entries) {
    if (literalCases.has(value) || constantCases.has(value)) continue;
    problems.push(`chatStore 未处理事件 ${key} = "${value}"（改名后事件会被静默丢弃）`);
  }
  for (const c of constantCases) {
    if (c.startsWith("<未知键")) problems.push(c);
  }
  return problems;
});

// --- 3：RuntimeStatus 快照不得带 clash_addr ---

check("RuntimeStatus / RuntimeSnapshot 快照不含 clash_addr", () => {
  const rust = read("src-tauri/src/runtime/manager.rs");
  const problems = [];

  for (const m of rust.matchAll(/pub struct (Runtime(?:Status|Snapshot))\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = m;
    if (/\bclash_addr\b/.test(body)) {
      problems.push(`${name} 含 clash_addr 字段（契约 runtime.md §11 要求从 UI 快照中移除）`);
    }
  }

  if (!/pub struct Runtime(?:Status|Snapshot)\s*\{/.test(rust)) {
    problems.push("未找到 RuntimeStatus / RuntimeSnapshot 定义，检查脚本需要更新");
  }
  return problems;
});

// --- 4：剧本里的工具名必须是契约里的模型可见名 ---

check("mock LLM 剧本的工具名都在 docs/contracts/tools.md 的工具总表里", () => {
  const md = read("docs/contracts/tools.md");
  const known = new Set();
  for (const m of md.matchAll(/^\|\s*\d+\s*\|\s*`([A-Za-z]+)`\s*\|/gm)) known.add(m[1]);
  if (known.size === 0) throw new Error("未能从 docs/contracts/tools.md §3 解析出工具名");

  const dir = join(ROOT, "tests", "fixtures", "llm-scenarios");
  const problems = [];
  for (const scenario of loadScenarios(dir)) {
    for (const turn of scenario.turns || []) {
      for (const tc of turn.tool_calls || []) {
        if (!known.has(tc.name)) problems.push(`${scenario.__file} 里的工具名 "${tc.name}" 不在契约工具总表中`);
      }
    }
  }
  return problems;
});

// --- 5：实现里的 contract_version 与对应契约文档一致（advisory） ---
//
// 契约拆成多份之后，各文件的版本**独立演进**，不能再用一个全局版本号去套：
//   - catalog.md 是和服务端协商的协议版本（client.rs 的 contract_compatible 精确比对）
//   - tools.md / runtime.md / events.md 是应用内部版本，各自升
// 所以这里按「实现目录 → 契约文件」逐段映射。
//
// 这一项默认只报 WARN，不阻断 CI：契约升版后实现往往滞后一版，先把偏差摆出来，
// 由架构师决定何时收紧。用 AIVPN_CONTRACT_STRICT=1（contracts.sh --strict）可当失败处理。

function walkRs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkRs(p, out);
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

// 顺序有意义：先按完整路径精确匹配，再按目录前缀匹配。
const VERSION_MAP = [
  { file: "src-tauri/src/claurst_session/events.rs", doc: "docs/contracts/events.md" },
  { prefix: "src-tauri/src/tools/", doc: "docs/contracts/tools.md" },
  { prefix: "src-tauri/src/runtime/", doc: "docs/contracts/runtime.md" },
  { prefix: "src-tauri/src/catalog/", doc: "docs/contracts/catalog.md" },
];

function docForFile(rel) {
  const exact = VERSION_MAP.find((e) => e.file === rel);
  if (exact) return exact.doc;
  const byPrefix = VERSION_MAP.find((e) => e.prefix && rel.startsWith(e.prefix));
  return byPrefix ? byPrefix.doc : null;
}

const docVersionCache = new Map();
function docContractVersion(relDoc) {
  if (docVersionCache.has(relDoc)) return docVersionCache.get(relDoc);
  const md = read(relDoc);
  const m = md.match(/契约版本：`([\d.]+)`/);
  if (!m) throw new Error(`未能从 ${relDoc} 读出契约版本`);
  docVersionCache.set(relDoc, m[1]);
  return m[1];
}

check(
  "实现里的 contract_version 与对应契约文档一致",
  () => {
    const srcDir = join(ROOT, "src-tauri", "src");
    if (!existsSync(srcDir)) return [];
    const problems = [];

    for (const file of walkRs(srcDir)) {
      const rel = file.slice(ROOT.length + 1);
      const doc = docForFile(rel);
      // 未映射的文件不参与检查（例如 agent/ 下的命令层，不携带契约版本语义）。
      if (!doc) continue;
      const expected = docContractVersion(doc);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/CONTRACT_VERSION|contract_version/.test(line)) return;
        for (const m of line.matchAll(/"([\d.]+\.[\d.]+)"/g)) {
          if (m[1] === expected) continue;
          problems.push(`${rel}:${i + 1} 是 ${m[1]}，${doc} 是 ${expected}`);
        }
      });
    }
    return problems;
  },
  { advisory: true }
);

// --- 输出 ---

const strict = process.env.AIVPN_CONTRACT_STRICT === "1";
let failed = 0;
let warned = 0;

for (const { name, problems, advisory } of results) {
  if (problems.length === 0) {
    console.log(`  ok   ${name}`);
    continue;
  }
  if (advisory) {
    warned++;
    console.log(`  WARN ${name}（advisory${strict ? "，严格模式下算失败" : "，不阻断"}）`);
    for (const p of problems) console.log(`       - ${p}`);
    continue;
  }
  failed++;
  console.log(`  FAIL ${name}`);
  for (const p of problems) console.log(`       - ${p}`);
}

console.log();
if (failed === 0 && (!strict || warned === 0)) {
  const extra = warned > 0 ? `，${warned} 项 advisory 待处理` : "";
  console.log(`[contracts] ${results.length} 项检查通过${extra}`);
  process.exit(0);
}
console.log(`[contracts] ${failed} 项不通过${warned > 0 ? `，${warned} 项 advisory` : ""}`);
process.exit(1);
