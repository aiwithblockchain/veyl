import type { ConfigDeleteData } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

export interface DeleteOutcome {
  ok: boolean;
  message?: string;
}

/** 删除编排：正在连接的配置先断开，断开失败就中止，不硬删。 */
export async function deleteConfigWithDisconnect(input: {
  configId: string;
  connectedConfigId: string | null;
  disconnect: () => Promise<DeleteOutcome>;
  remove: () => Promise<ConfigDeleteData>;
}): Promise<DeleteOutcome> {
  if (input.connectedConfigId === input.configId) {
    const stopped = await input.disconnect();
    if (!stopped.ok) return stopped;
  }

  try {
    const result = await input.remove();
    if (result.already_absent) return { ok: true };
    if (!result.deleted) return { ok: false, message: "删除配置失败，请重试。" };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: toBridgeError(err).message || "删除配置失败，请重试。",
    };
  }
}

/** 从本地配置列表移除；删掉 active 配置后回到 null（空态），不自动激活别的。 */
export function withoutConfig<T extends { config_id: string }>(
  configs: T[],
  activeId: string | null,
  configId: string,
): { configs: T[]; activeId: string | null } {
  return {
    configs: configs.filter((config) => config.config_id !== configId),
    activeId: activeId === configId ? null : activeId,
  };
}
