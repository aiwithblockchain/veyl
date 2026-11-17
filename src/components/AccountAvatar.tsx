interface Props {
  email: string | null;
  /** 账户读取中：不显示字母，避免读错身份。 */
  loading?: boolean;
  /** row = 左栏账号行 28px；nav = 导航 24px。 */
  size?: "row" | "nav";
}

/** 邮箱首字母：拉丁转大写，数字与中文原样；取不到退回人形。 */
export function accountInitial(email: string | null | undefined): string | null {
  const first = (email ?? "").trim().charAt(0);
  if (!first) return null;
  return first.toUpperCase();
}

export function AccountAvatar({ email, loading = false, size = "row" }: Props) {
  const initial = accountInitial(email);
  const className = `account-avatar account-avatar--${size}${
    loading ? " is-loading" : ""
  }${initial ? " has-initial" : ""}`;

  if (loading) {
    return <span className={className} aria-hidden="true" />;
  }

  if (initial) {
    return (
      <span className={className} aria-hidden="true">
        {initial}
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="15" height="15">
        <circle
          cx="12"
          cy="9"
          r="3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M5.8 19.2a6.2 6.2 0 0 1 12.4 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
