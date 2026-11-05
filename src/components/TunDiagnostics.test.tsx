/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, TunProbeData } from "../agent/bridge";
import { TunDiagnosticsRow } from "./TunDiagnostics";

const RESULT: TunProbeData = {
  conclusion: "隧道与出站均正常",
  reportPath: "/Users/me/.veyl/diagnostics/tun-20261105-101500.txt",
  utun: ["utun7 198.18.0.1/16 路由=3 关键段=0/1,128/1,16/4,32/3"],
  node: "example.com:8388 可直连（42ms）",
  dns: "www.apple.com → 203.0.113.10（18ms）",
  https: "HTTP 200（236ms）",
  process: "pid=4812 存活=true since=2026-11-05T10:00:00Z",
};

const writeText = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockClear();
});

afterEach(cleanup);

function makeBridge(tunProbe: AgentBridge["tunProbe"]): AgentBridge {
  return { mode: "mock", tunProbe } as unknown as AgentBridge;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("TunDiagnosticsRow", () => {
  it("未连接时就地提示，不弹错误框", async () => {
    const bridge = makeBridge(
      vi.fn(async () => {
        throw { code: "PRECONDITION_FAILED", message: "TUN 未连接，先连接后再执行诊断" };
      }),
    );
    render(<TunDiagnosticsRow bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "运行诊断" }));

    expect(await screen.findByText("连上之后再运行诊断")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "运行诊断" })).toBeTruthy();
  });

  it("运行中显示进度，完成后展示结论、关键项与报告路径", async () => {
    const gate = deferred<TunProbeData>();
    render(<TunDiagnosticsRow bridge={makeBridge(() => gate.promise)} />);

    fireEvent.click(screen.getByRole("button", { name: "运行诊断" }));

    expect(await screen.findByText("正在诊断…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "运行诊断" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      gate.resolve(RESULT);
      await Promise.resolve();
    });

    expect(await screen.findByText("隧道与出站均正常")).toBeTruthy();
    expect(screen.getByText(RESULT.utun[0])).toBeTruthy();
    expect(screen.getByText(RESULT.node)).toBeTruthy();
    expect(screen.getByText(RESULT.dns)).toBeTruthy();
    expect(screen.getByText(RESULT.https)).toBeTruthy();
    expect(screen.getByText(RESULT.process)).toBeTruthy();
    expect(screen.getByText(RESULT.reportPath)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新诊断" })).toBeTruthy();
  });

  it("失败时展示后端给的原因", async () => {
    render(
      <TunDiagnosticsRow
        bridge={makeBridge(async () => {
          throw { code: "INTERNAL", message: "采集诊断失败：读取路由表超时" };
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "运行诊断" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("采集诊断失败：读取路由表超时")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新诊断" })).toBeTruthy();
  });

  it("点击报告路径复制", async () => {
    render(<TunDiagnosticsRow bridge={makeBridge(async () => RESULT)} />);

    fireEvent.click(screen.getByRole("button", { name: "运行诊断" }));
    fireEvent.click(await screen.findByTitle("点击复制报告路径"));

    expect(writeText).toHaveBeenCalledWith(RESULT.reportPath);
    expect(await screen.findByText("已复制")).toBeTruthy();
  });
});
