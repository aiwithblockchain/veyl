/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrafficScopeSwitch } from "./TrafficScopeSwitch";

afterEach(cleanup);

describe("流量范围开关", () => {
  it("智能模式 + 中国：说明国内网站直连", () => {
    render(
      <TrafficScopeSwitch
        mode="direct"
        region="cn"
        connected
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByText("流量范围")).toBeTruthy();
    expect(screen.getByRole("button", { name: "智能模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("国内网站直连，其它走 VPN。")).toBeTruthy();
  });

  it("全局模式：说明所有流量走 VPN", () => {
    render(
      <TrafficScopeSwitch
        mode="proxy_all"
        region="jp"
        connected
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByRole("button", { name: "全局模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("所有流量走 VPN。")).toBeTruthy();
  });

  it("未连接末尾追加「连接后生效」", () => {
    render(
      <TrafficScopeSwitch
        mode="direct"
        region="cn"
        connected={false}
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByText("国内网站直连，其它走 VPN。连接后生效。")).toBeTruthy();
  });

  it("地区未知时明说智能模式实际全走 VPN", () => {
    render(
      <TrafficScopeSwitch
        mode="direct"
        region={null}
        connected
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(
      screen.getByText("没识别出你在哪个地区，现在所有网站都会走 VPN。"),
    ).toBeTruthy();
  });

  it("已连接时地区被 AI 改过：说明追加「下次连接生效」", () => {
    render(
      <TrafficScopeSwitch
        mode="direct"
        region="jp"
        regionChanged
        connected
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(
      screen.getByText("本国网站直连，其它走 VPN。地区已改，下次连接生效。"),
    ).toBeTruthy();
  });

  it("未连接且地区未知：整句改成连接后所有网站走 VPN", () => {
    render(
      <TrafficScopeSwitch
        mode="direct"
        region={null}
        connected={false}
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(
      screen.getByText("没识别出你在哪个地区，连接后所有网站都会走 VPN。"),
    ).toBeTruthy();
  });

  it("切换调用 route_set_mode 的入口；失败时行内说明且控件保持原值", async () => {
    const onChange = vi.fn(async () => ({
      ok: false,
      message: "没切成功，还是原来的范围。",
    }));
    render(
      <TrafficScopeSwitch mode="direct" region="cn" connected onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全局模式" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("proxy_all"));
    expect(await screen.findByText("没切成功，还是原来的范围。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "智能模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("旧数据的 proxy_selected 不显示开关", () => {
    const { container } = render(
      <TrafficScopeSwitch
        mode="proxy_selected"
        region="cn"
        connected
        onChange={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
