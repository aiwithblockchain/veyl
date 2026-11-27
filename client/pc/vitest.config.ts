import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // testing-library 靠全局 afterEach 自动清理 DOM；不开这个会在用例间串台。
    globals: true,
  },
});
