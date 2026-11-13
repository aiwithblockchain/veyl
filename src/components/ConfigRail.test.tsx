/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigSummary } from "../agent/protocol";
import { ConfigRail } from "./ConfigRail";

afterEach(cleanup);

const CONFIG: ConfigSummary = {
  config_id: "cfg_1",
  name: "家里",
  connect_mode: "system_proxy",
  routing_mode: "proxy_all",
  node_count: 2,
  listen_port: null,
  is_active: true,
  current_node_id: null,
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

const noop = () => {};

interface RenameResult {
  ok: boolean;
  message?: string;
}

function Harness({
  onRename,
  initial = [CONFIG],
}: {
  onRename: (configId: string, name: string) => Promise<RenameResult>;
  initial?: ConfigSummary[];
}) {
  const [configs, setConfigs] = useState(initial);
  return (
    <ConfigRail
      configs={configs}
      activeConfigId={CONFIG.config_id}
      connectedConfigId={null}
      onSelect={noop}
      onNewConfig={noop}
      onRetry={noop}
      onDelete={async () => ({ ok: true })}
      onRename={async (configId, name) => {
        const result = await onRename(configId, name);
        if (result.ok) {
          setConfigs((current) =>
            current.map((config) =>
              config.config_id === configId ? { ...config, name } : config,
            ),
          );
        }
        return result;
      }}
      onOpenSettings={noop}
    />
  );
}

function openByDoubleClick() {
  fireEvent.doubleClick(screen.getByText("家里"));
  return screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement;
}

describe("配置行内改名", () => {
  it("双击进入编辑，Enter 保存并就地更新名称", async () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    expect(input.value).toBe("家里");
    expect(screen.queryByRole("button", { name: "删除配置 家里" })).toBeNull();

    fireEvent.change(input, { target: { value: " 公司 " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("cfg_1", "公司"));
    await waitFor(() => expect(screen.getByText("公司")).toBeTruthy());
    expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  });

  it("悬停区的重命名入口打开同一个编辑态", () => {
    render(<Harness onRename={async () => ({ ok: true })} />);

    fireEvent.click(screen.getByRole("button", { name: "重命名配置 家里" }));

    expect(screen.getByRole("textbox", { name: "配置名称" })).toBeTruthy();
  });

  it("组合态回车不提交", () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "公司" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "配置名称" })).toBeTruthy();
  });

  it("Escape 取消，不调用更新并恢复原名", () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "公司" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("家里")).toBeTruthy();
    expect(screen.queryByText("公司")).toBeNull();
  });

  it("空串不调用更新，恢复原名", () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("家里")).toBeTruthy();
  });

  it("失焦保存", async () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "公司" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("cfg_1", "公司"));
  });

  it("跨行编辑时旧行只保存一次，新行编辑不受影响", async () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    const second = { ...CONFIG, config_id: "cfg_2", name: "公司" };
    render(<Harness onRename={onRename} initial={[CONFIG, second]} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "家里 2" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "重命名配置 公司" }));

    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    expect(onRename).toHaveBeenCalledWith("cfg_1", "家里 2");
    const next = screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement;
    expect(next.value).toBe("公司");
  });

  it("跨行但没改动时不发改名请求", () => {
    const onRename = vi.fn(async () => ({ ok: true }));
    const second = { ...CONFIG, config_id: "cfg_2", name: "公司" };
    render(<Harness onRename={onRename} initial={[CONFIG, second]} />);

    const input = openByDoubleClick();
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "重命名配置 公司" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement).value,
    ).toBe("公司");
  });

  it("更新失败时恢复原名并就地提示", async () => {
    const onRename = vi.fn(async () => ({ ok: false, message: "名字不能超过 40 个字" }));
    render(<Harness onRename={onRename} />);

    const input = openByDoubleClick();
    fireEvent.change(input, { target: { value: "公司" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("名字不能超过 40 个字")).toBeTruthy());
    expect(screen.getByText("家里")).toBeTruthy();
    expect(screen.queryByText("公司")).toBeNull();
  });
});
