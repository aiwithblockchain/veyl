/**
 * 桥接层错误归一化。
 *
 * 后端既有 `{ code, message }` 对象，也有字符串；前端只认这一种形状。
 * 刻意**不做** `JSON.stringify(error)`：错误对象里可能裹着调用参数，
 * 序列化进日志等于把凭据抄一遍。
 */

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export function toBridgeError(error: unknown, fallbackCode = "INTERNAL"): BridgeError {
  if (error instanceof BridgeError) return error;

  if (typeof error === "string") {
    return new BridgeError(fallbackCode, error);
  }

  if (error instanceof Error) {
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : fallbackCode;
    return new BridgeError(code, error.message);
  }

  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : fallbackCode;
    const message = typeof record.message === "string" ? record.message : "操作失败";
    return new BridgeError(code, message);
  }

  return new BridgeError(fallbackCode, "操作失败");
}
