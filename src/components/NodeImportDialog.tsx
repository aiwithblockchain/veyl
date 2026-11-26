import { useEffect, useRef, useState } from "react";
import type { AgentBridge } from "../agent/bridge";
import type {
  NodeImportResult,
  NodeImportSkipped,
  NodeSummary,
  NodeUpdateResult,
} from "../agent/protocol";
import { toBridgeError } from "../agent/errors";
import { t as translate, useT } from "../i18n";
import type { MessageKey } from "../i18n";
import { errorText } from "../i18n/errorText";
import { useFocusTrap } from "../ui/focus";
import { isComposingEvent } from "../ui/ime";
import { IconClose } from "./icons";

const IMPORT_SKIP_REASONS: Record<NodeImportSkipped["reason"], MessageKey> = {
  duplicate: "settings.import.skip.duplicate",
  unsupported_scheme: "settings.import.skip.scheme",
  unsupported_method: "settings.import.skip.method",
  malformed: "settings.import.skip.malformed",
  subscription_empty: "settings.import.skip.empty",
};

function importSkipReason(reason: string): string {
  return translate(
    IMPORT_SKIP_REASONS[reason as NodeImportSkipped["reason"]] ??
      "settings.import.skip.other",
  );
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 地址栏只收主机名：带 `:` 的必须是裸 IPv6，否则多半是把端口一起粘进来了。 */
function isBareIpv6(value: string): boolean {
  if (!value.includes(":")) return true;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  // 单个冒号一律当成 host:port；IPv6 至少两个冒号（含 `::` 简写）。
  if ((value.match(/:/g) ?? []).length < 2) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function describeFileImportError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  const reason =
    typeof bridgeError.details?.reason === "string" ? bridgeError.details.reason : null;
  switch (reason) {
    case "invalid_path":
      return translate("settings.error.filePath");
    case "file_unreadable":
      return translate("settings.error.fileUnreadable");
    case "file_too_large":
      return translate("settings.error.fileTooLarge");
    case "not_node_text":
      return translate("settings.error.notNodeText");
    default:
      break;
  }
  if (bridgeError.code === "NOT_FOUND") {
    return translate("settings.error.configGone");
  }
  return errorText(error, translate("settings.error.importFailed"));
}

/** 必须与 src-tauri/src/nodes.rs 的 SUPPORTED_METHODS 一致。 */
const METHODS = [
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
];

/** 2022 系列的密码是 base64 的 PSK，长度固定；规则与 `nodes.rs` 同一套。 */
const PSK_BYTES: Record<string, number> = {
  "2022-blake3-aes-128-gcm": 16,
  "2022-blake3-aes-256-gcm": 32,
  "2022-blake3-chacha20-poly1305": 32,
};

function pskPasswordOk(method: string, password: string): boolean {
  const expected = PSK_BYTES[method];
  if (expected === undefined) return true;
  const bare = password.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  try {
    return atob(padded).length === expected;
  } catch {
    return false;
  }
}

type Mode = "link" | "manual";
type ManualField = "name" | "server" | "port" | "password";
type ManualErrors = Partial<Record<ManualField | "method", string>>;

interface Props {
  open: boolean;
  bridge: AgentBridge;
  onClose: () => void;
  onNotice: (notice: { level: "info" | "error"; text: string }) => void;
  /** 非空时进入编辑态：只渲染手动填写段，连接参数按来源决定是否可改。 */
  editing?: NodeSummary | null;
  /** 编辑保存成功：调用方作废该节点测速并重拉列表（mock 通道不订阅事件）。 */
  onSaved?: (result: NodeUpdateResult) => void;
  /** 已连接 / 连接中：新导入的节点不在运行配置里，测速要等下次连接。 */
  connected?: boolean;
}

export function NodeImportDialog({
  open,
  bridge,
  onClose,
  onNotice,
  editing,
  onSaved,
  connected = false,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("link");

  const [importText, setImportText] = useState("");
  const [importFile, setImportFile] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkResult, setLinkResult] = useState<NodeImportResult | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [port, setPort] = useState("");
  const [method, setMethod] = useState(METHODS[2]);
  const [password, setPassword] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualErrors, setManualErrors] = useState<ManualErrors>({});
  const [manualError, setManualError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldRefs = {
    name: useRef<HTMLInputElement>(null),
    server: useRef<HTMLInputElement>(null),
    port: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  const editingNodeId = editing?.node_id ?? null;
  const paramsLocked = editing?.source === "url";
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (!open) return;
    const target = editingRef.current;
    setImportText("");
    setImportFile(null);
    setLinkBusy(false);
    setLinkResult(null);
    setLinkError(null);
    setManualBusy(false);
    setManualErrors({});
    setManualError(null);
    if (target) {
      setMode("manual");
      setName(target.name);
      setServer(target.server);
      setPort(String(target.port));
      setMethod(target.method);
      // 密码不回读：留空表示保持原密码。
      setPassword("");
      return;
    }
    setMode("link");
    setName("");
    setServer("");
    setPort("");
    setMethod(METHODS[2]);
    setPassword("");
  }, [open, editingNodeId]);

  const busy = mode === "link" ? linkBusy : manualBusy;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isComposingEvent(event)) return;
      if (event.key !== "Escape") return;
      if (busy) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  const importFirstLine =
    importText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const importIsUrl = /^https:\/\//i.test(importFirstLine);

  const applyLinkResult = (result: NodeImportResult) => {
    setLinkResult(result);
    if (result.imported === 0) return;
    setImportText("");
    setImportFile(null);
    onNotice({
      level: "info",
      text: t(
        connected
          ? "settings.import.addedNextConnect"
          : "settings.import.added",
        { count: result.imported },
      ),
    });
  };

  const submitLink = async () => {
    if (linkBusy) return;
    setLinkError(null);
    setLinkResult(null);

    if (importFile) {
      setLinkBusy(true);
      try {
        applyLinkResult(await bridge.nodeImportFile(importFile));
      } catch (error) {
        setLinkError(describeFileImportError(error));
      } finally {
        setLinkBusy(false);
      }
      return;
    }

    const text = importText.trim();
    if (!text) return;
    if (/^http:\/\//i.test(importFirstLine)) {
      setLinkError(t("settings.import.httpsOnly"));
      return;
    }
    setLinkBusy(true);
    try {
      applyLinkResult(
        importIsUrl
          ? await bridge.nodeImportUrl(importFirstLine)
          : await bridge.nodeImportText(text),
      );
    } catch (error) {
      setLinkError(errorText(error, t("settings.import.addFailed")));
    } finally {
      setLinkBusy(false);
    }
  };

  const chooseImportFile = async () => {
    if (linkBusy) return;
    setLinkError(null);
    try {
      const path = await bridge.pickNodeFile();
      if (!path) return;
      setImportFile(path);
      setImportText("");
      setLinkResult(null);
    } catch {
      setLinkError(t("settings.import.noPicker"));
    }
  };

  const validateManual = (): ManualErrors => {
    const errors: ManualErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.name = t("settings.import.manual.nameRequired");
    } else if (Array.from(trimmedName).length > 64) {
      errors.name = t("settings.import.manual.nameTooLong");
    }

    const trimmedServer = server.trim();
    if (!trimmedServer) {
      errors.server = t("settings.import.manual.serverRequired");
    } else if (trimmedServer.includes("://")) {
      errors.server = t("settings.import.manual.serverInvalid");
    } else if (trimmedServer.includes(":") && !isBareIpv6(trimmedServer)) {
      // 服务商后台常给「IP:端口」，整段粘进来会建出一个连不上的节点。
      errors.server = t("settings.import.manual.serverHasPort");
    } else if (new TextEncoder().encode(trimmedServer).length > 253) {
      errors.server = t("settings.import.manual.serverTooLong");
    } else if (/[\s/\\\u0000-\u001f\u007f]/.test(trimmedServer)) {
      errors.server = t("settings.import.manual.serverInvalid");
    }

    const portText = port.trim();
    const portValue = Number(portText);
    if (
      !/^\d+$/.test(portText) ||
      !Number.isInteger(portValue) ||
      portValue < 1 ||
      portValue > 65535
    ) {
      errors.port = t("settings.import.manual.portInvalid");
    }

    if (!password.trim()) {
      // 编辑态留空 = 保持原密码。
      if (!editing) errors.password = t("settings.import.manual.passwordRequired");
    } else if (Array.from(password).length > 256) {
      errors.password = t("settings.import.manual.passwordTooLong");
    } else if (!pskPasswordOk(method, password)) {
      errors.password = t("settings.import.manual.keyInvalid");
    }

    return errors;
  };

  const clearFieldError = (field: ManualField) => {
    setManualError(null);
    setManualErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  /** 切段只清结果与错误，保留已填内容。 */
  const switchMode = (next: Mode) => {
    setMode(next);
    setLinkError(null);
    setLinkResult(null);
    setManualError(null);
    setManualErrors({});
  };

  const validateField = (field: ManualField) => {
    const errors = validateManual();
    setManualErrors((current) => ({ ...current, [field]: errors[field] }));
  };

  const submitManual = async () => {
    if (manualBusy) return;
    setManualError(null);
    const errors = validateManual();
    setManualErrors(errors);
    const first = (["name", "server", "port", "password"] as const).find(
      (field) => errors[field],
    );
    if (first) {
      fieldRefs[first].current?.focus();
      return;
    }

    setManualBusy(true);
    try {
      if (editing) {
        const result = await bridge.nodeUpdate({
          nodeId: editing.node_id,
          name: name.trim(),
          ...(paramsLocked
            ? {}
            : {
                server: server.trim(),
                port: Number(port.trim()),
                method,
                ...(password.trim() ? { password } : {}),
              }),
        });
        onSaved?.(result);
        if (result.rebuildStatus === "failed") {
          // 保存成功但连接没回来：不能说「已保存」了事，要让用户知道连接断了。
          onNotice({
            level: "error",
            text: result.message ?? t("settings.import.manual.rebuildFailed"),
          });
        } else {
          onNotice({
            level: "info",
            text: result.disconnected
              ? t("settings.import.manual.savedDisconnected")
              : result.rebuilt
                ? t("settings.import.manual.savedReconnected")
                : t("settings.import.manual.saved"),
          });
        }
        onClose();
        return;
      }
      await bridge.nodeCreate({
        name: name.trim(),
        server: server.trim(),
        port: Number(port.trim()),
        method,
        password,
      });
      onNotice({ level: "info", text: t("settings.import.manual.added") });
      onClose();
    } catch (error) {
      const bridgeError = toBridgeError(error);
      const reason =
        typeof bridgeError.details?.reason === "string"
          ? bridgeError.details.reason
          : null;
      if (reason === "unsupported_method") {
        // 2022 系列被拒多半是密钥格式不对，不是方式本身；错误要落在填错的那栏。
        setManualErrors(
          PSK_BYTES[method] !== undefined
            ? { password: t("settings.import.manual.keyInvalid") }
            : { method: t("settings.import.manual.methodUnsupported") },
        );
      } else if (bridgeError.code === "INVALID_ARGUMENT" && !editing) {
        setManualError(t("settings.import.addFailed"));
      } else {
        setManualError(
          errorText(
            error,
            t(
              editing
                ? "settings.import.manual.saveFailed"
                : "settings.import.addFailed",
            ),
          ),
        );
      }
    } finally {
      setManualBusy(false);
    }
  };

  const skippedGroups: Array<{ reason: string; count: number }> = [];
  if (linkResult) {
    for (const item of linkResult.skipped) {
      const group = skippedGroups.find((entry) => entry.reason === item.reason);
      if (group) group.count += 1;
      else skippedGroups.push({ reason: item.reason, count: 1 });
    }
  }
  /**
   * 没有新增、但有节点命中既有记录：这不是「导入失败」，是这份订阅/链接已经导入过。
   * 不能要求 skipped 全是 duplicate——Clash 订阅每次都会带非 ss 类型与不支持的
   * cipher，它们和重复项混在同一个 skipped 里，要求「全是重复」就永远不成立。
   */
  const alreadyImported =
    linkResult !== null &&
    linkResult.imported === 0 &&
    skippedGroups.some((group) => group.reason === "duplicate");
  const skippedSummary = skippedGroups
    .map((group) => `${importSkipReason(group.reason)} ${group.count}`)
    .join("、");

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal--node-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="node-import-title" className="modal__title">
            {editing ? t("settings.import.editTitle") : t("settings.import.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="node-import__body">
          <p className="settings-note">
            {editing
              ? paramsLocked
                ? t("settings.import.editSubscribedNote")
                : t("settings.import.manual.note")
              : mode === "link"
                ? t("settings.import.note")
                : t("settings.import.manual.note")}
          </p>

          {editing ? null : (
            <div
              className="settings-seg node-import__seg"
              role="group"
              aria-label={t("settings.import.modeAria")}
            >
              <button
                type="button"
                className={mode === "link" ? "is-selected" : ""}
                aria-pressed={mode === "link"}
                disabled={busy}
                onClick={() => switchMode("link")}
              >
                {t("settings.import.modeLink")}
              </button>
              <button
                type="button"
                className={mode === "manual" ? "is-selected" : ""}
                aria-pressed={mode === "manual"}
                disabled={busy}
                onClick={() => switchMode("manual")}
              >
                {t("settings.import.modeManual")}
              </button>
            </div>
          )}

          {mode === "link" ? (
            <>
              {importFile ? (
                <p className="settings-row__value">
                  {t("settings.import.willImport")}{" "}
                  <span className="num">{fileNameOf(importFile)}</span>
                </p>
              ) : (
                <div className="settings-input">
                  <textarea
                    aria-label={t("settings.import.urlAria")}
                    value={importText}
                    rows={4}
                    disabled={linkBusy}
                    placeholder={"ss://...\nhttps://..."}
                    onChange={(event) => {
                      setImportText(event.target.value);
                      setLinkError(null);
                      setLinkResult(null);
                    }}
                  />
                </div>
              )}

              {linkResult ? (
                <div className="settings-import">
                  {linkResult.imported > 0 ? (
                    <>
                      <p className="settings-feedback" role="status">
                        {t("settings.import.added", {
                          count: linkResult.imported,
                        })}
                      </p>
                      <ul
                        className="settings-import__added"
                        aria-label={t("settings.import.addedList")}
                      >
                        {linkResult.nodes.map((node) => (
                          <li key={node.node_id}>{node.name}</li>
                        ))}
                      </ul>
                    </>
                  ) : alreadyImported ? (
                    <p className="settings-feedback" role="status">
                      {t("settings.import.allDuplicate")}
                    </p>
                  ) : (
                    <p
                      className="settings-feedback settings-feedback--warn"
                      role="status"
                    >
                      {t("settings.import.noneAdded")}
                    </p>
                  )}
                  {linkResult.skipped.length > 0 && !alreadyImported ? (
                    <details className="settings-import__skipped">
                      <summary>
                        {t("settings.import.skippedSummary", {
                          count: linkResult.skipped.length,
                          reasons: skippedSummary,
                        })}
                      </summary>
                      <ul className="settings-import__skipped-list">
                        {linkResult.skipped.map((item, index) => (
                          <li key={`${item.name}-${item.reason}-${index}`}>
                            {item.name ? `${item.name}：` : ""}
                            {importSkipReason(item.reason)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {linkError ? (
                <p
                  className="settings-feedback settings-feedback--error"
                  role="alert"
                >
                  {linkError}
                </p>
              ) : null}
            </>
          ) : (
            <form
              id="node-import-form"
              className="node-import__form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submitManual();
              }}
            >
              <div className="node-import__field">
                <label htmlFor="node-import-name">
                  {t("settings.import.manual.name")}
                </label>
                <input
                  id="node-import-name"
                  ref={fieldRefs.name}
                  value={name}
                  disabled={manualBusy}
                  placeholder={t("settings.import.manual.namePlaceholder")}
                  aria-invalid={manualErrors.name ? true : undefined}
                  aria-describedby={
                    manualErrors.name ? "node-import-name-error" : undefined
                  }
                  onChange={(event) => {
                    setName(event.target.value);
                    clearFieldError("name");
                  }}
                  onBlur={() => validateField("name")}
                />
                {manualErrors.name ? (
                  <p
                    id="node-import-name-error"
                    className="node-import__error"
                    role="alert"
                  >
                    {manualErrors.name}
                  </p>
                ) : null}
              </div>

              <div className="node-import__row">
                <div className="node-import__field">
                  <label htmlFor="node-import-server">
                    {t("settings.import.manual.server")}
                  </label>
                  <input
                    id="node-import-server"
                    ref={fieldRefs.server}
                    value={server}
                    disabled={manualBusy || paramsLocked}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={t("settings.import.manual.serverPlaceholder")}
                    aria-invalid={manualErrors.server ? true : undefined}
                    aria-describedby={
                      manualErrors.server ? "node-import-server-error" : undefined
                    }
                    onChange={(event) => {
                      setServer(event.target.value);
                      clearFieldError("server");
                    }}
                    onBlur={() => validateField("server")}
                  />
                  {manualErrors.server ? (
                    <p
                      id="node-import-server-error"
                      className="node-import__error"
                      role="alert"
                    >
                      {manualErrors.server}
                    </p>
                  ) : null}
                </div>

                <div className="node-import__field">
                  <label htmlFor="node-import-port">
                    {t("settings.import.manual.port")}
                  </label>
                  <input
                    id="node-import-port"
                    ref={fieldRefs.port}
                    value={port}
                    disabled={manualBusy || paramsLocked}
                    inputMode="numeric"
                    className="num"
                    placeholder={t("settings.import.manual.portPlaceholder")}
                    aria-invalid={manualErrors.port ? true : undefined}
                    aria-describedby={
                      manualErrors.port ? "node-import-port-error" : undefined
                    }
                    onChange={(event) => {
                      setPort(event.target.value);
                      clearFieldError("port");
                    }}
                    onBlur={() => validateField("port")}
                  />
                  {manualErrors.port ? (
                    <p
                      id="node-import-port-error"
                      className="node-import__error"
                      role="alert"
                    >
                      {manualErrors.port}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="node-import__field">
                <label htmlFor="node-import-method">
                  {t("settings.import.manual.method")}
                </label>
                <select
                  id="node-import-method"
                  value={method}
                  disabled={manualBusy || paramsLocked}
                  aria-invalid={manualErrors.method ? true : undefined}
                  aria-describedby={
                    manualErrors.method ? "node-import-method-error" : undefined
                  }
                  onChange={(event) => {
                    setMethod(event.target.value);
                    setManualErrors((current) => {
                      if (!current.method) return current;
                      const next = { ...current };
                      delete next.method;
                      return next;
                    });
                  }}
                >
                  {METHODS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                {manualErrors.method ? (
                  <p
                    id="node-import-method-error"
                    className="node-import__error"
                    role="alert"
                  >
                    {manualErrors.method}
                  </p>
                ) : null}
              </div>

              <div className="node-import__field">
                <label htmlFor="node-import-password">
                  {t("settings.import.manual.password")}
                </label>
                <input
                  id="node-import-password"
                  ref={fieldRefs.password}
                  type="password"
                  value={password}
                  disabled={manualBusy || paramsLocked}
                  autoComplete="new-password"
                  placeholder={
                    editing
                      ? t("settings.import.manual.editPasswordPlaceholder")
                      : t("settings.import.manual.passwordPlaceholder")
                  }
                  aria-invalid={manualErrors.password ? true : undefined}
                  aria-describedby={
                    manualErrors.password ? "node-import-password-error" : undefined
                  }
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearFieldError("password");
                  }}
                  onBlur={() => validateField("password")}
                />
                {manualErrors.password ? (
                  <p
                    id="node-import-password-error"
                    className="node-import__error"
                    role="alert"
                  >
                    {manualErrors.password}
                  </p>
                ) : null}
              </div>

              {manualError ? (
                <p
                  className="settings-feedback settings-feedback--error"
                  role="alert"
                >
                  {manualError}
                </p>
              ) : null}
            </form>
          )}
        </div>

        <div className="node-import__actions">
          {mode === "link" ? (
            <>
              {importFile ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void chooseImportFile()}
                    disabled={linkBusy}
                  >
                    {t("settings.import.reselect")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      setImportFile(null);
                      setLinkResult(null);
                    }}
                    disabled={linkBusy}
                  >
                    {t("settings.import.useText")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void chooseImportFile()}
                  disabled={linkBusy}
                >
                  {t("settings.import.fromFile")}
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                disabled={linkBusy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submitLink()}
                disabled={linkBusy || (!importFile && importText.trim() === "")}
                aria-busy={linkBusy ? true : undefined}
              >
                {linkBusy
                  ? importFile
                    ? t("settings.import.busy")
                    : importIsUrl
                      ? t("settings.import.busyUrl")
                      : t("settings.import.busyText")
                  : importFile
                    ? t("settings.import.action")
                    : t("settings.import.add")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                disabled={manualBusy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                form="node-import-form"
                className="btn btn--primary"
                disabled={manualBusy}
                aria-busy={manualBusy ? true : undefined}
              >
                {manualBusy
                  ? t(
                      editing
                        ? "settings.import.manual.saving"
                        : "settings.import.busyText",
                    )
                  : t(
                      editing
                        ? "settings.import.manual.save"
                        : "settings.import.manual.submit",
                    )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
