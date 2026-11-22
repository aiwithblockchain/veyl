import { useEffect, useRef, useState } from "react";
import type { AgentBridge, MyServer, MyServerState } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { ServerProgress } from "./ServerProgress";
import { IconPencil } from "./icons";
import {
  billingNoticeText,
  formatUsdCents,
  isProvisioning,
  isServerNodeReady,
  serverBillingText,
  serverTombstoneText,
  serverDetailState,
  serverTone,
} from "../myservers/labels";
import { isTombstone } from "../myservers/tombstones";
import { copyText } from "../ui/clipboard";
import { t, useT } from "../i18n";
import { errorText as describeError, failureText } from "../i18n/errorText";

interface Props {
  bridge: AgentBridge;
  server: MyServer;
  /** 地区显示名（来自目录）；目录读不到时退回 slug。 */
  regionLabel: string;
  /** 身份不可用：只读，不提供任何改动机器的操作。 */
  readOnly?: boolean;
  /** 打开充值：就绪后扣费失败（余额不够）时给「去充值」。 */
  onTopUp?: () => void;
  /** 失败时把结构化失败交给 AI。 */
  onAiLocate?: (serverId: string) => void;
  /** 再建一台：打开 client 舞台的新建节点。 */
  onCreateAnother: () => void;
  onChanged: () => void;
  /** 重建成功：选中 newServerId，详情继续显示安装进度。 */
  onRebuilt: (serverId: string, state: MyServerState) => void;
  /** 销毁后收起详情。 */
  onGone: () => void;
  /** 停机删除的墓碑：删掉本地节点并把这一行收起来。 */
  onForget: (serverId: string, nodeId: string) => Promise<void>;
  /** 改名成功：用返回的完整对象更新列表与详情，不二次拉取。 */
  onRenamed?: (server: MyServer) => void;
  /** 这台服务器的本地节点最近一次探测不可达：显示「智能分析」入口。 */
  repairAvailable?: boolean;
  /** 打开节点诊断面板；面板与命令依赖由 App 统一构造。 */
  onDiagnose?: (target: { serverId: string; nodeName: string }) => void;
}

/** 服务端允许对 destroying 再发一次销毁；界面等这么久才放开重试入口。 */
export const DESTROY_RETRY_MS = 60_000;

function errorText(error: unknown): string {
  const problem = toBridgeError(error);
  const tail = problem.retryable
    ? t("detail.error.noChangeRetry")
    : t("detail.error.noChange");
  return `${describeError(problem, t("detail.error.incomplete"))}${tail}`;
}

/** 服务器详情：事实 + 底部操作行（销毁在左，主按钮在右）。 */
export function MyServerDetail({
  bridge,
  server,
  regionLabel,
  readOnly = false,
  onTopUp,
  onAiLocate,
  onCreateAnother,
  onChanged,
  onRebuilt,
  onGone,
  onForget,
  onRenamed,
  repairAvailable = false,
  onDiagnose,
}: Props) {
  const tr = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destroyRetryAllowed, setDestroyRetryAllowed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const focusRenameAfterSave = useRef(false);
  const [ipCopy, setIpCopy] = useState<"idle" | "copied" | "failed">("idle");
  const ipCopyTimer = useRef(0);
  const serverIdRef = useRef(server.server_id);
  serverIdRef.current = server.server_id;

  // 换一台服务器：复位复制结果，别把上一台的话带过来。
  useEffect(() => {
    setIpCopy("idle");
    return () => window.clearTimeout(ipCopyTimer.current);
  }, [server.server_id]);

  const copyIp = async () => {
    const targetId = server.server_id;
    const copied = await copyText((server.ip ?? "").trim());
    // 复制在途时换了服务器：结果属于上一台，不能落到新面板上。
    if (targetId !== serverIdRef.current) return;
    setIpCopy(copied ? "copied" : "failed");
    window.clearTimeout(ipCopyTimer.current);
    ipCopyTimer.current = window.setTimeout(() => setIpCopy("idle"), 1500);
  };

  useEffect(() => {
    if (renaming) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
      return;
    }
    if (focusRenameAfterSave.current) {
      focusRenameAfterSave.current = false;
      renameButtonRef.current?.focus();
    }
  }, [renaming]);

  const validateName = (raw: string): string | null => {
    if (raw.length === 0) return tr("detail.name.empty");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return tr("detail.name.spaces");
    if (Array.from(trimmed).length > 24) return tr("detail.name.tooLong");
    return null;
  };

  const startRename = () => {
    setNameDraft(server.name);
    setRenameError(null);
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
    setRenameError(null);
    focusRenameAfterSave.current = true;
  };

  const submitRename = async () => {
    if (savingName) return;
    const problem = validateName(nameDraft);
    if (problem) {
      setRenameError(problem);
      return;
    }
    const next = nameDraft.trim();
    if (next === server.name) {
      setRenaming(false);
      focusRenameAfterSave.current = true;
      return;
    }
    setSavingName(true);
    setRenameError(null);
    try {
      const updated = await bridge.myServerRename(server.server_id, next);
      onRenamed?.(updated);
      focusRenameAfterSave.current = true;
      setRenaming(false);
    } catch (err) {
      setRenameError(errorText(err));
      // 保存中不 disabled（浏览器会把焦点踢走），失败后显式把焦点送回输入框。
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    } finally {
      setSavingName(false);
    }
  };

  const rebuild = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await bridge.myServerRebuild(server.server_id, true);
      onRebuilt(result.newServerId, result.state);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.myServerDestroy(server.server_id, true);
      onChanged();
      onGone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const destroying = server.state === "destroying";

  /** 停机删除的墓碑：删本地节点，调用方同时把这一行收起。 */
  const forget = async () => {
    if (busy || !server.local_node_id) return;
    setBusy(true);
    try {
      await onForget(server.server_id, server.local_node_id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    setBusy(false);
    setConfirming(false);
    setError(null);
    setRenaming(false);
    setRenameError(null);
    setNameDraft("");
  }, [server.server_id]);

  useEffect(() => {
    if (!destroying) {
      setDestroyRetryAllowed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDestroyRetryAllowed(true),
      DESTROY_RETRY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [destroying, server.server_id]);

  const locked = readOnly || busy || (destroying && !destroyRetryAllowed);

  // 停机删除的墓碑：只有一句说明和一个删除入口，不提供续费 / 重建 / 恢复。
  if (isTombstone(server)) {
    const tone = serverTone(server);
    return (
      <div className="myservers__detail">
        <div className="myservers__detail-head">
          <div className="myservers__detail-heading">
            <h2 className="myservers__detail-name">{server.name}</h2>
          </div>
          <span className={`myservers__state is-${tone}`}>
            <span className={`led is-${tone}`} aria-hidden />
            {serverDetailState(server)}
          </span>
        </div>

        <p className="myservers__billing is-expired" role="status">
          {serverTombstoneText()}
        </p>

        {error ? (
          <p className="myservers__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="myservers__footer">
          <div className="myservers__danger">
            {confirming ? (
              <div className="myservers__confirm" role="alert">
                <p>{tr("detail.delete.body")}</p>
                <div className="myservers__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    {tr("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    disabled={busy}
                    onClick={() => void forget()}
                  >
                    {busy ? tr("detail.deleting") : tr("detail.confirmDelete")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--danger-ghost"
                disabled={locked || !server.local_node_id}
                title={
                  server.local_node_id ? undefined : tr("detail.noLocalNode")
                }
                onClick={() => setConfirming(true)}
              >
                {tr("detail.delete")}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const primary = isProvisioning(server.state)
    ? null
    : server.state === "error"
      ? { label: tr("detail.primary.rebuild"), disabled: locked, onClick: onCreateAnother }
      : server.state === "gone"
        ? { label: tr("detail.primary.rebuy"), disabled: locked, onClick: onCreateAnother }
        : null;

  /** 没建成的机器不存在「本期有效至」：费用行只说退款结论。 */
  const failed = server.state === "error";
  // 建好之后进度块原地换成完成态（含创建用时），不再另起一段。
  const ready = server.state === "healthy" || server.state === "active";
  const chargedCents = server.charged_cents;
  const refundedCents = server.refunded_cents;
  /** 就绪后扣费时余额不够：机器没开通，这笔根本没扣。 */
  const settleFailed =
    server.state === "error" && server.failure?.code === "settle_insufficient";
  const failedBilling = settleFailed
    ? tr("detail.billing.noCharge")
    : chargedCents === undefined || refundedCents === undefined
      ? tr("detail.billing.unavailable")
      : refundedCents > 0
        ? tr("detail.billing.refunded", { amount: formatUsdCents(refundedCents) })
        : chargedCents === 0
          ? tr("detail.billing.noCharge")
          : tr("detail.billing.chargedPending", {
              amount: formatUsdCents(chargedCents),
            });

  return (
    <div className="myservers__detail">
      <div className="myservers__detail-head">
        <div className="myservers__detail-heading">
          {renaming ? (
            <div className="myservers__rename-box">
              <input
                ref={nameInputRef}
                className={`myservers__rename-input${
                  savingName ? " is-saving" : ""
                }`}
                aria-label={tr("detail.renameAria")}
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? "server-name-error" : undefined}
                value={nameDraft}
                readOnly={savingName}
                aria-busy={savingName || undefined}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  if (renameError) setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const native = event.nativeEvent as KeyboardEvent;
                    if (native.isComposing || native.keyCode === 229) return;
                    event.preventDefault();
                    void submitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
              {renameError ? (
                <p
                  id="server-name-error"
                  className="myservers__rename-error"
                  role="alert"
                >
                  {renameError}
                </p>
              ) : null}
            </div>
          ) : (
            <h2 className="myservers__detail-name">{server.name}</h2>
          )}
          {!renaming && !readOnly && !destroying && server.state !== "gone" ? (
            <button
              ref={renameButtonRef}
              type="button"
              className="myservers__rename"
              aria-label={tr("detail.rename", { name: server.name })}
              onClick={startRename}
            >
              <IconPencil size={14} />
            </button>
          ) : null}
        </div>
        <span className={`myservers__state is-${serverTone(server)}`}>
          <span className={`led is-${serverTone(server)}`} aria-hidden />
          {serverDetailState(server)}
        </span>
      </div>

      {isProvisioning(server.state) || ready ? (
        <ServerProgress server={server} />
      ) : null}

      <dl className="myservers__facts">
        <div>
          <dt>{tr("detail.region")}</dt>
          <dd>{regionLabel}</dd>
        </div>
        {ready && (server.ip ?? "").trim() !== "" ? (
          <div>
            <dt>IP</dt>
            <dd className="myservers__ip">
              <span className="num">{server.ip}</span>
              <button
                type="button"
                className="copy-btn"
                onClick={() => void copyIp()}
                aria-label={tr("detail.copyIp")}
              >
                {ipCopy === "copied"
                  ? tr("chat.copy.copied")
                  : ipCopy === "failed"
                    ? tr("chat.copy.failed")
                    : tr("detail.copy")}
              </button>
              <span className="sr-only" role="status">
                {ipCopy === "copied"
                  ? tr("chat.copy.copied")
                  : ipCopy === "failed"
                    ? tr("chat.copy.failed")
                    : ""}
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{tr("detail.node")}</dt>
          <dd>{isServerNodeReady(server) ? tr("detail.nodeReady") : tr("detail.nodeNotReady")}</dd>
        </div>
        <div>
          <dt>{tr("detail.cost")}</dt>
          <dd className="num">{failed ? failedBilling : serverBillingText(server)}</dd>
        </div>
        {!failed && server.transfer_gib > 0 ? (
          <div>
            <dt>{tr("detail.traffic")}</dt>
            <dd>{tr("detail.trafficMonthly", { gib: server.transfer_gib })}</dd>
          </div>
        ) : null}
      </dl>

      {server.billing_state === "past_due" || server.billing_state === "expired" ? (
        <p
          className={`myservers__billing ${
            server.billing_state === "expired" ? "is-expired" : ""
          }`}
          role="status"
        >
          {billingNoticeText(server)}
        </p>
      ) : null}

      {server.failure ? (
        <div className="myservers__failure" role="alert">
          <p>
            {settleFailed
              ? tr("detail.settleFailed")
              : failureText(server.failure, t("error.failure.generic"))}
          </p>
          {settleFailed && onTopUp && !readOnly ? (
            <button type="button" className="btn btn--ghost" onClick={onTopUp}>
              {tr("detail.topUp")}
            </button>
          ) : null}
          {onAiLocate ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onAiLocate(server.server_id)}
            >
              {tr("controls.aiLocate")}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="myservers__error" role="alert">
          {error}
        </p>
      ) : null}

      {/* 重建端点当前不可用（rebuild_not_supported）：入口先隐藏，保留实现等后端。 */}
      {void rebuild}

      <div className="myservers__footer">
        <div className="myservers__danger">
          {ready && !readOnly && repairAvailable && onDiagnose ? (
            <div className="myservers__repair">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={locked || confirming}
                onClick={() =>
                  onDiagnose({
                    serverId: server.server_id,
                    nodeName: server.name,
                  })
                }
              >
                {tr("diagnosis.entry")}
              </button>
            </div>
          ) : null}
          {destroying && !destroyRetryAllowed ? (
            <p className="myservers__hint" role="status">
              {tr("detail.destroying")}
            </p>
          ) : confirming ? (
            <div className="myservers__confirm" role="alert">
              <p>
                {isProvisioning(server.state)
                  ? tr("detail.destroyConfirmProvisioning")
                  : tr("detail.destroyConfirm")}
              </p>
              <div className="myservers__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  disabled={busy}
                  onClick={() => void destroy()}
                >
                  {busy ? tr("detail.destroying") : tr("detail.confirmDestroy")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--danger-ghost"
              disabled={locked}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {destroying ? tr("detail.retryDestroy") : tr("detail.destroy")}
            </button>
          )}
        </div>
        {primary ? (
          <button
            type="button"
            className="btn btn--primary myservers__primary"
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
