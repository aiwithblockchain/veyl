/**
 * 界面错误文案：只按 `code` + `details.reason` 查表（commands.md §1.6）。
 *
 * 2.55.0 起界面可见错误的 `message` 恒为空串，诊断文本只进 Host 日志。
 * 这里刻意不读 `message` / `hasMessage`：真读了，英文界面就会漏出中文诊断。
 *
 * 查表顺序：`code + reason` → 该 `code` 的通用句 → 调用点传入的 `fallback`。
 * 未知 reason 落到 code 通用句；未知 code 落 fallback；未单列的 `RUNTIME_*` 落运行时通用句。
 */
import { toBridgeError } from "../agent/errors";
import { formatUsdCents } from "../myservers/labels";
import { t } from "./index";
import type { MessageKey } from "./zh";

type Details = Record<string, unknown> | null;
type Vars = Record<string, string | number>;

interface Hit {
  key: MessageKey;
  vars?: Vars;
}

/** 静态条目直接用 key；要用 `details` 里的参数时用函数，缺参数返回 null 继续往下查。 */
type ReasonEntry = MessageKey | ((details: Details) => Hit | null);

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 码级通用句。只登记「调用点的兜底会误导」的码，其余交给调用点。 */
export const ERROR_CODE_TEXT: Record<string, MessageKey> = {
  UNAUTHENTICATED: "error.code.unauthenticated",
  PERMISSION_DENIED: "error.code.permissionDenied",
  RATE_LIMITED: "error.code.rateLimited",
  TIMEOUT: "error.code.timeout",
  NETWORK: "error.code.network",
  UPSTREAM_ERROR: "error.code.upstream",
  UNSUPPORTED: "error.code.unsupported",
  CANCELLED: "error.code.cancelled",
  AI_NOT_CONFIGURED: "error.code.aiNotConfigured",
  INVALID_KEY: "error.reason.providerKeyInvalid",
  RUNTIME_NOT_INSTALLED: "error.code.runtimeNotInstalled",
  RUNTIME_CONFIG_INVALID: "error.code.runtimeConfigInvalid",
  RUNTIME_PORT_UNAVAILABLE: "error.code.runtimePortUnavailable",
  RUNTIME_START_TIMEOUT: "error.code.runtimeStartTimeout",
  RUNTIME_BUSY: "error.code.runtimeBusy",
  RUNTIME_CRASH_LOOP: "error.code.runtimeCrashLoop",
  RUNTIME_EXITED: "error.code.runtimeExited",
  RUNTIME_HEALTH_FAILED: "error.code.runtimeHealthFailed",
};

/** reason 词表见 commands.md §1.6；已有同类 key 的直接复用，避免两套说法。 */
export const ERROR_REASON_TEXT: Record<string, ReasonEntry> = {  // 登录 / 账号
  auth_required: "error.code.unauthenticated",
  token_invalid: "error.code.unauthenticated",
  email_invalid: "login.error.emailInvalid",
  email_cooldown: (details) => {
    const seconds = readNumber(details?.retry_after_seconds) ?? 60;
    return { key: "error.reason.emailCooldown", vars: { seconds } };
  },
  email_rate_limited: "login.error.rateLimited",
  rate_limited: "error.reason.rateLimited",
  code_invalid: "login.error.codeInvalid",
  code_expired: "login.error.codeExpired",
  too_many_attempts: "login.error.tooManyAttempts",
  account_conflict: "login.error.accountConflict",
  device_revoked: "login.error.deviceRevoked",
  account_blocked: "login.error.accountBlocked",
  account_frozen: "error.reason.accountFrozen",
  invalid_name: (details) => {
    const min = readNumber(details?.min_length);
    const max = readNumber(details?.max_length);
    if (min === null || max === null) return null;
    return { key: "error.reason.invalidName", vars: { min, max } };
  },

  // 服务器 / 订单
  insufficient_balance: (details) => {
    const shortfall = readNumber(details?.shortfall_cents);
    return shortfall === null
      ? { key: "error.reason.insufficientBalanceBare" }
      : {
          key: "error.reason.insufficientBalance",
          vars: { amount: formatUsdCents(shortfall) },
        };
  },
  settle_insufficient: "error.reason.settleInsufficient",
  confirm_required: "error.reason.confirmRequired",
  // 历史写法：config_set_mode / mobile_export_rotate 用 confirmation_required，文案同一句。
  confirmation_required: "error.reason.confirmRequired",
  idempotency_in_flight: "error.reason.idempotencyInFlight",
  conflict: "error.reason.conflict",
  server_gone: "error.reason.serverGone",
  sync_in_flight: "error.reason.syncInFlight",
  server_busy: "error.reason.serverBusy",
  invalid_denomination: "topup.invalidDenomination",

  // 控制面网络
  provider_unavailable: "error.reason.providerUnavailable",
  unexpected_status: (details) => {
    const status = readNumber(details?.status);
    if (status === null) return null;
    return { key: "error.reason.unexpectedStatus", vars: { status } };
  },
  unexpected_code: "error.reason.unexpectedCode",
  invalid_response: "error.reason.invalidResponse",
  timeout: "error.code.timeout",

  // AI 会话
  request_in_flight: "error.reason.requestInFlight",
  active_request: "error.reason.activeRequest",
  session_gone: "error.reason.sessionGone",
  empty_text: "error.reason.emptyText",
  empty_title: "error.reason.emptyTitle",
  title_too_long: (details) => {
    const max = readNumber(details?.max_chars);
    if (max === null) return null;
    return { key: "error.reason.titleTooLong", vars: { max } };
  },
  invalid_payload: "error.reason.invalidPayload",
  invalid_config_id: "error.reason.invalidConfigId",
  connect_mode_immutable: "error.reason.connectModeImmutable",
  url_not_allowed: "error.reason.urlNotAllowed",
  no_logs: "error.reason.noLogs",
  budget_exceeded: "error.reason.budgetExceeded",

  // AI 配置
  name_required: "error.reason.nameRequired",
  model_required: "error.reason.modelRequired",
  protocol_unsupported: "error.reason.protocolUnsupported",
  base_url_invalid: "error.reason.baseUrlInvalid",
  base_url_scheme: "error.reason.baseUrlScheme",
  base_url_credentials: "error.reason.baseUrlCredentials",
  base_url_http_local_only: "error.reason.baseUrlHttpLocalOnly",
  key_required: "error.reason.keyRequired",
  provider_key_invalid: "error.reason.providerKeyInvalid",
  ai_not_configured: "error.reason.aiNotConfigured",

  // 本地存储 / 本地动作
  store_unavailable: "error.reason.storeUnavailable",
  store_error: "error.reason.storeError",
  job_read_failed: "error.reason.jobReadFailed",
  keychain_failed: "error.reason.keychainFailed",
  open_browser_failed: "error.reason.openBrowserFailed",
  checkout_open_failed: "topup.checkoutUnavailable",
  internal: "error.code.internal",

  // 节点 / 设置
  not_owned: "error.reason.notOwned",
  dismiss_failed: "error.reason.dismissFailed",
  reset_in_flight: "error.reason.resetInFlight",
  invalid_port: "error.reason.invalidPort",
  invalid_language: "error.reason.invalidLanguage",
  invalid_interval: "error.reason.invalidInterval",
  invalid_action: "error.reason.invalidAction",

  // 后台助手（运行时启动）
  helper_missing: "error.reason.helperMissing",
  helper_file_invalid: "error.reason.helperFileInvalid",
  helper_busy: "error.reason.helperBusy",
  helper_lease_unavailable: "error.reason.helperLeaseUnavailable",
  dev_unbundled: "error.reason.devUnbundled",

  // 连接 / 接管（§1.6 补词）
  tun_denied: "error.reason.tunDenied",
  helper_admin_cancelled: "error.reason.helperAdminCancelled",
  helper_start_failed: "error.reason.helperStartFailed",
  proxy_restore_failed: "error.reason.proxyRestoreFailed",
  cancelled: "error.reason.superseded",
  config_launching: "error.reason.configLaunching",
  config_not_running: "error.reason.configNotRunning",
  config_unknown: "error.reason.configUnknown",
  no_config: "error.reason.noConfig",
  no_nodes: "error.reason.noNodes",
  connected: "error.reason.configInUse",
  switch_in_progress: "error.reason.switchInProgress",
  runtime_busy: "error.reason.runtimeBusy",

  // 配置 / 节点
  duplicate_name: "error.reason.duplicateName",
  invalid_cidr: "error.reason.invalidCidr",
  seed_unavailable: "error.reason.seedUnavailable",
  source_required: "vpn.error.sourceRequired",
  use_config_set_mode: "error.reason.useConfigSetMode",
  insecure_url: "error.reason.insecureUrl",
  fetch_failed: "error.reason.fetchFailed",
  not_node_text: "error.reason.notNodeText",
  not_subscription: "error.reason.notSubscription",
  unsupported_method: "error.reason.unsupportedMethod",
  invalid_argument: "error.reason.invalidArgument",
  node_not_in_config: "error.reason.nodeNotInConfig",

  // 凭据（本地节点）
  credential_expired: "error.reason.credentialExpired",
  credential_key_unknown: "error.reason.credentialInvalid",
  credential_key_missing: "error.reason.credentialInvalid",
  credential_key_invalid: "error.reason.credentialInvalid",
  credential_signature_invalid: "error.reason.credentialInvalid",
  credential_server_mismatch: "error.reason.credentialInvalid",

  // 移动端导出
  login_required: "error.reason.loginRequired",
  unknown_client: "error.reason.unknownClient",
  qr_encode_failed: "error.reason.qrEncodeFailed",
  insecure_profile_origin: "error.reason.insecureProfileOrigin",
  mobile_token_corrupt: "error.reason.mobileTokenCorrupt",
};

/** 控制面 worker 写进 `MyServer.failure.code` 的失败码。 */
export const ERROR_FAILURE_TEXT: Record<string, MessageKey> = {
  billing_unpaid: "error.failure.billingUnpaid",
  settle_insufficient: "error.reason.settleInsufficient",
  service_inactive: "error.failure.serviceInactive",
  install_failed: "error.failure.installFailed",
  verify_failed: "error.failure.verifyFailed",
};

/** 字典缺 key 时 `t()` 会回空串：退到下一层，不把空文案露给界面。 */
function textOf(key: MessageKey, vars?: Vars): string | null {
  const text = t(key, vars);
  return text.length > 0 ? text : null;
}

function reasonText(reason: string, details: Details): string | null {
  const entry = ERROR_REASON_TEXT[reason];
  if (entry === undefined) return null;
  if (typeof entry === "string") return textOf(entry);
  const hit = entry(details);
  return hit === null ? null : textOf(hit.key, hit.vars);
}

/** 命令错误（`AivpnError` 形状）的界面文案；`fallback` 由调用点给。 */
export function errorText(error: unknown, fallback: string): string {
  const problem = toBridgeError(error);
  const reason =
    typeof problem.details?.reason === "string" ? problem.details.reason : null;
  const byReason = reason === null ? null : reasonText(reason, problem.details);
  if (byReason !== null) return byReason;
  const codeKey = ERROR_CODE_TEXT[problem.code];
  if (codeKey !== undefined) return textOf(codeKey) ?? fallback;
  // 未单列的 RUNTIME_CLASH_* 一类：统一落到运行时通用句，不逐个登记。
  if (problem.code.startsWith("RUNTIME_")) {
    return textOf("error.code.runtimeGeneric") ?? fallback;
  }
  return fallback;
}

/**
 * `MyServer.failure` / 订单 failure 的文案：只读 `code`，不读 `message`。
 * 没给 failure 时用调用点兜底；给了但码不认识，用「创建没有完成」通用句。
 */
export function failureText(
  failure: { code: string } | null | undefined,
  fallback: string,
): string {
  if (!failure) return fallback;
  return textOf(ERROR_FAILURE_TEXT[failure.code] ?? "error.failure.generic") ?? fallback;
}
