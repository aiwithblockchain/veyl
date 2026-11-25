import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentBridge,
  MobileClientId,
  MobileClientsQrData,
  MobileExportData,
  MobilePlatform,
  MyServer,
} from "../agent/bridge";
import { isServerNodeReady } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

/** 内部格式：只用于取数据，不出现在任何界面文本里。 */
type FormatId = "singbox" | "clash" | "ss" | "shadowrocket";

const PLATFORM_LABELS: Record<MobilePlatform, string> = {
  ios: "iPhone",
  android: "Android",
};

const VEYLCLI_ID = "veylcli" as const;
const OTHER_ID = "other" as const;

type RowId = MobileClientId | typeof VEYLCLI_ID | typeof OTHER_ID;

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

function phaseFrom(result: MobileExportData): Phase {
  if (result.state === "login_required") return { kind: "login_required" };
  if (result.state === "no_ready_server") return { kind: "no_ready_server" };
  const formats: Partial<Record<FormatId, FormatEntry>> = {};
  for (const item of result.formats) {
    formats[item.format] = {
      url: item.url,
      qr_data_url: item.qr_data_url,
    };
  }
  return { kind: "ok", formats };
}

/** 左栏快捷行的出现条件之一：至少一台服务器节点已就绪。 */
export function hasReadyServer(servers: MyServer[]): boolean {
  return servers.some(isServerNodeReady);
}

interface ImportTarget {
  name: string;
  /** 该目标内部吃哪一份数据；用户看不到这层映射。 */
  format: FormatId;
}

interface AppDef extends ImportTarget {
  id: MobileClientId;
  meta: MessageKey;
}

/** 顺序即界面顺序：按「最可能被用」排，不按平台分组。 */
const APPS: AppDef[] = [
  {
    id: "singbox",
    name: "sing-box",
    meta: "mobile.meta.singbox",
    format: "singbox",
  },
  {
    id: "shadowrocket",
    name: "Shadowrocket",
    meta: "mobile.meta.ios",
    format: "shadowrocket",
  },
  {
    id: "cmfa",
    name: "Clash Meta for Android",
    meta: "mobile.meta.androidOnly",
    format: "clash",
  },
  {
    id: "hiddify",
    name: "Hiddify",
    meta: "mobile.meta.both",
    format: "singbox",
  },
];

const OTHER_NAME: MessageKey = "mobile.otherName";

/**
 * 下载码取不到时的兜底链接：与 Host 的固定映射逐条一致。
 * 二维码要命令生成，链接不需要——命令失败也至少能点开下载页。
 */
const FALLBACK_PLATFORMS: Record<
  MobileClientId,
  Array<{ platform: MobilePlatform; url: string }>
> = {
  singbox: [
    {
      platform: "ios",
      url: "https://apps.apple.com/app/sing-box-mt/id6785326793",
    },
    {
      platform: "android",
      url: "https://github.com/SagerNet/sing-box/releases/latest",
    },
  ],
  shadowrocket: [
    {
      platform: "ios",
      url: "https://apps.apple.com/us/app/shadowrocket/id932747118",
    },
  ],
  cmfa: [
    {
      platform: "android",
      url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases/latest",
    },
  ],
  hiddify: [
    {
      platform: "ios",
      url: "https://apps.apple.com/us/app/hiddify-proxy-vpn/id6596777532",
    },
    {
      platform: "android",
      url: "https://github.com/hiddify/hiddify-app/releases/latest/download/Hiddify-Android-universal.apk",
    },
  ],
};

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
  /** 更上层的全局弹层（AI 告警）开着：让出焦点陷阱与 Esc，免得两层互抢。 */
  trapPaused?: boolean;
}

type CopyState = "idle" | "ok" | "fail";

/** 「在其它设备上使用」弹层：按设备或 App 分类，展开一行才出现该行的导入码与下载入口。 */
export function MobileExport({
  bridge,
  nested = false,
  onClose,
  onLogin,
  onGoServers,
  onAskAi,
  trapPaused = false,
}: Props) {
  const tr = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [openId, setOpenId] = useState<RowId | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [clientQr, setClientQr] = useState<
    Partial<Record<MobileClientId, MobileClientsQrData>>
  >({});
  const clientQrRef = useRef(clientQr);
  const loadingClientsRef = useRef<Set<MobileClientId>>(new Set());
  const rowRefs = useRef<Partial<Record<RowId, HTMLButtonElement | null>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rotateLinkRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  // 关闭后由 App 统一把焦点还给触发行（或左栏 ＋），这里不让陷阱自己归还。
  useFocusTrap(!trapPaused, dialogRef, false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    clientQrRef.current = clientQr;
  }, [clientQr]);

  // 展开后把该行标题顶到滚动区顶部，下面的面板才拿得到整屏。
  useEffect(() => {
    if (!openId) return;
    rowRefs.current[openId]?.scrollIntoView?.({ block: "start" });
  }, [openId]);

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

  // 可滚动且未到底时，页脚上方给一条渐隐，提示下面还有内容。
  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowFade(
      el.scrollHeight > el.clientHeight &&
        el.scrollTop + el.clientHeight < el.scrollHeight,
    );
  }, []);

  useEffect(() => {
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [updateFade, openId, phase, confirming, rotated, rotateError, copyState]);

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
      // 更上层弹层（AI 告警）的 Esc 归它自己。
      if (trapPaused) return;
      // 就地确认在展开面板里：Esc 只取消确认，不关弹层、不收面板。
      if (confirming) {
        setConfirming(false);
        return;
      }
      // 有展开行时先收面板，再按一次才关弹层。
      if (openId) {
        setOpenId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, openId, onClose, trapPaused]);

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

  const toggleRow = (id: RowId) => {
    setCopyState("idle");
    setRotated(false);
    setRotateError(null);
    setConfirming(false);
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (id !== OTHER_ID && id !== VEYLCLI_ID) loadClientQr(id);
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
        setRotateError(tr("mobile.regenerateFailed"));
      } else {
        setPhase({ kind: "error" });
      }
    } finally {
      if (aliveRef.current) setRotating(false);
    }
  };

  const startRotate = () => {
    setCopyState("idle");
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

  const stepTitle = (app: ImportTarget) => (
    <h3 className="mobile-export__step-title">
      <span className="mobile-export__step-num" aria-hidden="true">
        2
      </span>
      {tr("mobile.scanWith", { app: app.name })}
    </h3>
  );

  const importStep = (
    app: ImportTarget,
    opts: { withQr?: boolean; title?: ReactNode; note?: string } = {},
  ) => {
    const withQr = opts.withQr !== false;
    const title = opts.title ?? stepTitle(app);
    // 没有可用付费服务器：这一步不出现码位，说明与动作代替导入块。
    if (phase.kind === "no_ready_server") {
      return (
        <section className="mobile-export__step">
          {title}
          <p className="mobile-export__step-note">
            {tr("mobile.paidOnly")}
          </p>
          <div className="mobile-export__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onGoServers}
            >
              {tr("mobile.goCreate")}
            </button>
          </div>
        </section>
      );
    }

    const entry = phase.kind === "ok" ? phase.formats[app.format] : undefined;
    let qr: ReactNode = null;
    let side: ReactNode = null;
    let secure = false;

    if (phase.kind === "loading") {
      qr = <div className="mobile-export__qr-skeleton" />;
      side = (
        <p className="mobile-export__side-title" role="status">
          {tr("mobile.loadingNode")}
        </p>
      );
    } else if (phase.kind === "login_required") {
      side = (
        <>
          <p className="mobile-export__side-title">{tr("mobile.loginFirst")}</p>
          <p className="mobile-export__side-note">
            {tr("mobile.loginNote")}
          </p>
          <div className="mobile-export__actions">
            <button type="button" className="btn btn--ghost" onClick={onLogin}>
              {tr("mobile.login")}
            </button>
          </div>
        </>
      );
    } else if (phase.kind === "error" || !entry) {
      side = (
        <>
          <p className="mobile-export__side-title">{tr("mobile.genFailed")}</p>
          <div className="mobile-export__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void load()}
            >
              {tr("mobile.retry")}
            </button>
          </div>
        </>
      );
    } else {
      secure = true;
      qr = (
        <img
          className="mobile-export__qr-img"
          src={entry.qr_data_url}
          width={200}
          height={200}
          alt={tr("mobile.qrAlt")}
        />
      );
      side = (
        <>
          {opts.note ? (
            <p className="mobile-export__step-note">{opts.note}</p>
          ) : null}
          <div className="mobile-export__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copy(entry.url)}
            >
              <span role="status">
                {copyState === "ok"
                  ? tr("chat.copy.copied")
                  : copyState === "fail"
                    ? tr("chat.copy.failed")
                    : tr("topup.copyLink")}
              </span>
            </button>
            {confirming ? null : (
              <button
                ref={rotateLinkRef}
                type="button"
                className="btn btn--link"
                onClick={startRotate}
              >
                {tr("mobile.regenerate")}
              </button>
            )}
          </div>
          {confirming ? (
            <div className="mobile-export__confirm">
              <p className="mobile-export__confirm-text">
                {tr("mobile.regenerateConfirm")}
              </p>
              <div className="mobile-export__confirm-actions">
                <button
                  ref={cancelRef}
                  type="button"
                  className="btn btn--ghost"
                  disabled={rotating}
                  onClick={() => setConfirming(false)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  disabled={rotating}
                  onClick={() => void rotate()}
                >
                  {tr("mobile.regenerate")}
                </button>
              </div>
            </div>
          ) : null}
          {rotated ? (
            <p className="mobile-export__status" role="status">
              {tr("mobile.regenerated")}
            </p>
          ) : null}
          {rotateError ? (
            <p className="mobile-export__error" role="alert">
              {rotateError}
            </p>
          ) : null}
        </>
      );
    }

    const empty = withQr && qr === null;
    return (
      <section className="mobile-export__step">
        <div
          className={`mobile-export__import${withQr ? "" : " mobile-export__import--link"}`}
        >
          {withQr ? (
            <div
              className={`mobile-export__qr ${empty ? "is-empty" : ""}`.trim()}
              aria-busy={phase.kind === "loading" ? true : undefined}
            >
              {qr}
            </div>
          ) : null}
          <div className="mobile-export__side">
            {title}
            <div className="mobile-export__side-body">{side}</div>
          </div>
        </div>
        {secure ? (
          <p className="mobile-export__security">{tr("mobile.linkIsSecret")}</p>
        ) : null}
      </section>
    );
  };

  // ① 是 ② 的前提：码 120 + 两行文字，块限宽 380，明显轻于主块。
  // ① 每个平台一个码：iPhone 与 Android 的安装入口本来就不同，一个码写死一边就是死路。
  const downloadStep = (app: AppDef) => {
    // 码没有就跟兜底链接：链接在、码不在，也照样能装上。
    const platforms =
      clientQr[app.id]?.platforms ??
      FALLBACK_PLATFORMS[app.id].map((entry) => ({
        ...entry,
        qr_data_url: null,
      }));
    return (
      <section className="mobile-export__step">
        <h3 className="mobile-export__step-title">
          <span className="mobile-export__step-num" aria-hidden="true">
            1
          </span>
          {tr("mobile.downloadFirst")}
        </h3>
        <div className="mobile-export__platforms">
          {platforms
            ? platforms.map((entry) => (
                <div className="mobile-export__platform" key={entry.platform}>
                  {entry.qr_data_url ? (
                    <div className="mobile-export__download-qr">
                      <img
                        className="mobile-export__download-qr-img"
                        src={entry.qr_data_url}
                        width={120}
                        height={120}
                        alt=""
                        aria-hidden="true"
                      />
                    </div>
                  ) : null}
                  {externalLink(entry.url, PLATFORM_LABELS[entry.platform])}
                </div>
              ))
            : null}
        </div>
      </section>
    );
  };

  // veyl-cli：与手机端共用同一条链接，只是把二维码换成复制按钮，不需要下载步骤。
  const veylCliPanel = importStep(
    { name: "veyl-cli", format: "singbox" },
    {
      withQr: false,
      title: (
        <h3 className="mobile-export__step-title">
          {tr("mobile.veylcli.step")}
        </h3>
      ),
      note: tr("mobile.veylcli.hint"),
    },
  );

  const renderRow = (
    id: RowId,
    name: string,
    meta: string | null,
    panel: ReactNode,
  ) => {
    const open = openId === id;
    const rowId = `mobile-app-${id}`;
    const panelId = `mobile-app-panel-${id}`;
    return (
      <li key={id} className="mobile-export__app">
        <button
          id={rowId}
          ref={(node) => {
            rowRefs.current[id] = node;
          }}
          type="button"
          className="mobile-export__app-row"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => toggleRow(id)}
        >
          <span className="mobile-export__app-text">
            <span className="mobile-export__app-name-row">
              <span className="mobile-export__app-name">{name}</span>
              {id === "singbox" ? (
                <span className="mobile-export__badge">{tr("mobile.recommended")}</span>
              ) : null}
            </span>
            {meta ? (
              <span className="mobile-export__app-meta" title={meta}>
                {meta}
              </span>
            ) : null}
          </span>
          <span
            className={`mobile-export__chevron ${open ? "is-open" : ""}`.trim()}
            aria-hidden
          >
            ›
          </span>
        </button>
        {open ? (
          <div
            id={panelId}
            className="mobile-export__panel"
            role="region"
            aria-labelledby={rowId}
          >
            {panel}
          </div>
        ) : null}
      </li>
    );
  };

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
            {tr("mobile.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label={tr("common.close")}
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="mobile-export__scroll">
          <div
            ref={scrollRef}
            className="mobile-export__body"
            onScroll={updateFade}
          >
            <p className="mobile-export__intro">
              {tr("mobile.intro")}
            </p>

            <ul className="mobile-export__apps">
              {APPS.map((app) =>
                renderRow(
                  app.id,
                  app.name,
                  tr(app.meta),
                  <>
                    {downloadStep(app)}
                    {importStep(app)}
                  </>,
                ),
              )}
              {renderRow(
                VEYLCLI_ID,
                "veyl-cli",
                tr("mobile.veylcli.meta"),
                veylCliPanel,
              )}
              {renderRow(
                OTHER_ID,
                tr(OTHER_NAME),
                null,
                <p className="mobile-export__fallback">
                  {tr("mobile.otherNote")}
                </p>,
              )}
            </ul>
          </div>
          {showFade ? (
            <div className="mobile-export__fade" aria-hidden="true" />
          ) : null}
        </div>

        <footer className="mobile-export__footer">
          <p
            className="mobile-export__attribution"
            title={tr("mobile.attribution")}
          >
            {tr("mobile.attribution")}
          </p>
          <button
            type="button"
            className="btn btn--link mobile-export__ask-ai"
            onClick={onAskAi}
          >
            {tr("mobile.askAi")}
          </button>
        </footer>
      </div>
    </div>
  );
}
