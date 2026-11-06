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
//   4. mock 剧本里的工具名都在 docs/contracts/tools.md 的工具总表里
//   5. 实现里的 contract_version 与对应契约文档一致
//   6. 命令四方对齐：commands.md 总表 ↔ #[tauri::command] ↔ generate_handler! ↔ 前端 call()
//   7. 命令参数对齐：commands.md 的入参 ↔ Rust 形参 ↔ 前端调用实参
//   8. 事件载荷字段：events.md 的 Payload 类型 ↔ src/agent/protocol.ts 的接口

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

check("事件名：代码有、契约没有（漂移）", () => {
  const contract = new Set(contractEventNames());
  const codeValues = new Set(codeEventEntries().map((e) => e.value));
  const problems = [];
  for (const n of codeValues) if (!contract.has(n)) problems.push(`代码有、契约没有：${n}`);
  return problems;
});

// 测速事件已落地（2026-11-06），两个方向都按漂移处理。
check("事件名：契约有、代码没有", () => {
  const contract = new Set(contractEventNames());
  const codeValues = new Set(codeEventEntries().map((e) => e.value));
  const problems = [];
  for (const n of contract) if (!codeValues.has(n)) problems.push(`契约有、代码没有：${n}`);
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

// --- 2b：订阅列表覆盖 ---
//
// tauriBridge 只订阅 `[...AI_EVENT_NAMES, ...APP_EVENT_NAMES]`。事件定义在 AGENT_EVENTS
// 里但没进这两个数组 → **前端永远收不到**，而且不报错、不报警，最难查。
// 名字变了、新加了事件忘了加列表，都属于这一类。

function eventNameList(constName, ts) {
  const m = ts.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`));
  if (!m) return null;
  return [...m[1].matchAll(/AGENT_EVENTS\.(\w+)/g)].map((x) => x[1]);
}

check("AGENT_EVENTS 的每个事件都在 AI_EVENT_NAMES / APP_EVENT_NAMES 里被订阅", () => {
  const ts = read("src/agent/protocol.ts");
  const entries = codeEventEntries();
  const ai = eventNameList("AI_EVENT_NAMES", ts);
  const app = eventNameList("APP_EVENT_NAMES", ts);
  if (!ai || !app) throw new Error("未找到 AI_EVENT_NAMES / APP_EVENT_NAMES 定义");

  const problems = [];
  const known = new Set(entries.map((e) => e.key));
  for (const key of [...ai, ...app]) {
    if (!known.has(key)) problems.push(`订阅列表引用了不存在的 AGENT_EVENTS.${key}`);
  }

  const covered = new Set([...ai, ...app]);
  for (const { key } of entries) {
    if (!covered.has(key)) problems.push(`AGENT_EVENTS.${key} 没有被任何订阅列表覆盖（前端收不到这个事件）`);
  }

  for (const key of covered) {
    if (ai.includes(key) && app.includes(key)) problems.push(`AGENT_EVENTS.${key} 同时出现在两个订阅列表里（会重复订阅）`);
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

function walkExt(dir, exts, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkExt(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

function walkRs(dir, out = []) {
  return walkExt(dir, [".rs"], out);
}

// 顺序有意义：先按完整路径精确匹配，再按目录前缀匹配。
//
// 但**目录不等于归属**：`runtime/manager.rs` 里的 `EVENT_CONTRACT_VERSION` 服务的是
// 事件载荷与命令错误信封，版本应由 events.md / commands.md 决定，而不是 runtime.md
// （runtime.md 只管 runtime 自己的能力版本）。按目录一刀切会把这类「写在 A 目录、
// 服务于 B 契约」的常量判给错误的文档，产出假 advisory。
// 因此再加一条按**常量名**判定的规则，优先级高于目录。
const VERSION_MAP = [
  { file: "src-tauri/src/claurst_session/events.rs", doc: "docs/contracts/events.md" },
  // 这个文件只 emit 事件载荷，没有 runtime 能力版本。
  { file: "src-tauri/src/default_profile.rs", doc: "docs/contracts/events.md" },
  { prefix: "src-tauri/src/tools/", doc: "docs/contracts/tools.md" },
  { prefix: "src-tauri/src/runtime/", doc: "docs/contracts/runtime.md" },
  { prefix: "src-tauri/src/catalog/", doc: "docs/contracts/catalog.md" },
  // 前端侧：protocol.ts 是 AGENT_EVENTS 与事件载荷类型的唯一来源，跟 events.md 走。
  // 这一条曾经缺失，导致 CONTRACT_VERSION 停在 1.2.0 而契约已经 2.1.0 都没人发现。
  { file: "src/agent/protocol.ts", doc: "docs/contracts/events.md" },
];

// 常量名 → 契约文件。命中即用，不看目录。顺序：更具体的名字放前面。
// 这里**不放裸 `CONTRACT_VERSION`**：`src-tauri/src/tools/envelope.rs` 也有一个同名的
// `CONTRACT_VERSION`（值 3.2.0，归 tools.md），符号优先会把它错判给 events.md。
// 前端的同名常量走下面 VERSION_MAP 的精确文件映射。
const SYMBOL_MAP = [
  { symbol: "EVENT_CONTRACT_VERSION", doc: "docs/contracts/events.md" },
  { symbol: "CATALOG_CONTRACT_VERSION", doc: "docs/contracts/catalog.md" },
];

function docForFile(rel) {
  const exact = VERSION_MAP.find((e) => e.file === rel);
  if (exact) return exact.doc;
  const byPrefix = VERSION_MAP.find((e) => e.prefix && rel.startsWith(e.prefix));
  return byPrefix ? byPrefix.doc : null;
}

function docForLine(rel, line) {
  const bySymbol = SYMBOL_MAP.find((e) => line.includes(e.symbol));
  if (bySymbol) return bySymbol.doc;
  return docForFile(rel);
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
    // 两边都扫：Rust 侧（#[tauri::command] 与各模块常量）和前端侧（protocol.ts）。
    // 只扫 Rust 会漏掉「契约升了、前端没跟」这类漂移，而它不会在编译期报错。
    const roots = [
      { dir: join(ROOT, "src-tauri", "src"), exts: [".rs"] },
      { dir: join(ROOT, "src"), exts: [".ts", ".tsx"] },
    ];
    const problems = [];

    for (const { dir, exts } of roots) {
      if (!existsSync(dir)) continue;
      for (const file of walkExt(dir, exts)) {
        const rel = file.slice(ROOT.length + 1);
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/CONTRACT_VERSION|contract_version/.test(line)) return;
          // 归属按行判定：常量名优先于目录（见 VERSION_MAP 上方的说明）。
          const doc = docForLine(rel, line);
          // 未映射的文件/行不参与检查（例如 agent/ 下的命令层，不携带契约版本语义）。
          if (!doc) return;
          const expected = docContractVersion(doc);
          for (const m of line.matchAll(/"([\d.]+\.[\d.]+)"/g)) {
            if (m[1] === expected) continue;
            problems.push(`${rel}:${i + 1} 是 ${m[1]}，${doc} 是 ${expected}`);
          }
        });
      }
    }
    return problems;
  },
  { advisory: true }
);

// --- 6 & 7：命令四方对齐 ---
//
// 四个集合，任何一个方向对不上都会在运行期才炸：
//   doc       docs/contracts/commands.md §2 命令总表
//   impl      src-tauri/src/agent/commands.rs 的 #[tauri::command] 函数
//   register  src-tauri/src/lib.rs 的 generate_handler!
//   ui        src/agent/tauriBridge.ts 的 call("...")
//
// 判定：
//   impl 有、register 没有      → 失败（函数永远调不到）
//   register 有、doc 没有       → 失败（文档漏记，AI 与前端都按文档写）
//   ui 调用了 impl 里没有的命令 → 失败（点了就报「命令不存在」）
//   doc 有、impl 没有           → advisory（这批功能还没做到，不是缺陷）

function contractCommands() {
  const md = read("docs/contracts/commands.md");
  const start = md.indexOf("## 2. 命令总表");
  if (start < 0) throw new Error("未找到 docs/contracts/commands.md 的 §2 命令总表");
  const section = md.slice(start, md.indexOf("\n## ", start + 10));

  const rows = new Map();
  for (const m of section.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|\s*`([^`]*)`/gm)) {
    rows.set(m[1], { params: m[2] });
  }
  if (rows.size === 0) throw new Error("未能从 commands.md §2 解析出任何命令名");
  return rows;
}

/** 解析 `{ name, connectMode, targets? }` → ["name", "connectMode", "targets"]。 */
function parseParamList(text) {
  const inner = text.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/\?$/, "").trim())
    .filter(Boolean);
}

/** 从 Rust 文件里抽出 `#[tauri::command]` 函数的 (名字, 形参名[])。 */
// Tauri 从调用现场注入、不出现在 JS 入参对象里的形参。
const INJECTED_PARAMS = new Set(["state", "app", "window", "request"]);

function rustCommands() {
  const rs = read("src-tauri/src/agent/commands.rs");
  const out = new Map();
  const ATTR = "#[tauri::command]";
  let at = rs.indexOf(ATTR);
  while (at >= 0) {
    const sig = rs.indexOf("fn ", at);
    if (sig < 0) break;
    const nameMatch = /^fn\s+([a-z0-9_]+)\s*\(/.exec(rs.slice(sig));
    if (!nameMatch) {
      at = rs.indexOf(ATTR, at + 1);
      continue;
    }
    const name = nameMatch[1];
    // 从括号开始扫描到配对的右括号，收集形参名。
    let depth = 0;
    let i = rs.indexOf("(", sig);
    const startParen = i;
    for (; i < rs.length; i++) {
      if (rs[i] === "(") depth++;
      else if (rs[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const paramsBlob = rs.slice(startParen + 1, i).replace(/\/\/[^\n]*/g, "");
    const params = [];
    let d = 0;
    let current = "";
    for (const ch of paramsBlob) {
      if ("(<[".includes(ch)) d++;
      else if (")>]".includes(ch)) d--;
      if (ch === "," && d === 0) {
        params.push(current);
        current = "";
      } else current += ch;
    }
    if (current.trim()) params.push(current);

    const names = [];
    for (const raw of params) {
      const m = /^\s*(?:mut\s+)?(_?[a-z0-9_]+)\s*:/.exec(raw);
      if (!m) continue;
      // Tauri 注入参数：不对应任何 JS 入参。Rust 侧常写成 `_state` 表示未使用。
      if (INJECTED_PARAMS.has(m[1].replace(/^_+/, ""))) continue;
      names.push(m[1]);
    }
    out.set(name, names);
    at = rs.indexOf(ATTR, at + 1);
  }
  if (out.size === 0) throw new Error("未在 agent/commands.rs 找到任何 #[tauri::command] 函数");
  return out;
}

function registeredCommands() {
  const rs = read("src-tauri/src/lib.rs");
  const open = rs.indexOf("generate_handler![");
  if (open < 0) throw new Error("未在 lib.rs 找到 generate_handler!");
  const close = rs.indexOf("]", open);
  const blob = rs.slice(open, close);
  const names = new Set();
  for (const m of blob.matchAll(/\b([a-z0-9_]+)\s*(?:,|\s*$)/gm)) {
    if (m[1] === "generate_handler") continue;
    names.add(m[1]);
  }
  if (names.size === 0) throw new Error("generate_handler! 解析为空");
  return names;
}

/**
 * 从 tauriBridge.ts 抽出 `call("name")` / `call<T>("name", {...})`。
 * 泛型可能跨行（`call<{\n ... \n}>("x"`），所以按括号配对扫描，不用正则。
 */
function uiCalls() {
  const ts = read("src/agent/tauriBridge.ts");
  const calls = [];
  for (let i = ts.indexOf("call"); i >= 0; i = ts.indexOf("call", i + 4)) {
    // 必须是一个完整标识符起始，避免匹配到 recall 之类。
    if (i > 0 && /[A-Za-z0-9_$.]/.test(ts[i - 1])) continue;
    let p = i + 4;
    while (/\s/.test(ts[p] || "")) p++;
    if (ts[p] === "<") {
      let depth = 0;
      for (; p < ts.length; p++) {
        if (ts[p] === "<") depth++;
        else if (ts[p] === ">") {
          depth--;
          if (depth === 0) {
            p++;
            break;
          }
        }
      }
      while (/\s/.test(ts[p] || "")) p++;
    }
    if (ts[p] !== "(") continue;
    p++;
    while (/\s/.test(ts[p] || "")) p++;
    const m = /^"([a-z0-9_]+)"/.exec(ts.slice(p));
    if (!m) continue;

    // 取第二个实参（args 对象），只处理无 `...` 的简单字面量。
    const afterName = p + m[0].length;
    let q = ts.indexOf(",", afterName);
    let args = null;
    if (q >= 0 && ts.slice(afterName, q).trim() === "") {
      let brace = q + 1;
      while (/\s/.test(ts[brace] || "")) brace++;
      if (ts[brace] === "{") {
        let depth = 0;
        let r = brace;
        for (; r < ts.length; r++) {
          if (ts[r] === "{") depth++;
          else if (ts[r] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        const body = ts.slice(brace + 1, r);
        if (!/\.\.\./.test(body)) {
          args = body
            .split(",")
            .map((s) => s.split(":")[0].trim())
            .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
        }
      }
    }
    calls.push({ name: m[1], args });
  }
  if (calls.length === 0) throw new Error("未在 tauriBridge.ts 解析出任何 call(...)");
  return calls;
}

check("命令在文档 / 实现 / 注册 / 前端四方一致", () => {
  const doc = contractCommands();
  const impl = rustCommands();
  const registered = registeredCommands();
  const ui = new Set(uiCalls().map((c) => c.name));

  const problems = [];
  for (const name of impl.keys()) {
    if (!registered.has(name)) problems.push(`实现了但没注册到 generate_handler!：${name}`);
  }
  for (const name of registered) {
    if (!impl.has(name)) problems.push(`注册了但 agent/commands.rs 里没有这个函数：${name}`);
    if (!doc.has(name)) problems.push(`注册了但 commands.md §2 没写：${name}`);
  }
  for (const name of ui) {
    if (!impl.has(name)) problems.push(`前端 invoke 了一个不存在的命令：${name}`);
    if (!doc.has(name)) problems.push(`前端在调、但 commands.md §2 没写：${name}`);
  }
  return problems;
});

check(
  "commands.md 声明的命令尚未实现（advisory，未实现的功能不算缺陷）",
  () => {
    const doc = contractCommands();
    const impl = rustCommands();
    const problems = [];
    for (const name of doc.keys()) {
      if (!impl.has(name)) problems.push(`${name} 已在契约里声明，实现还没有`);
    }
    return problems;
  },
  { advisory: true }
);

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

check(
  "命令入参在文档 / Rust 形参之间对齐（契约声明了、实现还没收 → advisory）",
  () => {
    const doc = contractCommands();
    const impl = rustCommands();
    const problems = [];

    // 这个命令走 tauri::ipc::Request 手工解析，形参不是常规映射，单独跳过。
    const RAW_REQUEST_COMMANDS = new Set(["config_update"]);

    for (const [name, { params }] of doc) {
      if (!impl.has(name)) continue; // 未实现已由上面那条 advisory 覆盖
      if (RAW_REQUEST_COMMANDS.has(name)) continue;
      const expected = parseParamList(params).map(snakeToCamel);
      const actual = impl.get(name).map(snakeToCamel);

      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      for (const p of expected) if (!actualSet.has(p)) problems.push(`${name}：契约有 ${p}，Rust 形参还没收`);
    }
    return problems;
  },
  { advisory: true }
);

check("Rust 形参都在契约里写过，且前端实参 Rust 收得到", () => {
  const doc = contractCommands();
  const impl = rustCommands();
  const ui = uiCalls();
  const problems = [];

  const RAW_REQUEST_COMMANDS = new Set(["config_update"]);

  for (const [name, actual] of impl) {
    if (RAW_REQUEST_COMMANDS.has(name)) continue;
    const docParams = doc.has(name) ? parseParamList(doc.get(name).params).map(snakeToCamel) : [];
    const expectedSet = new Set(docParams);
    for (const p of actual.map(snakeToCamel)) {
      if (!expectedSet.has(p)) problems.push(`${name}：Rust 形参有 ${p}，commands.md 没写`);
    }
  }

  for (const { name, args } of ui) {
    if (!args || !impl.has(name)) continue;
    const expected = new Set(impl.get(name).map(snakeToCamel));
    for (const a of args) {
      if (!expected.has(a)) {
        problems.push(`前端调 ${name} 传了 ${a}，Rust 侧没有这个形参（会被静默忽略）`);
      }
    }
  }
  return problems;
});

// --- 8：事件载荷字段 ---
//
// events.md 里的 `type XxxPayload = {...}` 是 UI 唯一可以依赖的字段清单。
// protocol.ts 的接口是 UI 实际消费的形状。两者漂移 = 字段改名后 UI 静默读到 undefined。

function contractPayloadTypes() {
  const md = read("docs/contracts/events.md");
  // 只认 §1 事件总表里「载荷类型」那一列点过名的类型，避免把普通 type 别名算进来。
  const named = new Set();
  for (const m of md.matchAll(/^\|\s*\d+\s*\|\s*`[a-z0-9-]+`\s*\|[^|]*\|\s*`(\w+Payload)`\s*\|/gm)) {
    named.add(m[1]);
  }
  if (named.size === 0) throw new Error("未能从 events.md §1 解析出载荷类型名");

  const out = new Map();
  for (const m of md.matchAll(/^type\s+(\w+Payload)\s*=\s*\{([\s\S]*?)\n\};/gm)) {
    if (!named.has(m[1])) continue;
    out.set(m[1], parseTsFields(m[2]));
  }
  if (out.size === 0) throw new Error("events.md 里一个载荷类型都没解析出来");
  return { named, parsed: out };
}

function parseTsFields(body) {
  const fields = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const m = /^([a-z_][a-z0-9_]*)\??\s*:/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

function protocolPayloadTypes() {
  const ts = read("src/agent/protocol.ts");
  const out = new Map();
  for (const m of ts.matchAll(/^export interface (\w+Payload)\s*\{([\s\S]*?)\n\}/gm)) {
    out.set(m[1], parseTsFields(m[2]));
  }
  // 别名（`export type A = B`）直接继承，按 B 的字段算。
  for (const m of ts.matchAll(/^export type (\w+Payload)\s*=\s*(\w+Payload)\s*;/gm)) {
    if (out.has(m[2])) out.set(m[1], out.get(m[2]));
  }
  return out;
}

// 两个方向分开判：
//   契约有、UI 没有   → advisory（字段是 2.0/2.1 新加的，UI 还没跟上）
//   UI 有、契约没有   → 失败（旧字段名没清掉，UI 读到的是 undefined，这类最像「能跑但显示不对」）

function payloadFieldDiff() {
  const { named, parsed } = contractPayloadTypes();
  const code = protocolPayloadTypes();
  const missing = [];
  const stale = [];

  for (const typeName of named) {
    const docFields = parsed.get(typeName);
    if (!docFields) {
      missing.push(`${typeName}：events.md §1 点名了，但正文里没有可解析的 type 定义`);
      continue;
    }
    const codeFields = code.get(typeName);
    if (!codeFields) {
      missing.push(`${typeName}：protocol.ts 里没有对应接口（UI 会读不到字段）`);
      continue;
    }
    const docSet = new Set(docFields);
    const codeSet = new Set(codeFields);
    for (const f of docSet) if (!codeSet.has(f)) missing.push(`${typeName}.${f}：契约有、protocol.ts 没有`);
    for (const f of codeSet) if (!docSet.has(f)) stale.push(`${typeName}.${f}：protocol.ts 有、契约没有（旧字段名没清）`);
  }
  return { missing, stale };
}

check(
  "事件载荷：契约新增的字段还没进 protocol.ts",
  () => payloadFieldDiff().missing,
  { advisory: true }
);

check("事件载荷：protocol.ts 里有契约已删除的字段", () => payloadFieldDiff().stale);

// Rust 侧大部分事件载荷是 `json!({...})` 直接拼的，没有结构体可比。
// 只对**确实定义了结构体**的载荷做比对，其余交给 protocol.ts 那条。
check(
  "事件载荷：Rust 结构体与 events.md 的字段差异",
  () => {
    const { parsed } = contractPayloadTypes();
    const problems = [];
    let compared = 0;

    for (const file of walkRs(join(ROOT, "src-tauri", "src"))) {
      const rel = file.slice(ROOT.length + 1);
      const rs = readFileSync(file, "utf8");
      for (const m of rs.matchAll(/pub struct (\w+Payload)\s*\{([\s\S]*?)\n\}/g)) {
        const docFields = parsed.get(m[1]);
        if (!docFields) continue;
        compared++;
        const rustFields = [];
        for (const line of m[2].split("\n")) {
          const f = /^\s*pub\s+(\w+)\s*:/.exec(line);
          if (f) rustFields.push(f[1]);
        }
        const docSet = new Set(docFields);
        const rustSet = new Set(rustFields);
        for (const f of docSet) if (!rustSet.has(f)) problems.push(`${rel} ${m[1]}.${f}：契约有、Rust 结构体没有`);
        for (const f of rustSet) if (!docSet.has(f)) problems.push(`${rel} ${m[1]}.${f}：Rust 有、契约没有`);
      }
    }

    // 覆盖率低是事实，不要让它悄悄变成「全都检查过了」。
    if (compared === 0) return ["一个事件载荷结构体都没比对上，检查脚本需要更新"];
    if (problems.length > 0) {
      problems.push(`（本轮仅比对了 ${compared} 个以结构体定义的事件载荷；其余是 json! 拼的，见报告）`);
    }
    return problems;
  },
  { advisory: true }
);

// --- 9：AI 边界的硬约束 ---
//
// 运行时核心版本管理与 TUN helper 重启只属于 UI：模型既不能下载/升级/回滚运行时，
// 也不能重启特权组件。这两类操作都必须由用户看见并显式点击。
//
// 契约侧（tools.md / commands.md）是硬约束，违反即失败；实现侧滞后时只报 advisory，
// 等实现会话删掉 CoreInstallTool 后自动转绿。不要为了让检查变绿而回退契约。

const REMOVED_AI_TOOLS = ["CoreInstall"];
const UI_ONLY_COMMANDS = [
  "core_info",
  "core_check_updates",
  "core_cancel_upgrade",
  "core_rollback",
  "tun_helper_info",
  "tun_helper_restart",
  "node_probe_all",
  "node_probe_cancel",
  "node_probe_snapshot",
];

const pascalCase = (s) => s.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

/** tools.md §3 的工具表：模型可见名 → 该行其余内容。 */
function contractTools() {
  const md = read("docs/contracts/tools.md");
  const start = md.indexOf("## 3. P1 工具总表");
  if (start < 0) throw new Error("未找到 docs/contracts/tools.md 的 §3 工具总表");
  const end = md.indexOf("### 3.1", start);
  const section = md.slice(start, end < 0 ? undefined : end);
  const rows = new Map();
  for (const m of section.matchAll(/^\|\s*\d+\s*\|\s*`([A-Za-z]+)`\s*\|([^\n]*)$/gm)) {
    rows.set(m[1], m[2]);
  }
  if (rows.size === 0) throw new Error("未能从 tools.md §3 解析出任何工具名");
  return rows;
}

/** src-tauri/src/tools/mod.rs 的 vpn_tools() 注册了哪些模型可见名。 */
function registeredToolTypes() {
  const rs = read("src-tauri/src/tools/mod.rs");
  const open = rs.indexOf("pub fn vpn_tools");
  if (open < 0) throw new Error("未在 tools/mod.rs 找到 vpn_tools()");
  const close = rs.indexOf("\n}", open);
  const blob = rs.slice(open, close < 0 ? undefined : close);
  const names = new Set();
  for (const m of blob.matchAll(/Box::new\(\w+::(\w+Tool)\b/g)) names.add(m[1].replace(/Tool$/, ""));
  for (const m of blob.matchAll(/Box::new\((\w+Guard)\b/g)) names.add(m[1].replace(/Guard$/, ""));
  if (names.size === 0) throw new Error("vpn_tools() 里一个工具都没解析出来");
  return names;
}

check("AI 工具集不再包含已移除的工具（契约）", () => {
  const tools = contractTools();
  const problems = [];
  for (const n of REMOVED_AI_TOOLS) {
    if (tools.has(n)) problems.push(`tools.md §3 仍然列出 ${n}（它已被移出 AI 工具集）`);
  }

  const md = read("docs/contracts/tools.md");
  const regStart = md.indexOf("### 3.1 注册清单（照抄）");
  const regEnd = md.indexOf("### 3.2", regStart);
  const regBlock = md.slice(regStart, regEnd < 0 ? undefined : regEnd);
  for (const n of REMOVED_AI_TOOLS) {
    if (new RegExp(`\\b${n}Tool\\b`).test(regBlock)) {
      problems.push(`tools.md §3.1 的注册清单里仍有 ${n}Tool`);
    }
  }
  return problems;
});

check("UI 专用命令没有 AI 工具（契约）", () => {
  const tools = contractTools();
  const problems = [];
  for (const cmd of UI_ONLY_COMMANDS) {
    const name = pascalCase(cmd);
    if (tools.has(name)) {
      problems.push(`tools.md §3 列出了 ${name}，但 ${cmd} 是 UI 专用命令（模型不得触发）`);
    }
  }
  return problems;
});

check("CoreListVersions 仍是只读 AI 工具", () => {
  const tools = contractTools();
  const row = tools.get("CoreListVersions");
  if (!row) return ["tools.md §3 缺少 CoreListVersions（版本查询是保留给模型的只读能力）"];
  if (!row.includes("`ReadOnly`")) {
    return ["CoreListVersions 的 PermissionLevel 不是 ReadOnly（它只能查询，不能下载）"];
  }
  return [];
});

check("commands.md 记录了全部 UI 专用命令", () => {
  const doc = contractCommands();
  return UI_ONLY_COMMANDS.filter((n) => !doc.has(n)).map((n) => `commands.md §2 缺少 ${n}`);
});

check(
  "AI 工具实现与 contracts/tools.md 的工具集一致（advisory）",
  () => {
    const registered = registeredToolTypes();
    const problems = [];
    for (const n of REMOVED_AI_TOOLS) {
      if (registered.has(n)) {
        problems.push(`src-tauri/src/tools/mod.rs 仍注册 ${n}Tool（契约已移除；删掉后本项转绿）`);
      }
    }
    for (const cmd of UI_ONLY_COMMANDS) {
      const n = pascalCase(cmd);
      if (registered.has(n)) {
        problems.push(`src-tauri/src/tools/mod.rs 注册了 ${n}Tool，但 ${cmd} 是 UI 专用命令`);
      }
    }
    return problems;
  },
  { advisory: true }
);

// --- 10：TUN helper 的状态枚举与 restart 协商 ---
//
// `tun_helper_info.state` 是 UI 分支的唯一依据，少一个值就会有状态掉进 default。
// `restart` 是版本协商的探针：旧 helper 只会返回 bad_request。契约先锁文档，实现未
// 跟上时只报 advisory（PM 允许先不实现）。

const TUN_HELPER_STATES = ["running", "not_running", "stale", "start_failed", "file_invalid"];

function tunHelperInfoStateUnion() {
  const md = read("docs/contracts/commands.md");
  const typeBlock = md.match(/type TunHelperInfoData = \{([\s\S]*?)\n\};/);
  if (!typeBlock) throw new Error("未在 commands.md 找到 TunHelperInfoData 定义");
  const stateLine = typeBlock[1].match(/^\s*state\s*:\s*([^;]+);/m);
  if (!stateLine) throw new Error("TunHelperInfoData 缺少 state 字段");
  return [...stateLine[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

check("tun_helper_info.state 枚举完备（契约）", () => {
  const actual = tunHelperInfoStateUnion();
  const md = read("docs/contracts/commands.md");
  const problems = [];

  for (const s of TUN_HELPER_STATES) {
    if (!actual.includes(s)) problems.push(`缺失 state 取值：${s}`);
  }
  for (const s of actual) {
    if (!TUN_HELPER_STATES.includes(s)) problems.push(`多出未约定的 state 取值：${s}`);
  }

  // 每个取值都必须在 §7.8.1 的语义表里占一行，不能只写在类型里。
  const start = md.indexOf("### 7.8.1");
  const end = md.indexOf("### 7.8.2", start);
  const body = md.slice(start, end < 0 ? undefined : end);
  for (const s of TUN_HELPER_STATES) {
    if (!body.includes("| `" + s + "` |")) problems.push(`§7.8.1 的语义表没有解释 state = ${s}`);
  }
  return problems;
});

check("tun-backend.md 声明了 restart 与 helper 构建字段（契约）", () => {
  const md = read("docs/contracts/tun-backend.md");
  const problems = [];

  if (!/method:\s*"start"\s*\|\s*"stop"\s*\|\s*"status"\s*\|\s*"restart"/.test(md)) {
    problems.push("TunRequest.method 没有 restart");
  }
  if (!/fn\s+restart\s*\(&self\)\s*->\s*Result<\s*\(\s*\)\s*,\s*TunError\s*>/.test(md)) {
    problems.push("TunBackend trait 没有 fn restart(&self) -> Result<(), TunError>");
  }

  const snap = md.match(/type TunSnapshot = \{([\s\S]*?)\n\};/);
  if (!snap) {
    problems.push("找不到 TunSnapshot 定义");
  } else {
    for (const f of ["helper_build", "helper_version"]) {
      if (!new RegExp(`\\b${f}\\b`).test(snap[1])) problems.push(`TunSnapshot 缺少 ${f}`);
    }
  }
  return problems;
});

check(
  "tun-backend 的 restart 实现状态（advisory）",
  () => {
    const problems = [];
    if (!/"restart"\s*=>/.test(read("src-tauri/src/bin/veyl-helper/macos.rs"))) {
      problems.push("veyl-helper/macos.rs 还没有处理 restart");
    }
    if (!/"restart"\s*=>/.test(read("src-tauri/src/tun/windows/ipc.rs"))) {
      problems.push("tun/windows/ipc.rs 还没有解析 restart");
    }
    if (!/fn\s+restart\s*\(&self\)/.test(read("src-tauri/src/tun/backend.rs"))) {
      problems.push("tun/backend.rs 的 TunBackend 还没有 restart 方法");
    }
    return problems;
  },
  { advisory: true }
);

// --- 11：AI 代劳升级 ---
//
// CoreUpgrade 是唯一有确认点的工具：它不在 UI 专用清单里，而是明确允许模型调用。
// 这里锁三件事：工具表里有它、参数只有可选 version、确认卡走 AskUserQuestion 的
// kind/details；实现滞后时只报 advisory。

check("CoreUpgrade 在工具表中且为高风险 Execute", () => {
  const tools = contractTools();
  const row = tools.get("CoreUpgrade");
  if (!row) return ["tools.md §3 缺少 CoreUpgrade（AI 代劳升级的唯一入口）"];
  const problems = [];
  if (!row.includes("`Execute`")) problems.push("CoreUpgrade 的 PermissionLevel 不是 Execute");
  if (!row.includes("高")) problems.push("CoreUpgrade 的风险等级不是「高」");
  return problems;
});

check("CoreUpgrade 参数只有可选 version（契约）", () => {
  const md = read("docs/contracts/tools.md");
  const start = md.indexOf("### 4.45 `CoreUpgrade`");
  if (start < 0) return ["tools.md 找不到 §4.45 CoreUpgrade"];
  const end = md.indexOf("## 5.", start);
  const block = md.slice(start, end < 0 ? undefined : end);

  const schemaBlock = block.match(/```json\s*([\s\S]*?)```/);
  if (!schemaBlock) return ["§4.45 找不到 JSON Schema"];

  let schema;
  try {
    schema = JSON.parse(schemaBlock[1]);
  } catch (err) {
    return [`§4.45 的 JSON Schema 不是合法 JSON：${err.message}`];
  }

  const problems = [];
  const props = Object.keys(schema.properties || {});
  if (props.length !== 1 || props[0] !== "version") {
    problems.push(`§4.45 只允许 version 一个参数，实际是 ${JSON.stringify(props)}`);
  }
  if ((schema.required || []).includes("version")) problems.push("version 必须是可选参数");
  if (schema.additionalProperties !== false) problems.push("§4.45 必须声明 additionalProperties: false");
  for (const key of ["url", "sha256", "size", "force"]) {
    if (!block.includes(key)) problems.push(`§4.45 没有写明 ${key} 会被拒绝`);
  }
  return problems;
});

function payloadFields(rel, typeName) {
  const md = read(rel);
  const m = md.match(new RegExp(`type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
  return m ? parseTsFields(m[1]) : null;
}

function payloadFieldIsOptional(rel, typeName, field) {
  const md = read(rel);
  const m = md.match(new RegExp(`type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) return null;
  return new RegExp(`^\\s*${field}\\?\\s*:`, "m").test(m[1]);
}

check("ask-user-question 载荷有 kind / details（且可选）", () => {
  const fields = payloadFields("docs/contracts/events.md", "AskUserQuestionPayload");
  if (!fields) return ["events.md 找不到 AskUserQuestionPayload"];
  const problems = [];
  for (const f of ["kind", "details"]) {
    if (!fields.includes(f)) problems.push(`AskUserQuestionPayload 缺少 ${f}`);
    else if (payloadFieldIsOptional("docs/contracts/events.md", "AskUserQuestionPayload", f) !== true) {
      problems.push(`AskUserQuestionPayload.${f} 必须是可选字段（模型提问时不带）`);
    }
  }
  return problems;
});

check("任务来源 origin 在 Job 与三个事件载荷中必填", () => {
  const problems = [];

  for (const t of [
    "JobProgressPayload",
    "CoreUpgradeProgressPayload",
    "CoreUpgradeFinishedPayload",
  ]) {
    const fields = payloadFields("docs/contracts/events.md", t);
    if (!fields) {
      problems.push(`events.md 找不到 ${t}`);
      continue;
    }
    if (!fields.includes("origin")) problems.push(`${t} 缺少 origin`);
    else if (payloadFieldIsOptional("docs/contracts/events.md", t, "origin") !== false) {
      problems.push(`${t}.origin 必须是必填字段`);
    }
  }

  const jobFields = payloadFields("docs/contracts/tools.md", "Job");
  if (!jobFields) problems.push("tools.md 找不到 Job 类型");
  else if (!jobFields.includes("origin")) problems.push("Job 缺少 origin");
  else if (payloadFieldIsOptional("docs/contracts/tools.md", "Job", "origin") !== false) {
    problems.push("Job.origin 必须是必填字段");
  }
  return problems;
});

check("升级确认卡 details 含 restart_required（契约）", () => {
  const md = read("docs/contracts/commands.md");
  const m = md.match(/type CoreUpgradeConfirmDetails = \{([\s\S]*?)\n\};/);
  if (!m) return ["commands.md 找不到 CoreUpgradeConfirmDetails"];
  const fields = parseTsFields(m[1]);
  const problems = [];
  for (const f of ["current_version", "target_version", "size", "source", "restart_required"]) {
    if (!fields.includes(f)) problems.push(`CoreUpgradeConfirmDetails 缺少 ${f}`);
  }
  if (!/source:\s*"official"/.test(m[1])) problems.push('source 必须固定为 "official"');
  if (/^\s*restart_required\?\s*:/m.test(m[1])) problems.push("restart_required 必须是必填字段");
  return problems;
});

check(
  "CoreUpgrade 实现注册状态（advisory）",
  () => {
    if (!registeredToolTypes().has("CoreUpgrade")) {
      return ["src-tauri/src/tools/mod.rs 还没有注册 CoreUpgradeTool"];
    }
    return [];
  },
  { advisory: true }
);

// --- 12：对话过程展示 ---
//
// 工具调用对用户只呈现一行「做了什么 + 结果」：完成/失败文案在 tool-call-end.display，
// 进行中与兜底文案在前端静态映射表。这里锁三件事：display 形状、映射表与 §3 的 44 个
// 名字集合相等、AskUserQuestion 不产生展示行。前端尚未实现时映射表只报 advisory。

const TOOL_DISPLAY_FILE = "src/components/toolDisplay.ts";

check("tool-call-end 的 display 形状完备（契约）", () => {
  const fields = payloadFields("docs/contracts/events.md", "ToolCallEndPayload");
  if (!fields) return ["events.md 找不到 ToolCallEndPayload"];
  const problems = [];

  if (!fields.includes("display")) {
    problems.push("ToolCallEndPayload 缺少 display");
  } else if (payloadFieldIsOptional("docs/contracts/events.md", "ToolCallEndPayload", "display") !== true) {
    problems.push("display 必须是可选字段（旧后端缺失时静默回落）");
  }

  const md = read("docs/contracts/events.md");
  const m = md.match(/type ToolDisplay = \{([\s\S]*?)\n\};/);
  if (!m) {
    problems.push("events.md 找不到 ToolDisplay 类型");
    return problems;
  }
  const body = m[1];
  for (const f of ["text", "facts", "changed"]) {
    if (!new RegExp(`^\\s*${f}\\??\\s*:`, "m").test(body)) problems.push(`ToolDisplay 缺少 ${f}`);
  }
  if (!/^\s*facts\?\s*:/m.test(body)) problems.push("ToolDisplay.facts 必须是可选字段");
  if (!/changed\s*:\s*"none"\s*\|\s*"restored"\s*\|\s*"unknown"/.test(body)) {
    problems.push('ToolDisplay.changed 必须是 "none" | "restored" | "unknown"');
  }

  for (const phrase of ["≤24 字", "≤4 行", "只读工具固定", "不产生展示行"]) {
    if (!md.includes(phrase)) problems.push(`events.md 的 display 说明缺少「${phrase}」`);
  }
  for (const tool of ["VpnConnect", "NetRepair", "CoreUpgrade", "ConfigDelete"]) {
    if (!md.includes(tool)) problems.push(`events.md 的 display 说明没有点名 ${tool} 必须声明 changed`);
  }
  return problems;
});

check("失败第二行三句定稿且不含「网络」（契约）", () => {
  const md = read("docs/contracts/events.md");
  const m = md.match(
    /`"none"`\s*=\s*\*\*([^*]+)\*\*；\s*`"restored"`\s*=\s*\*\*([^*]+)\*\*；\s*`"unknown"`\s*=\s*\*\*([^*]+)\*\*/
  );
  if (!m) return ["events.md §3.4 找不到 changed 的三句定稿文案"];

  const expected = ["没有改动任何设置", "已经恢复原样", "不确定，诊断日志里有记录"];
  const actual = [m[1], m[2], m[3]].map((s) => s.trim());
  const problems = [];
  expected.forEach((want, i) => {
    if (actual[i] !== want) problems.push(`changed 文案应为「${want}」，实际是「${actual[i]}」`);
    if (actual[i].includes("网络")) problems.push(`changed 文案不得出现「网络」：「${actual[i]}」`);
  });
  return problems;
});

check(
  "changedLabel 文案不含「网络」（实现，advisory）",
  () => {
    if (!existsSync(join(ROOT, TOOL_DISPLAY_FILE))) return [];
    const ts = read(TOOL_DISPLAY_FILE);
    const fn = ts.match(/export function changedLabel[\s\S]*?\n\}/);
    if (!fn) return ["toolDisplay.ts 找不到 changedLabel"];
    return /网络/.test(fn[0]) ? ["changedLabel 的文案含「网络」；三句必须面向全部工具"] : [];
  },
  { advisory: true }
);

/** 前端映射表的工具名集合；文件不存在时返回 null（实现尚未落地）。 */
function frontendToolDisplayNames() {
  if (!existsSync(join(ROOT, TOOL_DISPLAY_FILE))) return null;
  const ts = read(TOOL_DISPLAY_FILE);
  const arr = ts.match(/TOOL_DISPLAY_NAMES\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/);
  if (arr) {
    return new Set([...arr[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((x) => x[1]));
  }
  // 实现名 `TOOL_COPY`，设计文档里写作 `TOOL_DISPLAY`；两个都认，断的是键集合。
  const obj = ts.match(/export const (?:TOOL_COPY|TOOL_DISPLAY)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\n\};/);
  if (obj) {
    return new Set([...obj[1].matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*:/gm)].map((x) => x[1]));
  }
  return new Set();
}

check("前端映射表工具名集合与 tools.md §3 的 44 个相等", () => {
  const names = frontendToolDisplayNames();
  if (names === null) return []; // 未实现时由下一条 advisory 报，不在这里制造红
  const tools = contractTools();
  const missing = [...tools.keys()].filter((n) => !names.has(n));
  const extra = [...names].filter((n) => !tools.has(n));
  const problems = [];
  if (missing.length) problems.push(`映射表缺少 ${missing.length} 个：${missing.join(", ")}`);
  if (extra.length) problems.push(`映射表多出 ${extra.length} 个：${extra.join(", ")}`);
  return problems;
});

check(
  "前端映射表尚未实现（advisory）",
  () => {
    if (frontendToolDisplayNames() !== null) return [];
    return [`${TOOL_DISPLAY_FILE} 不存在，集合相等断言暂不生效`];
  },
  { advisory: true }
);

check("AskUserQuestion 不产生展示行（契约）", () => {
  const md = read("docs/contracts/events.md");
  if (!/AskUserQuestion[\s\S]{0,120}不产生展示行/.test(md)) {
    return ["events.md 没有写明 AskUserQuestion 不产生展示行"];
  }
  return [];
});

check(
  "AskUserQuestion 不产生展示行（实现，advisory）",
  () => {
    if (frontendToolDisplayNames() === null) return [];
    const files = [
      "src/components/ToolCallCard.tsx",
      "src/components/MessageItem.tsx",
      "src/state/chatStore.ts",
    ].filter((f) => existsSync(join(ROOT, f)));
    const ui = files.map((f) => read(f)).join("\n");
    if (!/tool\s*===\s*"AskUserQuestion"/.test(ui)) {
      return ["渲染层没有跳过 AskUserQuestion，它会被画成普通工具行（应由提问浮层承担）"];
    }
    return [];
  },
  { advisory: true }
);

check(
  "前端 ChangedState 与契约的 changed 取值一致（advisory）",
  () => {
    if (!existsSync(join(ROOT, TOOL_DISPLAY_FILE))) return [];
    const ts = read(TOOL_DISPLAY_FILE);
    const m = ts.match(/type ChangedState\s*=\s*([^;]+);/);
    if (!m) return ["toolDisplay.ts 找不到 ChangedState"];
    const values = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    const expected = ["none", "restored", "unknown"];
    const problems = [];
    for (const v of expected) if (!values.includes(v)) problems.push(`ChangedState 缺少 "${v}"`);
    const extra = values.filter((v) => !expected.includes(v));
    if (extra.length) problems.push(`ChangedState 多出 ${extra.map((v) => `"${v}"`).join(", ")}`);
    return problems;
  },
  { advisory: true }
);

// --- 13：提示词、工具描述与状态文案 ---
//
// 提示词降低概率，渲染层是唯一结构闸门。这里防的是回归：
//   1. 系统提示「怎么说话」八条与 SAFETY_RULES 新增两条，删任一条即红；
//   2. 危险工具的 description 末尾有表达约束、第一行没有（第一行进能力清单）；
//   3. running 状态文案不拼工具名，未知工具落到「正在处理…」。

const DANGEROUS_EXPRESSION_TOOLS = [
  "VpnConnect",
  "VpnDisconnect",
  "NetRepair",
  "CoreUpgrade",
  "ConfigDelete",
  "RouteSetMode",
];

const EXPRESSION_MARKERS = [
  "对用户只说",
  "对用户说",
  "不要念给用户",
  "不出现",
  "不提",
  "说「",
  "不要复述",
  "是否已恢复",
  "恢复原样",
];

check("系统提示含「怎么说话」八条", () => {
  const rel = "resources/prompts/zh/first-run.md";
  if (!existsSync(join(ROOT, rel))) return [`找不到 ${rel}`];
  const md = read(rel);
  const problems = [];
  if (!md.includes("# 怎么说话")) problems.push("first-run.md 缺少「# 怎么说话」一节");
  const needles = [
    "只说结果和影响",
    "这些词和写法不出现在正文里",
    "不叙述你在调用什么",
    "也不要提前报",
    "失败固定三句",
    "技术细节在诊断日志里",
    "不重复界面上已经显示的内容",
    "只有用户主动问技术问题",
  ];
  for (const n of needles) if (!md.includes(n)) problems.push(`「怎么说话」缺少规则：${n}`);
  return problems;
});

check("SAFETY_RULES 含新增两条", () => {
  const rs = read("src-tauri/src/claurst_session/mod.rs");
  const m = rs.match(/const SAFETY_RULES: &str = "([\s\S]*?)";/);
  if (!m) return ["mod.rs 找不到 SAFETY_RULES"];
  const problems = [];
  for (const n of [
    "面向用户的正文不出现工具名、字段名、错误码、节点/配置 ID 与内部名词",
    "失败时说明有没有改动用户当前的网络设置",
  ]) {
    if (!m[1].includes(n)) problems.push(`SAFETY_RULES 缺少：${n}`);
  }
  return problems;
});

/** Rust 字符串字面量 → 实际文本：处理行尾反斜杠续行、\n、\". */
function rustStringBody(lit) {
  return lit
    .replace(/\\\n\s*/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 工具名 → description 文本（按 `impl Tool for X` 里的 name()/description() 配对）。 */
function rustDescriptions() {
  const dir = join(ROOT, "src-tauri", "src", "tools");
  const out = new Map();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".rs")) continue;
    const rel = `src-tauri/src/tools/${e.name}`;
    const src = read(rel);
    const re =
      /fn name\(&self\) -> &str \{\s*"([A-Za-z]+)"\s*\}[\s\S]*?fn description\(&self\) -> &str \{\s*"((?:[^"\\]|\\[\s\S])*)"/g;
    for (const m of src.matchAll(re)) {
      out.set(m[1], { body: rustStringBody(m[2]), file: rel });
    }
  }
  return out;
}

check("危险工具 description 末尾有表达约束、首行没有", () => {
  const descs = rustDescriptions();
  const problems = [];
  for (const tool of DANGEROUS_EXPRESSION_TOOLS) {
    const d = descs.get(tool);
    if (!d) {
      problems.push(`找不到 ${tool} 的 description()`);
      continue;
    }
    const [first, ...rest] = d.body.split("\n");
    const hitFirst = EXPRESSION_MARKERS.find((m) => first.includes(m));
    if (hitFirst) {
      problems.push(`${tool} 的第一行含表达约束「${hitFirst}」，会污染能力清单：${first.trim()}`);
    }
    const tail = rest.join("\n").trim();
    if (!tail) {
      problems.push(`${tool} 的 description 没有末尾表达约束（追加句必须用 \\n 分段）`);
    } else if (!EXPRESSION_MARKERS.some((m) => tail.includes(m))) {
      problems.push(`${tool} 的末尾没有约定措辞的表达约束：${tail}`);
    }
  }
  return problems;
});

check("ai-status 文案的约束写进了契约", () => {
  const md = read("docs/contracts/events.md");
  const problems = [];
  if (!md.includes("不得包含工具名")) problems.push("events.md 没有写明 ai-status.text 不得包含工具名");
  if (!md.includes("正在处理…")) problems.push("events.md 没有写明未知工具的 running 文案是「正在处理…」");
  return problems;
});

check("running 状态文案不拼工具名，未知工具落到「正在处理…」", () => {
  const problems = [];

  const mod = read("src-tauri/src/claurst_session/mod.rs");
  mod.split("\n").forEach((line, i) => {
    if (line.includes("正在运行") && line.includes("tool_name")) {
      problems.push(`mod.rs:${i + 1} 用工具名拼 running 文案：${line.trim()}`);
    }
  });

  const store = read("src/state/chatStore.ts");
  store.split("\n").forEach((line, i) => {
    if (/正在执行\s*\$\{\s*tool\s*\}/.test(line)) {
      problems.push(`chatStore.ts:${i + 1} 用工具名拼 running 文案：${line.trim()}`);
    }
  });

  if (!existsSync(join(ROOT, TOOL_DISPLAY_FILE))) {
    problems.push(`${TOOL_DISPLAY_FILE} 不存在，未知工具没有兜底`);
    return problems;
  }
  // 行为断言放在 src/components/toolDisplay.test.ts（vitest 真跑）：
  // 这里只做结构性检查，不把实现写法（??、if、查表顺序）变成契约。
  const ts = read(TOOL_DISPLAY_FILE);
  if (!/export const FALLBACK_COPY/.test(ts)) problems.push("toolDisplay.ts 缺少 FALLBACK_COPY");
  if (!/export function toolCopy\s*\(/.test(ts)) problems.push("toolDisplay.ts 未导出 toolCopy");
  return problems;
});

check("ToolEnvelope 不含 display（契约）", () => {
  const fields = payloadFields("docs/contracts/tools.md", "ToolEnvelope");
  if (!fields) return ["tools.md 找不到 ToolEnvelope"];
  return fields.includes("display")
    ? ["ToolEnvelope 不应包含 display：用户文案只走 tool-call-end.display"]
    : [];
});

// 后端已删除 display（2026-11-06），这里转成硬失败：再被塞回模型可见的信封就红。
check("to_envelope() 输出不含 display（实现）", () => {
  const rs = read("src-tauri/src/tools/envelope.rs");
  const m = rs.match(/fn to_envelope\(&self\) -> Value \{([\s\S]*?)\n    \}/);
  if (!m) return ["envelope.rs 找不到 to_envelope()"];
  if (/\bdisplay\b/.test(m[1])) {
    return ["to_envelope() 又输出了 display：用户文案只走 tool-call-end.display"];
  }
  return [];
});

// --- 14：批量测速 ---
//
// 三条 UI 专用命令 + 两条事件。锁形状、BUSY 的 run_id、snapshot.run 的两种取值、
// 「有缓存 ≠ 已测完」、四个终态，以及「不发 *-changed」。

function tsTypeBlock(rel, typeName) {
  const md = read(rel);
  const m = md.match(new RegExp(`type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
  return m ? m[1] : null;
}

check("批量测速三命令的入参与返回（契约）", () => {
  const cmds = contractCommands();
  const problems = [];

  for (const [name, params] of [
    ["node_probe_all", ["configId", "nodeIds"]],
    ["node_probe_cancel", ["runId"]],
    ["node_probe_snapshot", ["configId"]],
  ]) {
    const row = cmds.get(name);
    if (!row) {
      problems.push(`commands.md §2 缺少 ${name}`);
      continue;
    }
    const actual = parseParamList(row.params);
    if (actual.join(",") !== params.join(",")) {
      problems.push(`${name} 入参应为 ${params.join(", ")}，实际是 ${actual.join(", ")}`);
    }
  }

  const md = read("docs/contracts/commands.md");
  for (const ret of ["NodeProbeAllData", "NodeProbeSnapshotData", "{ cancelled: boolean }"]) {
    if (!md.includes(ret)) problems.push(`commands.md 命令总表缺少返回 ${ret}`);
  }

  const all = tsTypeBlock("docs/contracts/commands.md", "NodeProbeAllData");
  if (!all) problems.push("commands.md 找不到 NodeProbeAllData");
  else {
    for (const f of ["run_id", "config_id", "total", "concurrency", "ignored_node_ids"]) {
      if (!new RegExp(`^\\s*${f}\\s*:`, "m").test(all)) problems.push(`NodeProbeAllData 缺少 ${f}`);
    }
    if (!/ignored_node_ids\s*:\s*string\[\]/.test(all)) {
      problems.push("ignored_node_ids 必须是 string[]");
    }
  }

  const snap = tsTypeBlock("docs/contracts/commands.md", "NodeProbeSnapshotData");
  if (!snap) problems.push("commands.md 找不到 NodeProbeSnapshotData");
  else {
    for (const f of ["config_id", "results", "run"]) {
      if (!new RegExp(`^\\s*${f}\\s*:`, "m").test(snap)) problems.push(`NodeProbeSnapshotData 缺少 ${f}`);
    }
    if (!/run\s*:\s*null\s*\|/.test(snap)) problems.push("NodeProbeSnapshotData.run 必须允许 null");
    for (const f of ["run_id", "done", "total", "started_at", "phase", "method"]) {
      if (!new RegExp(`^\\s*${f}\\s*:`, "m").test(snap)) problems.push(`snapshot.run 缺少 ${f}`);
    }
    if (!/phase\s*:\s*"preparing"\s*\|\s*"probing"/.test(snap)) {
      problems.push('snapshot.run.phase 必须是 "preparing" | "probing"');
    }
    if (!/method\s*:\s*"tcp"\s*\|\s*"clash"/.test(snap)) {
      problems.push('snapshot.run.method 必须是 "tcp" | "clash"');
    }
  }

  for (const phrase of ["全局同时只允许一个批次", "`BUSY`，`details.run_id`", "固定 6", "3 秒超时", "**不重试**", "不中断整批"]) {
    if (!md.includes(phrase)) problems.push(`commands.md 缺少批量测速约束：${phrase}`);
  }
  const s46 = md.slice(md.indexOf("### 4.6"), md.indexOf("### 4.7"));
  for (const phrase of ["忽略并记入 `ignored_node_ids`", "`nodeIds = []`", "`total` = 实际要测的节点数", "即使为空数组", "该文案不可用"]) {
    if (!s46.includes(phrase)) problems.push(`commands.md §4.6 缺少节点子集规则：${phrase}`);
  }
  for (const phrase of ["只在该 `configId` 有批次在跑时非空", "`run` 为空 ≠ 已测完", "`results` 有内容也 ≠ 已测完"]) {
    if (!md.includes(phrase)) problems.push(`commands.md 缺少 snapshot.run 约束：${phrase}`);
  }
  if (!md.includes("不发任何 `*-changed`")) problems.push("commands.md 没有写明批次不发 `*-changed`");
  if (!md.includes("不进 Job")) problems.push("commands.md 没有写明批次不进 Job");
  if (!md.includes("不发网络请求")) problems.push("commands.md 没有写明 snapshot 不发网络请求");
  return problems;
});

check("批量测速两事件与四个终态（契约）", () => {
  const names = contractEventNames();
  const problems = [];

  for (const e of ["node-probe-progress", "node-probe-finished"]) {
    if (!names.includes(e)) problems.push(`events.md 事件总表缺少 ${e}`);
  }

  const progress = payloadFields("docs/contracts/events.md", "NodeProbeProgressPayload");
  if (!progress) problems.push("events.md 找不到 NodeProbeProgressPayload");
  else {
    for (const f of ["run_id", "config_id", "phase", "method", "done", "total", "result"]) {
      if (!progress.includes(f)) problems.push(`NodeProbeProgressPayload 缺少 ${f}`);
    }
    if (progress.includes("origin")) problems.push("批量测速是 UI 专用，载荷不应带 origin");
    const block = tsTypeBlock("docs/contracts/events.md", "NodeProbeProgressPayload") ?? "";
    if (!/phase\s*:\s*"preparing"\s*\|\s*"probing"/.test(block)) {
      problems.push('NodeProbeProgressPayload.phase 必须是 "preparing" | "probing"');
    }
    if (!/method\s*:\s*"tcp"\s*\|\s*"clash"/.test(block)) {
      problems.push('NodeProbeProgressPayload.method 必须是 "tcp" | "clash"');
    }
    if (!/result\s*:\s*NodeProbeData\s*\|\s*null/.test(block)) {
      problems.push("NodeProbeProgressPayload.result 必须允许 null（preparing 阶段为空）");
    }
  }

  const finished = payloadFields("docs/contracts/events.md", "NodeProbeFinishedPayload");
  if (!finished) problems.push("events.md 找不到 NodeProbeFinishedPayload");
  else {
    for (const f of ["run_id", "config_id", "total", "ok", "failed", "method", "cancelled", "reason", "network"]) {
      if (!finished.includes(f)) problems.push(`NodeProbeFinishedPayload 缺少 ${f}`);
    }
    const block = tsTypeBlock("docs/contracts/events.md", "NodeProbeFinishedPayload") ?? "";
    if (!/method\s*:\s*"tcp"\s*\|\s*"clash"/.test(block)) {
      problems.push('NodeProbeFinishedPayload.method 必须是 "tcp" | "clash"');
    }
    if (!/reason\s*:\s*"connected"\s*\|\s*null/.test(block)) {
      problems.push('NodeProbeFinishedPayload.reason 必须是 "connected" | null');
    }
  }

  const md = read("docs/contracts/events.md");
  if (!/network\s*:\s*"ok"\s*\|\s*"offline"/.test(md)) {
    problems.push('NodeProbeFinishedPayload.network 必须是 "ok" | "offline"');
  }
  for (const phrase of ["恰好一条", "正常结束", "全部失败、本机有网", "全部失败、本机离线", "取消"]) {
    if (!md.includes(phrase)) problems.push(`events.md 缺少终态说明：${phrase}`);
  }
  for (const phrase of ["`clash` = 真实可用性", "`tcp` = 仅可达"]) {
    if (!md.includes(phrase)) problems.push(`events.md 缺少术语定义：${phrase}`);
  }
  if (names.some((n) => /probe.*-changed/.test(n))) {
    problems.push("事件总表出现了 probe 相关的 *-changed 事件（批次是只读的，不应发状态变更事件）");
  }
  if (!md.includes("不发任何 `*-changed`")) problems.push("events.md 没有写明批量测速不发 `*-changed`");
  return problems;
});

check(
  "node_probe_all 节点子集参数待实现（advisory）",
  () => {
    const rs = read("src-tauri/src/agent/commands.rs");
    const open = rs.indexOf("pub async fn node_probe_all");
    if (open < 0) return ["commands.rs 找不到 node_probe_all"];
    const close = rs.indexOf("\n}", open);
    const body = rs.slice(open, close < 0 ? undefined : close);
    if (!/node_ids/.test(body)) {
      return ["commands.rs 的 node_probe_all 还没有 nodeIds 参数；后端落地前「测这 N 个」不可用"];
    }
    return [];
  },
  { advisory: true }
);

check("node_probe_all 返回必须带 ignored_node_ids（实现）", () => {
  const rs = read("src-tauri/src/tools/services.rs");
  const open = rs.indexOf("async fn node_probe_all(");
  if (open < 0) return ["services.rs 找不到 node_probe_all"];
  const close = rs.indexOf("async fn node_probe_cancel", open);
  const body = rs.slice(open, close < 0 ? undefined : close);
  if (!/ignored_node_ids/.test(body)) {
    return ["node_probe_all 的返回值缺少 ignored_node_ids（即使为空数组也必须带，否则前端无法解释实际测的数量）"];
  }
  return [];
});

// --- 15：种子刷新字段与当前节点回落 ---

check("DefaultProfileResult 的刷新字段（契约）", () => {
  const block = tsTypeBlock("docs/contracts/commands.md", "DefaultProfileResult");
  if (!block) return ["commands.md 找不到 DefaultProfileResult"];
  const problems = [];
  for (const f of ["source", "changed", "reason", "added", "removed", "removed_node_name", "replacement_node_name"]) {
    if (!new RegExp(`^\\s*${f}\\s*:`, "m").test(block)) problems.push(`DefaultProfileResult 缺少 ${f}`);
  }
  if (!/removed_node_name\s*:\s*string\s*\|\s*null/.test(block)) {
    problems.push("removed_node_name 必须是 string | null");
  }
  if (!/replacement_node_name\s*:\s*string\s*\|\s*null/.test(block)) {
    problems.push("replacement_node_name 必须是 string | null");
  }
  if (!/source\s*:\s*"network"\s*\|\s*"cache"/.test(block)) {
    problems.push('source 必须是 "network" | "cache"');
  }
  const reasonM = block.match(/reason\s*:\s*([^;]+);/);
  if (!reasonM) {
    problems.push("DefaultProfileResult 缺少 reason");
  } else {
    const vals = [...reasonM[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    const expected = ["invalid_content", "local_write", "offline"];
    if (vals.join(",") !== expected.join(",")) {
      problems.push(`reason 取值必须是 ${expected.join(" | ")} | null，实际是 ${vals.join(" | ")}`);
    }
    if (!/null/.test(reasonM[1])) problems.push("reason 必须允许 null");
  }
  if (!/added\s*:\s*number\s*\|\s*null/.test(block)) problems.push("added 必须是 number | null");
  if (!/removed\s*:\s*number\s*\|\s*null/.test(block)) problems.push("removed 必须是 number | null");
  if (!/changed\s*:\s*boolean/.test(block)) problems.push("changed 必须是 boolean");

  const md = read("docs/contracts/commands.md");
  for (const phrase of ["离线且有缓存仍返回 `Ok`", "分不出「离线」「内容异常」「本地写入失败」", "不得合并", "原来的 X 已下架，已切换到 Y"]) {
    if (!md.includes(phrase)) problems.push(`commands.md 缺少说明：${phrase}`);
  }
  for (const bad of ["previous_node_name", "new_node_name"]) {
    if (new RegExp(`^\\s*${bad}\\s*:`, "m").test(block)) {
      problems.push(`DefaultProfileResult 仍在用已作废的字段名 ${bad}`);
    }
  }

  const s81 = md.slice(md.indexOf("### 8.1"), md.indexOf("### 8.2"));
  for (const phrase of ["仍返回被下架的那个节点名", "`replacement_node_name = null`"]) {
    if (!s81.includes(phrase)) problems.push(`commands.md §8.1 缺少空列表语义：${phrase}`);
  }
  if (s81.includes("两者都为 `null`")) {
    problems.push("§8.1 仍写着剩余为空时两个名字都为 null（removed_node_name 必须保留旧名）");
  }

  const s82 = md.slice(md.indexOf("### 8.2"), md.indexOf("### 8.3"));
  for (const phrase of ["同步失败整体回滚", "不推进 hash"]) {
    if (!s82.includes(phrase)) problems.push(`commands.md §8.2 缺少回滚规则：${phrase}`);
  }
  return problems;
});

check(
  "种子刷新提示字段用契约名（实现，advisory）",
  () => {
    const blob = walkRs(join(ROOT, "src-tauri", "src"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const problems = [];
    if (/previous_node_name|new_node_name/.test(blob)) {
      problems.push("实现仍用已作废的 previous_node_name / new_node_name");
    }
    if (!/removed_node_name/.test(blob) || !/replacement_node_name/.test(blob)) {
      problems.push("实现还没返回 removed_node_name / replacement_node_name（前端按契约名读取）");
    }
    return problems;
  },
  { advisory: true }
);

check("种子刷新后当前节点落到第一个（契约）", () => {
  const md = read("docs/contracts/commands.md");
  const problems = [];
  for (const phrase of ["设为剩余列表的第一个节点", "剩余为空才置 `null`", "不得静默替换", "已下架，已切换到"]) {
    if (!md.includes(phrase)) problems.push(`commands.md 缺少回落规则：${phrase}`);
  }
  return problems;
});

check("default_profile_refresh 命令固定 force=true（实现）", () => {
  const problems = [];
  const md = read("docs/contracts/commands.md");
  if (!md.includes("固定以 `force = true` 调用")) {
    problems.push("commands.md §8.2 没有写明命令层固定 force=true");
  }

  const rs = read("src-tauri/src/agent/commands.rs");
  const open = rs.indexOf("pub async fn default_profile_refresh");
  if (open < 0) {
    problems.push("commands.rs 找不到 default_profile_refresh");
    return problems;
  }
  const close = rs.indexOf("\n}", open);
  const body = rs.slice(open, close < 0 ? undefined : close);
  if (/default_profile_refresh\s*\(\s*false\s*\)/.test(body)) {
    problems.push("命令层以 force=false 调用，会复用 6 小时短路；设置页点下去等于没检查");
  }
  if (!/default_profile_refresh\s*\(\s*true\s*\)/.test(body)) {
    problems.push("命令层没有固定以 force=true 调用");
  }
  return problems;
});

check("§4.6 探测方式与 §6.5 定稿一致（契约）", () => {
  const md = read("docs/contracts/commands.md");
  const problems = [];
  for (const phrase of [
    "完全未连接",
    "临时起一次运行时",
    "8 秒内未就绪",
    "已连接**别的配置**",
    "整批降级 `tcp`",
    "不启动运行时",
  ]) {
    if (!md.includes(phrase)) problems.push(`commands.md §4.6 缺少探测方式：${phrase}`);
  }
  return problems;
});

check(
  "§4.6 临时运行时路径待实现（advisory）",
  () => {
    const rs = read("src-tauri/src/tools/services.rs");
    const open = rs.indexOf("async fn node_probe_all(");
    if (open < 0) return ["services.rs 找不到 node_probe_all"];
    const close = rs.indexOf("async fn node_probe_cancel", open);
    const body = rs.slice(open, close < 0 ? undefined : close);
    // 结构信号：实现里必须出现探针运行时的痕迹；命名可变，但至少要提到 runtime。
    if (!/runtime/i.test(body)) {
      return ["node_probe_all 还没有临时运行时路径（未连接时应先起探针运行时，失败/8 秒降级 tcp）"];
    }
    return [];
  },
  { advisory: true }
);

check("OfflineReason 的取值与契约一致（实现）", () => {
  const rs = read("src-tauri/src/seed.rs");
  const m = rs.match(/impl OfflineReason \{[\s\S]*?fn as_str\(self\)[\s\S]*?match self \{([\s\S]*?)\n        \}/);
  if (!m) return ["seed.rs 找不到 OfflineReason::as_str"];
  const values = [...m[1].matchAll(/=> "([a-z_]+)"/g)].map((x) => x[1]);
  const expected = ["offline", "invalid_content", "local_write"];
  const missing = expected.filter((v) => !values.includes(v));
  const extra = values.filter((v) => !expected.includes(v));
  const problems = [];
  if (missing.length) problems.push(`OfflineReason 缺少：${missing.join(", ")}`);
  if (extra.length) problems.push(`OfflineReason 出现契约外取值：${extra.join(", ")}`);
  return problems;
});

// --- 16：中间区布局：非法整份丢弃、可写块数量、配置详情带布局版本 ---

check("布局非法块整份丢弃，AI 可写块为 5 个（契约）", () => {
  const md = read("docs/contracts/events.md");
  const start = md.indexOf("### 4.13");
  const end = md.indexOf("### 4.14");
  if (start < 0 || end < 0) return ["events.md 找不到 §4.13 layout-updated"];
  const s = md.slice(start, end);
  const problems = [];

  for (const phrase of [
    "整份丢弃",
    "不逐块过滤",
    "同一条消息出现多份布局时只认最后一份",
    "请求被取消或出错时不写入",
    "1–6 项",
    "24 字符",
    "`://`",
    "layout_revision",
    "请求开始时已有活动配置",
    "请求结束时",
    "首启无配置",
    "不落到旧配置",
  ]) {
    if (!s.includes(phrase)) problems.push(`§4.13 缺少「${phrase}」`);
  }

  // 旧策略的话术不得残留：逐块过滤会让中间区出现模型没打算要的构成。
  for (const stale of [
    "过滤掉并记日志",
    "不写库、不发事件里的那一项",
    "六个块",
    "取**请求开始时**捕获的那套",
  ]) {
    if (s.includes(stale)) problems.push(`§4.13 仍保留旧策略「${stale}」`);
  }

  for (const block of ["empty_hint", "proxy_card", "source_choice", "reachability", "update_hint"]) {
    if (!s.includes(`\`${block}\``)) problems.push(`§4.13 的可写块清单缺少 ${block}`);
  }
  if (!/issue_card[^。]*叠加|叠加[^。]*issue_card/.test(s)) {
    problems.push("§4.13 没有写清 issue_card 是叠加层、不写进布局");
  }

  const fields = payloadFields("docs/contracts/events.md", "LayoutUpdatedPayload");
  if (!fields) problems.push("events.md 找不到 LayoutUpdatedPayload");
  else if (!fields.includes("revision")) problems.push("LayoutUpdatedPayload 缺少 revision");

  return problems;
});

check("ConfigDetail 带 layout_revision（契约）", () => {
  const md = read("docs/contracts/commands.md");
  const m = md.match(/type ConfigDetail = [^{]*\{([\s\S]*?)\n\};/);
  if (!m) return ["commands.md 找不到 ConfigDetail"];
  const problems = [];
  if (!/^\s*layout_revision\s*:\s*number\s*\|\s*null\s*;/m.test(m[1])) {
    problems.push("ConfigDetail.layout_revision 必须是 number | null");
  }
  if (!md.includes("revision <= layout_revision")) {
    problems.push("commands.md §3.6 没有写「revision <= layout_revision 的事件丢弃」");
  }
  return problems;
});

check(
  "系统提示的块词汇表为 5 个、不含 issue_card（实现）",
  () => {
    const rs = read("src-tauri/src/claurst_session/mod.rs");
    const m = rs.match(/const BLOCK_CATALOG: &str = "\\\n([\s\S]*?)";/);
    if (!m) return ["找不到 BLOCK_CATALOG"];
    const problems = [];
    if (m[1].includes("`issue_card`")) {
      problems.push("BLOCK_CATALOG 仍包含 issue_card（叠加层不进布局，写进去故障卡会渲染两次）");
    }
    const rows = [...m[1].matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((x) => x[1]);
    const expected = ["empty_hint", "proxy_card", "source_choice", "reachability", "update_hint"];
    if (rows.join(",") !== expected.join(",")) {
      problems.push(`BLOCK_CATALOG 应为 ${expected.join(" / ")}，实际是 ${rows.join(" / ")}`);
    }
    return problems;
  },
  { advisory: true },
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
