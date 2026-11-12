import { describe, expect, it } from "vitest";
import { isComposingEvent } from "./ime";

function fake(native: Partial<KeyboardEvent>, composingRefActive = false): boolean {
  return isComposingEvent(native, composingRefActive);
}

describe("isComposingEvent", () => {
  it("组合中（isComposing）返回 true", () => {
    expect(fake({ isComposing: true })).toBe(true);
  });

  it("keyCode 229 返回 true", () => {
    expect(fake({ keyCode: 229 })).toBe(true);
  });

  it("组合期间的 Enter（ref 为真）即使事件没标记也返回 true", () => {
    expect(fake({ keyCode: 13 }, true)).toBe(true);
  });

  it("React 合成事件取 nativeEvent 判断", () => {
    expect(isComposingEvent({ nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isComposingEvent({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });

  it("正常按键返回 false", () => {
    expect(fake({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
