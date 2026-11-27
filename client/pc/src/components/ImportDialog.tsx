import { useState } from "react";

import { toCommandError, type CommandError, type Profile } from "../api";
import { ErrorNote } from "./ErrorNote";

type Props = {
  onClose: () => void;
  onImported: (profile: Profile) => void;
  importUrl: (url: string) => Promise<Profile>;
  pickFile: () => Promise<string | null>;
  importFile: (path: string) => Promise<Profile>;
};

export function ImportDialog({
  onClose,
  onImported,
  importUrl,
  pickFile,
  importFile,
}: Props) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);

  const submit = async () => {
    if (busy || link.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const profile = await importUrl(link);
      onImported(profile);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    if (busy) return;
    setError(null);
    try {
      const path = await pickFile();
      if (!path) return;
      setBusy(true);
      const profile = await importFile(path);
      onImported(profile);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <h2 className="dialog__title" id="import-title">
          导入配置
        </h2>
        <p className="dialog__body">
          粘贴桌面端给出的订阅链接。链接里带令牌，导入后只保存在本机的密钥里。
        </p>

        <ErrorNote error={error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="subscription-link">
              订阅链接
            </label>
            <input
              id="subscription-link"
              className="field__input num"
              type="text"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="https://veyl:…@主机/v1/mobile/profile"
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </div>

          <div className="dialog__actions">
            <button
              type="button"
              className="link"
              onClick={() => void chooseFile()}
              disabled={busy}
            >
              从文件导入…
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || link.trim() === ""}
              >
                {busy ? "导入中…" : "导入"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
