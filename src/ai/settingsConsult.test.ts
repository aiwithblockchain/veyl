import { afterEach, describe, expect, it } from "vitest";
import { settingsConsultPrompt } from "./settingsConsult";
import { setLanguage } from "../i18n";

afterEach(() => setLanguage("zh"));

describe("settingsConsultPrompt", () => {
  it("带上当前分区名与这一区的事实", () => {
    const text = settingsConsultPrompt("连接", "接管方式：Proxy 模式；本地代理端口：7890");
    expect(text).toContain("当前在「连接」分区");
    expect(text).toContain("这一区当前的值是：接管方式：Proxy 模式；本地代理端口：7890。");
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("要求先读产品文档，再就这一区开口，不再反问模块", () => {
    const text = settingsConsultPrompt("AI", "服务商：DeepSeek");
    expect(text).toContain("先读产品文档");
    expect(text).toContain("一两句话");
    expect(text).not.toContain("想咨询哪个模块");
    expect(text).not.toContain("只问这一个问题");
  });

  it("英文界面下发英文提示", () => {
    setLanguage("en");
    const text = settingsConsultPrompt("Connection", "Connection mode: Proxy mode");
    expect(text).toContain('currently on the "Connection" section');
    expect(text).toContain("Current values here: Connection mode: Proxy mode.");
    expect(text).toContain("First read the parts of the product docs");
    expect(text).not.toMatch(/[一-龥]/);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("不再带旧的逐项解释式模板", () => {
    const text = settingsConsultPrompt("连接", "接管方式：Tun 模式");
    expect(text).not.toContain("一句话说清");
    expect(text).not.toContain("按上面的分区逐项解释");
    expect(text).not.toContain("（默认）");
  });
});
