import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import {
  api,
  connectionApi,
  toCommandError,
  type CommandError,
  type ConnectionSnapshot,
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
  const [connection, setConnection] = useState<ConnectionSnapshot | null>(null);
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
    connectionApi
      .status()
      .then(setConnection)
      .catch(async (failure) => {
        // 读不到连接状态不是「未连接」：如实说出来，别把它吞成 null。
        setConnection(null);
        setError(await toCommandError(failure));
      });
    const stops: Promise<() => void>[] = [
      listen<ConnectionSnapshot>("connection-changed", (event) => {
        setConnection(event.payload);
      }),
      // 配置/同步状态可能在别处被改动（菜单栏、后台刷新）；订阅它们，
      // 界面才不会停在旧数据上。
      listen("profiles-changed", () => {
        void reload();
      }),
      listen<Profile>("sync-changed", (event) => {
        const updated = event.payload;
        setProfiles((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setDetail((current) =>
          current && current.profile.id === updated.id
            ? { ...current, profile: updated }
            : current,
        );
      }),
    ];
    return () => {
      stops.forEach((stop) => void stop.then((off) => off()));
    };
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

  const rename = async (id: string, name: string) => {
    setBusy(true);
    try {
      await api.rename(id, name);
      if (id === activeId) {
        await reload(id);
      } else {
        setProfiles(await api.list());
      }
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.remove(id);
      if (id === activeId) setDetail(null);
      await reload(id === activeId ? null : activeId);
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    try {
      setConnection(await connectionApi.connect(activeId));
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      setConnection(await connectionApi.disconnect());
    } catch (failure) {
      setError(await toCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const switchNode = async (tag: string) => {
    try {
      setConnection(await connectionApi.switchNode(tag));
    } catch (failure) {
      setError(await toCommandError(failure));
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
        onRename={(id, name) => void rename(id, name)}
        onDelete={(id) => void remove(id)}
      />

      <main className="main">
        <ErrorNote error={error} />
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
          <DetailView
            detail={detail}
            busy={busy}
            connection={connection}
            onRefresh={() => void refresh()}
            onRename={(name) => activeId && void rename(activeId, name)}
            onDelete={() => activeId && void remove(activeId)}
            onConnect={() => void connect()}
            onDisconnect={() => void disconnect()}
            onSwitchNode={(tag) => void switchNode(tag)}
          />
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
