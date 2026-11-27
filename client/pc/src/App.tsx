import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import {
  api,
  toCommandError,
  type CommandError,
  type Profile,
  type ProfileDetail,
} from "./api";
import { ErrorNote } from "./components/ErrorNote";
import { ImportDialog } from "./components/ImportDialog";
import { ProfileDetail as DetailView } from "./components/ProfileDetail";
import { ProfileList } from "./components/ProfileList";

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [loadError, setLoadError] = useState<CommandError | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = useCallback(async (preferId?: string | null) => {
    try {
      const [list, active] = await Promise.all([api.list(), api.active()]);
      setProfiles(list);
      const target = preferId ?? active ?? list[0]?.id ?? null;
      setActiveId(target);
      setDetail(target ? await api.detail(target) : null);
      setLoadError(null);
    } catch (failure) {
      setLoadError(await toCommandError(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = async (id: string) => {
    setActiveId(id);
    setError(null);
    try {
      await api.select(id);
      setDetail(await api.detail(id));
    } catch (failure) {
      setError(await toCommandError(failure));
    }
  };

  const afterImport = async (profile: Profile) => {
    setImporting(false);
    setError(null);
    await reload(profile.id);
  };

  const refresh = async () => {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.refresh(activeId);
      await reload(activeId);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (name: string) => {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.rename(activeId, name);
      await reload(activeId);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.remove(activeId);
      setDetail(null);
      await reload(null);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (): Promise<string | null> => {
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "sing-box 配置", extensions: ["json"] }],
    });
    return typeof chosen === "string" ? chosen : null;
  };

  return (
    <div className="shell">
      <ProfileList
        profiles={profiles}
        activeId={activeId}
        onSelect={(id) => void select(id)}
        onImport={() => setImporting(true)}
      />

      <main className="main">
        {loading ? null : loadError ? (
          <div className="empty">
            <h1 className="empty__title">读不到配置列表</h1>
            <p className="empty__body">{loadError.message}</p>
            <button type="button" className="btn" onClick={() => void reload()}>
              重新读取
            </button>
          </div>
        ) : !detail ? (
          <div className="empty">
            <h1 className="empty__title">还没有配置</h1>
            <p className="empty__body">
              粘贴桌面端给出的订阅链接，或者导入一份本地的 sing-box 配置文件。
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setImporting(true)}
            >
              导入订阅
            </button>
          </div>
        ) : (
          <>
            <ErrorNote error={error} />
            <DetailView
              detail={detail}
              busy={busy}
              onRefresh={() => void refresh()}
              onRename={(name) => void rename(name)}
              onDelete={() => void remove()}
            />
          </>
        )}
      </main>

      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(profile) => void afterImport(profile)}
          importUrl={api.importUrl}
          pickFile={pickFile}
          importFile={api.importFile}
        />
      ) : null}
    </div>
  );
}
