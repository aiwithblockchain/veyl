import { useEffect, useRef, useState } from "react";
import type { AgentBridge, MyServer, MyServerState } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { ServerProgress } from "./ServerProgress";
import { NodeRepairDialog } from "./NodeRepairDialog";
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
import {
  rotateFailureReason,
  rotateNodeCredentials,
} from "../myservers/rotateCredentials";
import { updateConfigAndReconnect } from "../myservers/updateConfigAndReconnect";
import { copyText } from "../ui/clipboard";
import { t, useT } from "../i18n";

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
  /** 智能修复成功：让调用方重读节点数据（服务器数据走 onChanged）。 */
  onRotated?: () => void;
  /** 隧道是否正在运行：运行中同步凭据后必须先 stop → start 再重测。 */
  tunnelConnected?: boolean;
  /** 正在运行的本地节点 id（nd_…）；只有它等于这台时才重启。 */
  runningNodeId?: string | null;
  /** 这台服务器的本地节点最近一次探测不可达：才显示智能修复。 */
  repairAvailable?: boolean;
  /** 先断开再连接（与连接页共用同一条链路）。 */
  onReconnectAndTest?: () => Promise<boolean>;
}

/** 服务端允许对 destroying 再发一次销毁；界面等这么久才放开重试入口。 */
export const DESTROY_RETRY_MS = 60_000;

function errorText(error: unknown): string {
  const problem = toBridgeError(error);
  // 批次 4 起改看稳定错误码；现在只认后端是否真的给了 message。
  const message = problem.hasMessage ? problem.message : "";
  const tail = problem.retryable
    ? t("detail.error.noChangeRetry")
    : t("detail.error.noChange");
  return message ? `${message}${tail}` : `${t("detail.error.incomplete")}${tail}`;
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
  onRotated,
  tunnelConnected = false,
  runningNodeId = null,
  repairAvailable = false,
  onReconnectAndTest,
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
  const [repairing, setRepairing] = useState(false);
  const [repairConfirming, setRepairConfirming] = useState(false);
  const [repairResult, setRepairResult] = useState<{ port: number } | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
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

  const repairErrorText = (err: unknown): string => {
    if (toBridgeError(err).code === "UNSUPPORTED") {
      return tr("detail.repair.unsupported");
    }
    switch (rotateFailureReason(err)) {
      case "agent_token_unavailable":
        return tr("detail.repair.tokenUnavailable");
      case "agent_tls_untrusted":
      case "agent_token_rejected":
        return tr("detail.repair.auth");
      case "agent_timeout":
      case "agent_unreachable":
        return tr("detail.repair.unreachable");
      case "agent_tool_failed":
      case "agent_bad_response":
        return tr("detail.repair.agentFailed");
      default:
        return tr("detail.repair.failed");
    }
  };

  /** 智能修复：换端口会重启节点，必须先过确认；失败按 reason 给不同出路。 */
  const repair = async () => {
    if (repairing) return;
    setRepairConfirming(false);
    setRepairing(true);
    setRepairError(null);
    setRepairResult(null);
    try {
      const result = await rotateNodeCredentials(bridge, server.server_id);
      setRepairResult({ port: result.port });
      // 服务器数据走 onChanged；节点数据由调用方的 onRotated 重读。
      onChanged();
      onRotated?.();
    } catch (err) {
      setRepairError(repairErrorText(err));
    } finally {
      setRepairing(false);
    }
  };

  /** 确认弹窗的「先更新配置」：取回最新凭据并重读数据，不换端口。 */
  const syncCredentials = async () => {
    if (repairing) return;
    setRepairConfirming(false);
    setRepairing(true);
    setRepairError(null);
    setRepairResult(null);
    try {
      // 与连接页共用同一套：取凭据 →（跑的就是这台时）stop → start → 重读数据。
      await updateConfigAndReconnect({
        fetchPort: async () =>
          (await bridge.myServerCredentials(server.server_id)).port,
        tunnelRunning: tunnelConnected,
        runningNodeId,
        nodeId: server.local_node_id,
        reconnect: () =>
          onReconnectAndTest ? onReconnectAndTest() : Promise.resolve(false),
      });
      onChanged();
      onRotated?.();
    } catch (err) {
      setRepairError(errorText(err));
    } finally {
      setRepairing(false);
    }
  };

  useEffect(() => {
    setBusy(false);
    setConfirming(false);
    setError(null);
    setRenaming(false);
    setRenameError(null);
    setNameDraft("");
    setRepairing(false);
    setRepairConfirming(false);
    setRepairResult(null);
    setRepairError(null);
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
              : server.failure.message}
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
          {ready && !readOnly && repairAvailable ? (
            <div className="myservers__repair">
              {repairConfirming ? null : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={locked || repairing || confirming}
                  aria-busy={repairing || undefined}
                  onClick={() => {
                    setConfirming(false);
                    setRepairError(null);
                    setRepairConfirming(true);
                  }}
                >
                  {tr("detail.repair")}
                </button>
              )}
              {repairing ? (
                <p className="myservers__hint" role="status">
                  {tr("detail.repair.working")}
                </p>
              ) : null}
              {repairResult ? (
                <p className="myservers__hint" role="status">
                  {tr("detail.repair.done", { port: repairResult.port })}
                </p>
              ) : null}
              {repairError ? (
                <p className="myservers__error" role="alert">
                  {repairError}
                </p>
              ) : null}
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
              disabled={locked || repairing}
              onClick={() => {
                setRepairConfirming(false);
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
      {repairConfirming ? (
        <NodeRepairDialog
          nodeName={server.name}
          onCancel={() => setRepairConfirming(false)}
          onConfirm={() => void repair()}
          onSync={() => void syncCredentials()}
        />
      ) : null}
    </div>
  );
}
