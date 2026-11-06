import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 裸跑 vitest 时同样只测本项目：src-tauri 下是 vendored 代码，用它自己的 runner。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, "src-tauri/**"],
    },
  }),
);
