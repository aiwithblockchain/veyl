import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  MobileClientId,
  MobileClientsQrData,
  MobileExportData,
  MyServer,
} from "../agent/bridge";
import { isServerNodeReady } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

type FormatId = "singbox" | "clash";

const FORMAT_IDS: FormatId[] = ["singbox", "clash"];

const FORMAT_LABELS: Record<FormatId, string> = {
  singbox: "sing-box",
  clash: "Clash",
};

interface FormatEntry {
  url: string;
  qr_data_url: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "login_required" }
  | { kind: "no_ready_server" }
  | { kind: "ok"; formats: Partial<Record<FormatId, FormatEntry>> };

/** ss 照契约会返回，但界面只做两段导入格式，忽略 ss。 */
function phaseFrom(result: MobileExportData): Phase {
  if (result.state === "login_required") return { kind: "login_required" };
  if (result.state === "no_ready_server") return { kind: "no_ready_server" };
  const formats: Partial<Record<FormatId, FormatEntry>> = {};
  for (const item of result.formats) {
    if (item.format === "singbox" || item.format === "clash") {
      formats[item.format] = {
        url: item.url,
        qr_data_url: item.qr_data_url,
      };
    }
  }
  return { kind: "ok", formats };
}

/** 左栏快捷行的出现条件之一：至少一台服务器节点已就绪。 */
export function hasReadyServer(servers: MyServer[]): boolean {
  return servers.some(isServerNodeReady);
}

interface ClientDef {
  id: MobileClientId;
  name: string;
  meta: string;
  format: FormatId;
  /** 与契约 §7.23 的 Host 固定映射一致；二维码以命令返回为准。 */
  url: string;
}

const CLIENTS: ClientDef[] = [
  {
    id: "singbox",
    name: "sing-box 官方",
    meta: "iOS（大陆以外 Apple 账号）/ Android · sing-box",
    format: "singbox",
    url: "https://sing-box.sagernet.org/clients/",
  },
  {
    id: "hiddify",
    name: "Hiddify",
    meta: "iOS / Android · sing-box / Clash",
    format: "singbox",
    url: "https://hiddify.com",
  },
  {
    id: "cmfa",
    name: "Clash Meta for Android",
    meta: "Android · Clash 格式",
    format: "clash",
    url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases",
  },
];

interface Props {
  bridge: AgentBridge;
  /** 设置页开着时叠在它上面。 */
  nested?: boolean;
  onClose: () => void;
  /** 先关闭弹层，再打开登录或切到「我的服务器」。 */
  onLogin: () => void;
  onGoServers: () => void;
  /** 底部「不会操作？问 AI」：由 App 关闭弹层并在右栏发送固定提示词。 */
  onAskAi: () => void;
}

type CopyState = "idle" | "ok" | "fail";

/** 「在手机上使用」弹层：导入码（两格式）+ 客户端列表与二级下载码。 */
export function MobileExport({
  bridge,
  nested = false,
  onClose,
  onLogin,
  onGoServers,
  onAskAi,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [format, setFormat] = useState<FormatId>("singbox");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [openClient, setOpenClient] = useState<MobileClientId | null>(null);
  const [clientQr, setClientQr] = useState<
    Partial<Record<MobileClientId, MobileClientsQrData>>
  >({});
  const clientQrRef = useRef(clientQr);
  const loadingClientsRef = useRef<Set<MobileClientId>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rotateLinkRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  // 关闭后由 App 统一把焦点还给触发行（或左栏 ＋），这里不让陷阱自己归还。
  useFocusTrap(true, dialogRef, false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    clientQrRef.current = clientQr;
  }, [clientQr]);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    setConfirming(false);
    setRotated(false);
    setRotateError(null);
    setCopyState("idle");
    const get = bridge.mobileExportGet;
    if (!get) {
      setPhase({ kind: "error" });
      return;
    }
    try {
      const result = await get.call(bridge);
      if (aliveRef.current) setPhase(phaseFrom(result));
    } catch {
      if (aliveRef.current) setPhase({ kind: "error" });
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (confirming) {
      wasConfirmingRef.current = true;
      cancelRef.current?.focus();
      return;
    }
    // 取消确认后回到「重新生成」；成功重新生成时这个按钮已不在，不强行聚焦。
    if (wasConfirmingRef.current) {
      wasConfirmingRef.current = false;
      rotateLinkRef.current?.focus();
    }
  }, [confirming]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 就地确认在弹层内：Esc 只取消确认，不关弹层。
      if (confirming) {
        setConfirming(false);
        return;
      }
      // 二级面板展开时先收面板，再按一次才关弹层。
      if (openClient) {
        setOpenClient(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, openClient, onClose]);

  const selectFormat = (next: FormatId): boolean => {
    if (next === format) return false;
    setFormat(next);
    setAnnouncement(`已切到 ${FORMAT_LABELS[next]} 格式。`);
    return true;
  };

  const loadClientQr = (id: MobileClientId) => {
    if (clientQrRef.current[id] || loadingClientsRef.current.has(id)) return;
    const source = bridge.mobileClientsQr;
    if (!source) return;
    loadingClientsRef.current.add(id);
    source
      .call(bridge, id)
      .then((data) => {
        if (!aliveRef.current) return;
        setClientQr((current) =>
          current[id] ? current : { ...current, [id]: data },
        );
      })
      .catch(() => {
        // 拿不到下载码就只留「打开下载页」，链接仍是等价入口。
      })
      .finally(() => {
        loadingClientsRef.current.delete(id);
      });
  };

  const toggleClient = (client: ClientDef) => {
    if (openClient === client.id) {
      setOpenClient(null);
      return;
    }
    setOpenClient(client.id);
    loadClientQr(client.id);
    selectFormat(client.format);
  };

  const copy = async (url: string) => {
    const ok = await copyText(url);
    setCopyState(ok ? "ok" : "fail");
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(
      () => setCopyState("idle"),
      ok ? 1500 : 2000,
    );
  };

  const rotate = async () => {
    const source = bridge.mobileExportRotate;
    if (!source || rotating) return;
    const previous = phase.kind === "ok" ? phase : null;
    setRotating(true);
    setRotateError(null);
    setRotated(false);
    setPhase({ kind: "loading" });
    try {
      const result = await source.call(bridge);
      if (!aliveRef.current) return;
      setConfirming(false);
      setPhase(phaseFrom(result));
      setRotated(result.state === "ok");
    } catch {
      if (!aliveRef.current) return;
      setConfirming(false);
      if (previous) {
        // 旧二维码还能用：保留它，只在操作区下方说明这次没成功。
        setPhase(previous);
        setRotateError("没能重新生成。旧链接还在，稍后再试。");
      } else {
        setPhase({ kind: "error" });
      }
    } finally {
      if (aliveRef.current) setRotating(false);
    }
  };

  const startRotate = () => {
    setRotated(false);
    setRotateError(null);
    setConfirming(true);
  };

  const externalLink = (url: string, label: string) => (
    <a
      className="mobile-export__link"
      href={url}
      onClick={(event) => {
        event.preventDefault();
        void bridge.openExternal(url);
      }}
    >
      {label}
      <span className="mobile-export__arrow" aria-hidden>
        ↗
      </span>
    </a>
  );

  const active = phase.kind === "ok" ? phase.formats[format] : undefined;
  const formatFailed = phase.kind === "error" || (phase.kind === "ok" && !active);
  const qr =
    phase.kind === "loading" ? (
      <div className="mobile-export__qr-skeleton" aria-busy="true" />
    ) : active ? (
      <img
        className="mobile-export__qr-img"
        src={active.qr_data_url}
        width={160}
        height={160}
        alt={`${FORMAT_LABELS[format]} 导入二维码`}
      />
    ) : null;

  let side = null;
  if (phase.kind === "loading") {
    side = (
      <p className="mobile-export__side-title" role="status">
        正在读取节点…
      </p>
    );
  } else if (formatFailed) {
    side = (
      <>
        <p className="mobile-export__side-title">这个格式暂时生成不了。</p>
        <div className="mobile-export__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      </>
    );
  } else if (phase.kind === "login_required") {
    side = (
      <>
        <p className="mobile-export__side-title">先登录。</p>
        <p className="mobile-export__side-note">
          登录后可以把自己的节点导入手机。
        </p>
        <div className="mobile-export__actions">
          <button type="button" className="btn btn--ghost" onClick={onLogin}>
            登录
          </button>
        </div>
      </>
    );
  } else if (phase.kind === "no_ready_server") {
    side = (
      <>
        <p className="mobile-export__side-title">还没有可用的服务器。</p>
        <p className="mobile-export__side-note">
          先在「我的服务器」里创建一台，再回来扫码。
        </p>
        <div className="mobile-export__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onGoServers}
          >
            去我的服务器
          </button>
        </div>
      </>
    );
  } else if (active) {
    side = (
      <>
        <div className="mobile-export__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void copy(active.url)}
          >
            <span role="status">
              {copyState === "ok"
                ? "已复制"
                : copyState === "fail"
                  ? "复制失败"
                  : "复制链接"}
            </span>
          </button>
          {confirming ? null : (
            <button
              ref={rotateLinkRef}
              type="button"
              className="btn btn--link"
              onClick={startRotate}
            >
              重新生成
            </button>
          )}
        </div>
        {confirming ? (
          <div className="mobile-export__confirm">
            <p className="mobile-export__confirm-text">
              重新生成后，手机上的旧配置下次更新时失效。
            </p>
            <div className="mobile-export__confirm-actions">
              <button
                ref={cancelRef}
                type="button"
                className="btn btn--ghost"
                disabled={rotating}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                disabled={rotating}
                onClick={() => void rotate()}
              >
                重新生成
              </button>
            </div>
          </div>
        ) : null}
        {rotated ? (
          <p className="mobile-export__status" role="status">
            已重新生成；手机上的旧配置下次更新时失效。
          </p>
        ) : null}
        {rotateError ? (
          <p className="mobile-export__error" role="alert">
            {rotateError}
          </p>
        ) : null}
        <p className="mobile-export__security">链接相当于密码，别转发。</p>
      </>
    );
  }

  return (
    <div
      className={`modal-backdrop ${nested ? "modal-backdrop--nested" : ""}`.trim()}
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        className="modal mobile-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-export-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2
            id="mobile-export-title"
            className="modal__title mobile-export__title"
          >
            在手机上使用
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="mobile-export__body">
          <section className="mobile-export__import">
            <h3 className="mobile-export__section-title">导入节点</h3>
            <div
              className="mobile-export__formats"
              role="group"
              aria-label="导入格式"
            >
              {FORMAT_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="mobile-export__format"
                  aria-pressed={format === id}
                  onClick={() => selectFormat(id)}
                >
                  {FORMAT_LABELS[id]}
                </button>
              ))}
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              {announcement ?? ""}
            </p>

            <div className="mobile-export__qr-area">
              <div className="mobile-export__qr">{qr}</div>
              <div className="mobile-export__side">{side}</div>
            </div>
          </section>

          <section className="mobile-export__clients">
            <h3 className="mobile-export__clients-title">还没有客户端？</h3>
            <p className="mobile-export__attribution">
              客户端不是我们开发的，Veyl 只提供节点。
            </p>
            <ul className="mobile-export__client-list">
              {CLIENTS.map((client) => {
                const open = openClient === client.id;
                const data = clientQr[client.id];
                const rowId = `mobile-client-${client.id}`;
                const panelId = `mobile-client-panel-${client.id}`;
                return (
                  <li key={client.id} className="mobile-export__client">
                    <button
                      id={rowId}
                      type="button"
                      className="mobile-export__client-row"
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => toggleClient(client)}
                    >
                      <span className="mobile-export__client-text">
                        <span className="mobile-export__client-name">
                          {client.name}
                        </span>
                        <span className="mobile-export__client-meta">
                          {client.meta}
                        </span>
                      </span>
                      <span
                        className={`mobile-export__chevron ${open ? "is-open" : ""}`}
                        aria-hidden
                      >
                        ›
                      </span>
                    </button>
                    {open ? (
                      <div
                        id={panelId}
                        className="mobile-export__client-panel"
                        role="region"
                        aria-labelledby={rowId}
                      >
                        <div className="mobile-export__client-qr-box">
                          {data ? (
                            <img
                              className="mobile-export__client-qr-img"
                              src={data.qr_data_url}
                              width={80}
                              height={80}
                              alt=""
                              aria-hidden="true"
                            />
                          ) : null}
                        </div>
                        {externalLink(data?.url ?? client.url, "打开下载页")}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          <button
            type="button"
            className="btn btn--link mobile-export__ask-ai"
            onClick={onAskAi}
          >
            不会操作？问 AI
          </button>
        </div>
      </div>
    </div>
  );
}
