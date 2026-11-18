/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerLoginTicket } from "../agent/bridge";
import { MyServerLogin } from "./MyServerLogin";

type StartFn = (email: string) => Promise<MyServerLoginTicket>;
type VerifyFn = (email: string, code: string) => Promise<unknown>;

function setup(onStart: StartFn, onVerify: VerifyFn = vi.fn(async () => undefined)) {
  const onCancel = vi.fn();
  render(<MyServerLogin onStart={onStart} onVerify={onVerify} onCancel={onCancel} />);
  const dialog = screen.getByRole("dialog", { name: "登录我的服务器" });
  fireEvent.change(within(dialog).getByLabelText("邮箱"), {
    target: { value: "me@example.com" },
  });
  return { dialog, onCancel };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("登录弹窗", () => {
  it("发码遇到 email_cooldown：直接进入验证码步骤并倒计时", async () => {
    const onStart = vi.fn<StartFn>().mockRejectedValue({
      code: "RATE_LIMITED",
      message: "发码太频繁。",
      details: { reason: "email_cooldown", retry_after_seconds: 42 },
      retryable: true,
    });
    const { dialog } = setup(onStart);

    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));

    expect(await within(dialog).findByLabelText("验证码")).toBeTruthy();
    expect(
      within(dialog).getByText(/验证码已发送，请查收邮箱/),
    ).toBeTruthy();
    expect(within(dialog).queryByText("刚发过验证码。")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    const resend = within(dialog).getByRole("button", { name: "42 秒后可重发" });
    expect((resend as HTMLButtonElement).disabled).toBe(true);
  });

  it("code_expired：留在验证码步骤，提示重新发送", async () => {
    const onStart = vi.fn<StartFn>().mockResolvedValue({ sent: true, cooldown_seconds: 60 });
    const onVerify = vi.fn<VerifyFn>().mockRejectedValue({
      code: "PRECONDITION_FAILED",
      message: "验证码过期了。",
      details: { reason: "code_expired" },
      retryable: false,
    });
    const { dialog } = setup(onStart, onVerify);

    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await within(dialog).findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));

    expect(await within(dialog).findByText(/验证码已过期，重新发送/)).toBeTruthy();
    expect(within(dialog).getByLabelText("验证码")).toBeTruthy();
    expect(within(dialog).queryByLabelText("邮箱")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /后可重发/ })).toBeTruthy();
  });
});

describe("设备身份对不上", () => {
  it("诚实说明需要重新注册，并提供入口；成功后提示再点一次登录", async () => {
    const onStart = vi.fn<StartFn>().mockResolvedValue({ sent: true, cooldown_seconds: 60 });
    const onVerify = vi.fn<VerifyFn>().mockRejectedValue({
      code: "PRECONDITION_FAILED",
      message: "设备对不上。",
      details: { reason: "device_mismatch" },
      retryable: false,
    });
    const onReRegister = vi.fn(async () => true);
    render(
      <MyServerLogin
        onStart={onStart}
        onVerify={onVerify}
        onReRegister={onReRegister}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await screen.findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("这台设备的身份对不上。")).toBeTruthy();
    expect(
      screen.getByText("需要重新注册设备；账户和服务器都还在。"),
    ).toBeTruthy();
    expect(screen.queryByText(/稍后再点「登录」/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));
    await waitFor(() => expect(onReRegister).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/设备已重新注册，再点一次「登录」/),
    ).toBeTruthy();
  });

  it("重新注册失败时如实回报，不说成功", async () => {
    const onStart = vi.fn<StartFn>().mockResolvedValue({ sent: true, cooldown_seconds: 60 });
    const onVerify = vi.fn<VerifyFn>().mockRejectedValue({
      code: "PRECONDITION_FAILED",
      message: "设备对不上。",
      details: { reason: "device_mismatch" },
      retryable: false,
    });
    const onReRegister = vi.fn(async () => false);
    render(
      <MyServerLogin
        onStart={onStart}
        onVerify={onVerify}
        onReRegister={onReRegister}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await screen.findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("这台设备的身份对不上。");

    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));
    expect(await screen.findByText("没能重新注册设备。")).toBeTruthy();
    expect(screen.queryByText(/设备已重新注册/)).toBeNull();
  });
});

describe("设备被停用", () => {
  it("说明重新登录会重新注册，并给「重新注册设备」入口", async () => {
    const onStart = vi.fn<StartFn>().mockResolvedValue({ sent: true, cooldown_seconds: 60 });
    const onVerify = vi.fn<VerifyFn>().mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "这台设备已被停用",
      details: { reason: "device_revoked" },
      retryable: false,
    });
    const onReRegister = vi.fn(async () => true);
    render(
      <MyServerLogin
        onStart={onStart}
        onVerify={onVerify}
        onReRegister={onReRegister}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await screen.findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(
      await screen.findByText("这台设备已被停用。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新注册设备" })).toBeTruthy();
    expect(screen.queryByText(/稍后再试/)).toBeNull();
    expect(screen.queryByText(/换一台设备/)).toBeNull();
  });
});
