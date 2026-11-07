import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import type { ConfigSummary } from "../agent/protocol";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";
import { ManualConfigForm } from "./ManualConfigForm";

interface Props {
  bridge: AgentBridge;
  configs: ConfigSummary[];
  aiReady: boolean;
  /** 系统时区 / 区域推断出的地区；null = 未知。 */
  region: string | null;
  onClose: () => void;
  /** 已配好 AI：关弹窗、开新会话、发开场消息。 */
  onAiAssist: () => void;
  /** 未配 AI：把控制权交给 AI 配置模块，结束后回到这里。 */
  onNeedAiSetup: () => void;
  onCreate: (input: ConfigCreateInput) => Promise<{ ok: boolean; message?: string }>;
  onCreated: () => void;
}

export function NewConfigDialog({
  bridge,
  configs,
  aiReady,
  region,
  onClose,
  onAiAssist,
  onNeedAiSetup,
  onCreate,
  onCreated,
}: Props) {
  const [step, setStep] = useState<"choose" | "manual">("choose");
  const dialogRef = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 每次回到入口都把焦点放回第一张卡，键盘用户不用重新 Tab。
  useEffect(() => {
    if (step !== "choose") return;
    choicesRef.current
      ?.querySelector<HTMLButtonElement>(".new-config__choice")
      ?.focus();
  }, [step]);

  const moveChoice = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(
      choicesRef.current?.querySelectorAll<HTMLButtonElement>(".new-config__choice") ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const chooseAi = () => {
    if (aiReady) {
      onAiAssist();
      return;
    }
    onNeedAiSetup();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal new-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-config-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head new-config__head">
          {step === "manual" ? (
            <button
              type="button"
              className="new-config__back"
              onClick={() => setStep("choose")}
            >
              ← 返回
            </button>
          ) : null}
          <h2 id="new-config-title" className="modal__title">
            新建配置
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </header>

        {step === "choose" ? (
          <>
            <div
              ref={choicesRef}
              className="new-config__choices"
              onKeyDown={moveChoice}
            >
              <button type="button" className="new-config__choice" onClick={chooseAi}>
                <span className="new-config__choice-title">AI 协助</span>
                {!aiReady ? (
                  <span className="new-config__choice-note">还没配置 AI</span>
                ) : null}
                <span className="new-config__choice-text">我一步步问你，最后帮你建好。</span>
              </button>
              <button
                type="button"
                className="new-config__choice"
                onClick={() => setStep("manual")}
              >
                <span className="new-config__choice-title">我自己配置</span>
                <span className="new-config__choice-text">
                  一次填完。知道服务器信息再用这个。
                </span>
              </button>
            </div>
            <div className="new-config__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                取消
              </button>
            </div>
          </>
        ) : (
          <ManualConfigForm
            bridge={bridge}
            configs={configs}
            region={region}
            onCreate={onCreate}
            onCreated={onCreated}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}
