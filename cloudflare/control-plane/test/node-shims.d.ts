// 测试跑在 Node（vitest）里，但 tsconfig 只带 workers-types；这里只声明用到的 Node API。
// 与 vitest.config.ts 里的 node:fs 用法对应，避免为一个运行期测试引入 @types/node。

// workers-types 的 ImportMeta 没有 url；vitest 下是 Node 的 ESM，能拿到。
interface ImportMeta {
  url: string;
}

declare module "node:child_process" {
  interface ChildProcess {
    stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): void } | null;
    kill(signal?: string): boolean;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
  }

  export function spawn(
    command: string,
    args: string[],
    options?: { stdio?: Array<"ignore" | "pipe"> },
  ): ChildProcess;

  export function spawnSync(
    command: string,
    args: string[],
    options?: { cwd?: string; encoding?: "utf8"; maxBuffer?: number },
  ): { status: number | null; stdout?: string; stderr?: string };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: { mode?: number },
  ): void;
  export function chmodSync(path: string, mode: number): void;
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:module" {
  export function createRequire(path: string | URL): (id: string) => unknown;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

// 真实 SQL 测试用 node:sqlite（Node 22+ 内置）；只为用到的最小接口声明。
declare module "node:sqlite" {
  export interface RunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export interface StatementSync {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
