const ACCOUNT_KEY = "veyl.myservers.account";

/** 本期登录是前端演示：只记一个邮箱，后端接入后换成真实会话。 */
export function readAccount(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(ACCOUNT_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function saveAccount(email: string): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, email.trim());
  } catch {
    // 存不了就只在这次会话里生效。
  }
}

/** 演示环境固定验证码；不发真实邮件。 */
export const MOCK_EMAIL_CODE = "123456";
