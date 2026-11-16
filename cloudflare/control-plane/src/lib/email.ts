// 验证码邮件（Resend）。只发信，不记日志：验证码、邮箱都不落盘。

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

/** 发信失败向上抛，由调用方决定「只记日志、仍对用户回 sent」。 */
export async function sendEmail(
  env: EmailEnv,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("resend_not_configured");
  }
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to, subject, html }),
  });
  if (!response.ok) {
    // 只带状态码：上游错误体可能回显收件人。
    throw new Error(`resend_${response.status}`);
  }
}

export async function sendVerificationCodeEmail(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<void> {
  await sendEmail(env, to, "Veyl 登录验证码", verificationHtml(code));
}

function verificationHtml(code: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FAFAF9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid rgba(0,0,0,.07);border-radius:12px;">
        <tr><td style="padding:28px 32px 8px;">
          <p style="margin:0;color:#1B1B1A;font-size:17px;font-weight:600;">Veyl</p>
        </td></tr>
        <tr><td style="padding:8px 32px 0;">
          <p style="margin:0 0 8px;color:#1B1B1A;font-size:15px;font-weight:500;">登录验证码</p>
          <p style="margin:0 0 24px;color:#5C5C58;font-size:14px;line-height:1.65;">把这 6 位数字填回 Veyl 即可登录。5 分钟内有效。</p>
          <div style="background:#F5F5F3;border-radius:8px;padding:20px;text-align:center;">
            <p class="num" style="margin:0;font-size:34px;font-weight:600;color:#1B1B1A;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;letter-spacing:8px;">${code}</p>
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;">
          <p style="margin:0;color:#8B8B85;font-size:13px;line-height:1.65;">没有请求过验证码？忽略这封邮件即可，你的账户不会有任何变化。</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
