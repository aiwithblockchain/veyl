/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import { setLanguage } from "./index";
import { zh } from "./zh";
import {
  ERROR_CODE_TEXT,
  ERROR_FAILURE_TEXT,
  ERROR_REASON_TEXT,
  errorText,
  failureText,
} from "./errorText";

afterEach(() => setLanguage("zh"));

const CJK = /[一-鿿]/;
const FALLBACK = "调用点兜底";

/** 带全所有参数，让需要 details 的条目也能查出来。 */
const RICH_DETAILS = {
  min_length: 1,
  max_length: 24,
  retry_after_seconds: 30,
  shortfall_cents: 210,
  required_cents: 500,
  status: 502,
  max_chars: 60,
};

describe("errorText", () => {
  it("code 命中通用句", () => {
    expect(errorText({ code: "TIMEOUT" }, FALLBACK)).toBe(
      "等服务器回应超时了，稍后再试。",
    );
  });

  it("reason 命中细分文案，并带上 details 参数", () => {
    expect(
      errorText(
        {
          code: "PRECONDITION_FAILED",
          details: { reason: "insufficient_balance", shortfall_cents: 210 },
        },
        FALLBACK,
      ),
    ).toBe("余额不足，还差 $2.10。");
    expect(
      errorText(
        { code: "INVALID_ARGUMENT", details: { reason: "title_too_long", max_chars: 60 } },
        FALLBACK,
      ),
    ).toBe("标题最多 60 个字符。");
  });

  it("server_provisioning：创建中不能销毁", () => {
    expect(
      errorText(
        {
          code: "PRECONDITION_FAILED",
          details: { reason: "server_provisioning", state: "installing" },
        },
        FALLBACK,
      ),
    ).toBe("正在创建这台服务器，不能销毁；创建会自动完成或失败。");
  });

  it("reason 缺关键参数时退到无参数句或下一层", () => {
    expect(
      errorText(
        { code: "PRECONDITION_FAILED", details: { reason: "insufficient_balance" } },
        FALLBACK,
      ),
    ).toBe("余额不足。");
    expect(
      errorText(
        { code: "INVALID_ARGUMENT", details: { reason: "invalid_name" } },
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });

  it("未知 reason 落 code 通用句", () => {
    expect(
      errorText({ code: "TIMEOUT", details: { reason: "not_registered" } }, FALLBACK),
    ).toBe("等服务器回应超时了，稍后再试。");
  });

  it("未知 code 落调用点兜底", () => {
    expect(errorText({ code: "SOMETHING_NEW" }, FALLBACK)).toBe(FALLBACK);
    expect(errorText("boom", FALLBACK)).toBe(FALLBACK);
    expect(errorText({ code: "INTERNAL" }, FALLBACK)).toBe(FALLBACK);
  });

  it("任何一层都不读 message", () => {
    expect(
      errorText({ code: "UPSTREAM_ERROR", message: "上游原文" }, FALLBACK),
    ).toBe("服务器服务暂时不可用，稍后再试。");
    expect(
      errorText(
        { code: "INTERNAL", message: "磁盘只读", details: { reason: "store_error" } },
        FALLBACK,
      ),
    ).toBe("读写本地数据失败，稍后再试。");
  });

  it("TUN 接管失败：回滚确认过才说「已回滚」，否则先让用户强制重置", () => {
    const takeover = (detail: Record<string, unknown>) => ({
      code: "tun_start_failed",
      details: { reason: "tun_start_failed", detail },
    });
    // 停干净、无残留、DNS 已刷新：与 connect_changed = restored 的判据一致。
    expect(
      errorText(
        takeover({
          reason: "takeover_incomplete",
          stopped: true,
          residual_routes: false,
          dns_flushed: true,
        }),
        FALLBACK,
      ),
    ).toBe(
      "接管全部流量没有准备就绪，已自动停止并回滚。可以重试；仍失败就到设置里强制重置网络。",
    );
    // 有残留路由：不能再声称已回滚，先强制重置。
    expect(
      errorText(
        takeover({
          reason: "takeover_incomplete",
          stopped: true,
          residual_routes: true,
          dns_flushed: true,
        }),
        FALLBACK,
      ),
    ).toBe(
      "接管全部流量没有准备就绪，自动停止也没能确认清理干净。先到设置里执行「强制重置网络」，再重试。",
    );
    // 停不掉也一样。
    expect(
      errorText(
        takeover({
          reason: "takeover_incomplete",
          stopped: false,
          residual_routes: false,
          dns_flushed: true,
        }),
        FALLBACK,
      ),
    ).toBe(
      "接管全部流量没有准备就绪，自动停止也没能确认清理干净。先到设置里执行「强制重置网络」，再重试。",
    );
  });

  it("TUN 启动失败但没有接管细节：只说没起来，不承诺已回滚", () => {
    expect(errorText({ code: "tun_start_failed" }, FALLBACK)).toBe(
      "接管全部流量没有起来。可以重试；仍失败就到设置里强制重置网络。",
    );
  });

  it("当前节点域名解析失败：说清连接没开始，不教人重置网络", () => {
    expect(
      errorText(
        {
          code: "tun_start_failed",
          details: { reason: "node_server_unresolved" },
        },
        FALLBACK,
      ),
    ).toBe(
      "当前节点的服务器地址解析不出来，连接没有开始。检查网络或换一个节点后再试。",
    );
  });

  it("Clash 配置没有可用的 Shadowsocks 节点时说清格式，不让用户去查地址", () => {
    expect(
      errorText(
        { code: "INVALID_ARGUMENT", details: { reason: "not_subscription" } },
        FALLBACK,
      ),
    ).toBe("这是 Clash 配置，但里面没有可用的 Shadowsocks 节点。");
  });

  it("英文界面取 en 字典", () => {
    setLanguage("en");
    expect(errorText({ code: "TIMEOUT" }, "fallback")).toBe(
      "The request timed out. Try again.",
    );
  });
});

describe("failureText", () => {
  it("只按 code 取文案", () => {
    expect(failureText({ code: "billing_unpaid" }, FALLBACK)).toBe(
      "余额不足，服务器已停机删除。",
    );
    const withMessage = { code: "install_failed", message: "raw" };
    expect(failureText(withMessage, FALLBACK)).toBe("装机失败。");
  });

  it("不认识的码用通用句，不显示原始 message", () => {
    expect(failureText({ code: "weird_stage" }, FALLBACK)).toBe("创建没有完成。");
  });

  it("没有 failure 时用调用点兜底", () => {
    expect(failureText(null, FALLBACK)).toBe(FALLBACK);
    expect(failureText(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe("字典覆盖", () => {
  it("已登记的 code / reason / failure 都查得到文案，不用兜底", () => {
    for (const code of Object.keys(ERROR_CODE_TEXT)) {
      expect(errorText({ code }, FALLBACK)).not.toBe(FALLBACK);
    }
    for (const reason of Object.keys(ERROR_REASON_TEXT)) {
      expect(
        errorText(
          { code: "PRECONDITION_FAILED", details: { ...RICH_DETAILS, reason } },
          FALLBACK,
        ),
      ).not.toBe(FALLBACK);
    }
    for (const code of Object.keys(ERROR_FAILURE_TEXT)) {
      expect(failureText({ code }, FALLBACK)).not.toBe(FALLBACK);
    }
  });

  it("表里每个 key 都必须在 zh 与 en 字典中存在", () => {
    const zhKeys = zh as Record<string, string>;
    const enKeys = en as Record<string, string>;
    const checkKey = (key: string, where: string) => {
      expect(typeof zhKeys[key], `${where}: zh 缺 ${key}`).toBe("string");
      expect(typeof enKeys[key], `${where}: en 缺 ${key}`).toBe("string");
    };

    for (const [code, key] of Object.entries(ERROR_CODE_TEXT)) {
      checkKey(key, `code ${code}`);
    }
    // 未单列的 RUNTIME_* 由前缀兜底，这个 key 不在表里，单独校验存在。
    checkKey("error.code.runtimeGeneric", "code RUNTIME_*");
    for (const [code, key] of Object.entries(ERROR_FAILURE_TEXT)) {
      checkKey(key, `failure ${code}`);
    }
    for (const [reason, entry] of Object.entries(ERROR_REASON_TEXT)) {
      if (typeof entry === "string") {
        checkKey(entry, `reason ${reason}`);
        continue;
      }
      const hit = entry(RICH_DETAILS);
      expect(hit, `reason ${reason} 在样例参数下解析为 null`).not.toBeNull();
      checkKey(hit?.key ?? "", `reason ${reason}`);
    }
  });

  it("confirmation_required 与 confirm_required 用同一句", () => {
    expect(
      errorText({ code: "PRECONDITION_FAILED", details: { reason: "confirmation_required" } }, FALLBACK),
    ).toBe(
      errorText({ code: "PRECONDITION_FAILED", details: { reason: "confirm_required" } }, FALLBACK),
    );
  });

  it("未单列的 RUNTIME_* 落运行时通用句", () => {
    expect(errorText({ code: "RUNTIME_CLASH_ADDRESS" }, FALLBACK)).toBe(
      "后台组件没能正常运行。",
    );
    expect(errorText({ code: "RUNTIME_START_TIMEOUT" }, FALLBACK)).toBe(
      "后台组件启动超时。",
    );
  });

  it("英文下所有已登记条目都不含中文", () => {
    setLanguage("en");
    const check = (text: string) => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toMatch(CJK);
    };
    for (const code of Object.keys(ERROR_CODE_TEXT)) {
      check(errorText({ code }, "fallback"));
    }
    for (const reason of Object.keys(ERROR_REASON_TEXT)) {
      check(
        errorText(
          { code: "PRECONDITION_FAILED", details: { ...RICH_DETAILS, reason } },
          "fallback",
        ),
      );
    }
    for (const code of Object.keys(ERROR_FAILURE_TEXT)) {
      check(failureText({ code }, "fallback"));
    }
    check(failureText({ code: "unknown_code" }, "fallback"));
  });

  it("§1.6 的界面可见 reason、RUNTIME_* 码与 worker 失败码都已登记", () => {
    const reasons = [
      "auth_required",
      "token_invalid",
      "code_invalid",
      "code_expired",
      "too_many_attempts",
      "account_conflict",
      "email_cooldown",
      "email_rate_limited",
      "rate_limited",
      "device_revoked",
      "account_blocked",
      "account_frozen",
      "email_invalid",
      "invalid_name",
      "insufficient_balance",
      "settle_insufficient",
      "confirm_required",
      "idempotency_in_flight",
      "conflict",
      "server_gone",
      "sync_in_flight",
      "server_busy",
      "server_provisioning",
      "invalid_denomination",
      "provider_unavailable",
      "unexpected_status",
      "unexpected_code",
      "invalid_response",
      "timeout",
      "request_in_flight",
      "active_request",
      "session_gone",
      "empty_text",
      "empty_title",
      "title_too_long",
      "invalid_payload",
      "invalid_config_id",
      "connect_mode_immutable",
      "url_not_allowed",
      "no_logs",
      "budget_exceeded",
      "name_required",
      "model_required",
      "protocol_unsupported",
      "base_url_invalid",
      "base_url_scheme",
      "base_url_credentials",
      "base_url_http_local_only",
      "key_required",
      "provider_key_invalid",
      "ai_not_configured",
      "store_unavailable",
      "store_error",
      "job_read_failed",
      "keychain_failed",
      "open_browser_failed",
      "checkout_open_failed",
      "internal",
      "not_owned",
      "dismiss_failed",
      "reset_in_flight",
      "invalid_port",
      "invalid_language",
      "invalid_interval",
      "invalid_action",
      "login_required",
      "unknown_client",
      "qr_encode_failed",
      "insecure_profile_origin",
      "mobile_token_corrupt",
      // helper / 连接 / 接管
      "helper_missing",
      "helper_file_invalid",
      "helper_busy",
      "helper_lease_unavailable",
      "dev_unbundled",
      "tun_denied",
      "helper_admin_cancelled",
      "helper_start_failed",
      "proxy_restore_failed",
      "cancelled",
      "config_launching",
      "config_not_running",
      "config_unknown",
      "no_config",
      "no_nodes",
      "connected",
      "switch_in_progress",
      "runtime_busy",
      // 配置 / 节点
      "duplicate_name",
      "invalid_cidr",
      "seed_unavailable",
      "trial_expired",
      "source_required",
      "use_config_set_mode",
      "insecure_url",
      "fetch_failed",
      "not_node_text",
      "unsupported_method",
      "invalid_argument",
      "node_not_in_config",
      // 凭据
      "credential_expired",
      "credential_key_unknown",
      "credential_key_missing",
      "credential_key_invalid",
      "credential_signature_invalid",
      "credential_server_mismatch",
      // 历史别名：与 confirm_required 同一句
      "confirmation_required",
    ];
    for (const reason of reasons) {
      expect(ERROR_REASON_TEXT[reason]).toBeDefined();
    }
    for (const code of [
      "billing_unpaid",
      "settle_insufficient",
      "service_inactive",
      "install_failed",
      "verify_failed",
    ]) {
      expect(ERROR_FAILURE_TEXT[code]).toBeDefined();
    }
    for (const code of [
      "RUNTIME_NOT_INSTALLED",
      "RUNTIME_CONFIG_INVALID",
      "RUNTIME_PORT_UNAVAILABLE",
      "RUNTIME_START_TIMEOUT",
      "RUNTIME_BUSY",
      "RUNTIME_CRASH_LOOP",
      "RUNTIME_EXITED",
      "RUNTIME_HEALTH_FAILED",
    ]) {
      expect(ERROR_CODE_TEXT[code]).toBeDefined();
    }
  });
});
