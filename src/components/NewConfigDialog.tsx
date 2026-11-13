import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import type { ConfigConnectMode, ConfigSummary } from "../agent/protocol";
import { nextConfigName } from "../config/model";
import { useFocusTrap } from "../ui/focus";
import { ConfigReview } from "./ConfigReview";
import { IconClose } from "./icons";

interface Props {
  bridge: AgentBridge;
  configs: ConfigSummary[];
  /** 生效地区；null = 未知，按全局模式保存。 */
  region: string | null;
  /** App 已读到的免费节点数；null / undefined 时弹窗自己补一次只读状态。 */
  defaultNodeCount?: number | null;
  onClose: () => void;
  onCreate: (
    input: ConfigCreateInput,
  ) => Promise<{ ok: boolean; message?: string; reason?: string }>;
  onCreated: (connect: boolean) => void;
  /** 当前是否已连接：决定主按钮文案与创建后是否自动连接。 */
  connected?: boolean;
  /** 第 2 问选「其它节点」：切到「我的服务器」destination，保留接管方式。 */
  onChooseServers?: (connectMode: ConfigConnectMode) => void;
  /** 从「我的服务器」带回来的节点：直接进审视页，节点来源已确定。 */
  ownedNodes?: { nodeIds: string[]; label: string } | null;
  /** 从「我的服务器」返回时恢复的接管方式。 */
  initialConnectMode?: ConfigConnectMode;
}

type View = "questions" | "review";
type SeedState = "ready" | "empty" | "loading" | "failed";

const SEED_ERROR = [
  "没能取到免费节点。",
  "可能没联网，或免费节点服务暂时不可用。",
  "点「重试」；还是不行，就改选「其它节点」。",
];

function errorText(error: unknown, fallback: string): string {
  const message = toBridgeError(error).message;
  return message && message !== "操作失败" ? message : fallback;
}

function moveWithinGroup(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const group = event.currentTarget;
  const options = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
  if (options.length === 0) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement as HTMLElement);
  const delta = event.key === "ArrowDown" ? 1 : -1;
  const next = (current + delta + options.length) % options.length;
  // 方向键切换即选中，符合 radiogroup 的键盘预期。
  options[next]?.focus();
  options[next]?.click();
}

export function NewConfigDialog({
  bridge,
  configs,
  region,
  defaultNodeCount = null,
  onClose,
  onCreate,
  onCreated,
  connected = false,
  onChooseServers,
  ownedNodes = null,
  initialConnectMode,
}: Props) {
  const [view, setView] = useState<View>(ownedNodes ? "review" : "questions");
  const [connectMode, setConnectMode] = useState<ConfigConnectMode>(
    initialConnectMode ?? "tun",
  );
  const [source, setSource] = useState<"seed" | "vendor">(
    ownedNodes ? "vendor" : "seed",
  );
  const [seedState, setSeedState] = useState<SeedState>("empty");
  const [seedCount, setSeedCount] = useState<number | null>(null);
  const name = nextConfigName(configs);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [seedProblem, setSeedProblem] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const seedTouchedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (savingRef.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 打开弹窗不联网：读一次本地的池状态；App 已有值时直接复用。
  useEffect(() => {
    if (seedTouchedRef.current) return;
    if (defaultNodeCount !== null) {
      setSeedCount(defaultNodeCount);
      setSeedState(defaultNodeCount > 0 ? "ready" : "empty");
      return;
    }
    let alive = true;
    bridge
      .defaultProfileStatus()
      .then((status) => {
        if (!alive || seedTouchedRef.current) return;
        setSeedCount(status.nodeCount);
        setSeedState(status.nodeCount > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!alive || seedTouchedRef.current) return;
        setSeedCount(0);
        setSeedState("empty");
      });
    return () => {
      alive = false;
    };
  }, [bridge, defaultNodeCount]);

  // 回两问时聚焦刚才操作的那组已选项。
  useEffect(() => {
    if (view !== "questions") return;
    connectRef.current
      ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ?.focus();
  }, [view]);

  const fetchSeed = async (): Promise<boolean> => {
    seedTouchedRef.current = true;
    setSeedState("loading");
    try {
      const status = await bridge.defaultProfileRefresh();
      setSeedCount(status.nodeCount);
      if (status.nodeCount > 0) {
        setSeedState("ready");
        return true;
      }
      setSeedState("failed");
      return false;
    } catch {
      setSeedState("failed");
      return false;
    }
  };

  const goNext = async () => {
    if (source === "vendor") {
      onChooseServers?.(connectMode);
      return;
    }
    if (seedState === "loading") return;
    if (seedState === "ready" || (seedCount ?? 0) > 0) {
      setView("review");
      return;
    }
    const ok = await fetchSeed();
    if (ok) setView("review");
  };

  const save = async () => {
    if (savingRef.current) return;
    const trimmed = name.trim();
    setSaveError(null);
    setSeedProblem(false);
    setSaving(true);
    savingRef.current = true;
    const input: ConfigCreateInput = ownedNodes
      ? {
          name: trimmed,
          connectMode,
          routingMode: region ? "direct" : "proxy_all",
          source: "empty",
          nodeIds: ownedNodes.nodeIds,
        }
      : {
          name: trimmed,
          connectMode,
          routingMode: region ? "direct" : "proxy_all",
          source: "seed",
        };
    try {
      let result: { ok: boolean; message?: string; reason?: string };
      try {
        result = await onCreate(input);
      } catch (error) {
        setSaveError(errorText(error, "创建配置失败，再试一次。"));
        return;
      }
      // 免费节点的刷新与重试只留在 useVpnSession 一层，弹窗不重复。
      if (!result.ok) {
        if (result.reason === "seed_unavailable") {
          setSeedProblem(true);
        } else {
          setSaveError(result.message ?? "创建配置失败，再试一次。");
        }
        return;
      }
      onCreated(!connected);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const optionProps = (selected: boolean, onPick: () => void) => ({
    role: "radio" as const,
    "aria-checked": selected,
    tabIndex: selected ? 0 : -1,
    className: `new-config__answer ${selected ? "is-selected" : ""}`,
    onClick: onPick,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        onPick();
      }
    },
  });

  const title = "新建配置";
  const step = view === "review" ? 2 : 1;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!savingRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal new-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-config-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head new-config__head">
          {view === "review" ? (
            <button
              type="button"
              className="new-config__back"
              disabled={saving}
              onClick={() => setView("questions")}
            >
              ← 返回
            </button>
          ) : null}
          <h2 id="new-config-title" className="modal__title">
            {title}
          </h2>
          <span
            className="new-config__steps"
            aria-label={`第 ${step} 步，共 2 步`}
          >
            <span className={`new-config__dot ${step === 1 ? "is-current" : ""}`} />
            <span className={`new-config__dot ${step === 2 ? "is-current" : ""}`} />
          </span>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </header>

        {view === "questions" ? (
          <div className="new-config__questions">
            <p className="new-config__intro">先定两件事，以后随时能在中间改。</p>

            <div
              ref={connectRef}
              className="new-config__group"
              role="radiogroup"
              aria-label="怎么接管"
              onKeyDown={moveWithinGroup}
            >
              <p className="new-config__group-title">
                <span className="new-config__num">①</span>怎么接管
              </p>
              <div
                {...optionProps(connectMode === "tun", () => setConnectMode("tun"))}
              >
                <span className="new-config__answer-head">
                  <span className="new-config__marker" aria-hidden />
                  <span className="new-config__answer-title">TUN 模式（接管全部流量）</span>
                </span>
                <span className="new-config__answer-lead">整台电脑都走 VPN。</span>
                <span className="new-config__answer-note">
                  浏览器、聊天、游戏、命令行都走 VPN，不用逐个软件设置。
                </span>
                <span className="new-config__answer-note">
                  第一次连接时，系统会请求一次授权。
                </span>
              </div>
              <div
                {...optionProps(connectMode === "system_proxy", () =>
                  setConnectMode("system_proxy"),
                )}
              >
                <span className="new-config__answer-head">
                  <span className="new-config__marker" aria-hidden />
                  <span className="new-config__answer-title">
                    Proxy 模式（只给代理地址）
                  </span>
                </span>
                <span className="new-config__answer-lead">只让部分软件走 VPN。</span>
                <span className="new-config__answer-note">
                  只让能填代理地址的软件走 VPN，其它软件保持原样。
                </span>
                <span className="new-config__answer-note">
                  需要在那个软件里填一次本机代理地址。
                </span>
              </div>
            </div>

            <div
              ref={sourceRef}
              className="new-config__group"
              role="radiogroup"
              aria-label="节点从哪来"
              onKeyDown={moveWithinGroup}
            >
              <p className="new-config__group-title">
                <span className="new-config__num">②</span>节点从哪来
              </p>
              <div {...optionProps(source === "seed", () => setSource("seed"))}>
                <span className="new-config__answer-head">
                  <span className="new-config__marker" aria-hidden />
                  <span className="new-config__answer-title">Veyl 免费节点</span>
                </span>
                <span className="new-config__answer-lead">不用自己准备，先连上再说。</span>
                <span className="new-config__answer-text">
                  用 Veyl 提供的免费节点，建好后直接连。
                </span>
                {source === "seed" && seedState === "empty" ? (
                  <span className="new-config__answer-status">
                    还没有免费节点，下一步时会去获取。
                  </span>
                ) : null}
              </div>
              {source === "seed" && seedState === "loading" ? (
                <div className="new-config__seed-loading" role="status" aria-busy="true">
                  <span className="new-config__spinner" aria-hidden />
                  正在获取免费节点…
                </div>
              ) : null}
              {source === "seed" && seedState === "failed" ? (
                <div className="new-config__seed-error" role="alert">
                  {SEED_ERROR.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void fetchSeed()}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              <div {...optionProps(source === "vendor", () => setSource("vendor"))}>
                <span className="new-config__answer-head">
                  <span className="new-config__marker" aria-hidden />
                  <span className="new-config__answer-title">其它节点</span>
                </span>
                <span className="new-config__answer-lead">
                  用你自己的机场或节点供应商。
                </span>
                <span className="new-config__answer-text">
                  下一步打开「我的服务器」，可以买一台，也可以在里面导入已有节点。
                </span>
              </div>
            </div>

            <div className="new-config__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  source === "seed" &&
                  (seedState === "loading" || seedState === "failed")
                }
                onClick={() => void goNext()}
              >
                {source === "seed" && seedState === "loading" ? "正在获取…" : "下一步"}
              </button>
            </div>
          </div>
        ) : (
          <ConfigReview
            connectMode={connectMode}
            region={region}
            name={name}
            error={saveError}
            saving={saving}
            connected={connected}
            seedProblem={seedProblem}
            nodeSourceLabel={ownedNodes?.label ?? null}
            onRetrySeed={() => void save()}
            onBack={() => setView("questions")}
            onCancel={onClose}
            onSave={() => void save()}
          />
        )}
      </div>
    </div>
  );
}
