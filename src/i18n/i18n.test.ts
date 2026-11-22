/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "./en";
import { zh } from "./zh";
import {
  getLanguage,
  setLanguage,
  subscribe,
  t,
  translate,
} from "./index";
import { initLanguage } from "./bootstrap";

afterEach(() => {
  setLanguage("zh");
  vi.restoreAllMocks();
});

describe("字典", () => {
  it("中英 key 集合一致", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("每个值非空，且不是 key 本身", () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toBe(key);
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toBe(key);
    }
  });

  it("同一句占位符在两种语言里一致", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
    }
  });

  it("英文值不含中日韩字符（语言名「中文」按规范保留原文）", () => {
    const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
    for (const [key, value] of Object.entries(en)) {
      if (key === "settings.language.zh") continue;
      expect(CJK.test(value), key).toBe(false);
    }
  });
});

describe("语言 store", () => {
  it("默认中文", () => {
    expect(getLanguage()).toBe("zh");
  });

  it("切换会通知订阅者；同值不重复通知；取消订阅后不再收到", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(listener).toHaveBeenCalledTimes(1);

    setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setLanguage("zh");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("同步 document.lang（zh-CN / en）", () => {
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    setLanguage("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("按当前语言取值并插值", () => {
    expect(t("common.cancel")).toBe("取消");
    setLanguage("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("stage.switched", { target: "Tun mode" })).toBe("Switched to Tun mode");
    expect(t("pane.pixels", { value: 280 })).toBe("280 px");
  });

  it("未知占位符原样保留", () => {
    expect(translate("en", "stage.switched")).toBe("Switched to {target}");
    expect(translate("en", "pane.pixels", { other: 1 })).toBe("{value} px");
  });
});

describe("缺失 key", () => {
  it("英文缺 key 时回退中文并记一行日志，不把 key 露给用户", async () => {
    // 用一份新的模块实例：警告去重是模块级的，避免 watch 模式重复跑时失效。
    vi.resetModules();
    const fresh = await import("./index");
    const freshEn = await import("./en");
    const freshZh = await import("./zh");

    const key = "assistant.newChat";
    const saved = freshEn.en[key];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete (freshEn.en as Partial<Record<string, string>>)[key];
    try {
      fresh.setLanguage("en");
      expect(fresh.t(key)).toBe(freshZh.zh[key]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`i18n missing key=${key} lang=en`),
      );
      expect(fresh.t(key)).not.toBe(key);
    } finally {
      freshEn.en[key] = saved;
    }
  });
});

describe("启动读取", () => {
  it("拿 resolved 设置当前语言", async () => {
    await initLanguage({
      appLanguageGet: async () => ({
        selected: "system" as const,
        resolved: "en" as const,
      }),
    });
    expect(getLanguage()).toBe("en");
  });

  it("读库期间用户已切换：晚到的结果不覆盖用户选择", async () => {
    let resolve!: (value: { selected: "system"; resolved: "en" }) => void;
    const pending = new Promise<{ selected: "system"; resolved: "en" }>(
      (done) => {
        resolve = done;
      },
    );
    const running = initLanguage({ appLanguageGet: () => pending });
    // 用户在中途显式选了「中文」（与默认同值也算一次选择）。
    setLanguage("zh");
    resolve({ selected: "system", resolved: "en" });
    await running;
    expect(getLanguage()).toBe("zh");
  });

  it("读失败保持中文，不抛出", async () => {
    await expect(
      initLanguage({
        appLanguageGet: async () => {
          throw new Error("backend unavailable");
        },
      }),
    ).resolves.toBeUndefined();
    expect(getLanguage()).toBe("zh");
  });
});
