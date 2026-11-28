import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readWrangler(): Record<string, unknown> {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // 只去掉整行注释：本文件的注释都是整行写的，而字符串里的 https:// 不能动。
  const json = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("部署配置", () => {
  it("keep_names 必须是 false，否则内嵌的客户端脚本会在浏览器里炸", () => {
    // 页面里的「查看健康」脚本是 src/client.ts 的 consoleClient.toString() 原样嵌进 HTML 的。
    // 开着 keep_names 时 esbuild 会在那个函数体里注入 __name(...) 调用，而 __name 定义在
    // 模块作用域，浏览器里并不存在——脚本一加载就 ReferenceError，面板完全不能用。
    // 这个失败只在真实构建产物里出现，所有单元测试照样全绿，所以必须直接盯着这个开关。
    expect(readWrangler().keep_names).toBe(false);
  });
});
