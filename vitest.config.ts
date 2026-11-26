import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 根配置只测本仓库（桌面端前端 + 脚本）。
//
// - `src-tauri/**`：vendored 代码，用它自己的 runner。
// - `cloudflare/**`：独立包（control-plane / edge 各有自己的 package.json 与
//   vitest.config.ts）。**故意不在这里扫**：control-plane 的 `.srs` / `.mrs` 规则文件
//   靠它自己配置里的 `rules-as-arraybuffer` 插件按 Data 模块注入，根配置没有这个插件，
//   扫进来会在 transform 阶段报「invalid JS syntax … .mrs」。
//   要跑那份套件用 `npm run test:cp`（等价于 `cd cloudflare/control-plane && npm test`）。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, "src-tauri/**", "cloudflare/**"],
    },
  }),
);
