/** @vitest-environment jsdom */
// @ts-expect-error 测试跑在 Node 里；项目 tsconfig 只带浏览器类型（vite/client），没有 @types/node。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * jsdom 不加载样式表，v6 的尺寸只能从源文件断言；
 * 这里钉住评审给出的数值，避免以后被顺手改回去。
 */
const css = readFileSync("src/styles/app.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `缺少规则 ${selector}`).not.toBeNull();
  return match![1];
}

function expectDecls(selector: string, ...decls: string[]) {
  const body = rule(selector);
  for (const decl of decls) expect(body).toContain(decl);
}

describe("在其它设备上使用的 v6 尺寸", () => {
  it("只覆盖本弹层：640 宽、88vh/880 高、28 内边距", () => {
    expectDecls(
      ".modal.mobile-export",
      "width: min(640px, calc(100vw - 48px))",
      "max-height: min(88vh, 880px)",
    );
    expectDecls(".mobile-export .modal__head", "padding: 14px 28px");
    expectDecls(".mobile-export__body", "padding: 0 28px");
    expectDecls(".mobile-export__footer", "padding: 14px 28px");
  });

  it("两码：导入 200、下载 120，白卡无内边距、圆角 10、图铺满", () => {
    expectDecls(".mobile-export__qr", "width: 200px", "height: 200px");
    expectDecls(
      ".mobile-export__download-qr",
      "width: 120px",
      "height: 120px",
    );
    const cards = rule(".mobile-export__download-qr,\n.mobile-export__qr");
    expect(cards).toContain("border: 1px solid var(--hair)");
    expect(cards).toContain("border-radius: 10px");
    expect(cards).toContain("background: #ffffff");
    expect(cards).not.toContain("padding");
    expectDecls(
      ".mobile-export__download-qr-img,\n.mobile-export__qr-img",
      "width: 100%",
      "height: 100%",
    );
  });

  it("① 每个平台一张卡并排；安全句在码下 10、宽 200", () => {
    expectDecls(".mobile-export__platforms", "gap: 24px", "margin-top: 12px");
    expectDecls(
      ".mobile-export__platform",
      "flex-direction: column",
      "align-items: center",
    );
    expectDecls(
      ".mobile-export__security",
      "width: 200px",
      "margin: 10px 0 0",
      "font-size: 13px",
    );
  });

  it("字号与按钮按 640 放大", () => {
    expectDecls(".mobile-export__title", "font-size: 20px");
    expectDecls(".mobile-export__intro", "font-size: 14px");
    expectDecls(".mobile-export__app-name", "font-size: 15px");
    expectDecls(".mobile-export__app-meta", "font-size: 13px");
    expectDecls(".mobile-export__step-title", "font-size: 14px");
    expectDecls(".mobile-export__step-num", "width: 22px", "height: 22px");
    expectDecls(".mobile-export .btn", "height: 36px", "font-size: 14px");
  });

  it("渐隐高 20、覆盖滚动区底部且不吃点击", () => {
    expectDecls(
      ".mobile-export__fade",
      "position: absolute",
      "height: 20px",
      "pointer-events: none",
    );
  });
});
