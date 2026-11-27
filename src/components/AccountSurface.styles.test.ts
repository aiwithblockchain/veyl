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
const ledgerSource: string = readFileSync(
  "src/components/BillingLedgerTable.tsx",
  "utf8",
);
const topUpSource: string = readFileSync(
  "src/components/MyServerTopUp.tsx",
  "utf8",
);

/** 用到 `myservers__*` 的全部组件：白名单同样适用于这一族。 */
const MYSERVERS_COMPONENTS = [
  "MyServerDetail.tsx",
  "MyServerLogin.tsx",
  "MyServerWizard.tsx",
  "MyServersPage.tsx",
  "MyServersRail.tsx",
  "ServerProgress.tsx",
];

/** 纯布局钩子：组件里挂着，但没有自己的规则。 */
const UNSTYLED = new Set([
  "account-surface__topup",
  "account-surface__traffic-block",
]);

/** 账单的纯钩子：7166b72^ 里也没有规则。 */
const UNSTYLED_BILLING = new Set(["billing-body"]);

/** 服务器相关组件里的纯钩子：只当容器，7166b72^ 里也没有规则。 */
const UNSTYLED_MYSERVERS = new Set([
  "myservers__danger",
  "myservers__region-group",
]);

/** 只收 className 里的词：id / aria-controls 里的 account-billing-details 不算类名。 */
function classNameTokens(src: string, prefix: string): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    // 模板/表达式里的条件后缀不是类名本身，去掉后再按空白切词。
    for (const token of raw.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      if (token.startsWith(prefix)) out.add(token);
    }
  };
  for (const match of src.matchAll(
    /className=(?:"([^"]*)"|`([^`]*)`|\{([^}]*)\})/g,
  )) {
    if (match[1] !== undefined) add(match[1]);
    else if (match[2] !== undefined) add(match[2]);
    else if (match[3] !== undefined) {
      // 三元/&& 两侧的字面量都要算：`className={a ? "x" : "y"}` 里的类名也要被守卫看见。
      for (const literal of match[3].matchAll(/"([^"]*)"|`([^`]*)`/g)) {
        add(literal[1] ?? literal[2] ?? "");
      }
    }
  }
  return out;
}

/** 必须是有非空声明块的规则：只剩选择器（或注释里的名字）不算数。
 *  声明块内不允许出现花括号，否则空块会吞掉下一条规则冒充自己。 */
function hasDeclarationBlock(cls: string): boolean {
  return new RegExp(
    `\\.${cls}(?![\\w-])[^{}]*\\{[^{}]*[^\\s{}][^{}]*\\}`,
  ).test(css);
}

/** 用一个前缀把一个组件里的类名对一遍样式表，返回缺声明的类名。 */
function missingFor(
  src: string,
  prefix: string,
  unstyled: ReadonlySet<string> = new Set(),
): string[] {
  const used = classNameTokens(src, prefix);
  expect(used.size, `没取到 ${prefix} 类名`).toBeGreaterThan(0);
  return [...used].filter(
    (cls) => !unstyled.has(cls) && !hasDeclarationBlock(cls),
  );
}

describe("账户弹层样式覆盖", () => {
  it("组件里用到的每个 account-surface 类名在 app.css 里都有声明块", () => {
    const used = new Set(
      source.match(/account-surface(?:__[A-Za-z0-9-]+)?/g) ?? [],
    );
    expect(used.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const cls of used) {
      if (UNSTYLED.has(cls)) continue;
      if (!hasDeclarationBlock(cls)) missing.push(cls);
    }
    expect(missing).toEqual([]);
  });

  it("BillingLedgerTable 用到的每个 billing 类名在 app.css 里都有声明块", () => {
    expect(missingFor(ledgerSource, "billing-", UNSTYLED_BILLING)).toEqual([]);
  });

  it("MyServerTopUp 用到的每个 myservers-topup__ 类名在 app.css 里都有声明块", () => {
    expect(missingFor(topUpSource, "myservers-topup__")).toEqual([]);
  });

  it("所有用 myservers__ 的组件，其类名在 app.css 里都有声明块", () => {
    for (const file of MYSERVERS_COMPONENTS) {
      const src = readFileSync(`src/components/${file}`, "utf8");
      expect(missingFor(src, "myservers__", UNSTYLED_MYSERVERS), file).toEqual(
        [],
      );
    }
  });
});
