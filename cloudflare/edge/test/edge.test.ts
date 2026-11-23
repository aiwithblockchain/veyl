import { describe, expect, it, vi } from "vitest";

import { forward } from "../proxy";

function upstream(response: Response | (() => Response)) {
  return {
    fetch: vi.fn(async (_request: Request) => (typeof response === "function" ? response() : response)),
  };
}

describe("edge proxy", () => {
  it("把方法、路径、请求体和请求头原样转给控制面", async () => {
    const binding = upstream(new Response("{}", { status: 200 }));
    const request = new Request("https://dev.veyl.dessage.xyz/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }),
    });

    await forward(request, { CONTROL_PLANE: binding });

    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const forwarded = binding.fetch.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(new URL(forwarded.url).pathname).toBe("/v1/orders");
    expect(forwarded.headers.get("authorization")).toBe("Bearer t");
    expect(await forwarded.text()).toBe(JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }));
  });

  it("客户端 IP 透传，限流才认得出是谁", async () => {
    const binding = upstream(new Response("{}", { status: 200 }));
    const request = new Request("https://veyl.dessage.xyz/v1/auth/device", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: "{}",
    });

    await forward(request, { CONTROL_PLANE: binding });

    const forwarded = binding.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
  });

  it("控制面的状态码与响应体原样返回", async () => {
    const binding = upstream(
      () =>
        new Response(JSON.stringify({ code: "PRECONDITION_FAILED" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await forward(new Request("https://veyl.dessage.xyz/v1/orders"), {
      CONTROL_PLANE: binding,
    });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ code: "PRECONDITION_FAILED" });
  });

  it("没绑定 service 时明确报错，不抛异常", async () => {
    const res = await forward(new Request("https://veyl.dessage.xyz/health"), {});

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "edge_not_configured" });
  });
});
