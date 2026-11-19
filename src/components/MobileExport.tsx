import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, MobileExportData, MyServer } from "../agent/bridge";
import { isServerNodeReady } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

// 两行都指向官方客户端页：App Store 网页按 IP 落到大陆区，而该 App 不在大陆区商店。
const CLIENTS_URL = "https://sing-box.sagernet.org/clients/";

type ExportOk = Extract<MobileExportData, { state: "ok" }>;

type Phase =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "login_required" }
  | { kind: "no_ready_server" }
  | { kind: "ok"; data: ExportOk };

function phaseFrom(result: MobileExportData): Phase {
  if (result.state === "ok") return { kind: "ok", data: result };
  if (result.state === "login_required") return { kind: "login_required" };
  return { kind: "no_ready_server" };
}

/** 左栏快捷行的出现条件之一：至少一台服务器节点已就绪。 */
export function hasReadyServer(servers: MyServer[]): boolean {
  return servers.some(isServerNodeReady);
}

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

/** 「在手机上使用」弹层：下载入口 + 二维码 + 复制 / 重新生成。 */
export function MobileExport({
  bridge,
  nested = false,
  onClose,
  onLogin,
  onGoServers,
  onAskAi,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  /** 下载码与账户态无关：独立读取，失败就留空位。 */
  const [clientsQr, setClientsQr] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
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
    const source = bridge.mobileClientsQr;
    if (!source) return;
    let alive = true;
    source
      .call(bridge)
      .then((data) => {
        if (alive) setClientsQr(data.qr_data_url);
      })
      .catch(() => {
        // 下载码失败不显示破图：上方两行链接仍是等价入口。
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

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

  // 关闭后的焦点由 App 统一恢复；弹层自己不做，避免和设置陷阱抢焦点。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 就地确认在弹层内：Esc 只取消确认，不关弹层。
      if (confirming) {
        setConfirming(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, onClose]);

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

  const download = (url: string, label: string, ariaLabel: string) => (
    <a
      className="mobile-export__link"
      href={url}
      aria-label={ariaLabel}
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

  const qr =
    phase.kind === "ok" ? (
      <img
        className="mobile-export__qr-img"
        src={phase.data.qr_data_url}
        width={160}
        height={160}
        alt="sing-box 导入二维码"
      />
    ) : phase.kind === "loading" ? (
      <div className="mobile-export__qr-skeleton" aria-busy="true" />
    ) : null;

  let side = null;
  if (phase.kind === "loading") {
    side = (
      <p className="mobile-export__side-title" role="status">
        正在读取节点…
      </p>
    );
  } else if (phase.kind === "error") {
    side = (
      <>
        <p className="mobile-export__side-title">二维码暂时生成不了。</p>
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
  } else {
    side = (
      <>
        <p className="mobile-export__side-note">
          节点变化会自动更新，不用重扫。
        </p>
        <div className="mobile-export__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void copy(phase.data.url)}
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
          <section className="mobile-export__step">
            <h3 className="mobile-export__step-head">
              <span className="mobile-export__step-num num" aria-hidden="true">
                1
              </span>
              安装客户端
            </h3>

            <div className="mobile-export__install">
              <div className="mobile-export__platforms">
                <div className="mobile-export__download">
                  <div>
                    <div className="mobile-export__platform">iPhone</div>
                    <p className="mobile-export__caption">
                      需要大陆以外的 Apple 账号。
                    </p>
                  </div>
                  {download(
                    CLIENTS_URL,
                    "官方下载页",
                    "查看 sing-box 的 iPhone 安装说明",
                  )}
                </div>
                <div className="mobile-export__download">
                  <div className="mobile-export__platform">Android</div>
                  {download(
                    CLIENTS_URL,
                    "官方下载页",
                    "查看 sing-box 的 Android 安装说明",
                  )}
                </div>
              </div>

              <div className="mobile-export__download-qr">
                <p className="mobile-export__qr-caption">扫码下载</p>
                <div className="mobile-export__download-qr-box">
                  {clientsQr ? (
                    <img
                      className="mobile-export__download-qr-img"
                      src={clientsQr}
                      width={80}
                      height={80}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="mobile-export__step">
            <h3 className="mobile-export__step-head">
              <span className="mobile-export__step-num num" aria-hidden="true">
                2
              </span>
              导入节点
            </h3>

            <div className="mobile-export__qr-area">
              <div className="mobile-export__qr-col">
                <p className="mobile-export__qr-caption">扫码导入</p>
                <div className="mobile-export__qr">{qr}</div>
              </div>
              <div className="mobile-export__side">{side}</div>
            </div>
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
