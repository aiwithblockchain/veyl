import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommandError, Profile } from "../api";
import { ImportDialog } from "./ImportDialog";

const profile: Profile = {
  id: "p1",
  name: "vpn.example.com",
  source: { kind: "subscription", host: "vpn.example.com" },
  node_count: 3,
  last_synced_at: 1_763_000_000_000,
  sync_state: "ok",
  sync_error: null,
  created_at: 1_763_000_000_000,
  kernel_check: "passed",
};

const link = `https://veyl:mp_${"a".repeat(43)}@vpn.example.com/v1/mobile/profile`;

function setup(overrides?: {
  importUrl?: (url: string) => Promise<Profile>;
  pickFile?: () => Promise<string | null>;
  importFile?: (path: string) => Promise<Profile>;
}) {
  const onImported = vi.fn();
  const importUrl = vi.fn(overrides?.importUrl ?? (async () => profile));
  const pickFile = vi.fn(overrides?.pickFile ?? (async () => null));
  const importFile = vi.fn(overrides?.importFile ?? (async () => profile));
  render(
    <ImportDialog
      onClose={() => {}}
      onImported={onImported}
      importUrl={importUrl}
      pickFile={pickFile}
      importFile={importFile}
    />,
  );
  return { onImported, importUrl, pickFile, importFile };
}

describe("导入弹层", () => {
  it("链接为空时不能提交", () => {
    setup();
    const submit = screen.getByRole("button", { name: "导入" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("粘贴链接后按导入，把原文交给后端", async () => {
    const { importUrl, onImported } = setup();
    fireEvent.change(screen.getByLabelText("订阅链接"), {
      target: { value: link },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() => expect(importUrl).toHaveBeenCalledWith(link));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(profile));
  });

  it("失败时按三段式显示：发生了什么、为什么、现在做什么", async () => {
    const failure: CommandError = {
      code: "UNAUTHORIZED",
      message: "订阅链接已失效",
      reason: "桌面端重新生成过令牌",
      hint: "回桌面端复制新的链接，重新导入。",
    };
    setup({ importUrl: async () => Promise.reject(failure) });

    fireEvent.change(screen.getByLabelText("订阅链接"), {
      target: { value: link },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("订阅链接已失效");
    expect(alert.textContent).toContain("桌面端重新生成过令牌");
    expect(alert.textContent).toContain("回桌面端复制新的链接");
  });

  it("从文件导入走原生选择器，没选就什么都不做", async () => {
    const { pickFile, importFile } = setup({ pickFile: async () => null });
    fireEvent.click(screen.getByRole("button", { name: "从文件导入…" }));
    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect(importFile).not.toHaveBeenCalled();
  });

  it("选中文件后交给后端并带上路径", async () => {
    const { importFile, onImported } = setup({
      pickFile: async () => "/tmp/profile.json",
    });
    fireEvent.click(screen.getByRole("button", { name: "从文件导入…" }));
    await waitFor(() =>
      expect(importFile).toHaveBeenCalledWith("/tmp/profile.json"),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});
