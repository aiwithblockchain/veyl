import { useCallback, useEffect, useState } from "react";
import type { ConnectMode, VpnConfig } from "./model";
import { createMockConfig } from "./model";

const STORAGE_KEY = "veyl.configs.v1";

interface StoredConfigs {
  configs: VpnConfig[];
  activeId: string | null;
}

const EMPTY: StoredConfigs = { configs: [], activeId: null };

function read(): StoredConfigs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredConfigs>;
    if (!Array.isArray(parsed.configs)) return EMPTY;
    const configs = parsed.configs.filter(
      (config): config is VpnConfig =>
        Boolean(config) &&
        typeof config.config_id === "string" &&
        Array.isArray(config.nodes),
    );
    const activeId = configs.some((config) => config.config_id === parsed.activeId)
      ? parsed.activeId ?? null
      : configs[0]?.config_id ?? null;
    return { configs, activeId };
  } catch {
    return EMPTY;
  }
}

/** 批 2 的本地配置状态；批 1 的命令接上后整层替换成 config_list / config_create。 */
export function useConfigs() {
  const [stored, setStored] = useState<StoredConfigs>(read);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // 存不了就只在本次会话里保留。
    }
  }, [stored]);

  const activeConfig =
    stored.configs.find((config) => config.config_id === stored.activeId) ?? null;

  const createConfig = useCallback((name: string, mode: ConnectMode) => {
    const config = createMockConfig(name.trim(), mode);
    setStored((current) => ({
      configs: [...current.configs, config],
      activeId: config.config_id,
    }));
    return config;
  }, []);

  const selectConfig = useCallback((configId: string) => {
    setStored((current) =>
      current.configs.some((config) => config.config_id === configId)
        ? { ...current, activeId: configId }
        : current,
    );
  }, []);

  const setCurrentNode = useCallback((configId: string, nodeId: string) => {
    setStored((current) => ({
      ...current,
      configs: current.configs.map((config) =>
        config.config_id === configId &&
        config.nodes.some((node) => node.node_id === nodeId)
          ? { ...config, current_node_id: nodeId }
          : config,
      ),
    }));
  }, []);

  return {
    configs: stored.configs,
    activeConfig,
    activeConfigId: stored.activeId,
    createConfig,
    selectConfig,
    setCurrentNode,
  };
}
