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
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
