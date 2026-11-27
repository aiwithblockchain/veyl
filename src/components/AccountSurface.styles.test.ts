// 类名在组件里、样式在 app.css 里：两边一起读，删掉任何一块账号样式都会变红。
// @ts-ignore 测试跑在 Node 里；项目 tsconfig 只带浏览器类型（vite/client），没有 @types/node。
// 用 ts-ignore 而不是 ts-expect-error：以后补上 @types/node 时不会反过来报「未使用的抑制」。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync("src/styles/app.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const source: string = readFileSync("src/components/AccountSurface.tsx", "utf8");

/** 纯布局钩子：组件里挂着，但没有自己的规则。 */
const UNSTYLED = new Set([
  "account-surface__topup",
  "account-surface__traffic-block",
]);

describe("账户弹层样式覆盖", () => {
  it("组件里用到的每个 account-surface 类名在 app.css 里都有声明块", () => {
    const used = new Set(
      source.match(/account-surface(?:__[A-Za-z0-9-]+)?/g) ?? [],
    );
    expect(used.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const cls of used) {
      if (UNSTYLED.has(cls)) continue;
      // 必须是有非空声明块的规则：只剩选择器（或注释里的名字）不算数。
      // 声明块内不允许出现花括号，否则空块会吞掉下一条规则冒充自己。
      const selector = new RegExp(
        `\\.${cls}(?![\\w-])[^{}]*\\{[^{}]*[^\\s{}][^{}]*\\}`,
      );
      if (!selector.test(css)) missing.push(cls);
    }
    expect(missing).toEqual([]);
  });
});
