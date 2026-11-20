// vitest 不经过 wrangler 的打包，.srs / .mrs 要自己按 Data 模块（ArrayBuffer）注入。
import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // 与 wrangler 顶层包一致：测试按 live 编译期常量运行。
  define: {
    __DODO_API_BASE__: JSON.stringify("https://live.dodopayments.com"),
  },
  plugins: [
    {
      name: "rules-as-arraybuffer",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".srs") && !id.endsWith(".mrs")) return null;
        const base64 = readFileSync(id).toString("base64");
        return `export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0)).buffer;`;
      },
    },
  ],
});
