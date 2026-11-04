#!/usr/bin/env node
// 日常开发启动：把上一次运行留在 logs/ 里的文件归档，再拉起 `tauri dev`。
//
//   npm run app:dev                  # 日常开发（会归档旧日志）
//   npm run app:dev -- --no-open     # 透传给 tauri dev 的参数
//   node scripts/dev/run-with-logs.mjs --help
//
// 为什么要归档：应用日志按天追加（`logs/app-<日期>.log`），同一天里启动几次
// 会全混在一个文件里，事后分不清哪段是上一次。这里在每次启动前把上一轮的
// 文件整体挪进 `logs/archive/<上一次运行 id>/`，`logs/` 下只留本次运行。
//
// 目录名用**上一次**的 id，不是本次的时间：`logs/.run-id` 记着当前这一轮是什么
// 时候开始的，启动时读它给归档目录命名，再把新 id 写回去。否则
// `archive/20261104-1922/` 里装的是 19:00 那次的日志，查日志的人照着目录名
// 判断时间会直接判错。
//
// 两个逃生口：
//   --dry-run        只做归档与打印，不拉起任何进程（用来验证归档逻辑）
//   --cmd "<命令>"   用指定命令代替 `tauri dev`（调试本脚本用）
//
// 跨平台：Windows 与 macOS 共用这一份，不再分别维护 .sh / .ps1。

import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOGS_DIR = join(ROOT, "logs");
const ARCHIVE_DIR = join(LOGS_DIR, "archive");
/** 记录「logs/ 里现有的文件是哪一次运行留下的」的标记文件。 */
const RUN_ID_FILE = ".run-id";
/** `logs/archive/` 下最多保留几个归档目录。 */
const KEEP_ARCHIVES = 10;

const USAGE = `用法：node scripts/dev/run-with-logs.mjs [选项] [-- tauri dev 的参数...]

启动前把 logs/ 里上一次运行留下的日志文件（app-*.log、terminal.log）移到
logs/archive/<上一次运行 id>/，然后拉起 npm run tauri -- dev；子进程输出
同时打到终端和 logs/terminal.log，下次启动时跟着一起归档。
logs/ 里其它文件（你手放的笔记、脚本）不动。

上一次运行的 id 记在 logs/.run-id 里：启动时读它给归档目录命名，再把
本次的 id 写回去。所以目录名就是里面那批日志的运行时间。

选项：
  --help, -h        打印本说明
  --dry-run         只做归档与打印，不拉起进程
  --cmd <命令>      用指定命令代替 npm run tauri -- dev（调试用，经系统 shell 执行）

其余参数原样透传给 tauri dev；写在「--」之后的一律透传。`;

function parseArgs(argv) {
  const options = { help: false, dryRun: false, command: null, passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--cmd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--cmd 需要一个值");
      }
      options.command = value;
      index += 1;
    } else {
      options.passthrough.push(arg);
    }
  }
  return options;
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

/** 读上一次运行的 id。`.run-id` 是普通文本，坏数据会让归档目录跑飞，所以校验格式。 */
function readRunId() {
  const path = join(LOGS_DIR, RUN_ID_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const value = readFileSync(path, "utf8").trim();
    return /^\d{8}-\d{6}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** 只归档本脚本/本应用自己写的文件。 */
const OWN_LOG_FILE = [/^app-.*\.log$/, /^terminal\.log$/];

function isOwnLogFile(name) {
  return OWN_LOG_FILE.some((pattern) => pattern.test(name));
}

/** `logs/` 一级目录下属于上一次运行的文件。`archive/` 是目录，`.run-id` 是标记，都跳过。 */
function previousRunFiles() {
  if (!existsSync(LOGS_DIR)) {
    return [];
  }
  return readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isOwnLogFile(entry.name))
    .map((entry) => entry.name);
}

/** 不是我们写的文件：原样留在 logs/，只提示一句。 */
function foreignFiles() {
  if (!existsSync(LOGS_DIR)) {
    return [];
  }
  return readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== RUN_ID_FILE &&
        !isOwnLogFile(entry.name),
    )
    .map((entry) => entry.name);
}

function archivePreviousRun(archivePath, names) {
  const moved = [];
  for (const name of names) {
    try {
      renameSync(join(LOGS_DIR, name), join(archivePath, name));
      moved.push(name);
    } catch (error) {
      console.error(`[logs] 归档 ${name} 失败：${error.message}`);
    }
  }
  return moved;
}

/** 只保留最近 `KEEP_ARCHIVES` 个归档目录，更早的删掉。 */
function pruneArchives() {
  if (!existsSync(ARCHIVE_DIR)) {
    return [];
  }
  const names = readdirSync(ARCHIVE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // 只认本脚本建的目录名；别的目录不是我们的，不删。
    .filter((name) => /^\d{8}-\d{6}$/.test(name))
    // 目录名是 YYYYMMDD-HHMMSS，字典序即时间序。
    .sort();
  const removed = [];
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_ARCHIVES))) {
    try {
      rmSync(join(ARCHIVE_DIR, name), { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      console.error(`[logs] 删除旧归档 ${name} 失败：${error.message}`);
    }
  }
  return removed;
}

/** 子进程的输出同时进终端和 terminal.log。 */
function pipeTo(stream, sink, target) {
  stream.on("data", (chunk) => {
    target.write(chunk);
    sink.write(chunk);
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const runId = timestamp(new Date());
  // 必须先存在：下面要读 .run-id，也要把 terminal.log 写在里面。
  mkdirSync(LOGS_DIR, { recursive: true });

  const previousId = readRunId();
  let archivePath = null;
  let moved = [];
  if (previousId) {
    const names = previousRunFiles();
    // 目录里除了标记文件什么都没有时不必建空归档目录：没有东西可查。
    if (names.length > 0) {
      archivePath = join(ARCHIVE_DIR, previousId);
      mkdirSync(archivePath, { recursive: true });
      moved = archivePreviousRun(archivePath, names);
    }
  }
  pruneArchives();
  // 标记要在归档之后写：写早了，下一次启动会把本次的 id 当成上一次的。
  writeFileSync(join(LOGS_DIR, RUN_ID_FILE), `${runId}\n`);

  const terminalLog = join(LOGS_DIR, "terminal.log");
  console.log(`[logs] 本次运行：${runId}`);
  if (archivePath) {
    console.log(`[logs] 归档上一次运行（${previousId}）的 ${moved.length} 个文件到：${archivePath}`);
  } else if (previousId) {
    console.log(`[logs] 上一次运行（${previousId}）没有留下文件，不建归档目录`);
  } else {
    console.log("[logs] 首次运行，没有需要归档的文件");
  }
  console.log(`[logs] 本次应用日志：${LOGS_DIR}；终端输出：${terminalLog}`);
  // 只动自己写的文件：用户手放进去的笔记/脚本必须原样留下。
  const foreign = foreignFiles();
  if (foreign.length > 0) {
    console.log(
      `[logs] logs/ 里有 ${foreign.length} 个不是本脚本生成的文件，保持原样：${foreign.join("、")}`,
    );
  }

  if (options.dryRun) {
    console.log("[logs] --dry-run：不拉起进程");
    process.exit(0);
  }

  const sink = createWriteStream(terminalLog, { flags: "a" });

  const command = options.command ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = options.command
    ? // --cmd 是一个完整命令行，交给系统 shell 解析。
      options.passthrough
    : ["run", "tauri", "--", "dev", ...options.passthrough];
  const useShell = Boolean(options.command);

  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    shell: useShell,
    // POSIX 上让子进程成为新进程组的组长，Ctrl-C 才能整组转发；
    // 否则 `tauri dev` 拉起的 vite / app 会散在父进程组里杀不干净。
    detached: process.platform !== "win32",
  });

  pipeTo(child.stdout, sink, process.stdout);
  pipeTo(child.stderr, sink, process.stderr);

  let stopping = false;

  /** 把信号转发给整组子进程。Windows 上没有进程组，用 taskkill /T 收整棵树。 */
  function forward(signal) {
    if (stopping || !child.pid) {
      return;
    }
    stopping = true;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      // 组已经没了就直接发给子进程本身。
      try {
        child.kill(signal);
      } catch {
        // 已经退出，忽略。
      }
    }
  }

  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  child.on("error", (error) => {
    console.error(`[logs] 启动失败：${error.message}`);
    sink.end();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    sink.end();
    console.log(`\n[logs] 本次运行结束，日志：${terminalLog}（下次启动时归档）`);
    if (signal) {
      // 被信号结束：用 128+n 的惯例值，Ctrl-C 就是 130。
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    process.exit(code ?? 0);
  });
}

main();
