import { describe, expect, it } from "vitest";
import { rotateFailureReason } from "./rotateCredentials";

describe("rotateFailureReason", () => {
  it("Host 没接命令：UNSUPPORTED 原样透传，不落成 unknown", () => {
    expect(
      rotateFailureReason({
        code: "UNSUPPORTED",
        message: "",
        retryable: false,
      }),
    ).toBe("UNSUPPORTED");
  });
});
