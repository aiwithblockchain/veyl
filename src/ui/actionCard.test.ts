import { describe, expect, it } from "vitest";
import { actionCardControls, readActionCards } from "./actionCard";

function layout(props: unknown, type = "action_card") {
  return { version: 1, blocks: [{ type, props }] };
}

const valid = {
  id: "first_step",
  title: "先做这一步",
  detail: "点继续就开始。",
  actions: [
    { id: "go_on", label: "继续", kind: "primary" },
    { id: "later", label: "以后", kind: "secondary" },
  ],
};

describe("action_card 解析", () => {
  it("合法卡片原样读出，按钮可用于 context", () => {
    const cards = readActionCards(layout(valid));
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("先做这一步");
    expect(actionCardControls(cards).map((item) => item.id)).toEqual([
      "go_on",
      "later",
    ]);
  });

  it("非 action_card 块忽略", () => {
    expect(readActionCards(layout(valid, "unknown_block"))).toEqual([]);
    expect(readActionCards(null)).toEqual([]);
  });

  it("结构不合法整张跳过，不抛错", () => {
    expect(
      readActionCards(layout({ ...valid, id: "Bad Id" })),
    ).toEqual([]);
    expect(
      readActionCards(layout({ ...valid, actions: [] })),
    ).toEqual([]);
    expect(
      readActionCards(
        layout({
          ...valid,
          actions: [
            { id: "same", label: "一", kind: "primary" },
            { id: "same", label: "二", kind: "secondary" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("模型写了价格 / IP / 地区：整张卡不渲染", () => {
    expect(
      readActionCards(layout({ ...valid, detail: "每天 $0.20 就可以开始。" })),
    ).toEqual([]);
    expect(
      readActionCards(layout({ ...valid, title: "东京的机器" })),
    ).toEqual([]);
  });
});
