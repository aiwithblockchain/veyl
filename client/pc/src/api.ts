import { invoke } from "@tauri-apps/api/core";

export type SyncState = "ok" | "failed" | "unauthorized" | "never";
export type KernelCheck = "passed" | "unavailable";

export type ProfileSource =
  | { kind: "subscription"; host: string }
  | { kind: "file"; path: string; name?: string };

export type Profile = {
  id: string;
  name: string;
  source: ProfileSource;
  node_count: number;
  last_synced_at: number | null;
  sync_state: SyncState;
  sync_error: string | null;
  created_at: number;
  kernel_check: KernelCheck;
};

export type NodeBrief = {
  tag: string;
  kind: string;
};

export type ProfileDetail = {
  profile: Profile;
  nodes: NodeBrief[];
  source_label: string;
};

/** Rust 侧的 AppError 形状：发生了什么 / 为什么 / 现在做什么。 */
export type CommandError = {
  code: string;
  message: string;
  reason: string;
  hint: string;
};

export function isCommandError(value: unknown): value is CommandError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommandError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export async function toCommandError(value: unknown): Promise<CommandError> {
  if (isCommandError(value)) return value;
  // invoke 抛字符串时也归一化，界面只需要一种形状。
  const message = value instanceof Error ? value.message : String(value);
  return { code: "INTERNAL", message, reason: "", hint: "" };
}

export const api = {
  list: () => invoke<Profile[]>("profiles_list"),
  active: () => invoke<string | null>("profiles_active"),
  select: (id: string) => invoke<void>("profile_select", { id }),
  importUrl: (url: string) => invoke<Profile>("profile_import_url", { url }),
  importFile: (path: string) => invoke<Profile>("profile_import_file", { path }),
  refresh: (id: string) => invoke<Profile>("profile_refresh", { id }),
  rename: (id: string, name: string) =>
    invoke<Profile>("profile_rename", { id, name }),
  remove: (id: string) => invoke<void>("profile_remove", { id }),
  detail: (id: string) => invoke<ProfileDetail>("profile_detail", { id }),
};

export type ConnectionState =
  | { state: "idle" }
  | { state: "connecting"; config_id: string }
  | { state: "connected"; config_id: string; pid: number; since?: string; node: string | null }
  | { state: "disconnecting" }
  | { state: "failed"; code: string; message: string; reason: string; hint: string };

export type ConnectionSnapshot = ConnectionState & {
  uptime_seconds: number | null;
  /** 用户选中的节点；未连接时也有，界面据此高亮。 */
  selected_node?: string | null;
};

export const connectionApi = {
  connect: (id: string) => invoke<ConnectionSnapshot>("connect", { id }),
  disconnect: () => invoke<ConnectionSnapshot>("disconnect"),
  status: () => invoke<ConnectionSnapshot>("connection_status"),
  switchNode: (tag: string) => invoke<ConnectionSnapshot>("switch_node", { tag }),
};
