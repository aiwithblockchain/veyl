/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MyServer } from "../agent/bridge";
import { ServerProgress } from "./ServerProgress";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1 · DigitalOcean",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "installing",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: null,
    local_node_id: null,
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 20,
    paid_until: null,
    billing_state: "pending",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

afterEach(cleanup);

describe("四段进度条", () => {
  it("installing 时四段与阶段一一对应：前两段已完成，第三段当前，第四段未到", () => {
    const { container } = render(
      <ServerProgress server={server({ state: "installing" })} />,
    );

    const segments = [
      ...container.querySelectorAll(".myservers__bar span"),
    ];
    expect(segments).toHaveLength(4);
    expect(segments[0].classList.contains("is-done")).toBe(true);
    expect(segments[1].classList.contains("is-done")).toBe(true);
    expect(segments[2].classList.contains("is-current")).toBe(true);
    expect(segments[3].className).toBe("");
  });

  it("creating 时只有第一段是当前段，其余三段都没有已完成", () => {
    const { container } = render(
      <ServerProgress server={server({ state: "creating" })} />,
    );

    const segments = [
      ...container.querySelectorAll(".myservers__bar span"),
    ];
    expect(segments).toHaveLength(4);
    expect(segments[0].classList.contains("is-current")).toBe(true);
    expect(
      segments.slice(1).some((segment) => segment.classList.contains("is-done")),
    ).toBe(false);
  });
});
