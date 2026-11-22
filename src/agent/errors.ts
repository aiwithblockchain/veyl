/**
 * 桥接层错误归一化。
 *
 * 后端既有 `{ code, message }` 对象，也有字符串；前端只认这一种形状。
 * 刻意**不做** `JSON.stringify(error)`：错误对象里可能裹着调用参数，
 * 序列化进日志等于把凭据抄一遍。
 */

export class BridgeError extends Error {
  readonly code: string;
  /** 后端的结构化细节，例如 `{ reason: "empty_title" }`。 */
  readonly details: Record<string, unknown> | null;
  /** 后端标记为可重试（例如任务正在准备）；没给时按不可重试处理。 */
  readonly retryable: boolean;
  /**
   * message 是否真的来自后端。false 表示这里是本地补的通用占位，
   * 调用方要显示自己的兜底文案，不要拿占位文案当后端原话。
   * 批次 4 起后端只回错误码，调用方应改看 code / details。
   */
  readonly hasMessage: boolean;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> | null = null,
    retryable = false,
    hasMessage = message.trim().length > 0,
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.hasMessage = hasMessage;
  }
}

function readDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function toBridgeError(error: unknown, fallbackCode = "INTERNAL"): BridgeError {
  if (error instanceof BridgeError) return error;

  if (typeof error === "string") {
    return new BridgeError(fallbackCode, error, null, false, error.trim().length > 0);
  }

  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; details?: unknown; retryable?: unknown };
    const code = typeof record.code === "string" ? record.code : fallbackCode;
    return new BridgeError(
      code,
      record.message,
      readDetails(record.details),
      record.retryable === true,
      record.message.trim().length > 0,
    );
  }

  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      retryable?: unknown;
    };
    const code = typeof record.code === "string" ? record.code : fallbackCode;
    const message = typeof record.message === "string" ? record.message : "操作失败";
    return new BridgeError(
      code,
      message,
      readDetails(record.details),
      record.retryable === true,
      typeof record.message === "string" && record.message.trim().length > 0,
    );
  }

  return new BridgeError(fallbackCode, "操作失败", null, false, false);
}
