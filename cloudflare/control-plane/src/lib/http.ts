// 控制面 HTTP 形状：成功用 JSON，失败用 §3 的错误信封。
// 客户端只认这一层，不要把上游（DigitalOcean）的错误体直接透出去。

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PRECONDITION_FAILED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
};

export function apiError(
  code: keyof typeof STATUS_BY_CODE | string,
  message: string,
  options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
    reason?: string;
    status?: number;
  } = {},
): Response {
  return json(
    {
      code,
      message,
      retryable: options.retryable ?? false,
      details: { ...(options.details ?? {}), ...(options.reason ? { reason: options.reason } : {}) },
      request_id: "",
    },
    options.status ?? STATUS_BY_CODE[code] ?? 400,
  );
}

export function notFound(): Response {
  return apiError("NOT_FOUND", "没有这个接口");
}

export function methodNotAllowed(): Response {
  return json({ code: "PRECONDITION_FAILED", message: "方法不允许", retryable: false }, 405);
}
