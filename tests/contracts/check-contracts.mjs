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
