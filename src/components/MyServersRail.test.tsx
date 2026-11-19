/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MyServer } from "../agent/bridge";
import { MyServersRail } from "./MyServersRail";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 2 · Vultr",
    region: "nrt1",
    plan: "s-1vcpu-1gb",
    state: "active",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.11",
    port: 8388,
    node_id: "nd_1",
    local_node_id: "local_1",
    hourly_usd: 0.00893,
    monthly_usd: 9,
    daily_price_cents: 30,
    paid_until: null,
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

afterEach(cleanup);

describe("服务器列表左栏", () => {
  it("日价用等宽数字：金额套 .num，「/天」在数字之外", () => {
    const { container } = render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const meta = container.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("$0.30/天");
    expect(meta?.querySelector(".num")?.textContent).toBe("$0.30");
  });
});
