import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 在 dev 时通过固定端口注入 webview；移动端场景下由 TAURI_DEV_HOST 覆盖。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    sourcemap: true,
  },
});
