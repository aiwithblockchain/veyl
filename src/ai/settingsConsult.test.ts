import { afterEach, describe, expect, it } from "vitest";
import { settingsConsultPrompt } from "./settingsConsult";
import { setLanguage } from "../i18n";

afterEach(() => setLanguage("zh"));

describe("settingsConsultPrompt", () => {
  it("带上当前分区名", () => {
    expect(settingsConsultPrompt("连接")).toContain("当前在「连接」");
    expect(settingsConsultPrompt("高级")).toContain("当前在「高级」");
  });

  it("要求先读产品文档再回答", () => {
    expect(settingsConsultPrompt("AI")).toContain("先读产品文档");
  });

  it("只问用户想咨询哪个模块，并列出四个模块", () => {
    const text = settingsConsultPrompt("账户");
    expect(text).toMatch(/问我：想咨询哪个模块/);
    expect(text).toContain("AI 服务、连接、账户、高级");
    expect(text).toContain("只问这一个问题");
  });

  it("英文界面下发英文提示", () => {
    setLanguage("en");
    const text = settingsConsultPrompt("Connection");
    expect(text).toContain('currently on "Connection"');
    expect(text).toContain("First read the parts of the product docs");
  });

  it("不再带旧的逐项解释式模板", () => {
    const text = settingsConsultPrompt("连接");
    expect(text).not.toContain("一句话说清");
    expect(text).not.toContain("按上面的分区逐项解释");
    expect(text).not.toContain("（默认）");
  });
});
